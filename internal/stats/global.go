package stats

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"hash/fnv"
	"io"
	"io/fs"
	"math/rand/v2"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pocketbase/dbx"
)

// Contributor is the "Contribute" feature: with the player's consent it sends
// their rounds to the global stats site (global/CONTRACT.md §7), in the format
// the Tsum script shares rounds in, about once an hour. The page drives it and
// shows its state; the uploads run in the background.

// TopicGlobal carries the contributor's state to the page as it changes.
const TopicGlobal = "ts/global"

// DefaultGlobalURL is the global stats site; --global-url replaces it.
const DefaultGlobalURL = "https://tsum-stats.gapscripts.app"

const (
	// RoundStatsSchema is the upload format, the Tsum script's own (roundShare.ts).
	RoundStatsSchema = "gap.round-stats/1"
	// GlobalBatchRows is the most records one upload carries. The Worker takes
	// up to 250; 100 keeps its CPU for one request well under Workers Free's 10 ms.
	GlobalBatchRows = 100
	// globalBatchBytes keeps a batch of long settings rows under the Worker's 1 MiB body limit.
	globalBatchBytes = 768 << 10
	// globalWindow is how far back rounds are sent: the Worker refuses older ones (ACCEPT_DAYS).
	globalWindow = 60 * 24 * time.Hour
	// globalSettle holds a round back until its CSV row has usually replaced the live event's.
	globalSettle = 20 * time.Minute
	globalJitter = 10 * time.Minute
	// globalUnlinkWait bounds how long an unlink waits for the batch in flight:
	// longer than the HTTP client's timeout, so that batch has ended by then.
	globalUnlinkWait = 90 * time.Second
)

// GlobalState is what the page shows. It never holds the key.
type GlobalState struct {
	Enabled bool   `json:"enabled"`
	Joined  bool   `json:"joined"`
	URL     string `json:"url"`
	ID      int64  `json:"id"`
	// Sent counts the rounds this contributor has had taken; Pending the ones waiting.
	Sent       int    `json:"sent"`
	Pending    int    `json:"pending"`
	LastUpload string `json:"lastUpload"`
	LastError  string `json:"lastError"`
	// RetryAt is when the global site said to come back (its daily limits); "" when it did not.
	RetryAt string    `json:"retryAt"`
	Me      *GlobalMe `json:"me"`
	// Running is true while a pass is uploading.
	Running bool `json:"running"`
}

// globalSaved is global.json in the data folder: the key and the record of uploads.
type globalSaved struct {
	// URL is the site the key belongs to; a key is never sent anywhere else.
	// It is also the site ts_global_sent records uploads to, so it stays when
	// the key is forgotten. A data folder contributes to one site at a time.
	URL        string `json:"url"`
	ID         int64  `json:"id"`
	Key        string `json:"key"`
	Enabled    bool   `json:"enabled"`
	JoinedAt   string `json:"joinedAt"`
	Sent       int    `json:"sent"`
	LastUpload string `json:"lastUpload"`
	LastError  string `json:"lastError"`
	RetryAt    string `json:"retryAt"`
}

// Contributor holds the key and the pass that may be running.
type Contributor struct {
	file    string
	url     string
	db      func() dbx.Builder
	version string
	notify  func(GlobalState)
	http    *http.Client
	now     func() time.Time
	jitter  func() time.Duration
	// first is the wait after the start or a join; interval the wait between passes.
	first, interval time.Duration
	wake            chan time.Duration // reschedules Run's next pass

	memo *globalMemo
	// medalTsums is the catalog's medal Tsums as a JSON array: the global site
	// turns away a round of one without a medal figure.
	medalTsums string

	mu      sync.Mutex
	saved   globalSaved
	me      *GlobalMe
	pending int
	gen     int  // counts joins and leaves, so a pass that overlaps one stops and changes nothing
	busy    bool // a pass is running
	// passDone is closed when the running pass ends; nil while none runs.
	passDone  chan struct{}
	joining   bool
	unlinking bool // no pass starts, and no join, until the unlink is answered
}

// NewContributor reads any saved key from dataDir. siteURL is --global-url;
// "" turns contributing off. medalTsums is the catalog's (CatalogMedalTsums).
func NewContributor(dataDir, siteURL string, medalTsums []string, db func() dbx.Builder, version string, notify func(GlobalState)) *Contributor {
	medals, _ := json.Marshal(append([]string{}, medalTsums...)) // [] for none, never null
	c := &Contributor{
		file: filepath.Join(dataDir, "global.json"), url: strings.TrimRight(strings.TrimSpace(siteURL), "/"),
		db: db, medalTsums: string(medals), version: version, notify: notify, http: &http.Client{Timeout: 60 * time.Second},
		now: time.Now, jitter: func() time.Duration { return rand.N(globalJitter) },
		first: 2 * time.Minute, interval: time.Hour, wake: make(chan time.Duration, 1),
		memo: &globalMemo{seen: map[string]memoEntry{}},
	}
	if data, err := os.ReadFile(c.file); err == nil {
		_ = json.Unmarshal(data, &c.saved)
	}
	return c
}

// CatalogMedalTsums is the medal: true Tsums of site's data/catalog.json, the
// catalog the global site checks rounds against too; none when it is unreadable.
func CatalogMedalTsums(site fs.FS) []string {
	var catalog struct {
		Tsums []struct {
			ID    string `json:"id"`
			Medal bool   `json:"medal"`
		} `json:"tsums"`
	}
	data, err := fs.ReadFile(site, "data/catalog.json")
	if err != nil || json.Unmarshal(data, &catalog) != nil {
		return nil
	}
	var out []string
	for _, t := range catalog.Tsums {
		if t.Medal && t.ID != "" {
			out = append(out, t.ID)
		}
	}
	return out
}

// joined is a saved key for the site in use. The caller holds the lock.
func (c *Contributor) joined() bool {
	return c.saved.Key != "" && c.saved.URL == c.url
}

// waiting is the global site having asked to come back later. The caller holds the lock.
func (c *Contributor) waiting() bool {
	t, err := time.Parse(time.RFC3339, c.saved.RetryAt)
	return err == nil && t.After(c.now())
}

// view is the state from what is saved. The caller holds the lock.
func (c *Contributor) view() GlobalState {
	s := GlobalState{URL: c.url, Pending: c.pending, Running: c.busy}
	if c.saved.URL == "" || c.saved.URL == c.url {
		s.LastError = c.saved.LastError // never another site's
	}
	if c.joined() {
		s.Joined, s.Enabled, s.ID = true, c.saved.Enabled, c.saved.ID
		s.Sent, s.LastUpload, s.RetryAt, s.Me = c.saved.Sent, c.saved.LastUpload, c.saved.RetryAt, c.me
	}
	return s
}

// State is what the page shows now.
func (c *Contributor) State() GlobalState {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.view()
}

// Refresh counts the waiting rounds again, for the page opening the dialog.
func (c *Contributor) Refresh() GlobalState {
	n, err := countGlobalPending(c.db(), c.now(), c.medalTsums, c.memo)
	c.mu.Lock()
	defer c.mu.Unlock()
	if err == nil {
		c.pending = n
	}
	return c.view()
}

// set tells the page. The caller holds the lock. Unlike publish.go's, it is
// not sent from a goroutine: the broadcaster never blocks, and a pass's last
// message must not overtake its first.
func (c *Contributor) set() {
	if c.notify != nil {
		c.notify(c.view())
	}
}

// persist writes global.json with only the owner able to read it: it holds the key.
func (c *Contributor) persist() error {
	data, _ := json.MarshalIndent(c.saved, "", "  ")
	tmp := c.file + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, c.file)
}

func (c *Contributor) site(key string) *GlobalSite {
	return &GlobalSite{URL: c.url, Key: key, Client: "tsum-stats/" + c.version, HTTP: c.http}
}

// schedule moves Run's next pass to d from now. It never blocks: a wake Run
// has not taken yet is replaced.
func (c *Contributor) schedule(d time.Duration) {
	for {
		select {
		case c.wake <- d:
			return
		default:
		}
		select {
		case <-c.wake:
		default:
		}
	}
}

// checkGlobalURL sends a key only over HTTPS, or to this computer (a local Worker).
func checkGlobalURL(s string) error {
	if s == "" {
		return errors.New("contributing is turned off: --global-url is empty")
	}
	u, err := url.Parse(s)
	if err != nil || u.Host == "" {
		return fmt.Errorf("--global-url %q is not a web address", s)
	}
	if u.Scheme == "https" || u.Scheme == "http" && IsLoopback(net.JoinHostPort(u.Hostname(), "0")) {
		return nil
	}
	return fmt.Errorf("--global-url must start with https://")
}

// Join makes this computer a contributor, or turns a saved one back on. The
// first upload follows c.first later, so a player who changes their mind at
// once can still leave before anything is sent.
//
// A data folder contributes to one site: a key saved for another is never
// replaced (it is the only way to unlink the rounds sent there), so joining a
// second site is refused. Once that key is forgotten, joining another site
// empties ts_global_sent, since its rounds were sent to the first.
func (c *Contributor) Join() error {
	if err := checkGlobalURL(c.url); err != nil {
		return err
	}
	c.mu.Lock()
	if c.joined() && c.saved.Enabled {
		c.mu.Unlock()
		return nil
	}
	if c.saved.Key != "" && c.saved.URL != c.url {
		other := c.saved.URL
		c.mu.Unlock()
		return fmt.Errorf("this data folder already contributes to %s. Start Tsum Tsum Stats with --global-url %s to carry on "+
			"or unlink there; for a test site, use another data folder (--dir)", other, other)
	}
	// A pass still ending after a stop is no bar: the join's gen stops it changing anything.
	if c.joining || c.unlinking {
		c.mu.Unlock()
		return errors.New("already joining or unlinking; try again in a moment")
	}
	c.joining = true
	resume, key := c.joined(), c.saved.Key
	otherSent := c.saved.URL != "" && c.saved.URL != c.url
	c.mu.Unlock()
	defer func() {
		c.mu.Lock()
		c.joining = false
		c.mu.Unlock()
	}()

	// No pass runs while no key is joined, so nothing else writes the table now.
	pending := -1
	if otherSent {
		if _, err := c.db().NewQuery("DELETE FROM ts_global_sent").Execute(); err != nil {
			return fmt.Errorf("could not join the global stats: %w", err)
		}
		if n, err := countGlobalPending(c.db(), c.now(), c.medalTsums, c.memo); err == nil {
			pending = n
		}
	}

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	var id int64
	if !resume {
		var err error
		if id, key, err = c.site("").Join(ctx); err != nil {
			return joinError(err)
		}
	}
	// The totals show at once, and a resumed key is checked before it is trusted.
	me, meErr := c.site(key).Me(ctx)

	c.mu.Lock()
	defer c.mu.Unlock()
	c.gen++
	if pending >= 0 {
		c.pending = pending
	}
	if resume {
		c.saved.Enabled, c.saved.LastError = true, ""
	} else {
		c.saved = globalSaved{URL: c.url, ID: id, Key: key, Enabled: true, JoinedAt: c.now().UTC().Format(time.RFC3339)}
		c.me = nil
	}
	if errors.Is(meErr, ErrGlobalKey) {
		c.rejected()
		return errors.New(c.saved.LastError)
	}
	if meErr == nil {
		c.me = &me
	}
	err := c.persist()
	c.set()
	c.schedule(c.first)
	return err
}

func joinError(err error) error {
	var e *GlobalError
	switch {
	case errors.As(err, &e) && e.wait() && e.Code == "join-limit":
		return errors.New("the global site takes only a few joins a day from one address; try again tomorrow")
	case errors.As(err, &e) && e.wait() && e.Code == "budget":
		return errors.New("the global site has taken all it can for today; try again after 00:00 UTC")
	}
	return fmt.Errorf("could not join the global stats: %w", err)
}

// Leave stops the uploads. The key is kept, so Join resumes as the same
// contributor. With unlink the global site is first asked to unlink this
// contributor's rounds, then the key is forgotten. A key saved for another
// site is left as it is.
func (c *Contributor) Leave(unlink bool) error {
	c.mu.Lock()
	if !c.joined() {
		c.mu.Unlock()
		return nil
	}
	if unlink && c.unlinking {
		c.mu.Unlock()
		return errors.New("already unlinking; try again in a moment")
	}
	c.gen++
	c.saved.Enabled, c.saved.LastError = false, ""
	key, done := c.saved.Key, c.passDone
	if unlink {
		c.unlinking = true
	}
	err := c.persist()
	c.set()
	c.mu.Unlock()
	if !unlink {
		return err
	}
	defer func() {
		c.mu.Lock()
		c.unlinking = false
		c.mu.Unlock()
	}()
	if err != nil {
		return err
	}
	// The pass stops before its next batch, but the one in flight must be
	// answered first: the site would otherwise store it after the unlink,
	// under the old id.
	if done != nil {
		select {
		case <-done:
		case <-time.After(globalUnlinkWait):
			return errors.New("uploads are stopped, but an upload is still finishing; try unlinking again in a minute")
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	// A key the site no longer knows has nothing left to unlink.
	if err := c.site(key).Unlink(ctx); err != nil && !errors.Is(err, ErrGlobalKey) {
		return fmt.Errorf("uploads are stopped, but your rounds could not be unlinked (%v); try again", err)
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.gen++
	c.saved, c.me = globalSaved{URL: c.url}, nil
	err = c.persist()
	c.set()
	return err
}

// rejected is the global site refusing the key: uploads stop until the player
// joins again, as a new contributor. The caller holds the lock.
func (c *Contributor) rejected() {
	c.gen++
	c.saved = globalSaved{URL: c.url, LastError: "The global site no longer accepts this computer's key. Join again to keep contributing."}
	c.me = nil
	_ = c.persist()
	c.set()
}

// UploadNow runs a pass in the background, unless one is running or the
// global site asked to wait.
func (c *Contributor) UploadNow() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	switch {
	case !c.joined() || !c.saved.Enabled:
		return errors.New("join the global stats first")
	case c.busy:
		return errors.New("an upload is already running")
	case c.waiting():
		return fmt.Errorf("the global site asked to wait until %s", c.saved.RetryAt)
	}
	p, _ := c.begin()
	go c.upload(p)
	return nil
}

// Run makes the passes while the player contributes: c.first after the start
// or a join, then hourly, spread by up to globalJitter so contributors do not
// all arrive at once. It returns when stop closes.
func (c *Contributor) Run(stop <-chan struct{}) {
	t := time.NewTimer(c.first)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case d := <-c.wake:
			t.Reset(d)
		case <-t.C:
			c.mu.Lock()
			p, ok := c.begin()
			c.mu.Unlock()
			if ok {
				c.upload(p)
			}
			t.Reset(c.untilNext())
		}
	}
}

// untilNext is the wait before the next pass: the interval, or until the
// global site said to come back, with jitter.
func (c *Contributor) untilNext() time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	d := c.interval
	if t, err := time.Parse(time.RFC3339, c.saved.RetryAt); err == nil {
		d = max(d, t.Sub(c.now()))
	}
	return d + c.jitter()
}

// pass is what one upload run works with, taken when it starts.
type pass struct {
	gen  int
	key  string
	wait bool // the global site asked to wait: only the totals are fetched
}

// begin claims the pass. The caller holds the lock.
func (c *Contributor) begin() (pass, bool) {
	if c.busy || c.unlinking || !c.joined() || !c.saved.Enabled {
		return pass{}, false
	}
	c.busy, c.passDone = true, make(chan struct{})
	c.set()
	return pass{gen: c.gen, key: c.saved.Key, wait: c.waiting()}, true
}

// upload sends every waiting round, oldest first, a batch at a time, until
// none are left or the global site refuses one; then fetches the totals.
func (c *Contributor) upload(p pass) {
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	site := c.site(p.key)
	var err error
	if !p.wait {
		err = c.send(ctx, site, p.gen)
	}
	var me *GlobalMe
	// Not after a leave, whose unlink waits for this pass.
	if !errors.Is(err, ErrGlobalKey) && !c.left(p.gen) {
		m, meErr := site.Me(ctx)
		if meErr == nil {
			me = &m
		} else if errors.Is(meErr, ErrGlobalKey) {
			err = meErr
		}
	}
	pending, countErr := countGlobalPending(c.db(), c.now(), c.medalTsums, c.memo)

	c.mu.Lock()
	defer c.mu.Unlock()
	c.busy = false
	close(c.passDone)
	c.passDone = nil
	if countErr == nil {
		c.pending = pending
	}
	// The player left, or left and joined again, meanwhile.
	if p.gen != c.gen {
		c.set()
		return
	}
	if me != nil {
		c.me = me
	}
	var refused *GlobalError
	switch {
	case errors.Is(err, ErrGlobalKey):
		c.rejected()
		return
	case errors.As(err, &refused) && refused.wait():
		wait := refused.RetryAfter
		if wait <= 0 {
			wait = c.interval
		}
		c.saved.RetryAt, c.saved.LastError = c.now().Add(wait).UTC().Format(time.RFC3339), ""
	case err != nil:
		c.saved.LastError = "The last upload did not go through: " + err.Error()
	default:
		c.saved.LastError = ""
	}
	_ = c.persist()
	c.set()
}

// left is the player having left, or left and joined again, since the pass
// of gen began.
func (c *Contributor) left(gen int) bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return gen != c.gen
}

// send is the batches of one pass. It stops at the first refusal, or when
// the player leaves.
func (c *Contributor) send(ctx context.Context, site *GlobalSite, gen int) error {
	var cur globalCursor
	for {
		batch, next, err := nextGlobalBatch(c.db(), c.now(), cur, c.medalTsums, c.memo)
		if err != nil || len(batch) == 0 || c.left(gen) {
			return err
		}
		reply, err := site.Rounds(ctx, NewRoundBatch(globalRecords(batch), site.Client, c.now()))
		if err != nil {
			return err
		}
		// ok: true means "do not send these again", rejected rows too (only a
		// change to a round's record sends it again), but for those the site
		// names in retry: turned away for a reason that can pass, such as a
		// clock ahead of the site's, they go again on the next pass.
		taken := takenRows(batch, reply.Retry)
		at := c.now()
		if err := markGlobalSent(c.db(), taken, at); err != nil {
			return err
		}
		c.mu.Lock()
		if gen == c.gen {
			c.saved.Sent += len(taken)
			c.saved.LastUpload, c.saved.RetryAt = at.UTC().Format(time.RFC3339), ""
			c.pending = max(0, c.pending-len(taken))
			_ = c.persist()
			c.set()
		}
		c.mu.Unlock()
		cur = next
	}
}

// ---- What is sent ----

// globalNeverSent are columns that stay on this computer even if a round's
// settings named one.
var globalNeverSent = map[string]bool{"device": true, "source": true}

// GlobalRecord is a round as the Tsum script shares it (gap.round-stats/1): its
// stats CSV row keyed by column, every cell a string and an unread figure "".
// The settings go back into their own columns, written so that csv.go's
// settingValue reads each one as it was. The device and source are never sent.
func GlobalRecord(r Round) map[string]string {
	rec := map[string]string{}
	var settings map[string]any
	if json.Unmarshal([]byte(r.Settings), &settings) == nil {
		for k, v := range settings {
			if s, ok := settingCell(v); ok && k != "" && !globalNeverSent[k] {
				rec[k] = s
			}
		}
	}
	// The base columns last, so a setting of the same name cannot replace one.
	for k, v := range map[string]string{
		"id": r.ID, "datetime": r.PlayedAt, "script_version": r.ScriptVersion, "skill_type": r.SkillType,
		"tsum": r.Tsum, "build": r.Build, "duration_seconds": floatText(r.Duration), "score": intText(r.Score),
		"base_coins": intText(r.BaseCoins), "final_coins": intText(r.FinalCoins), "medals": intText(r.Medals),
	} {
		rec[k] = v
	}
	return rec
}

// settingCell is settingValue the other way round: switches as T/F, numbers
// in their shortest form (3, 0.5). Null, objects and arrays have no cell.
func settingCell(v any) (string, bool) {
	switch v := v.(type) {
	case bool:
		if v {
			return "T", true
		}
		return "F", true
	case float64:
		return strconv.FormatFloat(v, 'f', -1, 64), true
	case string:
		return v, true
	}
	return "", false
}

func intText(v *int64) string {
	if v == nil {
		return ""
	}
	return strconv.FormatInt(*v, 10)
}

func floatText(v *float64) string {
	if v == nil {
		return ""
	}
	return strconv.FormatFloat(*v, 'f', -1, 64)
}

// fingerprint is the FNV-1a 64 hash of a record's canonical JSON (keys sorted,
// as json.Marshal writes a map), as SQLite's signed INTEGER holds it, and the
// JSON's length.
func fingerprint(rec map[string]string) (int64, int) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	_ = enc.Encode(rec)
	data := bytes.TrimSuffix(buf.Bytes(), []byte("\n"))
	h := fnv.New64a()
	h.Write(data)
	return int64(h.Sum64()), len(data)
}

// RoundBatch is one gap.round-stats/1 upload (CONTRACT §1).
type RoundBatch struct {
	Schema string `json:"schema"`
	Script struct {
		ID string `json:"id"`
	} `json:"script"`
	Source  string              `json:"source"`
	SentAt  string              `json:"sentAt"`
	Client  string              `json:"client,omitempty"`
	Records []map[string]string `json:"records"`
}

// NewRoundBatch wraps records (GlobalRecord's) as one upload from client, "tsum-stats/<version>".
func NewRoundBatch(records []map[string]string, client string, now time.Time) RoundBatch {
	b := RoundBatch{Schema: RoundStatsSchema, Source: "tsum-stats", SentAt: now.UTC().Format("2006-01-02T15:04:05.000Z"),
		Client: client, Records: records}
	b.Script.ID = "app.gap.Tsum"
	return b
}

// GlobalBatches is every upload a pass would make at now, in order, without
// marking anything sent: the forwarder's own encoding, for tests that feed it
// to the global site. medalTsums is the catalog's (CatalogMedalTsums).
func GlobalBatches(db dbx.Builder, now time.Time, client string, medalTsums []string) ([]RoundBatch, error) {
	medals, _ := json.Marshal(append([]string{}, medalTsums...))
	var out []RoundBatch
	var cur globalCursor
	for {
		batch, next, err := nextGlobalBatch(db, now, cur, string(medals), nil)
		if err != nil || len(batch) == 0 {
			return out, err
		}
		out = append(out, NewRoundBatch(globalRecords(batch), client, now))
		cur = next
	}
}

// ---- Which rounds ----

// globalCandidatesSQL is the rounds a pass may send (CONTRACT §7.2), oldest
// first: complete, here and by the catalog's medal Tsums ({:medalTsums}, a
// JSON array) as the global site judges it; of a known build or one the
// settings name; played in the window; with the fingerprint each was last
// sent with. Never the device or the source.
const globalCandidatesSQL = `SELECT round_id, played_at, tsum, build, skill_type, script_version, duration_seconds,
		score, base_coins, final_coins, medals, settings,
		(SELECT hash FROM ts_global_sent s WHERE s.round_id = ts_rounds.round_id) AS sent_hash
	FROM ts_rounds
	WHERE ` + completeSQL + `
		AND (medals IS NOT NULL OR tsum NOT IN (SELECT value FROM json_each({:medalTsums})))
		AND (build IN ('global', 'jp') OR (json_valid(settings) AND json_type(settings, '$.jpVersion') IN ('true', 'false')))
		AND played_at >= {:from} AND played_at <= {:to} AND (played_at, round_id) > ({:at}, {:id})
	ORDER BY played_at, round_id`

type globalRow struct {
	Round
	SentHash *int64 `db:"sent_hash"`
}

// pendingRound is a round waiting to be sent, as its record.
type pendingRound struct {
	id     string
	hash   int64
	record map[string]string
}

// globalCursor is the last candidate a scan walked past.
type globalCursor struct{ at, id string }

// scanGlobal walks the candidates after cur and hands take each one waiting
// to be sent (never sent, or its record changed since) with its fingerprint.
// take returns false to stop before that round. medals is the catalog's medal
// Tsums as a JSON array; memo may be nil.
func scanGlobal(db dbx.Builder, now time.Time, cur globalCursor, medals string, memo *globalMemo, take func(Round, int64) bool) (globalCursor, error) {
	rows, err := db.NewQuery(globalCandidatesSQL).Bind(dbx.Params{
		"from": now.Add(-globalWindow).UTC().Format(sqlTime), "to": now.Add(-globalSettle).UTC().Format(sqlTime),
		"at": cur.at, "id": cur.id, "medalTsums": medals,
	}).Rows()
	if err != nil {
		return cur, err
	}
	defer rows.Close()
	for rows.Next() {
		var r globalRow
		if err := rows.ScanStruct(&r); err != nil {
			return cur, err
		}
		hash := memo.fingerprint(r.Round)
		if (r.SentHash == nil || *r.SentHash != hash) && !take(r.Round, hash) {
			return cur, nil
		}
		cur = globalCursor{r.PlayedAt, r.ID}
	}
	return cur, rows.Err()
}

// countGlobalPending counts the rounds waiting to be sent.
func countGlobalPending(db dbx.Builder, now time.Time, medals string, memo *globalMemo) (int, error) {
	n := 0
	memo.begin()
	_, err := scanGlobal(db, now, globalCursor{}, medals, memo, func(Round, int64) bool { n++; return true })
	if err == nil {
		memo.end()
	}
	return n, err
}

// nextGlobalBatch is the next GlobalBatchRows waiting rounds after cur, fewer
// when their records are long.
func nextGlobalBatch(db dbx.Builder, now time.Time, cur globalCursor, medals string, memo *globalMemo) ([]pendingRound, globalCursor, error) {
	var batch []pendingRound
	size := 0
	next, err := scanGlobal(db, now, cur, medals, memo, func(r Round, hash int64) bool {
		rec := GlobalRecord(r)
		_, n := fingerprint(rec)
		if len(batch) == GlobalBatchRows || len(batch) > 0 && size+n > globalBatchBytes {
			return false
		}
		batch = append(batch, pendingRound{id: r.ID, hash: hash, record: rec})
		size += n
		return true
	})
	return batch, next, err
}

// globalMemo remembers each round's fingerprint by a quick hash of its row as
// read. Counting the waiting rounds then rebuilds only the records whose rows
// changed, not 60 days of them (some 60,000 for a player with a few devices).
type globalMemo struct {
	mu   sync.Mutex
	gen  uint64
	seen map[string]memoEntry
}

type memoEntry struct {
	row, gen uint64
	hash     int64
}

// fingerprint is the round's record's fingerprint. A nil memo works it out every time.
func (m *globalMemo) fingerprint(r Round) int64 {
	if m == nil {
		h, _ := fingerprint(GlobalRecord(r))
		return h
	}
	row := rowHash(r)
	m.mu.Lock()
	e, ok := m.seen[r.ID]
	m.mu.Unlock()
	if !ok || e.row != row {
		e.row = row
		e.hash, _ = fingerprint(GlobalRecord(r))
	}
	m.mu.Lock()
	e.gen = m.gen
	m.seen[r.ID] = e
	m.mu.Unlock()
	return e.hash
}

// begin and end bracket a walk of every candidate; end forgets the rounds it
// did not meet, which have left the window.
func (m *globalMemo) begin() {
	if m != nil {
		m.mu.Lock()
		m.gen++
		m.mu.Unlock()
	}
}

func (m *globalMemo) end() {
	if m == nil {
		return
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, e := range m.seen {
		if e.gen != m.gen {
			delete(m.seen, id)
		}
	}
}

// rowHash is FNV-1a 64 over every column GlobalRecord reads.
func rowHash(r Round) uint64 {
	h := fnv.New64a()
	for _, s := range []string{r.ID, r.PlayedAt, r.Tsum, r.Build, r.SkillType, r.ScriptVersion, floatText(r.Duration),
		intText(r.Score), intText(r.BaseCoins), intText(r.FinalCoins), intText(r.Medals), r.Settings} {
		h.Write([]byte(s))
		h.Write([]byte{0})
	}
	return h.Sum64()
}

func globalRecords(batch []pendingRound) []map[string]string {
	out := make([]map[string]string, len(batch))
	for i, p := range batch {
		out[i] = p.record
	}
	return out
}

// takenRows is the batch less the rounds the global site asked to have again
// (its reply's retry, by record id).
func takenRows(batch []pendingRound, retry []string) []pendingRound {
	if len(retry) == 0 {
		return batch
	}
	again := map[string]bool{}
	for _, id := range retry {
		again[id] = true
	}
	var out []pendingRound
	for _, r := range batch {
		if !again[r.id] {
			out = append(out, r)
		}
	}
	return out
}

// markGlobalSent records a batch the global site took, in one statement.
func markGlobalSent(db dbx.Builder, batch []pendingRound, at time.Time) error {
	if len(batch) == 0 {
		return nil
	}
	var q strings.Builder
	p := dbx.Params{"at": at.UTC().Format(sqlTime)}
	q.WriteString("INSERT INTO ts_global_sent (round_id, hash, sent_at) VALUES ")
	for i, r := range batch {
		if i > 0 {
			q.WriteString(", ")
		}
		fmt.Fprintf(&q, "({:i%d}, {:h%d}, {:at})", i, i)
		p[fmt.Sprintf("i%d", i)], p[fmt.Sprintf("h%d", i)] = r.id, r.hash
	}
	q.WriteString(" ON CONFLICT (round_id) DO UPDATE SET hash = excluded.hash, sent_at = excluded.sent_at")
	_, err := db.NewQuery(q.String()).Bind(p).Execute()
	return err
}

// ---- The global site's API ----

// GlobalSite talks to the global stats site's Worker (CONTRACT §2) as one contributor.
type GlobalSite struct {
	URL    string // no trailing slash
	Key    string // the contributor's; "" to join
	Client string // "tsum-stats/<version>": the User-Agent, also named in joins and uploads
	HTTP   *http.Client
}

// ErrGlobalKey is the global site refusing the key (401 unauthorized): unlinked,
// or unknown to it.
var ErrGlobalKey = errors.New("the global site does not accept this computer's key")

// GlobalError is the global site refusing a request, with its error code.
type GlobalError struct {
	Status int
	Code   string
	// RetryAfter is how long the site asked to wait; 0 when it did not say.
	RetryAfter time.Duration
}

func (e *GlobalError) Error() string {
	return fmt.Sprintf("the global site said %d %s", e.Status, e.Code)
}

// wait is a refusal that asks to come back later: the Worker's own daily
// limits, by their codes. Any other 429 or 5xx, such as the platform's own
// error page, is a plain failure, and the next hourly pass tries again.
func (e *GlobalError) wait() bool {
	switch e.Status {
	case http.StatusTooManyRequests:
		return e.Code == "quota" || e.Code == "join-limit"
	case http.StatusServiceUnavailable:
		return e.Code == "budget"
	}
	return false
}

// GlobalMe is the global site's record of this contributor (GET /api/v1/me).
type GlobalMe struct {
	ID         int64   `json:"id"`
	Status     string  `json:"status"`
	Since      string  `json:"since"`
	LastSeen   string  `json:"lastSeen"`
	Rounds     int64   `json:"rounds"`
	Duplicates int64   `json:"duplicates"`
	Devices    int64   `json:"devices"`
	First      *string `json:"first"`
	Last       *string `json:"last"`
	Today      struct {
		Rounds int64 `json:"rounds"`
		Quota  int64 `json:"quota"`
	} `json:"today"`
}

// RoundsReply is the global site's answer to an upload.
type RoundsReply struct {
	Accepted   int            `json:"accepted"`
	Unchanged  int            `json:"unchanged"`
	Duplicates int            `json:"duplicates"`
	Rejected   map[string]int `json:"rejected"`
	// Retry is the record ids rejected for a reason that can pass later
	// (future): they are not taken as sent.
	Retry []string `json:"retry"`
}

// do sends one request. The body goes uncompressed: inflating it would spend
// the Worker's 10 ms of CPU, and a batch is well under its 1 MiB limit.
func (g *GlobalSite) do(ctx context.Context, method, endpoint string, body, out any) error {
	var rd io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		rd = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, g.URL+endpoint, rd)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", g.Client)
	if g.Key != "" {
		req.Header.Set("Authorization", "Bearer "+g.Key)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := g.HTTP.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	var reply struct {
		OK    bool   `json:"ok"`
		Error string `json:"error"`
	}
	_ = json.Unmarshal(data, &reply)
	// Only the Worker's own answer forgets the key, never a page in its way.
	if res.StatusCode == http.StatusUnauthorized && reply.Error == "unauthorized" {
		return ErrGlobalKey
	}
	if res.StatusCode >= 300 || !reply.OK {
		return &GlobalError{Status: res.StatusCode, Code: cmpOr(reply.Error, http.StatusText(res.StatusCode)),
			RetryAfter: retryAfter(res.Header.Get("Retry-After"), time.Now())}
	}
	if out != nil {
		return json.Unmarshal(data, out)
	}
	return nil
}

// retryAfter reads a Retry-After header: seconds, or an HTTP date.
func retryAfter(h string, now time.Time) time.Duration {
	if s, err := strconv.Atoi(strings.TrimSpace(h)); err == nil && s > 0 {
		return time.Duration(s) * time.Second
	}
	if t, err := http.ParseTime(h); err == nil && t.After(now) {
		return t.Sub(now)
	}
	return 0
}

// Join makes a new contributor. The key is in this answer only.
func (g *GlobalSite) Join(ctx context.Context) (int64, string, error) {
	var r struct {
		ID  int64  `json:"id"`
		Key string `json:"key"`
	}
	if err := g.do(ctx, http.MethodPost, "/api/v1/join", map[string]string{"client": g.Client}, &r); err != nil {
		return 0, "", err
	}
	if r.ID <= 0 || r.Key == "" {
		return 0, "", errors.New("the global site's answer has no key")
	}
	return r.ID, r.Key, nil
}

// Rounds uploads one batch.
func (g *GlobalSite) Rounds(ctx context.Context, b RoundBatch) (RoundsReply, error) {
	var r RoundsReply
	err := g.do(ctx, http.MethodPost, "/api/v1/rounds", b, &r)
	return r, err
}

// Me is the site's record of this contributor.
func (g *GlobalSite) Me(ctx context.Context) (GlobalMe, error) {
	var m GlobalMe
	err := g.do(ctx, http.MethodGet, "/api/v1/me", nil, &m)
	return m, err
}

// Unlink asks the site to take this contributor's id off its rounds; the key stops working.
func (g *GlobalSite) Unlink(ctx context.Context) error {
	return g.do(ctx, http.MethodPost, "/api/v1/me/unlink", map[string]any{}, nil)
}
