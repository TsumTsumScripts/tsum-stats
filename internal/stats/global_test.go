package stats

import (
	"encoding/json"
	"fmt"
	"maps"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"testing/fstest"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
)

// fakeWorker is the global stats site's API (CONTRACT §2) as far as the
// forwarder uses it: joins, uploads, the contributor's record and unlinking.
type fakeWorker struct {
	t   *testing.T
	srv *httptest.Server

	mu       sync.Mutex
	keys     map[string]int64 // live key -> contributor id
	joins    int
	clients  []string     // what each join named itself
	batches  []RoundBatch // every upload taken, in order
	refused  int          // uploads refused
	meCalls  int
	unlinked []string // keys unlinked
	// refuseStatus, when set, refuses uploads once refuseFrom have been taken,
	// with refuseCode and refuseRetry (the Retry-After header).
	refuseFrom   int
	refuseStatus int
	refuseCode   string
	refuseRetry  string
	refuseBody   string         // when set, the refusal is this page, not the Worker's JSON
	rejected     map[string]int // the counts every upload's reply names
	// retry is the round ids an upload's reply names in retry (rejected as future).
	retry map[string]bool
	// hold, when set, keeps each upload waiting until it closes; held hears of each one waiting.
	hold, held chan struct{}
	log        []string // "rounds" and "unlink", as each was answered
}

func newFakeWorker(t *testing.T) *fakeWorker {
	f := &fakeWorker{t: t, keys: map[string]int64{}}
	f.srv = httptest.NewServer(http.HandlerFunc(f.api))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeWorker) reply(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (f *fakeWorker) api(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	hold, held := f.hold, f.held
	f.mu.Unlock()
	if hold != nil && r.URL.Path == "/api/v1/rounds" {
		held <- struct{}{}
		<-hold
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if ua := r.Header.Get("User-Agent"); ua != "tsum-stats/0.25" {
		f.t.Errorf("%s: User-Agent %q", r.URL.Path, ua)
	}
	if r.URL.Path == "/api/v1/join" {
		if r.Method != http.MethodPost || r.Header.Get("Authorization") != "" {
			f.t.Errorf("join: %s with Authorization %q", r.Method, r.Header.Get("Authorization"))
		}
		var body struct {
			Client string `json:"client"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.joins++
		f.clients = append(f.clients, body.Client)
		id := int64(16 + f.joins)
		key := fmt.Sprintf("key-%d-0123456789abcdefghijklmnopqrstuvwxyzABC", id)
		f.keys[key] = id
		f.reply(w, http.StatusCreated, map[string]any{"ok": true, "id": id, "key": key})
		return
	}
	key := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	id, ok := f.keys[key]
	if !ok {
		f.reply(w, http.StatusUnauthorized, map[string]any{"ok": false, "error": "unauthorized"})
		return
	}
	switch {
	case r.URL.Path == "/api/v1/rounds" && r.Method == http.MethodPost:
		var b RoundBatch
		if err := json.NewDecoder(r.Body).Decode(&b); err != nil || b.Schema != RoundStatsSchema || len(b.Records) < 1 || len(b.Records) > 250 {
			f.reply(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "bad-request"})
			return
		}
		if f.refuseStatus != 0 && len(f.batches) >= f.refuseFrom {
			f.refused++
			if f.refuseRetry != "" {
				w.Header().Set("Retry-After", f.refuseRetry)
			}
			if f.refuseBody != "" {
				w.Header().Set("Content-Type", "text/html")
				w.WriteHeader(f.refuseStatus)
				_, _ = w.Write([]byte(f.refuseBody))
				return
			}
			f.reply(w, f.refuseStatus, map[string]any{"ok": false, "error": f.refuseCode})
			return
		}
		f.batches = append(f.batches, b)
		f.log = append(f.log, "rounds")
		rejected := maps.Clone(f.rejected)
		if rejected == nil {
			rejected = map[string]int{}
		}
		retry := []string{}
		for _, rec := range b.Records {
			if f.retry[rec["id"]] {
				retry = append(retry, rec["id"])
			}
		}
		if len(retry) > 0 {
			rejected["future"] += len(retry)
		}
		f.reply(w, http.StatusOK, map[string]any{"ok": true, "accepted": len(b.Records) - len(retry), "unchanged": 0, "duplicates": 0,
			"rejected": rejected, "retry": retry})
	case r.URL.Path == "/api/v1/me" && r.Method == http.MethodGet:
		f.meCalls++
		f.reply(w, http.StatusOK, map[string]any{"ok": true, "id": id, "status": "active", "since": "2026-10-14",
			"lastSeen": nil, "rounds": f.taken(), "duplicates": 0, "devices": 1, "first": nil, "last": nil,
			"today": map[string]int{"rounds": f.taken(), "quota": 5000}})
	case r.URL.Path == "/api/v1/me/unlink" && r.Method == http.MethodPost:
		delete(f.keys, key)
		f.unlinked = append(f.unlinked, key)
		f.log = append(f.log, "unlink")
		f.reply(w, http.StatusOK, map[string]any{"ok": true})
	default:
		f.t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
		f.reply(w, http.StatusNotFound, map[string]any{"ok": false, "error": "not-found"})
	}
}

// taken counts the records uploaded. The caller holds the lock.
func (f *fakeWorker) taken() int {
	n := 0
	for _, b := range f.batches {
		n += len(b.Records)
	}
	return n
}

// sentIDs is the round ids uploaded, in order.
func (f *fakeWorker) sentIDs() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	var ids []string
	for _, b := range f.batches {
		for _, r := range b.Records {
			ids = append(ids, r["id"])
		}
	}
	return ids
}

var globalNow = time.Date(2026, 10, 14, 18, 0, 0, 0, time.UTC)

// globalRound is a complete round played ago before globalNow.
func globalRound(id string, ago time.Duration) Round {
	score, base, final, medals := int64(1250000), int64(800), int64(1600), int64(3)
	d := 72.5
	return Round{ID: id, PlayedAt: globalNow.Add(-ago).Format(sqlTime), Tsum: "mickey", Build: "global", SkillType: "burst",
		ScriptVersion: "4.0b1", Duration: &d, Score: &score, BaseCoins: &base, FinalCoins: &final, Medals: &medals,
		Device: "pixel-7", Source: SourceCSV, Settings: `{"bonusCoin": true, "skillLevel": 4}`}
}

func addRounds(t *testing.T, app core.App, rounds ...Round) {
	t.Helper()
	for _, r := range rounds {
		if err := upsertRound(app.DB(), r); err != nil {
			t.Fatal(err)
		}
	}
}

// testMedalTsums stands for the catalog's medal Tsums.
var testMedalTsums = []string{"mickeyplus"}

// testContributor is a contributor of app's rounds to f, on globalNow's clock.
func testContributor(t *testing.T, app core.App, f *fakeWorker) (*Contributor, string) {
	dir := t.TempDir()
	return contributorIn(dir, app, f.srv.URL), dir
}

// contributorIn is a contributor with its data folder at dir, sending to siteURL.
func contributorIn(dir string, app core.App, siteURL string) *Contributor {
	c := NewContributor(dir, siteURL, testMedalTsums, app.DB, "0.25", nil)
	c.now = func() time.Time { return globalNow }
	c.jitter = func() time.Duration { return 0 }
	return c
}

// runPass runs one pass to its end, as Run's timer would.
func runPass(t *testing.T, c *Contributor) {
	t.Helper()
	c.mu.Lock()
	p, ok := c.begin()
	c.mu.Unlock()
	if !ok {
		t.Fatal("a pass did not start")
	}
	c.upload(p)
}

func TestGlobalRecord(t *testing.T) {
	r := globalRound("0192a-1", time.Hour)
	r.Medals = nil
	r.Settings = `{"useFan": true, "bonusCoin": false, "skillLevel": 3, "linkReach": 0.5, "big": 190, "tiny": 1e-7,
		"bubbleStrategy": "all_mid_chain", "fan": null, "nested": {"a": 1}, "list": [1, 2],
		"tsum": "not-the-tsum", "device": "a-setting-named-device", "": "no column"}`
	rec := GlobalRecord(r)
	want := map[string]string{
		"id": "0192a-1", "datetime": "2026-10-14 17:00:00", "script_version": "4.0b1", "skill_type": "burst",
		"tsum": "mickey", "build": "global", "duration_seconds": "72.5", "score": "1250000", "base_coins": "800",
		"final_coins": "1600", "medals": "",
		"useFan": "T", "bonusCoin": "F", "skillLevel": "3", "linkReach": "0.5", "big": "190", "tiny": "0.0000001",
		"bubbleStrategy": "all_mid_chain",
	}
	if len(rec) != len(want) {
		t.Errorf("record has %d columns, want %d: %v", len(rec), len(want), rec)
	}
	for k, v := range want {
		if rec[k] != v {
			t.Errorf("%s: %q, want %q", k, rec[k], v)
		}
	}
	// Each setting reads back as it was, the way the Worker reads a stats CSV row.
	var settings map[string]any
	_ = json.Unmarshal([]byte(r.Settings), &settings)
	for k, v := range rec {
		if !statsBaseColumns[k] && settingValue(v) != settings[k] {
			t.Errorf("setting %s: %q reads back as %v, was %v", k, v, settingValue(v), settings[k])
		}
	}
	// Settings that are not an object are left out, not an error.
	r.Settings = `[1, 2]`
	if rec := GlobalRecord(r); len(rec) != len(statsBaseColumns) {
		t.Errorf("array settings: %v", rec)
	}

	b := NewRoundBatch([]map[string]string{GlobalRecord(globalRound("0192a-2", time.Hour))}, "tsum-stats/0.25", globalNow)
	data, _ := json.Marshal(b)
	for _, s := range []string{`"schema":"gap.round-stats/1"`, `"script":{"id":"app.gap.Tsum"}`, `"source":"tsum-stats"`,
		`"sentAt":"2026-10-14T18:00:00.000Z"`, `"client":"tsum-stats/0.25"`} {
		if !strings.Contains(string(data), s) {
			t.Errorf("the batch lacks %s: %s", s, data)
		}
	}
	if strings.Contains(string(data), "pixel-7") || strings.Contains(string(data), `"csv"`) {
		t.Errorf("the device or the source reached the batch: %s", data)
	}
}

func TestGlobalSelection(t *testing.T) {
	app := testApp(t)
	mk := func(id string, ago time.Duration, f func(*Round)) Round {
		r := globalRound(id, ago)
		f(&r)
		return r
	}
	addRounds(t, app,
		mk("a-complete", time.Hour, func(*Round) {}),
		mk("b-incomplete", time.Hour, func(r *Round) { r.Score = nil }),
		mk("c-no-build", time.Hour, func(r *Round) { r.Build = "" }),
		mk("d-jp-setting", time.Hour, func(r *Round) { r.Build, r.Settings = "", `{"jpVersion": true}` }),
		mk("e-jp-not-a-switch", time.Hour, func(r *Round) { r.Build, r.Settings = "", `{"jpVersion": "yes"}` }),
		mk("f-too-new", 10*time.Minute, func(*Round) {}),
		mk("g-settled", 21*time.Minute, func(*Round) {}),
		mk("h-too-old", 61*24*time.Hour, func(*Round) {}),
		mk("i-in-window", 59*24*time.Hour, func(*Round) {}),
		// mickey earns medals, so its round without a medal figure is incomplete; stitch never does.
		mk("j-medals-unread", time.Hour, func(r *Round) { r.Medals = nil }),
		mk("k-no-medal-tsum", time.Hour, func(r *Round) { r.Tsum, r.Medals = "stitch", nil }),
		mk("l-unknown-tsum", time.Hour, func(r *Round) { r.Tsum = "" }),
		// The catalog's medal Tsum with no medal figure, which the global site turns
		// away, waits; read as 0 it goes.
		mk("m-catalog-medals-unread", time.Hour, func(r *Round) { r.Tsum, r.Medals = "mickeyplus", nil }),
		mk("n-catalog-medals-read", time.Hour, func(r *Round) { r.Tsum, *r.Medals = "mickeyplus", 0 }),
		// A Tsum newer than the catalog goes: the global site keeps it until a deploy knows it.
		mk("o-tsum-not-in-catalog", time.Hour, func(r *Round) { r.Tsum, r.Medals = "newtsum", nil }),
	)
	batches, err := GlobalBatches(app.DB(), globalNow, "tsum-stats/0.25", testMedalTsums)
	if err != nil {
		t.Fatal(err)
	}
	var ids []string
	for _, b := range batches {
		for _, r := range b.Records {
			ids = append(ids, r["id"])
		}
	}
	slices.Sort(ids)
	want := []string{"a-complete", "d-jp-setting", "g-settled", "i-in-window", "k-no-medal-tsum", "n-catalog-medals-read", "o-tsum-not-in-catalog"}
	if !slices.Equal(ids, want) {
		t.Fatalf("picked %v, want %v", ids, want)
	}
	medals := `["mickeyplus"]`
	if n, err := countGlobalPending(app.DB(), globalNow, medals, nil); err != nil || n != len(want) {
		t.Fatalf("pending: %d %v", n, err)
	}
	// With no catalog, only the rounds here judge a medal Tsum.
	if n, err := countGlobalPending(app.DB(), globalNow, "[]", nil); err != nil || n != len(want)+1 {
		t.Fatalf("pending with no catalog: %d %v", n, err)
	}
	// The memo counts the same, and forgets rounds that leave the window.
	memo := &globalMemo{seen: map[string]memoEntry{}}
	for range 2 {
		if n, err := countGlobalPending(app.DB(), globalNow, medals, memo); err != nil || n != len(want) || len(memo.seen) != len(want) {
			t.Fatalf("pending with a memo: %d %v, %d remembered", n, err, len(memo.seen))
		}
	}
	if n, _ := countGlobalPending(app.DB(), globalNow.Add(62*24*time.Hour), medals, memo); n != 0 || len(memo.seen) != 0 {
		t.Fatalf("after the window moved on: %d pending, %d remembered", n, len(memo.seen))
	}
	// The build stays as it was; the Worker takes it from the setting.
	for _, b := range batches {
		for _, r := range b.Records {
			if r["id"] == "d-jp-setting" && (r["build"] != "" || r["jpVersion"] != "T") {
				t.Errorf("jp by setting: %v", r)
			}
		}
	}
}

func TestCatalogMedalTsums(t *testing.T) {
	site := fstest.MapFS{"data/catalog.json": {Data: []byte(`{"tsums": [{"id": "mickey"}, {"id": "mickeyplus", "medal": true},
		{"id": "stitch", "medal": false}]}`)}}
	if got := CatalogMedalTsums(site); !slices.Equal(got, []string{"mickeyplus"}) {
		t.Fatalf("medal Tsums %v", got)
	}
	if got := CatalogMedalTsums(fstest.MapFS{}); got != nil {
		t.Fatalf("with no catalog: %v", got)
	}
	// The catalog the site is built with (and the Worker bundles).
	if got := CatalogMedalTsums(os.DirFS("../../ui/public")); len(got) < 20 || !slices.Contains(got, "mickeyplus") {
		t.Fatalf("the catalog's medal Tsums: %v", got)
	}
}

func TestGlobalJoin(t *testing.T) {
	app := testApp(t)
	f := newFakeWorker(t)
	c, dir := testContributor(t, app, f)
	if c.State().Joined {
		t.Fatal("joined before joining")
	}
	if err := c.UploadNow(); err == nil {
		t.Fatal("an upload before joining was accepted")
	}
	if err := c.Join(); err != nil {
		t.Fatal(err)
	}
	st := c.State()
	if !st.Joined || !st.Enabled || st.ID != 17 || st.Me == nil || st.Me.ID != 17 || st.URL != f.srv.URL {
		t.Fatalf("after joining: %+v", st)
	}
	if f.clients[0] != "tsum-stats/0.25" {
		t.Errorf("the join named itself %q", f.clients[0])
	}
	info, err := os.Stat(filepath.Join(dir, "global.json"))
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("global.json must be readable only by its owner: %v %v", info, err)
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "global.json"))
	var saved globalSaved
	if json.Unmarshal(raw, &saved) != nil || saved.Key == "" || saved.URL != f.srv.URL || !saved.Enabled || saved.JoinedAt == "" {
		t.Fatalf("global.json: %s", raw)
	}
	data, _ := json.Marshal(c.State())
	if strings.Contains(string(data), saved.Key) || strings.Contains(string(data), `"key"`) {
		t.Fatal("the state sent to the page contains the key")
	}
	// The first pass is scheduled, a little after the join.
	select {
	case d := <-c.wake:
		if d != c.first {
			t.Errorf("first pass in %v, want %v", d, c.first)
		}
	default:
		t.Error("joining scheduled no pass")
	}

	// Joining again changes nothing.
	if err := c.Join(); err != nil || f.joins != 1 {
		t.Fatalf("a second join: %v, %d joins", err, f.joins)
	}

	// The key is kept between starts, and only for the site it came from.
	if st := NewContributor(dir, f.srv.URL, nil, app.DB, "0.25", nil).State(); !st.Joined || st.ID != 17 {
		t.Fatalf("after a restart: %+v", st)
	}
	other := NewContributor(dir, "http://127.0.0.1:1", nil, app.DB, "0.25", nil)
	if st := other.State(); st.Joined || st.Enabled {
		t.Fatalf("the key was offered to another site: %+v", st)
	}
	if _, ok := other.begin(); ok {
		t.Fatal("a pass started for another site's key")
	}

	for _, u := range []string{"", "http://example.com", "ftp://127.0.0.1", "not a url"} {
		if checkGlobalURL(u) == nil {
			t.Errorf("--global-url %q was accepted", u)
		}
	}
	for _, u := range []string{DefaultGlobalURL, "http://127.0.0.1:8788", "http://localhost:8788"} {
		if err := checkGlobalURL(u); err != nil {
			t.Errorf("--global-url %q: %v", u, err)
		}
	}
}

func TestGlobalBatchesOldestFirst(t *testing.T) {
	app := testApp(t)
	f := newFakeWorker(t)
	c, _ := testContributor(t, app, f)
	if err := c.Join(); err != nil {
		t.Fatal(err)
	}
	// 600 rounds stored newest first, pairs of them in the same second.
	var want []string
	for i := 599; i >= 0; i-- {
		addRounds(t, app, globalRound(fmt.Sprintf("r%03d", i), time.Duration(600-i/2)*time.Minute))
	}
	for i := range 600 {
		want = append(want, fmt.Sprintf("r%03d", i))
	}
	if st := c.Refresh(); st.Pending != 600 {
		t.Fatalf("pending before: %d", st.Pending)
	}
	runPass(t, c)
	if got := f.sentIDs(); !slices.Equal(got, want) {
		t.Fatalf("not oldest first: %v", got)
	}
	var sizes []int
	for _, b := range f.batches {
		sizes = append(sizes, len(b.Records))
		if b.Client != "tsum-stats/0.25" || b.Source != "tsum-stats" {
			t.Errorf("batch: %+v", b)
		}
	}
	// 100 a batch keeps the Worker's CPU for one well under Workers Free's 10 ms.
	if !slices.Equal(sizes, []int{100, 100, 100, 100, 100, 100}) {
		t.Fatalf("batch sizes %v", sizes)
	}
	st := c.State()
	if st.Sent != 600 || st.Pending != 0 || st.LastUpload == "" || st.LastError != "" || st.Running || st.Me.Rounds != 600 {
		t.Fatalf("after the pass: %+v", st)
	}
	var n int
	_ = app.DB().NewQuery("SELECT COUNT(*) FROM ts_global_sent").Row(&n)
	if n != 600 {
		t.Fatalf("%d rows recorded as sent", n)
	}

	// Nothing new, nothing sent.
	runPass(t, c)
	if len(f.batches) != 6 {
		t.Fatalf("an unchanged pass uploaded: %d batches", len(f.batches))
	}
}

func TestGlobalResendsOnlyChangedRounds(t *testing.T) {
	app := testApp(t)
	f := newFakeWorker(t)
	// Rejected rows are taken as sent too: ok: true means "do not send these again".
	f.rejected = map[string]int{"pace": 2}
	c, _ := testContributor(t, app, f)
	if err := c.Join(); err != nil {
		t.Fatal(err)
	}
	addRounds(t, app, globalRound("a", 3*time.Hour), globalRound("b", 2*time.Hour), globalRound("c", time.Hour))
	runPass(t, c)
	if st := c.Refresh(); st.Pending != 0 || st.Sent != 3 {
		t.Fatalf("after the first pass: %+v", st)
	}

	// The device is not in the record, so a change to it sends nothing.
	if _, err := app.DB().NewQuery("UPDATE ts_rounds SET device = 'tab-s8', source = 'event' WHERE round_id = 'a'").Execute(); err != nil {
		t.Fatal(err)
	}
	// A changed figure or setting does.
	b := globalRound("b", 2*time.Hour)
	*b.FinalCoins = 1700
	cr := globalRound("c", time.Hour)
	cr.Settings = `{"bonusCoin": true, "skillLevel": 5}`
	addRounds(t, app, b, cr)
	if st := c.Refresh(); st.Pending != 2 {
		t.Fatalf("pending after changes: %d", st.Pending)
	}
	runPass(t, c)
	got := f.sentIDs()
	if !slices.Equal(got, []string{"a", "b", "c", "b", "c"}) {
		t.Fatalf("sent %v", got)
	}
	last := f.batches[len(f.batches)-1].Records
	if last[0]["final_coins"] != "1700" || last[1]["skillLevel"] != "5" {
		t.Fatalf("the re-sent records: %v", last)
	}
	if st := c.State(); st.Pending != 0 || st.Sent != 5 {
		t.Fatalf("after the second pass: %+v", st)
	}
}

func TestGlobalRetryAfter(t *testing.T) {
	app := testApp(t)
	f := newFakeWorker(t)
	c, _ := testContributor(t, app, f)
	clock := globalNow
	c.now = func() time.Time { return clock }
	if err := c.Join(); err != nil {
		t.Fatal(err)
	}
	for i := range 600 {
		addRounds(t, app, globalRound(fmt.Sprintf("r%03d", i), time.Duration(700-i)*time.Minute))
	}

	// The quota: one batch is taken, the next refused, and the pass stops there.
	f.refuseFrom, f.refuseStatus, f.refuseCode, f.refuseRetry = 1, 429, "quota", "3600"
	runPass(t, c)
	st := c.State()
	if len(f.batches) != 1 || f.refused != 1 || st.Sent != 100 || st.LastError != "" {
		t.Fatalf("after the quota: %d taken, %d refused, %+v", len(f.batches), f.refused, st)
	}
	if st.RetryAt != clock.Add(time.Hour).Format(time.RFC3339) {
		t.Fatalf("retryAt %q", st.RetryAt)
	}
	if err := c.UploadNow(); err == nil || !strings.Contains(err.Error(), "wait") {
		t.Fatalf("Upload now while asked to wait: %v", err)
	}
	if d := c.untilNext(); d < time.Hour {
		t.Fatalf("the next pass comes before retryAt: %v", d)
	}
	// A pass while asked to wait fetches the totals and sends nothing.
	clock = clock.Add(30 * time.Minute)
	me := f.meCalls
	runPass(t, c)
	if f.refused != 1 || len(f.batches) != 1 || f.meCalls != me+1 {
		t.Fatalf("a pass while waiting: %d refused, %d taken, %d me", f.refused, len(f.batches), f.meCalls)
	}

	// The day's budget, past the quota's wait: one more taken, then 503.
	clock = clock.Add(2 * time.Hour)
	f.refuseFrom, f.refuseStatus, f.refuseCode, f.refuseRetry = 2, 503, "budget", "120"
	runPass(t, c)
	st = c.State()
	if len(f.batches) != 2 || f.refused != 2 || st.Sent != 200 || st.RetryAt != clock.Add(2*time.Minute).Format(time.RFC3339) {
		t.Fatalf("after the budget: %d taken, %+v", len(f.batches), st)
	}

	// Once the wait is over the rest goes, from where it stopped.
	clock = clock.Add(5 * time.Minute)
	f.refuseStatus = 0
	if err := c.UploadNow(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the upload", func() bool { return !c.State().Running })
	st = c.State()
	if st.Sent != 600 || st.RetryAt != "" || st.Pending != 0 {
		t.Fatalf("after the wait: %+v", st)
	}
	if ids := f.sentIDs(); len(ids) != 600 || ids[200] != "r200" || ids[599] != "r599" {
		t.Fatalf("sent %d rounds, from %v", len(ids), ids[200])
	}

	// Anything else is an error for the page, and the next hourly pass tries again.
	addRounds(t, app, globalRound("late", time.Hour))
	f.refuseFrom, f.refuseStatus, f.refuseCode, f.refuseRetry = len(f.batches), 400, "bad-request", ""
	runPass(t, c)
	if st := c.State(); !strings.Contains(st.LastError, "400 bad-request") || st.RetryAt != "" || !st.Enabled {
		t.Fatalf("after a 400: %+v", st)
	}
}

// Only the Worker's own daily limits, by their codes, make the forwarder wait.
// Any other refusal, such as the platform's page for a request over its CPU
// limit, is an error for the page, and the next hourly pass tries again.
func TestGlobalRefusalCodes(t *testing.T) {
	for _, r := range []struct {
		status int
		code   string
		wait   bool
	}{
		{429, "quota", true}, {429, "join-limit", true}, {503, "budget", true},
		{429, "Too Many Requests", false}, {503, "Service Unavailable", false}, {503, "quota", false},
		{429, "budget", false}, {500, "internal", false}, {400, "bad-request", false},
	} {
		if got := (&GlobalError{Status: r.status, Code: r.code}).wait(); got != r.wait {
			t.Errorf("%d %s: wait %v, want %v", r.status, r.code, got, r.wait)
		}
	}

	app := testApp(t)
	f := newFakeWorker(t)
	c, _ := testContributor(t, app, f)
	if err := c.Join(); err != nil {
		t.Fatal(err)
	}
	addRounds(t, app, globalRound("a", 2*time.Hour), globalRound("b", time.Hour))
	page := "<!DOCTYPE html><title>Worker exceeded resource limits</title>"
	for _, r := range []struct {
		status            int
		code, body, retry string
	}{
		{503, "", page, "3600"}, // the platform's page, not the Worker's budget
		{429, "", page, "60"},   // a rate limit in front of the Worker
		{429, "slow-down", "", "60"},
		{500, "internal", "", ""},
		{502, "", "Bad Gateway", ""},
		{401, "", page, ""}, // not the Worker's 401: the key is kept
		{200, "", page, ""}, // a page in the way of the answer
	} {
		f.refuseFrom, f.refuseStatus, f.refuseCode, f.refuseBody, f.refuseRetry = 0, r.status, r.code, r.body, r.retry
		runPass(t, c)
		st := c.State()
		if !strings.Contains(st.LastError, fmt.Sprint(r.status)) || st.RetryAt != "" || !st.Joined || !st.Enabled || st.ID != 17 {
			t.Fatalf("after %d %q: %+v", r.status, r.code, st)
		}
		if c.waiting() || c.untilNext() != c.interval || st.Pending != 2 || st.Sent != 0 {
			t.Fatalf("after %d %q: waiting %v, next pass in %v, %+v", r.status, r.code, c.waiting(), c.untilNext(), st)
		}
	}
	// The Worker's own answers still count: its budget waits, and its 401 forgets the key.
	f.refuseStatus, f.refuseCode, f.refuseBody, f.refuseRetry = 503, "budget", "", "600"
	runPass(t, c)
	if st := c.State(); st.LastError != "" || st.RetryAt != globalNow.Add(10*time.Minute).Format(time.RFC3339) {
		t.Fatalf("after the budget: %+v", st)
	}
	c.saved.RetryAt = ""
	f.refuseStatus, f.refuseCode = 401, "unauthorized"
	runPass(t, c)
	if st := c.State(); st.Joined || !strings.Contains(st.LastError, "Join again") {
		t.Fatalf("after the Worker's 401: %+v", st)
	}
	if len(f.batches) != 0 {
		t.Fatalf("%d batches were taken", len(f.batches))
	}
}

// A join refused for one of the Worker's daily limits says which, and when to try again.
func TestGlobalJoinError(t *testing.T) {
	for _, r := range []struct {
		status     int
		code, want string
	}{
		{429, "join-limit", "a few joins a day"}, {503, "budget", "after 00:00 UTC"},
		{503, "Service Unavailable", "could not join the global stats: the global site said 503"}, {429, "budget", "could not join"},
	} {
		if got := joinError(&GlobalError{Status: r.status, Code: r.code}).Error(); !strings.Contains(got, r.want) {
			t.Errorf("%d %s: %q", r.status, r.code, got)
		}
	}
}

// Rounds the global site turns away for a reason that can pass, which its
// reply names in retry, are not taken as sent: later passes send them again
// until they go. A Tsum the catalog does not know yet is sent like any other.
func TestGlobalRetriesWhatCanPass(t *testing.T) {
	app := testApp(t)
	f := newFakeWorker(t)
	c, _ := testContributor(t, app, f)
	if err := c.Join(); err != nil {
		t.Fatal(err)
	}
	b := globalRound("b", 2*time.Hour)
	b.Tsum, b.Medals = "newtsum", nil
	addRounds(t, app, globalRound("a", 3*time.Hour), b, globalRound("c", time.Hour))
	f.retry = map[string]bool{"b": true} // say, this computer's clock is ahead of the site's
	sent := func() []string {
		var ids []string
		_ = app.DB().NewQuery("SELECT round_id FROM ts_global_sent ORDER BY round_id").Column(&ids)
		return ids
	}

	runPass(t, c)
	if got := f.sentIDs(); !slices.Equal(got, []string{"a", "b", "c"}) {
		t.Fatalf("sent %v", got)
	}
	if st := c.State(); !slices.Equal(sent(), []string{"a", "c"}) || st.Sent != 2 || st.Pending != 1 || st.LastError != "" {
		t.Fatalf("after the first pass: recorded %v, %+v", sent(), st)
	}
	// Every pass offers it again, and only it.
	runPass(t, c)
	if got := f.sentIDs(); !slices.Equal(got, []string{"a", "b", "c", "b"}) || c.State().Pending != 1 {
		t.Fatalf("after the second pass: sent %v, %+v", got, c.State())
	}
	// Once the site takes it, it is sent.
	f.retry = nil
	runPass(t, c)
	if st := c.State(); !slices.Equal(sent(), []string{"a", "b", "c"}) || st.Sent != 3 || st.Pending != 0 {
		t.Fatalf("after it went: recorded %v, %+v", sent(), st)
	}
	runPass(t, c)
	if got := f.sentIDs(); len(got) != 5 {
		t.Fatalf("sent again after it went: %v", got)
	}
	// Ids the reply names that the batch lacks change nothing.
	batch := []pendingRound{{id: "a"}, {id: "b"}}
	if got := takenRows(batch, []string{"zz"}); len(got) != 2 {
		t.Fatalf("taken %v", got)
	}
}

func TestGlobalForgetsARefusedKey(t *testing.T) {
	app := testApp(t)
	f := newFakeWorker(t)
	c, dir := testContributor(t, app, f)
	if err := c.Join(); err != nil {
		t.Fatal(err)
	}
	addRounds(t, app, globalRound("a", time.Hour))
	f.mu.Lock()
	clear(f.keys) // unlinked from somewhere else, or lost on the site's side
	f.mu.Unlock()
	runPass(t, c)
	st := c.State()
	if st.Joined || st.Enabled || !strings.Contains(st.LastError, "Join again") {
		t.Fatalf("after a refused key: %+v", st)
	}
	if raw, _ := os.ReadFile(filepath.Join(dir, "global.json")); strings.Contains(string(raw), "key-17") {
		t.Fatal("the refused key is still on disk")
	}
	// Joining again makes a new contributor.
	if err := c.Join(); err != nil || f.joins != 2 || c.State().ID != 18 || c.State().LastError != "" {
		t.Fatalf("joining again: %v %+v", err, c.State())
	}
}

func TestGlobalLeave(t *testing.T) {
	app := testApp(t)
	f := newFakeWorker(t)
	c, dir := testContributor(t, app, f)
	if err := c.Join(); err != nil {
		t.Fatal(err)
	}
	addRounds(t, app, globalRound("a", time.Hour))

	// Stopping keeps the key, so joining again resumes as the same contributor.
	if err := c.Leave(false); err != nil {
		t.Fatal(err)
	}
	if st := c.State(); st.Enabled || !st.Joined || st.ID != 17 {
		t.Fatalf("after stopping: %+v", st)
	}
	if _, ok := c.begin(); ok {
		t.Fatal("a pass started after stopping")
	}
	if err := c.UploadNow(); err == nil {
		t.Fatal("Upload now after stopping was accepted")
	}
	if len(f.unlinked) != 0 {
		t.Fatal("stopping unlinked")
	}
	if err := c.Join(); err != nil || f.joins != 1 || !c.State().Enabled || c.State().ID != 17 {
		t.Fatalf("resuming: %v, %d joins, %+v", err, f.joins, c.State())
	}

	// Stopping and unlinking asks the site, then forgets the key.
	if err := c.Leave(true); err != nil {
		t.Fatal(err)
	}
	if len(f.unlinked) != 1 || !strings.HasPrefix(f.unlinked[0], "key-17") {
		t.Fatalf("unlinked %v", f.unlinked)
	}
	if st := c.State(); st.Joined || st.Enabled || st.Me != nil || st.Sent != 0 {
		t.Fatalf("after unlinking: %+v", st)
	}
	if raw, _ := os.ReadFile(filepath.Join(dir, "global.json")); strings.Contains(string(raw), "key-17") {
		t.Fatal("the key is still on disk after unlinking")
	}
	if len(f.batches) != 0 {
		t.Fatal("rounds were sent")
	}

	// A site out of reach leaves the key, so unlinking can be tried again.
	if err := c.Join(); err != nil {
		t.Fatal(err)
	}
	c.url = "http://127.0.0.1:1"
	c.saved.URL = c.url
	if err := c.Leave(true); err == nil || !strings.Contains(err.Error(), "try again") {
		t.Fatalf("unlinking with the site out of reach: %v", err)
	}
	if st := c.State(); !st.Joined || st.Enabled {
		t.Fatalf("after a failed unlink: %+v", st)
	}
}

// A pass started before the player left stops at its next batch and changes nothing.
func TestGlobalLeaveDuringAPass(t *testing.T) {
	app := testApp(t)
	f := newFakeWorker(t)
	c, _ := testContributor(t, app, f)
	if err := c.Join(); err != nil {
		t.Fatal(err)
	}
	for i := range 300 {
		addRounds(t, app, globalRound(fmt.Sprintf("r%03d", i), time.Duration(400-i)*time.Minute))
	}
	c.mu.Lock()
	p, _ := c.begin()
	c.mu.Unlock()
	if err := c.Leave(false); err != nil {
		t.Fatal(err)
	}
	// Resuming while the old pass is still ending is allowed; that pass still changes nothing.
	if err := c.Join(); err != nil || !c.State().Enabled {
		t.Fatalf("resuming during a pass: %v %+v", err, c.State())
	}
	c.upload(p)
	if st := c.State(); len(f.batches) != 0 || st.Sent != 0 || st.Running || !st.Enabled {
		t.Fatalf("a pass went on after leaving: %d batches, %+v", len(f.batches), st)
	}
	// Rescheduling never blocks, and the latest wait wins.
	c.schedule(time.Second)
	c.schedule(2 * time.Second)
	if d := <-c.wake; d != 2*time.Second {
		t.Fatalf("scheduled %v", d)
	}
}

// Unlinking during a pass waits for the batch in flight to be answered, and
// the pass sends no other: the site never takes a batch after the unlink.
func TestGlobalUnlinkWaitsForTheBatchInFlight(t *testing.T) {
	app := testApp(t)
	f := newFakeWorker(t)
	c, dir := testContributor(t, app, f)
	if err := c.Join(); err != nil {
		t.Fatal(err)
	}
	for i := range 150 {
		addRounds(t, app, globalRound(fmt.Sprintf("r%03d", i), time.Duration(300-i)*time.Minute))
	}
	f.mu.Lock()
	f.hold, f.held = make(chan struct{}), make(chan struct{}, 4)
	f.mu.Unlock()
	release := sync.OnceFunc(func() { close(f.hold) })
	defer release() // a failure must not leave the site's server waiting
	c.mu.Lock()
	p, _ := c.begin()
	c.mu.Unlock()
	passed := make(chan struct{})
	go func() {
		c.upload(p)
		close(passed)
	}()
	<-f.held // the first batch is at the site

	left := make(chan error, 1)
	go func() { left <- c.Leave(true) }()
	waitFor(t, "the stop", func() bool { return !c.State().Enabled })
	select {
	case err := <-left:
		t.Fatalf("unlinked with a batch in flight: %v", err)
	case <-time.After(150 * time.Millisecond):
	}
	// Meanwhile neither a pass nor a join starts.
	if err := c.Join(); err == nil {
		t.Fatal("a join while unlinking was accepted")
	}
	c.mu.Lock()
	_, ok := c.begin()
	c.mu.Unlock()
	if ok {
		t.Fatal("a pass started while unlinking")
	}
	release()
	if err := <-left; err != nil {
		t.Fatal(err)
	}
	<-passed
	f.mu.Lock()
	log := slices.Clone(f.log)
	f.mu.Unlock()
	if !slices.Equal(log, []string{"rounds", "unlink"}) || len(f.batches) != 1 {
		t.Fatalf("the site saw %v, %d batches", log, len(f.batches))
	}
	if st := c.State(); st.Joined || st.Running {
		t.Fatalf("after unlinking: %+v", st)
	}
	if raw, _ := os.ReadFile(filepath.Join(dir, "global.json")); strings.Contains(string(raw), "key-17") {
		t.Fatal("the key is still on disk after unlinking")
	}
}

// A data folder contributes to one site. Another site's join never replaces
// the saved key, which is the only way to unlink the rounds sent with it, and
// uploads to one site never count as sent to another.
func TestGlobalOneSitePerDataFolder(t *testing.T) {
	app := testApp(t)
	f := newFakeWorker(t)
	c, dir := testContributor(t, app, f)
	if err := c.Join(); err != nil {
		t.Fatal(err)
	}
	addRounds(t, app, globalRound("a", 2*time.Hour), globalRound("b", time.Hour))
	runPass(t, c)
	if len(f.sentIDs()) != 2 {
		t.Fatalf("the first site got %v", f.sentIDs())
	}
	// That site's error is not another's to show.
	c.mu.Lock()
	c.saved.LastError = "The last upload did not go through"
	_ = c.persist()
	c.mu.Unlock()

	// A test site on the same data folder.
	test := newFakeWorker(t)
	other := contributorIn(dir, app, test.srv.URL)
	if st := other.State(); st.Joined || st.LastError != "" {
		t.Fatalf("the test site sees the first one's record: %+v", st)
	}
	err := other.Join()
	if err == nil || !strings.Contains(err.Error(), f.srv.URL) || !strings.Contains(err.Error(), "--dir") || test.joins != 0 {
		t.Fatalf("joining a second site: %v, %d joins", err, test.joins)
	}
	if err := other.Leave(false); err != nil {
		t.Fatal(err)
	}
	if err := other.Leave(true); err != nil || len(test.unlinked)+len(f.unlinked) != 0 {
		t.Fatalf("leaving the test site: %v", err)
	}
	// The first site's key is as it was.
	if st := contributorIn(dir, app, f.srv.URL).State(); !st.Joined || !st.Enabled || st.ID != 17 {
		t.Fatalf("back on the first site: %+v", st)
	}

	// Once unlinked there, the test site may be joined, and gets every round.
	if err := c.Leave(true); err != nil {
		t.Fatal(err)
	}
	other = contributorIn(dir, app, test.srv.URL)
	if err := other.Join(); err != nil {
		t.Fatal(err)
	}
	if st := other.State(); !st.Joined || st.Pending != 2 {
		t.Fatalf("joined the test site: %+v", st)
	}
	runPass(t, other)
	if got := test.sentIDs(); !slices.Equal(got, []string{"a", "b"}) {
		t.Fatalf("the test site got %v", got)
	}
	// And the first site is now the other one.
	if err := contributorIn(dir, app, f.srv.URL).Join(); err == nil || !strings.Contains(err.Error(), test.srv.URL) {
		t.Fatalf("joining the first site again: %v", err)
	}
	// Joining the same site again after unlinking keeps what was sent.
	if err := other.Leave(true); err != nil {
		t.Fatal(err)
	}
	if err := other.Join(); err != nil || other.Refresh().Pending != 0 || test.joins != 2 {
		t.Fatalf("joining the test site again: %v %+v", err, other.State())
	}
}

func TestGlobalRunSchedulesPasses(t *testing.T) {
	app := testApp(t)
	f := newFakeWorker(t)
	c, _ := testContributor(t, app, f)
	if err := c.Join(); err != nil {
		t.Fatal(err)
	}
	addRounds(t, app, globalRound("a", time.Hour))
	c.first = 10 * time.Millisecond
	<-c.wake // the join's, made before first was shortened
	var states []GlobalState
	var smu sync.Mutex
	c.notify = func(s GlobalState) {
		smu.Lock()
		states = append(states, s)
		smu.Unlock()
	}
	stop := make(chan struct{})
	defer close(stop)
	go c.Run(stop)
	waitFor(t, "the first pass", func() bool { return len(f.sentIDs()) == 1 && !c.State().Running })
	smu.Lock()
	defer smu.Unlock()
	if len(states) < 2 || !states[0].Running || states[len(states)-1].Running {
		t.Fatalf("the page was not told the pass ran: %+v", states)
	}
}

func TestGlobalRoutes(t *testing.T) {
	app := testApp(t)
	f := newFakeWorker(t)
	c, _ := testContributor(t, app, f)
	addRounds(t, app, globalRound("a", time.Hour))
	r := router.NewRouter(func(w http.ResponseWriter, r *http.Request) (*core.RequestEvent, router.EventCleanupFunc) {
		e := new(core.RequestEvent)
		e.Response, e.Request, e.App = w, r, app
		return e, nil
	})
	registerGlobalRoutes(r.Group("/api/stats"), c)
	mux, err := r.BuildMux()
	if err != nil {
		t.Fatal(err)
	}
	do := func(method, path, origin, body string) (int, string) {
		req := httptest.NewRequest(method, "http://127.0.0.1:8090"+path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, req)
		return w.Code, w.Body.String()
	}

	// Another site's page in the browser cannot join, upload or leave.
	for _, p := range []string{"/api/stats/global/join", "/api/stats/global/run", "/api/stats/global/leave"} {
		if code, _ := do("POST", p, "http://evil.example", `{"unlink": true}`); code != http.StatusForbidden {
			t.Errorf("cross-origin POST %s: %d", p, code)
		}
	}
	if f.joins != 0 {
		t.Fatal("a cross-origin join went through")
	}

	code, body := do("GET", "/api/stats/global", "", "")
	if code != 200 || !strings.Contains(body, `"pending":1`) || !strings.Contains(body, `"joined":false`) {
		t.Fatalf("GET: %d %s", code, body)
	}
	code, body = do("POST", "/api/stats/global/join", "http://127.0.0.1:8090", "")
	if code != 200 || !strings.Contains(body, `"joined":true`) || strings.Contains(body, "key-17") {
		t.Fatalf("join: %d %s", code, body)
	}
	if code, body = do("POST", "/api/stats/global/run", "", ""); code != 200 {
		t.Fatalf("run: %d %s", code, body)
	}
	waitFor(t, "the upload", func() bool { return !c.State().Running })
	if code, body = do("POST", "/api/stats/global/run", "", ""); code != 200 {
		t.Fatalf("a second run: %d %s", code, body)
	}
	waitFor(t, "the upload", func() bool { return !c.State().Running })
	code, body = do("POST", "/api/stats/global/leave", "", `{"unlink": false}`)
	if code != 200 || !strings.Contains(body, `"enabled":false`) || len(f.unlinked) != 0 {
		t.Fatalf("leave: %d %s", code, body)
	}
	if code, _ = do("POST", "/api/stats/global/run", "", ""); code != http.StatusBadRequest {
		t.Fatalf("run after leaving: %d", code)
	}
	if len(f.sentIDs()) != 1 {
		t.Fatalf("sent %v", f.sentIDs())
	}
}

// dialogCheck compiles the Contribute dialog and runs its module script's
// tickUntil, in ui/ (its svelte).
const dialogCheck = `
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {compile, parse} from 'svelte/compiler';

const src = readFileSync('src/components/ContributeDialog.svelte', 'utf8');
for (const generate of ['client', 'server']) {
  const {warnings} = compile(src, {filename: 'ContributeDialog.svelte', generate});
  assert.deepEqual(warnings.map(w => w.message), [], generate);
}
const {module} = parse(src, {modern: true});
const {tickUntil} = await import('data:text/javascript,' + encodeURIComponent(src.slice(module.content.start, module.content.end)));
const sleep = ms => new Promise(done => setTimeout(done, ms));

// No wait: told the time once, and no timer.
let calls = [];
tickUntil(NaN, t => calls.push(t));
assert.equal(calls.length, 1);
// A wait: told again once it has passed, then no more.
calls = [];
const until = Date.now() + 100;
await new Promise(done => tickUntil(until, t => (calls.push(t), t >= until && done())));
await sleep(400);
assert.equal(calls.length, 2);
assert.ok(calls[1] >= until);
// Cancelled, as when the state changes: no more.
calls = [];
tickUntil(Date.now() + 100, t => calls.push(t))();
await sleep(400);
assert.equal(calls.length, 1);
// A long wait is re-armed an hour at a time.
const delays = [];
tickUntil(Date.now() + 5 * 3600e3, () => {}, {setTimeout: (f, ms) => delays.push(ms), clearTimeout() {}});
assert.deepEqual(delays, [3600e3]);
`

// The Contribute dialog: its consent text says only what holds (CONTRACT §2,
// §4), its daily-limit state ends when retryAt passes while it is open, and it
// compiles.
func TestGlobalDialog(t *testing.T) {
	src, err := os.ReadFile("../../ui/src/components/ContributeDialog.svelte")
	if err != nil {
		t.Fatal(err)
	}
	text := strings.Join(strings.Fields(string(src)), " ")
	// Ids are handed out in order; a Tsum with one contributor shows that contributor's rounds.
	for _, s := range []string{"random", "never shown publicly", "pooled from everyone"} {
		if strings.Contains(text, s) {
			t.Errorf("the dialog says %q", s)
		}
	}
	for _, s := range []string{"given out in order", "your number is not published", "how many contributors (in all and per Tsum)",
		"a group of one round shows that round's score, coins and end time", `"few players"`, "a hashed form of your internet address",
		// The waiting state reads a clock that ticks at retryAt.
		"$effect(() => tickUntil(Date.parse(st?.retryAt ?? ''), t => (now = t)));", "Date.parse(st.retryAt) > now"} {
		if !strings.Contains(text, s) {
			t.Errorf("the dialog lacks %q", s)
		}
	}
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is not installed")
	}
	ui, _ := filepath.Abs("../../ui")
	if _, err := os.Stat(filepath.Join(ui, "node_modules", "svelte")); err != nil {
		t.Skip("no ui/node_modules: run npm ci in ui/")
	}
	cmd := exec.Command("node", "--input-type=module", "-e", dialogCheck)
	cmd.Dir = ui
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("%v\n%s", err, out)
	}
}
