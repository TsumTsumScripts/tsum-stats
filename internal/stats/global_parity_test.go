package stats

import (
	"encoding/json"
	"fmt"
	"maps"
	"math"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

// parityDevices are TestGlobalParity's devices: three players (tsum-stats
// installs), each device with the 12-hex tag the Tsum script ends its round
// ids with.
var parityDevices = []struct {
	player    int
	name, tag string
}{
	{0, "pixel-7", "a1b2c3d4e5f6"}, {0, "tab-s8", "a1b2c3d4e5f7"},
	{1, "fold-5", "0b0b0b0b0b01"},
	{2, "pc-1", "0c0c0c0c0c01"}, {2, "pc-2", "0c0c0c0c0c02"},
}

// parityRound is a generated round and the player whose install has it.
type parityRound struct {
	Round
	player int
}

// uuid7 is a round id as roundStats.ts: statsUuidV7 makes one: the start in
// ms, seven random hex digits around the version and variant, the device tag.
func uuid7(start time.Time, tail int, tag string) string {
	t := fmt.Sprintf("%012x", start.UnixMilli())
	r := fmt.Sprintf("%07x", tail&0xfffffff)
	v, _ := strconv.ParseUint(r[6:], 16, 8)
	return t[:8] + "-" + t[8:] + "-7" + r[:3] + "-" + string("89ab"[v&3]) + r[3:6] + "-" + tag
}

// roundStart is when a round began: the first 12 hex digits of its UUIDv7
// id, in ms. The global site files a round under this day (CONTRACT §1.1).
func roundStart(id string) time.Time {
	ms, _ := strconv.ParseInt(strings.ReplaceAll(id, "-", "")[:12], 16, 64)
	return time.UnixMilli(ms).UTC()
}

// binEdge is the lowest whole value at least v that starts a bin (CONTRACT §5):
// a range bound there keeps the same rounds whole bins do.
func binEdge(v int) int {
	bin := func(v int) int {
		if v < 100 {
			return v
		}
		return 100 + int(math.Floor(math.Log(float64(v)/100)/math.Log(1.02)))
	}
	for v >= 100 && bin(v) == bin(v-1) {
		v++
	}
	return v
}

// globalParityRounds makes about 3,000 rounds the global site accepts, from
// 2026-08-19 to an hour before now: each device's rounds one after another,
// some across midnight, a few lasting hours (some of those across midnight
// too); catalog Tsums, one of them a medal Tsum; both builds; skill levels
// 1-6, unknown and out of range; a few item sets and settings from before
// items; coins under 100.
func globalParityRounds(now time.Time) []parityRound {
	seed := uint64(11)
	next := func(n int) int { // deterministic, so a failure repeats
		seed = seed*6364136223846793005 + 1442695040888963407
		return int((seed >> 33) % uint64(n))
	}
	tsums := []string{"mickey", "mickey", "elsa", "stitch", "abu", "minnie", "mickeyplus"}
	// nil is settings from before the items were recorded.
	itemSets := [][]string{nil, {}, {"bonusCoin"}, {"bonusCoin", "bonusTime"}, {"bonus5to4", "bonusBubble", "bonusCombo"},
		{"bonusCoin", "bonus5to4", "bonusTime", "bonusExp", "bonusScore", "bonusBubble", "bonusCombo"}}
	end := now.Add(-time.Hour)
	var out []parityRound
	for _, d := range parityDevices {
		t := time.Date(2026, 8, 19, 0, 0, 0, 0, time.UTC).Add(time.Duration(next(3600)) * time.Second)
		var prevEnd time.Time
		for {
			dur, screens := 40+float64(next(5200))/10, 5+next(40)
			// Now and then a round of a Tsum whose rounds last hours.
			if next(30) == 0 {
				dur = float64(3600 + next(4*3600))
			}
			// The row is written a little after the play time: the result screens.
			lag := time.Duration((dur + float64(screens)) * float64(time.Second))
			start := t.Add(time.Duration(next(1000)) * time.Millisecond)
			// Now and then a round straddles midnight.
			if midnight := t.Truncate(24 * time.Hour); !prevEnd.IsZero() && prevEnd.Before(midnight) && next(2) == 0 {
				if s := midnight.Add(-lag / 2); s.After(prevEnd.Add(time.Minute)) {
					start = s
				}
			}
			at := start.Add(lag)
			if at.After(end) {
				break
			}
			tsum := tsums[next(len(tsums))]
			build := []string{"global", "global", "jp"}[next(3)]
			score, base := int64(next(4_000_000)), int64(100+next(9000))
			if next(15) == 0 {
				base = int64(next(100))
			}
			final := base*13/10 + int64(next(50))
			var medals *int64
			switch {
			case tsum == "mickeyplus":
				m := int64(20 + next(600))
				if next(25) == 0 {
					m = 0
				}
				medals = &m
			case next(4) == 0:
				medals = new(int64)
			}
			settings := map[string]any{
				"skillLevel": 1 + next(6), "jpVersion": build == "jp", "bubbleStrategy": []string{"all_mid_chain", "one_mid_chain"}[next(2)],
				"linkReach": []float64{1.5, 2, 190}[next(3)], "fan": nil, "nested": map[string]int{"a": 1},
			}
			switch next(10) {
			case 0:
				delete(settings, "skillLevel")
			case 1:
				settings["skillLevel"] = 12
			}
			if items := itemSets[next(len(itemSets))]; items != nil {
				for _, b := range itemBits {
					settings[b.key] = slices.Contains(items, b.key)
				}
			}
			js, _ := json.Marshal(settings)
			out = append(out, parityRound{Round: Round{
				ID: uuid7(start, next(1<<28), d.tag), PlayedAt: at.UTC().Format(sqlTime), Tsum: tsum, Build: build,
				SkillType: "burst", ScriptVersion: []string{"4.0b1", "4.0b2"}[next(2)], Duration: &dur,
				Score: &score, BaseCoins: &base, FinalCoins: &final, Medals: medals,
				Device: d.name, Source: SourceCSV, Settings: string(js),
			}, player: d.player})
			prevEnd = at
			t = at.Add(time.Duration(60+next(4*3600)) * time.Second)
		}
	}
	return out
}

// paritySkill is the round's skill level as the global site files it
// (CONTRACT §1.2): skillLevel when it is an integer 1-10, else -1.
func paritySkill(settings string) int {
	var s map[string]any
	_ = json.Unmarshal([]byte(settings), &s)
	if v, ok := s["skillLevel"].(float64); ok && v == math.Trunc(v) && v >= 1 && v <= 10 {
		return int(v)
	}
	return -1
}

// workerCatalog is the Tsum ids the Worker is built with (global/src/catalog.ts).
func workerCatalog(t *testing.T) map[string]bool {
	var catalog struct {
		Tsums []struct {
			ID string `json:"id"`
		} `json:"tsums"`
	}
	data, err := os.ReadFile("../../ui/public/data/catalog.json")
	if err == nil {
		err = json.Unmarshal(data, &catalog)
	}
	if err != nil {
		t.Fatal(err)
	}
	ids := map[string]bool{}
	for _, c := range catalog.Tsums {
		ids[c.ID] = true
	}
	return ids
}

// TestGlobalParity holds the global site to the server's own answers, end to
// end: three players' rounds go through the forwarder as it uploads them (in
// batches of GlobalBatchRows), then (global/test/parity.test.ts, in
// Miniflare) the Worker's checks and hourly job, and the page's global engine
// over the files it publishes. Every exact figure must match Summarize over
// the same rounds in UTC days, a round's day being the one it began (CONTRACT
// §1.1); the quartiles and P90 come within a bin. On the way: rounds the
// Worker turns away, rounds of a Tsum its catalog lacks (stored, never in the
// public figures), rounds the site names in retry and takes on the next pass,
// and parts too long for one file. It runs again once the days are archived
// and compacted into month parts.
func TestGlobalParity(t *testing.T) {
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("node is not installed")
	}
	global, _ := filepath.Abs("../../global")
	vitest := filepath.Join(global, "node_modules", ".bin", "vitest")
	if _, err := os.Stat(vitest); err != nil {
		t.Skip("no global/node_modules: run npm ci in global/")
	}
	now := globalNow
	rounds := globalParityRounds(now)
	// The rounds that tell a start day from an end day: hours long, some ending the day after they began.
	long, crossing := 0, 0
	for _, r := range rounds {
		if *r.Duration > 3600 {
			long++
			if r.PlayedAt[:10] != roundStart(r.ID).Format(time.DateOnly) {
				crossing++
			}
		}
	}
	if long < 20 || crossing < 3 {
		t.Fatalf("%d rounds last hours and %d of them cross midnight; the data needs more", long, crossing)
	}

	// The union is every player's rounds once: what the global site should end up with.
	union := testApp(t)
	apps := make([]core.App, 3)
	for i := range apps {
		apps[i] = testApp(t)
	}
	duplicated := map[string]bool{}
	for i, r := range rounds {
		addRounds(t, union, r.Round)
		addRounds(t, apps[r.player], r.Round)
		// The second player also imported some of the first's CSV files.
		if r.player == 0 && i%90 == 0 {
			duplicated[r.ID] = true
			addRounds(t, apps[1], r.Round)
		}
	}
	// Rounds the global site turns away, only on the third player's computer.
	bad := func(id string, at time.Duration, change func(*Round)) Round {
		r := rounds[len(rounds)-1].Round
		r.ID, r.PlayedAt = id, now.Add(-at).Format(sqlTime)
		if id == "" {
			r.ID = uuid7(now.Add(-at-3*time.Minute), int(at), "0bad0bad0bad")
		}
		change(&r)
		return r
	}
	addRounds(t, apps[2],
		bad("not-a-uuid", 50*time.Hour, func(*Round) {}),
		// Not a Tsum id at all (a well-formed one the catalog lacks is kept: below).
		bad("", 51*time.Hour, func(r *Round) { r.Tsum = "no pe" }),
		bad("", 52*time.Hour, func(r *Round) { d := 0.0; r.Duration = &d }),
		bad("", 53*time.Hour, func(r *Round) { b := int64(99999); r.BaseCoins = &b }),
		// It ends 11 minutes before it began: more than clock skew.
		bad("", 54*time.Hour, func(r *Round) { r.ID = uuid7(now.Add(-54*time.Hour+11*time.Minute), 54, "0bad0bad0bad") }),
	)
	// Rounds of a Tsum newer than the Worker's catalog, from the third player's
	// first device, its medals unread: stored and counted as that player's
	// (CONTRACT §1.2), but in no public figure, so not in the union.
	newTsum := map[string]bool{}
	var starts []time.Time
	for _, r := range rounds {
		if r.ID[24:] == parityDevices[3].tag {
			starts = append(starts, roundStart(r.ID))
		}
	}
	for k := range 4 {
		start := now.Add(-time.Duration(240-k*29) * time.Hour)
		// Clear of the device's own rounds, which the pace check measures from.
		for slices.ContainsFunc(starts, func(s time.Time) bool { return s.Sub(start).Abs() < time.Minute }) {
			start = start.Add(5 * time.Minute)
		}
		r := rounds[len(rounds)-1].Round
		dur := 95.5 + float64(k)
		r.ID, r.PlayedAt, r.Tsum, r.Device, r.Duration, r.Medals = uuid7(start, 777+k, parityDevices[3].tag),
			start.Add(100*time.Second).Format(sqlTime), "newtsum", parityDevices[3].name, &dur, nil
		addRounds(t, apps[2], r)
		newTsum[r.ID] = true
	}
	if ids := workerCatalog(t); ids["newtsum"] || !ids["mickey"] {
		t.Fatal("the Worker's catalog should know mickey and not newtsum")
	}

	// Each player's forwarder makes its first pass, then the first player's
	// CSV rows correct some rounds and its next pass sends only those. At the
	// third player's first pass the site's clock is 6 hours behind (as if that
	// computer and its devices ran fast): to the site its newest rounds have
	// not happened yet, so it names them in retry, and the next pass sends
	// them again, when they go.
	type pass []RoundBatch
	players := make([]struct {
		Passes []pass         `json:"passes"`
		Me     map[string]any `json:"me"`
		// PassAt is the Worker's clock at each pass, ms.
		PassAt []int64 `json:"passAt"`
	}, 3)
	behind := now.Add(-6 * time.Hour)
	ahead := behind.Add(10 * time.Minute) // past this the site calls a time future (§1.2)
	var retried []string
	for _, r := range rounds {
		if at, _ := time.Parse(sqlTime, r.PlayedAt); r.player == 2 && (at.After(ahead) || roundStart(r.ID).After(ahead)) {
			retried = append(retried, r.ID)
		}
	}
	if len(retried) < 2 {
		t.Fatalf("%d of the third player's rounds end in its last 6 hours; the data needs more", len(retried))
	}
	slices.Sort(retried)
	workers := make([]*fakeWorker, 3)
	contributors := make([]*Contributor, 3)
	// What a player's forwarder has uploaded so far.
	uploaded := func(i int) []RoundBatch {
		f := workers[i]
		f.mu.Lock()
		defer f.mu.Unlock()
		return slices.Clone(f.batches)
	}
	for i, app := range apps {
		workers[i] = newFakeWorker(t)
		contributors[i], _ = testContributor(t, app, workers[i])
		if err := contributors[i].Join(); err != nil {
			t.Fatal(err)
		}
		at := now
		if i == 2 {
			at = behind
			workers[i].retry = map[string]bool{}
			for _, id := range retried {
				workers[i].retry[id] = true
			}
		}
		runPass(t, contributors[i])
		players[i].Passes = append(players[i].Passes, uploaded(i))
		players[i].PassAt = []int64{at.UnixMilli(), now.UnixMilli()}
		workers[i].retry = nil
		// Batches of at most GlobalBatchRows, oldest first.
		for j, b := range players[i].Passes[0] {
			if n := len(b.Records); n > GlobalBatchRows || n < GlobalBatchRows && j < len(players[i].Passes[0])-1 {
				t.Fatalf("player %d's batch %d has %d records", i+1, j+1, n)
			}
		}
	}
	var edits []Round
	coins, renamed, moved := 0, false, false
	for _, r := range rounds {
		if r.player != 0 || duplicated[r.ID] {
			continue
		}
		at, _ := time.Parse(sqlTime, r.PlayedAt)
		switch {
		case coins < 10:
			coins++
			score, final := *r.Score+1000, *r.FinalCoins+7
			r.Score, r.FinalCoins = &score, &final
		case !renamed && r.Tsum != "mickeyplus":
			// The event named the wrong Tsum. (Never a medal Tsum: its medals would make another one.)
			renamed = true
			r.Tsum = map[string]string{"stitch": "abu"}[r.Tsum]
			if r.Tsum == "" {
				r.Tsum = "stitch"
			}
		case !moved && at.Hour() == 23 && at.Minute() >= 50:
			// The CSV's time is a few minutes later than the event's: the round
			// now ends on the next day, but stays in the day it began.
			moved = true
			r.PlayedAt = at.Truncate(24 * time.Hour).Add(24*time.Hour + 30*time.Second).Format(sqlTime)
		default:
			continue
		}
		edits = append(edits, r.Round)
	}
	if !moved {
		t.Fatal("no round of the first player's ends late enough in a day to move it past midnight")
	}
	addRounds(t, union, edits...)
	addRounds(t, apps[0], edits...)
	for i := range players {
		runPass(t, contributors[i])
		players[i].Passes = append(players[i].Passes, uploaded(i)[len(players[i].Passes[0]):])
	}
	if n := len(players[0].Passes[1]); n != 1 || len(players[0].Passes[1][0].Records) != len(edits) {
		t.Fatalf("the second pass should send just the %d changed rounds, sent %d batches", len(edits), n)
	}
	if len(players[1].Passes[1]) != 0 {
		t.Fatalf("the second player's second pass sent %d batches", len(players[1].Passes[1]))
	}
	var again []string
	for _, b := range players[2].Passes[1] {
		for _, rec := range b.Records {
			again = append(again, rec["id"])
		}
	}
	if slices.Sort(again); !slices.Equal(again, retried) {
		t.Fatalf("the third player's second pass should send the %d rounds the site named in retry, sent %v", len(retried), again)
	}

	// What the global site should answer, from the union's rounds.
	var final []Round
	if err := union.DB().NewQuery("SELECT " + roundColumns + " FROM ts_rounds").All(&final); err != nil {
		t.Fatal(err)
	}
	owner := map[string]int{}
	for _, r := range rounds {
		owner[r.ID] = r.player
	}
	type spreads struct {
		Primary bool `json:"primary"`
		Medals  bool `json:"medals"`
	}
	type testCase struct {
		Name     string            `json:"name"`
		Route    string            `json:"route"`
		Params   map[string]string `json:"params"`
		Expected any               `json:"expected"`
		Spreads  *spreads          `json:"spreads,omitempty"`
		// Cut: an outlier range cuts cells, so a few figures are about (CONTRACT §6.2).
		Cut bool `json:"cut,omitempty"`
	}
	var cases []testCase
	roundtrip := func(v any) any {
		data, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		var out any
		_ = json.Unmarshal(data, &out)
		return out
	}
	summarize := func(app core.App, p map[string]string) any {
		q := url.Values{}
		for k, v := range p {
			q.Set(k, v)
		}
		s, err := Summarize(app.DB(), ParseFilter(q), 0)
		if err != nil {
			t.Fatal(err)
		}
		return roundtrip(s)
	}
	// summarizeRounds is Summarize over a server that has just rs.
	summarizeRounds := func(rs []Round, f Filter) Summary {
		app := testApp(t)
		if err := app.RunInTransaction(func(tx core.App) error {
			for _, r := range rs {
				if err := upsertRound(tx.DB(), r); err != nil {
					return err
				}
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		s, err := Summarize(app.DB(), f, 0)
		if err != nil {
			t.Fatal(err)
		}
		return s
	}
	// A summary case: the page sends params; the server is asked want, the
	// same filter as it reads it (params less what the global site ignores,
	// UTC days whole), over the rounds keep picks (nil: all). The global site
	// files a round under the UTC day it began, the server under the day it
	// ended, so want's days pick rounds by their start, and the per-day
	// figures are those of the same rounds dated by their start.
	summary := func(name string, params, want map[string]string, keep func(Round) bool) {
		if want == nil {
			want = params
		}
		q := url.Values{}
		for k, v := range want {
			q.Set(k, v)
		}
		f := ParseFilter(q)
		from, to := f.From, f.To
		if from != "" {
			from = from[:10] + " 00:00:00"
		}
		f.From, f.To = "", ""
		var picked, byStart []Round
		for _, r := range final {
			start := roundStart(r.ID)
			if day := start.Format(time.DateOnly) + " 00:00:00"; (keep != nil && !keep(r)) || day < from || (to != "" && day >= to) {
				continue
			}
			picked = append(picked, r)
			r.PlayedAt = start.Format(sqlTime)
			byStart = append(byStart, r)
		}
		s := summarizeRounds(picked, f)
		days := summarizeRounds(byStart, f)
		s.Daily, s.DailyTsums = days.Daily, days.DailyTsums
		// Under an outlier range only the range's own figure has spreads: the
		// bins of one figure are not cut by another's range. The coin range
		// is applied when both are set.
		coinRange := params["minCoins"] != "" || params["maxCoins"] != ""
		medalRange := !coinRange && (params["minMedals"] != "" || params["maxMedals"] != "")
		medalMode := params["coins"] == "medals"
		sp := &spreads{Primary: (!coinRange || !medalMode) && (!medalRange || medalMode), Medals: !coinRange}
		cases = append(cases, testCase{Name: "summary " + name, Route: "summary", Params: params, Expected: roundtrip(s), Spreads: sp,
			Cut: coinRange || medalRange})
	}
	skillIn := func(levels ...int) func(Round) bool {
		return func(r Round) bool { return slices.Contains(levels, paritySkill(r.Settings)) }
	}
	itemsIn := func(masks ...int) func(Round) bool {
		return func(r Round) bool {
			m := -1
			if items := itemsOf(r.Settings); items != nil {
				m = *items
			}
			return slices.Contains(masks, m)
		}
	}
	none := map[string]string{}

	summary("everything", none, nil, nil)
	summary("one Tsum", map[string]string{"tsum": "elsa"}, nil, nil)
	summary("two Tsums", map[string]string{"tsum": "mickey, abu"}, nil, nil)
	summary("the medal Tsum", map[string]string{"tsum": "mickeyplus"}, nil, nil)
	summary("jp", map[string]string{"build": "jp"}, nil, nil)
	summary("final coins", map[string]string{"coins": "final"}, nil, nil)
	summary("medals", map[string]string{"coins": "medals"}, nil, nil)
	summary("net", map[string]string{"net": "1"}, nil, nil)
	summary("net final, global", map[string]string{"net": "1", "coins": "final", "build": "global"}, nil, nil)
	summary("net in medal mode", map[string]string{"net": "1", "coins": "medals"}, nil, nil)
	summary("UTC days", map[string]string{"from": "2026-09-01 00:00:00", "to": "2026-09-08 00:00:00"}, nil, nil)
	summary("UTC days, iso, across months", map[string]string{"from": "2026-08-25T00:00:00Z", "to": "2026-10-02T00:00:00.000Z"}, nil, nil)
	summary("one day", map[string]string{"from": "2026-09-10T00:00:00Z", "to": "2026-09-11T00:00:00Z"}, nil, nil)
	summary("from only", map[string]string{"from": "2026-10-01T00:00:00Z", "coins": "final"}, nil, nil)
	// A bound inside a day takes that whole day (CONTRACT §6.2).
	summary("bounds inside days", map[string]string{"from": "2026-09-10T13:00:00Z", "to": "2026-09-20T06:00:00Z"},
		map[string]string{"from": "2026-09-10T00:00:00Z", "to": "2026-09-21T00:00:00Z"}, nil)
	summary("empty range", map[string]string{"from": "2026-09-10T00:00:00Z", "to": "2026-09-10T00:00:00Z"}, nil, nil)
	summary("nothing matches", map[string]string{"from": "2030-01-01T00:00:00Z"}, nil, nil)
	summary("unknown Tsum", map[string]string{"tsum": "nope"}, nil, nil)
	summary("a Tsum the catalog lacks", map[string]string{"tsum": "newtsum"}, nil, nil)
	summary("ignored parameters", map[string]string{"device": "pixel-7", "minScore": "3000", "maxScore": "100", "incomplete": "1", "tz": "540"}, none, nil)
	summary("everything filtered", map[string]string{"tsum": "elsa, mickeyplus", "build": "global", "coins": "final", "from": "2026-09-01T00:00:00Z"}, nil, nil)
	summary("one skill level", map[string]string{"skill": "3"}, none, skillIn(3))
	summary("skill levels and unknown", map[string]string{"skill": "2, 5,-1", "coins": "final"}, map[string]string{"coins": "final"}, skillIn(2, 5, -1))
	summary("skill level in medal mode", map[string]string{"skill": "4", "coins": "medals", "tsum": "mickeyplus"},
		map[string]string{"coins": "medals", "tsum": "mickeyplus"}, skillIn(4))
	summary("one item set", map[string]string{"items": "5"}, none, itemsIn(5))
	summary("item sets and unknown", map[string]string{"items": "0,127,-1", "build": "jp"}, map[string]string{"build": "jp"}, itemsIn(0, 127, -1))
	summary("item set, net", map[string]string{"items": "1", "net": "1"}, map[string]string{"net": "1"}, itemsIn(1))
	summary("skill and items", map[string]string{"skill": "1,6", "items": "98", "from": "2026-09-15T00:00:00Z"},
		map[string]string{"from": "2026-09-15T00:00:00Z"}, func(r Round) bool { return skillIn(1, 6)(r) && itemsIn(98)(r) })

	// Outlier ranges. The global site keeps whole bins, by their rounds'
	// average; a bound on a bin's edge keeps the same rounds as the server.
	edge := func(v int) string { return strconv.Itoa(binEdge(v)) }
	below := func(v int) string { return strconv.Itoa(binEdge(v) - 1) }
	summary("coin range", map[string]string{"minCoins": edge(1500), "maxCoins": below(6000)}, nil, nil)
	summary("coin range on a Tsum, final coins", map[string]string{"tsum": "mickey", "coins": "final", "maxCoins": below(5000)}, nil, nil)
	summary("coin range with skill levels, jp", map[string]string{"build": "jp", "minCoins": edge(3000), "skill": "2,3"},
		map[string]string{"build": "jp", "minCoins": edge(3000)}, skillIn(2, 3))
	summary("coin range under 100", map[string]string{"maxCoins": "50"}, nil, nil)
	summary("medal range", map[string]string{"minMedals": edge(150), "maxMedals": below(450)}, nil, nil)
	summary("medal range in medal mode", map[string]string{"coins": "medals", "minMedals": edge(200)}, nil, nil)
	summary("medal range keeping 0", map[string]string{"minMedals": "0", "maxMedals": below(300), "coins": "final"}, nil, nil)
	summary("both ranges: the coins' only", map[string]string{"minCoins": edge(2000), "minMedals": "100"}, map[string]string{"minCoins": edge(2000)}, nil)

	// The manifest's per-Tsum and site-wide counts: contributors over the
	// rounds begun in the last 30 days, first sender's; devices seen (a round
	// ended) in the last 30 days.
	recent := now.AddDate(0, 0, -29).Format("2006-01-02")
	type tsumRow struct {
		Tsum         string `json:"tsum"`
		Rounds       int    `json:"rounds"`
		Contributors int    `json:"contributors"`
	}
	byTsum := map[string]*tsumRow{}
	who := map[string]map[int]bool{}
	everyone := map[int]bool{}
	skills := map[int]bool{}
	devices := map[string]bool{}
	for _, r := range final {
		if byTsum[r.Tsum] == nil {
			byTsum[r.Tsum], who[r.Tsum] = &tsumRow{Tsum: r.Tsum}, map[int]bool{}
		}
		byTsum[r.Tsum].Rounds++
		if roundStart(r.ID).Format(time.DateOnly) >= recent {
			who[r.Tsum][owner[r.ID]], everyone[owner[r.ID]] = true, true
		}
		if at, _ := time.Parse(sqlTime, r.PlayedAt); !at.Before(now.Add(-30 * 24 * time.Hour)) {
			devices[r.ID[24:]] = true
		}
		if s := paritySkill(r.Settings); s >= 0 {
			skills[s] = true
		}
	}
	var tsums []tsumRow
	for tsum, row := range byTsum {
		row.Contributors = len(who[tsum])
		tsums = append(tsums, *row)
	}
	slices.SortFunc(tsums, func(a, b tsumRow) int {
		if a.Rounds != b.Rounds {
			return b.Rounds - a.Rounds
		}
		return strings.Compare(a.Tsum, b.Tsum)
	})
	cases = append(cases, testCase{Name: "tsums", Route: "tsums", Params: none, Expected: roundtrip(tsums)})
	all := summarize(union, none).(map[string]any)["totals"].(map[string]any)
	cases = append(cases, testCase{Name: "status", Route: "status", Params: none, Expected: map[string]any{
		"global": true, "rounds": len(final), "contributors": len(everyone), "devices": len(devices),
		"generatedAt": now.Format(time.RFC3339), "first": all["first"], "last": all["last"], "minContributors": 3,
		"skills": slices.Sorted(maps.Keys(skills)),
	}})

	// Each player's own record (GET /api/v1/me): the rounds it sent first, its
	// devices, and the first and last days its rounds began.
	for i := range players {
		n, first, last := 0, "", ""
		tags := map[string]bool{}
		mine := func(id string) {
			n++
			day := roundStart(id).Format(time.DateOnly)
			if first == "" || day < first {
				first = day
			}
			last = max(last, day)
		}
		for _, r := range final {
			if owner[r.ID] == i {
				mine(r.ID)
			}
		}
		if i == 2 {
			for id := range newTsum {
				mine(id)
			}
		}
		dups := 0
		for _, b := range players[i].Passes[0] {
			for _, rec := range b.Records {
				if _, ok := owner[rec["id"]]; ok || newTsum[rec["id"]] {
					tags[rec["id"][24:]] = true
				}
				if owner[rec["id"]] != i && duplicated[rec["id"]] {
					dups++
				}
			}
		}
		players[i].Me = map[string]any{"rounds": n, "duplicates": dups, "devices": len(tags), "first": first, "last": last}
	}

	type totals struct {
		Accepted   int            `json:"accepted"`
		Unchanged  int            `json:"unchanged"`
		Duplicates int            `json:"duplicates"`
		Rejected   map[string]int `json:"rejected"`
		Retry      []string       `json:"retry"`
	}
	fixture := map[string]any{
		"now": now.UnixMilli(), "players": players, "cases": cases,
		"uploads": []totals{
			{Accepted: len(rounds) + len(newTsum) - len(retried), Duplicates: len(duplicated),
				Rejected: map[string]int{"id": 2, "tsum": 1, "duration": 1, "range": 1, "future": len(retried)}, Retry: retried},
			{Accepted: len(edits) + len(retried), Rejected: map[string]int{}, Retry: []string{}},
		},
	}
	data, err := json.Marshal(fixture)
	if err != nil {
		t.Fatal(err)
	}
	// test/.parity is ignored by git; parity.test.ts runs only when it finds the file.
	file := filepath.Join(global, "test", ".parity", "fixture.json")
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, data, 0o644); err != nil {
		t.Fatal(err)
	}
	defer os.Remove(file)

	report := filepath.Join(t.TempDir(), "report.json")
	cmd := exec.Command(vitest, "run", "test/parity.test.ts", "--reporter=default", "--reporter=json", "--outputFile.json="+report)
	cmd.Dir = global
	cmd.Env = append(os.Environ(), "WRANGLER_SEND_METRICS=false", "CI=1")
	out, err := cmd.CombinedOutput()
	t.Logf("%d rounds from %d players (%d hours long, %d of those across midnight; %d sent again after a retry), "+
		"%d of a Tsum the catalog lacks, %d cases\n%s", len(rounds), len(players), long, crossing, len(retried), len(newTsum), len(cases), out)
	if err != nil {
		t.Fatalf("the global site's answers differ from the server's:\n%s", out)
	}
	// A suite that skipped (it did not find the fixture) would pass too.
	var res struct {
		Total  int `json:"numTotalTests"`
		Passed int `json:"numPassedTests"`
	}
	if data, err := os.ReadFile(report); err != nil || json.Unmarshal(data, &res) != nil || res.Total == 0 || res.Passed != res.Total {
		t.Fatalf("the parity suite did not run: %+v (%v)", res, err)
	}
}
