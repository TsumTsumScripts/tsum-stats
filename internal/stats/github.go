package stats

import (
	"bytes"
	"context"
	"crypto/sha1"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

// A small GitHub client: signing in with the device flow (the player types a
// short code on github.com, so no token is ever pasted), and publishing a
// folder to a repo's Pages site as one commit. It uses only the REST API, so
// the player needs neither git nor the gh tool.

const (
	// githubScope lets the token create a public repo and write to it. Nothing
	// more: no private repos, no account settings.
	githubScope = "public_repo"

	// GitHubAPI and GitHubWeb are where the client talks; tests point them at a fake.
	GitHubAPI = "https://api.github.com"
	GitHubWeb = "https://github.com"
)

// GitHub talks to one account with one token.
type GitHub struct {
	API, Web string // base URLs
	ClientID string // of the OAuth app that asks the player to sign in
	Token    string
	HTTP     *http.Client
	// PollEvery, when set, replaces the interval GitHub asks for between sign-in checks (tests).
	PollEvery time.Duration
}

// NewGitHub is a client for github.com.
func NewGitHub(clientID, token string) *GitHub {
	return &GitHub{API: GitHubAPI, Web: GitHubWeb, ClientID: clientID, Token: token, HTTP: &http.Client{Timeout: 60 * time.Second}}
}

// APIError is GitHub's answer to a request that was refused.
type APIError struct {
	Status  int
	Message string
}

func (e *APIError) Error() string { return fmt.Sprintf("GitHub said %d: %s", e.Status, e.Message) }

// ErrSignedOut means the token is no longer accepted: revoked, or expired.
var ErrSignedOut = errors.New("GitHub no longer accepts the saved sign-in")

func (g *GitHub) do(ctx context.Context, method, endpoint string, body, out any) error {
	var rd io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, g.API+endpoint, rd)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", "tsum-stats")
	if g.Token != "" {
		req.Header.Set("Authorization", "Bearer "+g.Token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := g.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 64<<20))
	if res.StatusCode == http.StatusUnauthorized {
		return ErrSignedOut
	}
	if res.StatusCode >= 300 {
		var e struct {
			Message string `json:"message"`
		}
		_ = json.Unmarshal(data, &e)
		if e.Message == "" {
			e.Message = http.StatusText(res.StatusCode)
		}
		return &APIError{Status: res.StatusCode, Message: e.Message}
	}
	if out != nil && len(data) > 0 {
		return json.Unmarshal(data, out)
	}
	return nil
}

// ---- Signing in ----

// DeviceCode is what the player is shown: type UserCode at VerificationURI.
type DeviceCode struct {
	DeviceCode      string `json:"device_code"`
	UserCode        string `json:"user_code"`
	VerificationURI string `json:"verification_uri"`
	ExpiresIn       int    `json:"expires_in"`
	Interval        int    `json:"interval"`
}

func (g *GitHub) form(ctx context.Context, endpoint string, values url.Values, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, g.Web+endpoint, strings.NewReader(values.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", "tsum-stats")
	res, err := g.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode >= 300 {
		return &APIError{Status: res.StatusCode, Message: http.StatusText(res.StatusCode)}
	}
	return json.Unmarshal(data, out)
}

// StartLogin asks GitHub for a code the player can type in.
func (g *GitHub) StartLogin(ctx context.Context) (DeviceCode, error) {
	var dc DeviceCode
	if g.ClientID == "" {
		return dc, errors.New("this build of Tsum Tsum Stats has no GitHub app to sign in with")
	}
	var res struct {
		DeviceCode
		Error string `json:"error"`
		Desc  string `json:"error_description"`
	}
	err := g.form(ctx, "/login/device/code", url.Values{"client_id": {g.ClientID}, "scope": {githubScope}}, &res)
	if err != nil {
		return dc, err
	}
	if res.Error != "" {
		return dc, fmt.Errorf("GitHub refused the sign-in: %s", cmpOr(res.Desc, res.Error))
	}
	if res.Interval < 1 {
		res.Interval = 5
	}
	return res.DeviceCode, nil
}

func cmpOr(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

// WaitForLogin polls until the player has approved the code, and returns the token.
func (g *GitHub) WaitForLogin(ctx context.Context, dc DeviceCode) (string, error) {
	interval := time.Duration(dc.Interval) * time.Second
	if g.PollEvery > 0 {
		interval = g.PollEvery
	}
	deadline := time.Now().Add(time.Duration(dc.ExpiresIn) * time.Second)
	for {
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-time.After(interval):
		}
		if dc.ExpiresIn > 0 && time.Now().After(deadline) {
			return "", errors.New("the code expired before it was entered; start again")
		}
		var res struct {
			AccessToken string `json:"access_token"`
			Error       string `json:"error"`
		}
		err := g.form(ctx, "/login/oauth/access_token", url.Values{
			"client_id": {g.ClientID}, "device_code": {dc.DeviceCode},
			"grant_type": {"urn:ietf:params:oauth:grant-type:device_code"},
		}, &res)
		if err != nil {
			return "", err
		}
		switch res.Error {
		case "":
			if res.AccessToken != "" {
				return res.AccessToken, nil
			}
		case "authorization_pending":
		case "slow_down":
			interval += 5 * time.Second
		case "expired_token":
			return "", errors.New("the code expired before it was entered; start again")
		case "access_denied":
			return "", errors.New("the sign-in was cancelled on GitHub")
		default:
			return "", fmt.Errorf("GitHub refused the sign-in: %s", res.Error)
		}
	}
}

// Login is the signed-in account's name.
func (g *GitHub) Login(ctx context.Context) (string, error) {
	var u struct {
		Login string `json:"login"`
	}
	err := g.do(ctx, http.MethodGet, "/user", nil, &u)
	return u.Login, err
}

// ---- Publishing ----

// protectedPaths are files GitHub adds to a new repo that a publish leaves be.
func protectedPath(p string) bool {
	switch strings.ToLower(p) {
	case "readme.md", "license", "license.md", "cname", ".gitignore":
		return true
	}
	return false
}

// ErrRepoNotOurs is a repo that already exists holding something other than a published snapshot.
var ErrRepoNotOurs = errors.New("that repository already exists and holds something else; choose another name")

// gitBlobSHA is the SHA-1 git gives a file's content, so a file can be
// compared with the repo's copy without downloading it.
func gitBlobSHA(data []byte) string {
	h := sha1.New()
	fmt.Fprintf(h, "blob %d\x00", len(data))
	h.Write(data)
	return hex.EncodeToString(h.Sum(nil))
}

// PublishResult says what a publish did.
type PublishResult struct {
	URL       string `json:"url"`
	Repo      string `json:"repo"`
	Uploaded  int    `json:"uploaded"`
	Removed   int    `json:"removed"`
	Unchanged int    `json:"unchanged"`
	Committed bool   `json:"committed"` // false when the repo already had these files
}

type gitRepo struct {
	DefaultBranch string `json:"default_branch"`
}

type treeEntry struct {
	Path string  `json:"path"`
	Mode string  `json:"mode"`
	Type string  `json:"type"`
	SHA  *string `json:"sha"`
}

// Publish makes the repo's Pages site match dir: the repo is created if it
// is missing, changed files are uploaded, and everything goes in one commit.
// progress is told what is happening, for the page to show.
func (g *GitHub) Publish(ctx context.Context, owner, name, dir string, progress func(string)) (PublishResult, error) {
	res := PublishResult{Repo: owner + "/" + name}
	say := func(s string) {
		if progress != nil {
			progress(s)
		}
	}
	repoPath := "/repos/" + owner + "/" + name

	// The files to publish.
	files := map[string][]byte{}
	err := filepath.WalkDir(dir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		data, err := os.ReadFile(p)
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(dir, p)
		files[filepath.ToSlash(rel)] = data
		return nil
	})
	if err != nil {
		return res, err
	}

	say("Checking the repository")
	var repo gitRepo
	created := false
	err = g.do(ctx, http.MethodGet, repoPath, nil, &repo)
	var apiErr *APIError
	if errors.As(err, &apiErr) && apiErr.Status == http.StatusNotFound {
		say("Creating the repository " + res.Repo)
		err = g.do(ctx, http.MethodPost, "/user/repos", map[string]any{
			"name": name, "description": "Tsum Tsum Stats: my Tsum Tsum statistics",
			"private": false, "auto_init": true,
		}, &repo)
		created = err == nil
	}
	if err != nil {
		return res, err
	}
	if repo.DefaultBranch == "" {
		repo.DefaultBranch = "main"
	}

	// The commit and the tree the repo has now.
	var ref struct {
		Object struct {
			SHA string `json:"sha"`
		} `json:"object"`
	}
	if err := g.do(ctx, http.MethodGet, repoPath+"/git/ref/heads/"+repo.DefaultBranch, nil, &ref); err != nil {
		return res, err
	}
	var commit struct {
		Tree struct {
			SHA string `json:"sha"`
		} `json:"tree"`
	}
	if err := g.do(ctx, http.MethodGet, repoPath+"/git/commits/"+ref.Object.SHA, nil, &commit); err != nil {
		return res, err
	}
	var tree struct {
		Tree      []treeEntry `json:"tree"`
		Truncated bool        `json:"truncated"`
	}
	if err := g.do(ctx, http.MethodGet, repoPath+"/git/trees/"+commit.Tree.SHA+"?recursive=1", nil, &tree); err != nil {
		return res, err
	}
	have := map[string]string{}
	for _, e := range tree.Tree {
		if e.Type == "blob" && e.SHA != nil {
			have[e.Path] = *e.SHA
		}
	}
	// Only a repo made by a publish, or one with nothing in it, may be written over:
	// a publish also removes files, and must never remove someone's other work.
	_, ours := have["data/snapshot/manifest.json"]
	if !created && !ours {
		for p := range have {
			if !protectedPath(p) {
				return res, ErrRepoNotOurs
			}
		}
	}
	if tree.Truncated {
		return res, errors.New("the repository is too large to update in one step")
	}

	// What changed: new or different files, and old files that are gone.
	var upload []string
	for p, data := range files {
		if have[p] != gitBlobSHA(data) {
			upload = append(upload, p)
		}
	}
	sort.Strings(upload)
	var remove []string
	for p := range have {
		if _, ok := files[p]; !ok && !protectedPath(p) {
			remove = append(remove, p)
		}
	}
	sort.Strings(remove)
	res.Uploaded, res.Removed, res.Unchanged = len(upload), len(remove), len(files)-len(upload)

	if len(upload) > 0 || len(remove) > 0 {
		entries := make([]treeEntry, len(upload)+len(remove))
		var (
			mu       sync.Mutex
			done     int
			firstErr error
			wg       sync.WaitGroup
			slots    = make(chan struct{}, 4)
		)
		for i, p := range upload {
			wg.Add(1)
			slots <- struct{}{}
			go func() {
				defer wg.Done()
				defer func() { <-slots }()
				var blob struct {
					SHA string `json:"sha"`
				}
				err := g.do(ctx, http.MethodPost, repoPath+"/git/blobs",
					map[string]string{"content": base64.StdEncoding.EncodeToString(files[p]), "encoding": "base64"}, &blob)
				mu.Lock()
				defer mu.Unlock()
				if err != nil {
					if firstErr == nil {
						firstErr = err
					}
					return
				}
				entries[i] = treeEntry{Path: p, Mode: "100644", Type: "blob", SHA: &blob.SHA}
				done++
				say(fmt.Sprintf("Uploading files (%d of %d)", done, len(upload)))
			}()
		}
		wg.Wait()
		if firstErr != nil {
			return res, firstErr
		}
		for i, p := range remove {
			entries[len(upload)+i] = treeEntry{Path: p, Mode: "100644", Type: "blob"} // a nil sha deletes it
		}

		say("Saving the update")
		var newTree struct {
			SHA string `json:"sha"`
		}
		if err := g.do(ctx, http.MethodPost, repoPath+"/git/trees", map[string]any{"base_tree": commit.Tree.SHA, "tree": entries}, &newTree); err != nil {
			return res, err
		}
		var newCommit struct {
			SHA string `json:"sha"`
		}
		if err := g.do(ctx, http.MethodPost, repoPath+"/git/commits", map[string]any{
			"message": "Update Tsum Tsum Stats", "tree": newTree.SHA, "parents": []string{ref.Object.SHA},
		}, &newCommit); err != nil {
			return res, err
		}
		if err := g.do(ctx, http.MethodPatch, repoPath+"/git/refs/heads/"+repo.DefaultBranch, map[string]any{"sha": newCommit.SHA}, nil); err != nil {
			return res, err
		}
		res.Committed = true
	}

	say("Turning on the web page")
	res.URL, err = g.enablePages(ctx, owner, name, repo.DefaultBranch)
	return res, err
}

// enablePages turns Pages on for the repo, if it is not, and returns its address.
func (g *GitHub) enablePages(ctx context.Context, owner, name, branch string) (string, error) {
	path := "/repos/" + owner + "/" + name + "/pages"
	var pages struct {
		HTMLURL string `json:"html_url"`
	}
	err := g.do(ctx, http.MethodGet, path, nil, &pages)
	var apiErr *APIError
	if errors.As(err, &apiErr) && apiErr.Status == http.StatusNotFound {
		err = g.do(ctx, http.MethodPost, path, map[string]any{"source": map[string]string{"branch": branch, "path": "/"}}, &pages)
		// Another request may have turned it on a moment ago.
		if errors.As(err, &apiErr) && (apiErr.Status == http.StatusConflict || apiErr.Status == http.StatusUnprocessableEntity) {
			err = nil
		}
	}
	if err != nil {
		return "", err
	}
	if pages.HTMLURL != "" {
		return pages.HTMLURL, nil
	}
	if strings.EqualFold(name, owner+".github.io") {
		return "https://" + strings.ToLower(name) + "/", nil
	}
	return "https://" + strings.ToLower(owner) + ".github.io/" + name + "/", nil
}
