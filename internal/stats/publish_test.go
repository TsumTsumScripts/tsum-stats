package stats

import (
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"
)

// fakeGitHub implements the parts of GitHub's API that publishing uses, with
// git's own content addressing, so uploads that are skipped can be counted.
type fakeGitHub struct {
	t   *testing.T
	srv *httptest.Server

	mu          sync.Mutex
	token       string // the one token it accepts
	repoExists  bool
	blobs       map[string][]byte
	trees       map[string]map[string]string // tree sha -> path -> blob sha
	commits     map[string]string            // commit sha -> tree sha
	head        string
	blobPosts   int
	commitPosts int
	pagesOn     bool
}

func newFakeGitHub(t *testing.T) *fakeGitHub {
	f := &fakeGitHub{t: t, token: "tok-1", blobs: map[string][]byte{}, trees: map[string]map[string]string{}, commits: map[string]string{}}
	mux := http.NewServeMux()
	mux.HandleFunc("/", f.api)
	f.srv = httptest.NewServer(mux)
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeGitHub) json(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (f *fakeGitHub) sha(kind string, parts ...string) string {
	h := sha1.New()
	fmt.Fprint(h, kind, strings.Join(parts, "|"))
	return hex.EncodeToString(h.Sum(nil))
}

func (f *fakeGitHub) api(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.Header.Get("Authorization") != "Bearer "+f.token {
		f.json(w, 401, map[string]string{"message": "Bad credentials"})
		return
	}
	var body map[string]any
	_ = json.NewDecoder(r.Body).Decode(&body)
	path := r.URL.Path
	const repo = "/repos/ada/tsum-stats"
	switch {
	case path == "/user":
		f.json(w, 200, map[string]string{"login": "ada"})
	case path == repo && r.Method == "GET":
		if !f.repoExists {
			f.json(w, 404, map[string]string{"message": "Not Found"})
			return
		}
		f.json(w, 200, map[string]string{"default_branch": "main"})
	case path == "/user/repos":
		if body["private"] != false {
			f.t.Errorf("the repo must be public, got %v", body["private"])
		}
		f.repoExists = true
		f.seed(map[string][]byte{"README.md": []byte("# tsum-stats\n")})
		f.json(w, 201, map[string]string{"default_branch": "main"})
	case path == repo+"/git/ref/heads/main":
		f.json(w, 200, map[string]any{"object": map[string]string{"sha": f.head}})
	case strings.HasPrefix(path, repo+"/git/commits/"):
		f.json(w, 200, map[string]any{"tree": map[string]string{"sha": f.commits[strings.TrimPrefix(path, repo+"/git/commits/")]}})
	case strings.HasPrefix(path, repo+"/git/trees/") && r.Method == "GET":
		var entries []map[string]string
		for p, sha := range f.trees[strings.TrimPrefix(path, repo+"/git/trees/")] {
			entries = append(entries, map[string]string{"path": p, "type": "blob", "sha": sha, "mode": "100644"})
		}
		f.json(w, 200, map[string]any{"tree": entries, "truncated": false})
	case path == repo+"/git/blobs":
		f.blobPosts++
		data, err := base64.StdEncoding.DecodeString(body["content"].(string))
		if err != nil {
			f.json(w, 422, map[string]string{"message": "bad base64"})
			return
		}
		sha := gitBlobSHA(data)
		f.blobs[sha] = data
		f.json(w, 201, map[string]string{"sha": sha})
	case path == repo+"/git/trees" && r.Method == "POST":
		next := map[string]string{}
		for p, sha := range f.trees[body["base_tree"].(string)] {
			next[p] = sha
		}
		for _, e := range body["tree"].([]any) {
			e := e.(map[string]any)
			if e["sha"] == nil {
				delete(next, e["path"].(string))
				continue
			}
			sha := e["sha"].(string)
			if _, ok := f.blobs[sha]; !ok {
				f.json(w, 422, map[string]string{"message": "GitRPC::BadObjectState"})
				return
			}
			next[e["path"].(string)] = sha
		}
		keys := make([]string, 0, len(next))
		for p, s := range next {
			keys = append(keys, p+":"+s)
		}
		sha := f.sha("tree", sortedJoin(keys))
		f.trees[sha] = next
		f.json(w, 201, map[string]string{"sha": sha})
	case path == repo+"/git/commits":
		f.commitPosts++
		if body["parents"].([]any)[0] != f.head {
			f.json(w, 422, map[string]string{"message": "wrong parent"})
			return
		}
		sha := f.sha("commit", body["tree"].(string), fmt.Sprint(f.commitPosts))
		f.commits[sha] = body["tree"].(string)
		f.json(w, 201, map[string]string{"sha": sha})
	case path == repo+"/git/refs/heads/main" && r.Method == "PATCH":
		f.head = body["sha"].(string)
		f.json(w, 200, map[string]any{})
	case path == repo+"/pages" && r.Method == "GET":
		if !f.pagesOn {
			f.json(w, 404, map[string]string{"message": "Not Found"})
			return
		}
		f.json(w, 200, map[string]string{"html_url": "https://ada.github.io/tsum-stats/"})
	case path == repo+"/pages" && r.Method == "POST":
		f.pagesOn = true
		f.json(w, 201, map[string]string{"html_url": "https://ada.github.io/tsum-stats/"})
	default:
		f.t.Errorf("unexpected request %s %s", r.Method, path)
		f.json(w, 404, map[string]string{"message": "Not Found"})
	}
}

func sortedJoin(s []string) string {
	for i := range s {
		for j := i + 1; j < len(s); j++ {
			if s[j] < s[i] {
				s[i], s[j] = s[j], s[i]
			}
		}
	}
	return strings.Join(s, ",")
}

// seed makes the repo's first commit.
func (f *fakeGitHub) seed(files map[string][]byte) {
	tree := map[string]string{}
	for p, data := range files {
		sha := gitBlobSHA(data)
		f.blobs[sha] = data
		tree[p] = sha
	}
	treeSHA := f.sha("tree", fmt.Sprint(len(f.trees)))
	f.trees[treeSHA] = tree
	f.head = f.sha("commit", treeSHA)
	f.commits[f.head] = treeSHA
}

// files is the repo's current content.
func (f *fakeGitHub) files() map[string][]byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	out := map[string][]byte{}
	for p, sha := range f.trees[f.commits[f.head]] {
		out[p] = f.blobs[sha]
	}
	return out
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestPublishEndToEnd(t *testing.T) {
	app := testApp(t)
	fillRounds(t, func(r Round) {
		if err := upsertRound(app.DB(), r); err != nil {
			t.Fatal(err)
		}
	})
	gh := newFakeGitHub(t)
	site := fstest.MapFS{
		"index.html":        {Data: []byte("<html><head></head><body></body></html>")},
		"assets/app.js":     {Data: []byte("app")},
		"themes/ember.css":    {Data: []byte("/* @name Ember */")},
		"data/catalog.json": {Data: []byte("{}")},
	}
	dataDir := t.TempDir()
	var states []PublishState
	var smu sync.Mutex
	pub := NewPublisher(dataDir, site, app.DB, "test", func(s PublishState) {
		smu.Lock()
		states = append(states, s)
		smu.Unlock()
	})
	pub.newGH = func(token string) *GitHub {
		g := NewGitHub(token)
		g.API = gh.srv.URL
		return g
	}
	clock := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	pub.now = func() time.Time { return clock }
	opts := PublishOptions{Repo: "tsum-stats", Devices: DevicesAnonymous, Collection: true, Public: true}

	// Nothing works before signing in, and consent is required.
	if err := pub.Run(opts); err == nil || !strings.Contains(err.Error(), "sign in") {
		t.Fatalf("publishing while signed out: %v", err)
	}

	// Sign in with a pasted token.
	if err := pub.SaveToken("tok-1"); err != nil {
		t.Fatal(err)
	}
	if st := pub.State(); !st.SignedIn || st.Login != "ada" || st.Phase != PhaseIdle {
		t.Fatalf("signed in: %+v", st)
	}
	info, err := os.Stat(filepath.Join(dataDir, "github.json"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("the token file must be readable only by its owner: %v %v", info, err)
	}
	data, _ := json.Marshal(pub.State())
	if strings.Contains(string(data), "tok-1") {
		t.Fatal("the state sent to the page contains the token")
	}

	noConsent := opts
	noConsent.Public = false
	if err := pub.Run(noConsent); err == nil {
		t.Fatal("a publish without confirming it is public was accepted")
	}
	bad := opts
	bad.Repo = "../evil"
	if err := pub.Run(bad); err == nil {
		t.Fatal("a repository name with a slash was accepted")
	}

	publish := func() PublishState {
		t.Helper()
		if err := pub.Run(opts); err != nil {
			t.Fatal(err)
		}
		waitFor(t, "the publish to end", func() bool { p := pub.State().Phase; return p == PhaseDone || p == PhaseError })
		st := pub.State()
		if st.Phase != PhaseDone {
			t.Fatalf("publish failed: %+v", st)
		}
		return st
	}

	// First publish: the repo is created and everything is uploaded in one commit.
	st := publish()
	if st.URL != "https://ada.github.io/tsum-stats/" || st.Rounds != 500 || !st.Result.Committed {
		t.Fatalf("first publish: %+v %+v", st, st.Result)
	}
	files := gh.files()
	for _, p := range []string{"README.md", "index.html", ".nojekyll", "assets/app.js", "themes/ember.css", "data/snapshot/manifest.json",
		"data/snapshot/rounds-2026-08.json", "data/snapshot/rounds-2026-09.json", "data/snapshot/rounds-2026-10.json"} {
		if _, ok := files[p]; !ok {
			t.Errorf("the repo lacks %s", p)
		}
	}
	if !strings.Contains(string(files["index.html"]), "tsum-snapshot") {
		t.Error("the published index.html is not tagged as a snapshot")
	}
	if strings.Contains(string(files["data/snapshot/rounds-2026-09.json"]), "pixel-7") {
		t.Error("a device name reached the public repo")
	}
	if gh.commitPosts != 1 {
		t.Errorf("want one commit, got %d", gh.commitPosts)
	}

	// Publishing the same data at the same time uploads nothing and makes no commit.
	blobs, commits := gh.blobPosts, gh.commitPosts
	st = publish()
	if st.Result.Committed || st.Result.Uploaded != 0 || gh.blobPosts != blobs || gh.commitPosts != commits {
		t.Fatalf("an unchanged publish uploaded: %+v (blobs %d->%d)", st.Result, blobs, gh.blobPosts)
	}

	// A new round in October changes that month's file and the manifest, and nothing else.
	clock = clock.Add(time.Hour)
	if err := upsertRound(app.DB(), Round{ID: "new", PlayedAt: "2026-10-10 10:00:00", Tsum: "mickey", Build: "global", Source: SourceCSV}); err != nil {
		t.Fatal(err)
	}
	st = publish()
	if !st.Result.Committed || st.Result.Uploaded != 2 || gh.commitPosts != commits+1 {
		t.Fatalf("a new round should upload two files in one commit: %+v", st.Result)
	}

	// A month with no rounds any more is removed from the repo.
	if _, err := app.DB().NewQuery("DELETE FROM ts_rounds WHERE played_at < '2026-09-01'").Execute(); err != nil {
		t.Fatal(err)
	}
	st = publish()
	if _, ok := gh.files()["data/snapshot/rounds-2026-08.json"]; ok || st.Result.Removed != 1 {
		t.Fatalf("the empty month should be gone: %+v", st.Result)
	}
	if _, ok := gh.files()["README.md"]; !ok {
		t.Error("the README GitHub made was removed")
	}

	// Signing out forgets the token but keeps the published address.
	if err := pub.Logout(); err != nil {
		t.Fatal(err)
	}
	if st := pub.State(); st.SignedIn || st.URL == "" {
		t.Fatalf("after sign-out: %+v", st)
	}
	if raw, _ := os.ReadFile(filepath.Join(dataDir, "github.json")); strings.Contains(string(raw), "tok-1") {
		t.Fatal("the token is still on disk after signing out")
	}
	smu.Lock()
	defer smu.Unlock()
	if len(states) == 0 {
		t.Error("the page was never told about a change")
	}
}

func TestPublishRefusesARepoThatIsNotOurs(t *testing.T) {
	gh := newFakeGitHub(t)
	gh.repoExists = true
	gh.seed(map[string][]byte{"README.md": []byte("mine"), "src/main.go": []byte("package main")})
	g := NewGitHub("tok-1")
	g.API = gh.srv.URL
	dir := t.TempDir()
	_ = os.WriteFile(filepath.Join(dir, "index.html"), []byte("x"), 0o644)
	_, err := g.Publish(t.Context(), "ada", "tsum-stats", dir, nil)
	if !errors.Is(err, ErrRepoNotOurs) {
		t.Fatalf("want ErrRepoNotOurs, got %v", err)
	}
	if _, ok := gh.files()["src/main.go"]; !ok || gh.commitPosts != 0 {
		t.Fatal("someone else's files were touched")
	}
}

func TestPublishSignInProblems(t *testing.T) {
	gh := newFakeGitHub(t)

	// A token GitHub stopped accepting sends the player back to sign in.
	app := testApp(t)
	pub := NewPublisher(t.TempDir(), fstest.MapFS{"index.html": {Data: []byte("<head></head>")}}, app.DB, "test", nil)
	pub.saved = saved{Token: "stale", Login: "ada"}
	pub.newGH = func(token string) *GitHub {
		x := NewGitHub(token)
		x.API = gh.srv.URL
		return x
	}
	if err := pub.Run(PublishOptions{Repo: "tsum-stats", Devices: DevicesAnonymous, Public: true}); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the publish to fail", func() bool { return pub.State().Phase == PhaseError })
	if st := pub.State(); st.SignedIn || !strings.Contains(st.Error, "Sign in again") {
		t.Fatalf("after a rejected token: %+v", st)
	}

	// A pasted token is checked with GitHub, then kept.
	pub2 := NewPublisher(t.TempDir(), fstest.MapFS{"index.html": {Data: []byte("<head></head>")}}, app.DB, "test", nil)
	pub2.newGH = pub.newGH
	if err := pub2.SaveToken("  "); err == nil {
		t.Fatal("an empty token was accepted")
	}
	if err := pub2.SaveToken("stale"); err == nil || pub2.State().SignedIn {
		t.Fatalf("a token GitHub refuses was kept: %v", err)
	}
	if err := pub2.SaveToken(" tok-1\n"); err != nil {
		t.Fatal(err)
	}
	if st := pub2.State(); !st.SignedIn || st.Login != "ada" {
		t.Fatalf("after pasting a token: %+v", st)
	}
}

func TestPublishCheckFindsADeadToken(t *testing.T) {
	gh := newFakeGitHub(t)
	app := testApp(t)
	site := fstest.MapFS{"index.html": {Data: []byte("<head></head>")}}
	newGH := func(token string) *GitHub {
		x := NewGitHub(token)
		x.API = gh.srv.URL
		return x
	}

	// A good token stays, and the last publish is still offered for an update.
	pub := NewPublisher(t.TempDir(), site, app.DB, "test", nil)
	pub.newGH = newGH
	pub.saved = saved{Token: "tok-1", Login: "ada", URL: "https://ada.github.io/tsum-stats/"}
	if st := pub.Check(); !st.SignedIn || st.Phase != PhaseIdle || st.URL == "" {
		t.Fatalf("a good token: %+v", st)
	}

	// A dead one is forgotten before the player presses Publish; the page's address is kept.
	pub.saved.Token = "stale"
	if st := pub.Check(); st.SignedIn || !strings.Contains(st.Error, "Sign in again") || st.URL == "" {
		t.Fatalf("a dead token: %+v", st)
	}

	// GitHub out of reach is not a dead token.
	pub.saved.Token = "tok-1"
	pub.newGH = func(token string) *GitHub {
		x := newGH(token)
		x.API = "http://127.0.0.1:1"
		return x
	}
	if st := pub.Check(); !st.SignedIn {
		t.Fatalf("an unreachable GitHub signed the player out: %+v", st)
	}

}

// The page listens for each topic the server sends on; a name that differs
// means the page silently never hears it.
func TestPageSubscribesToEveryTopic(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("..", "..", "ui", "src", "App.svelte"))
	if err != nil {
		t.Fatal(err)
	}
	for _, topic := range []string{TopicDevices, TopicRounds, TopicImports, TopicPublish} {
		if !strings.Contains(string(src), "subscribe('"+topic+"'") {
			t.Errorf("App.svelte does not subscribe to %q", topic)
		}
	}
}
