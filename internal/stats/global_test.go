package stats

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
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
	// refuseFrom, when > 0, refuses uploads once that many have been taken,
	// with refuseStatus, refuseCode and refuseRetry (the Retry-After header).
	refuseFrom   int
	refuseStatus int
	refuseCode   string
	refuseRetry  string
	rejected     map[string]int // the counts every upload's reply names
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
		if f.refuseFrom > 0 && len(f.batches) >= f.refuseFrom {
			f.refused++
			if f.refuseRetry != "" {
				w.Header().Set("Retry-After", f.refuseRetry)
			}
			f.reply(w, f.refuseStatus, map[string]any{"ok": false, "error": f.refuseCode})
			return
		}
		f.batches = append(f.batches, b)
		rejected := f.rejected
		if rejected == nil {
			rejected = map[string]int{}
		}
		f.reply(w, http.StatusOK, map[string]any{"ok": true, "accepted": len(b.Records), "unchanged": 0, "duplicates": 0, "rejected": rejected})
	case r.URL.Path == "/api/v1/me" && r.Method == http.MethodGet:
		f.meCalls++
		f.reply(w, http.StatusOK, map[string]any{"ok": true, "id": id, "status": "active", "since": "2026-10-14",
			"lastSeen": nil, "rounds": f.taken(), "duplicates": 0, "devices": 1, "first": nil, "last": nil,
			"today": map[string]int{"rounds": f.taken(), "quota": 5000}})
	case r.URL.Path == "/api/v1/me/unlink" && r.Method == http.MethodPost:
		delete(f.keys, key)
		f.unlinked = append(f.unlinked, key)
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

// testContributor is a contributor of app's rounds to f, on globalNow's clock.
func testContributor(t *testing.T, app core.App, f *fakeWorker) (*Contributor, string) {
	dir := t.TempDir()
	c := NewContributor(dir, f.srv.URL, app.DB, "0.25", nil)
	c.now = func() time.Time { return globalNow }
	c.jitter = func() time.Duration { return 0 }
	return c, dir
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
	)
	batches, err := GlobalBatches(app.DB(), globalNow, "tsum-stats/0.25")
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
	want := []string{"a-complete", "d-jp-setting", "g-settled", "i-in-window", "k-no-medal-tsum"}
	if !slices.Equal(ids, want) {
		t.Fatalf("picked %v, want %v", ids, want)
	}
	if n, err := countGlobalPending(app.DB(), globalNow, nil); err != nil || n != len(want) {
		t.Fatalf("pending: %d %v", n, err)
	}
	// The memo counts the same, and forgets rounds that leave the window.
	memo := &globalMemo{seen: map[string]memoEntry{}}
	for range 2 {
		if n, err := countGlobalPending(app.DB(), globalNow, memo); err != nil || n != len(want) || len(memo.seen) != len(want) {
			t.Fatalf("pending with a memo: %d %v, %d remembered", n, err, len(memo.seen))
		}
	}
	if n, _ := countGlobalPending(app.DB(), globalNow.Add(62*24*time.Hour), memo); n != 0 || len(memo.seen) != 0 {
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
	if st := NewContributor(dir, f.srv.URL, app.DB, "0.25", nil).State(); !st.Joined || st.ID != 17 {
		t.Fatalf("after a restart: %+v", st)
	}
	other := NewContributor(dir, "http://127.0.0.1:1", app.DB, "0.25", nil)
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
	for _, u := range []string{DefaultGlobalURL, "http://127.0.0.1:8787", "http://localhost:8787"} {
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
	if !slices.Equal(sizes, []int{250, 250, 100}) {
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
	if len(f.batches) != 3 {
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
	if len(f.batches) != 1 || f.refused != 1 || st.Sent != 250 || st.LastError != "" {
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
	if len(f.batches) != 2 || f.refused != 2 || st.Sent != 500 || st.RetryAt != clock.Add(2*time.Minute).Format(time.RFC3339) {
		t.Fatalf("after the budget: %d taken, %+v", len(f.batches), st)
	}

	// Once the wait is over the rest goes, from where it stopped.
	clock = clock.Add(5 * time.Minute)
	f.refuseFrom = 0
	if err := c.UploadNow(); err != nil {
		t.Fatal(err)
	}
	waitFor(t, "the upload", func() bool { return !c.State().Running })
	st = c.State()
	if st.Sent != 600 || st.RetryAt != "" || st.Pending != 0 {
		t.Fatalf("after the wait: %+v", st)
	}
	if ids := f.sentIDs(); len(ids) != 600 || ids[250] != "r250" || ids[599] != "r599" {
		t.Fatalf("sent %d rounds, from %v", len(ids), ids[250])
	}

	// Anything else is an error for the page, and the next hourly pass tries again.
	addRounds(t, app, globalRound("late", time.Hour))
	f.refuseFrom, f.refuseStatus, f.refuseCode, f.refuseRetry = 3, 400, "bad-request", ""
	runPass(t, c)
	if st := c.State(); !strings.Contains(st.LastError, "400 bad-request") || st.RetryAt != "" || !st.Enabled {
		t.Fatalf("after a 400: %+v", st)
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
