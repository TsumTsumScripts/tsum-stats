package stats

import (
	"encoding/json"
	"math"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	// Registers PocketBase's own system migrations, which Bootstrap runs.
	_ "github.com/pocketbase/pocketbase/migrations"
)

func testApp(t *testing.T) core.App {
	t.Helper()
	app := core.NewBaseApp(core.BaseAppConfig{DataDir: t.TempDir()})
	if err := app.Bootstrap(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = app.ResetBootstrapState() })
	if err := migrate(app); err != nil {
		t.Fatal(err)
	}
	return app
}

const statsCSV = "\xef\xbb\xbfid,datetime,script_version,skill_type,tsum,build,duration_seconds,score,base_coins,final_coins,medals,useFan,maxChain,newSetting\n" +
	"0199-a,2026-09-04 11:20:31,4.0b1,mickey,mickey,global,72.5,1250000,800,1600,0,T,12,\n" +
	"0199-b,2026-09-04 11:25:00,4.0b1,mickey,mickey,global,70,,,,,F,12,x\n" +
	",2026-09-04 11:30:00,4.0b1,mickey,mickey,global,70,1,1,1,0,F,12,\n"

func TestParseStatsCSV(t *testing.T) {
	rows, err := parseStatsCSV(strings.NewReader(statsCSV))
	if err != nil {
		t.Fatal(err)
	}
	if len(rows) != 2 {
		t.Fatalf("want 2 rows (the id-less one skipped), got %d", len(rows))
	}
	a := rows[0]
	if a.ID != "0199-a" || a.PlayedAt != "2026-09-04 11:20:31" || *a.Score != 1250000 || *a.FinalCoins != 1600 || *a.Duration != 72.5 {
		t.Fatalf("row a: %+v", a)
	}
	var settings map[string]any
	_ = json.Unmarshal([]byte(a.Settings), &settings)
	if settings["useFan"] != true || settings["maxChain"] != float64(12) {
		t.Fatalf("settings: %v", settings)
	}
	if _, ok := settings["newSetting"]; ok {
		t.Fatal("an empty setting cell should be left out")
	}
	b := rows[1]
	if b.Score != nil || b.FinalCoins != nil || b.Medals != nil {
		t.Fatalf("unread figures must stay nil: %+v", b)
	}
}

func TestParseTsumList(t *testing.T) {
	build, device, rows, err := parseTsumListCSV(strings.NewReader(
		"order,tsum,name,level,level_cap,skill,skill_max,skill_progress,acquired,build,device\n1,mickey,Mickey,5,10,3,6,40,2024-05,jp,tsum-left\n2,,,,,,,,2024-06,jp,tsum-left\n"))
	if err != nil || build != "jp" || device != "tsum-left" || len(rows) != 1 || *rows[0].LevelCap != 10 || *rows[0].SkillProgress != 40 || rows[0].Acquired != "2024-05" {
		t.Fatalf("build=%q rows=%+v err=%v", build, rows, err)
	}
	// Older exports have no build column: Japanese names mean a JP list.
	build, device, _, _ = parseTsumListCSV(strings.NewReader("order,tsum,name\n1,abu,アブー\n"))
	if device != "" {
		t.Fatalf("an old export has no device, got %q", device)
	}
	if build != "jp" {
		t.Fatalf("want jp, got %q", build)
	}
	build, _, _, _ = parseTsumListCSV(strings.NewReader("order,tsum,name\n1,abu,Abu\n"))
	if build != "global" {
		t.Fatalf("want global, got %q", build)
	}
}

func i64(n int64) *int64 { return &n }

func TestEventThenCSVIsOneRound(t *testing.T) {
	app := testApp(t)
	ev := Round{ID: "0199-a", PlayedAt: "2026-09-04 11:20:33", Tsum: "mickey", Score: i64(1), Device: "tsum-left", Source: SourceEvent}
	if err := upsertRound(app.DB(), ev); err != nil {
		t.Fatal(err)
	}
	rows, _ := parseStatsCSV(strings.NewReader(statsCSV))
	for _, r := range rows {
		if err := upsertRound(app.DB(), r); err != nil {
			t.Fatal(err)
		}
	}
	// A late event must not overwrite the CSV's figures.
	if err := upsertRound(app.DB(), ev); err != nil {
		t.Fatal(err)
	}
	var got Round
	if err := app.DB().NewQuery("SELECT " + roundColumns + " FROM ts_rounds WHERE round_id = '0199-a'").One(&got); err != nil {
		t.Fatal(err)
	}
	if got.Source != SourceCSV || *got.Score != 1250000 || got.Device != "tsum-left" {
		t.Fatalf("merged row: %+v", got)
	}
	var n int
	_ = app.DB().NewQuery("SELECT COUNT(*) FROM ts_rounds").Row(&n)
	if n != 2 {
		t.Fatalf("want 2 rounds, got %d", n)
	}
}

func TestFiltersAndSummary(t *testing.T) {
	app := testApp(t)
	add := func(id, at, tsum, build string, score, coins int64) {
		if err := upsertRound(app.DB(), Round{ID: id, PlayedAt: at, Tsum: tsum, Build: build, Score: &score, FinalCoins: &coins, Source: SourceCSV}); err != nil {
			t.Fatal(err)
		}
	}
	add("1", "2026-09-01 10:00:00", "mickey", "global", 1000, 500)
	add("2", "2026-09-01 23:30:00", "mickey", "global", 3000, 900)
	add("3", "2026-09-02 10:00:00", "abu", "jp", 2000, 700)
	if err := upsertRound(app.DB(), Round{ID: "4", PlayedAt: "2026-09-02 11:00:00", Tsum: "abu", Build: "jp", Source: SourceCSV}); err != nil {
		t.Fatal(err)
	}

	// These rounds have no times, so they count only with incomplete rounds kept.
	f := ParseFilter(url.Values{"tsum": {"mickey"}, "minCoins": {"600"}, "coins": {"final"}, "incomplete": {"1"}})
	rows, err := RoundsPage(app.DB(), f, "-score", 1, 50)
	if err != nil || len(rows) != 1 || rows[0].ID != "2" {
		t.Fatalf("filtered rows: %+v %v", rows, err)
	}

	rows, _ = RoundsPage(app.DB(), Filter{}, "score", 1, 50)
	if len(rows) != 4 || rows[0].ID != "1" || rows[3].ID != "4" {
		t.Fatalf("ascending score with NULL last: %+v", rows)
	}

	f = ParseFilter(url.Values{"from": {"2026-09-02T00:00:00.000Z"}, "build": {"jp"}, "incomplete": {"1"}})
	s, err := Summarize(app.DB(), f, 0)
	if err != nil || s.Totals.Rounds != 2 || *s.Totals.AvgScore != 2000 {
		t.Fatalf("summary: %+v %v", s.Totals, err)
	}

	// UTC 23:30 on the 1st is the 2nd for a viewer at UTC+1.
	s, _ = Summarize(app.DB(), Filter{}, 60)
	if len(s.Daily) != 2 || s.Daily[0].Rounds != 1 || s.Daily[1].Rounds != 3 {
		t.Fatalf("daily buckets: %+v", s.Daily)
	}
}

func TestCoinEfficiency(t *testing.T) {
	app := testApp(t)
	add := func(id, tsum string, coins int64, secs float64, settings string) {
		c, b, d := coins, coins/2, secs
		if err := upsertRound(app.DB(), Round{ID: id, PlayedAt: "2026-09-01 10:00:00", Tsum: tsum, Build: "global",
			FinalCoins: &c, BaseCoins: &b, Duration: &d, Settings: settings, Source: SourceCSV}); err != nil {
			t.Fatal(err)
		}
	}
	add("1", "mickey", 100, 50, `{"bonusCoin":true,"bonus5to4":false}`)
	add("2", "mickey", 200, 50, `{"bonusCoin":true,"bonus5to4":true}`)
	add("3", "mickey", 300, 100, `{"bonusCoin":false}`)
	add("4", "mickey", 400, 100, `{}`)
	add("5", "abu", 5000, 100, `{}`)

	// Base coins are the default basis.
	s, err := Summarize(app.DB(), Filter{Tsums: []string{"mickey"}}, 0)
	if err != nil || *s.Totals.MinCoins != 50 || *s.Totals.AvgFinal != 250 || *s.Totals.CoinsPerSec != 500.0/300 {
		t.Fatalf("base totals: %+v %v", s.Totals, err)
	}

	s, _ = Summarize(app.DB(), Filter{Tsums: []string{"mickey"}, FinalCoins: true}, 0)
	tt := s.Totals
	if *tt.MinCoins != 100 || *tt.MaxCoins != 400 || *tt.CoinsPerSec != 1000.0/300 {
		t.Fatalf("totals: %+v", tt)
	}
	if *tt.Median != 200 || *tt.Q1 != 100 || *tt.Q3 != 300 || math.Abs(*tt.StdCoins-math.Sqrt(12500)) > 1e-9 {
		t.Fatalf("spread: %+v", tt.Spread)
	}
	items := map[int]int64{}
	for _, m := range s.Mix {
		items[m.Items] += m.Rounds
	}
	if items[1] != 1 || items[3] != 1 || items[0] != 1 || items[-1] != 1 {
		t.Fatalf("items: %+v", s.Mix)
	}
	if s.Histogram.Width != 20 || s.Histogram.Cap != nil || len(s.Hours) != 1 || s.Hours[0].Hour != 10 {
		t.Fatalf("histogram %d, hours %+v", s.Histogram.Width, s.Hours)
	}

	// abu's 5000 is past Q3 + 1.5 × IQR, so it lands in the capped last bucket.
	s, _ = Summarize(app.DB(), Filter{FinalCoins: true}, 0)
	last := s.Histogram.Bins[len(s.Histogram.Bins)-1]
	if s.Histogram.Cap == nil || last.From != *s.Histogram.Cap || last.Tsum != "abu" {
		t.Fatalf("capped histogram: cap %v, bins %+v", s.Histogram.Cap, s.Histogram.Bins)
	}

	rows, _ := RoundsPage(app.DB(), Filter{}, "-coinsPerSec", 1, 50)
	if rows[0].ID != "5" || rows[1].Items != nil || rows[2].Items == nil || *rows[2].Items != 3 || *rows[3].Items != 0 {
		t.Fatalf("rows by coin rate: %+v", rows)
	}
}

func TestMedalStat(t *testing.T) {
	app := testApp(t)
	add := func(id string, medals *int64, secs float64) {
		c, d := int64(1000), secs
		if err := upsertRound(app.DB(), Round{ID: id, PlayedAt: "2026-09-01 10:00:00", Tsum: "mickey", Build: "global",
			BaseCoins: &c, Medals: medals, Duration: &d, Source: SourceCSV}); err != nil {
			t.Fatal(err)
		}
	}
	m := func(v int64) *int64 { return &v }
	add("1", m(3), 60)
	add("2", m(5), 60)
	add("3", m(0), 60)
	add("4", nil, 60)

	// Only the two rounds that earned medals count, and the figures are medals.
	s, err := Summarize(app.DB(), Filter{Medals: true}, 0)
	if err != nil || s.Totals.Rounds != 2 || *s.Totals.TotalCoins != 8 || *s.Totals.MinCoins != 3 || *s.Totals.CoinsPerSec != 8.0/120 {
		t.Fatalf("medal totals: %+v %v", s.Totals, err)
	}
	if s.Medals.Totals.Rounds != 2 || len(s.Medals.Tsums) != 1 {
		t.Fatalf("medal set in medal mode: %+v", s.Medals)
	}

	// With coins primary, the medal set still counts only the rounds with medals.
	s, _ = Summarize(app.DB(), Filter{}, 0)
	mt := s.Medals.Totals
	if s.Totals.Rounds != 4 || *s.Totals.TotalCoins != 4000 || mt.Rounds != 2 || *mt.TotalCoins != 8 || *mt.Median != 3 || *s.Medals.Tsums[0].MaxCoins != 5 {
		t.Fatalf("medal set beside coins: %+v / %+v", s.Totals, mt)
	}
	if f := ParseFilter(url.Values{"coins": {"medals"}}); !f.Medals || f.FinalCoins {
		t.Fatalf("parse: %+v", f)
	}
}

func TestCompleteRoundsAndRanges(t *testing.T) {
	app := testApp(t)
	m := func(v int64) *int64 { return &v }
	add := func(id, tsum string, score, base, medals *int64) {
		d := 60.0
		var final *int64
		if base != nil {
			final = m(*base * 2)
		}
		if err := upsertRound(app.DB(), Round{ID: id, PlayedAt: "2026-09-01 10:00:00", Tsum: tsum, Build: "global",
			Score: score, BaseCoins: base, FinalCoins: final, Medals: medals, Duration: &d, Source: SourceCSV}); err != nil {
			t.Fatal(err)
		}
	}
	add("1", "mickey", m(1000), m(500), m(20))
	add("2", "mickey", m(2000), m(900), nil) // mickey earns medals: incomplete
	add("3", "abu", m(3000), m(700), nil)    // abu never does: complete
	add("4", "abu", nil, m(800), m(0))       // no score: incomplete
	add("5", "", m(4000), m(600), m(0))      // no Tsum: incomplete
	add("6", "mickey", m(9000), m(5000), m(400))

	ids := func(q url.Values) string {
		rows, err := RoundsPage(app.DB(), ParseFilter(q), "playedAt", 1, 50)
		if err != nil {
			t.Fatal(err)
		}
		var out []string
		for _, r := range rows {
			out = append(out, r.ID)
		}
		return strings.Join(out, ",")
	}
	for _, c := range []struct {
		q    url.Values
		want string
	}{
		{url.Values{}, "1,3,6"},
		{url.Values{"incomplete": {"1"}}, "1,2,3,4,5,6"},
		{url.Values{"maxScore": {"5000"}, "maxCoins": {"1000"}}, "1,3"},
		{url.Values{"minCoins": {"1500"}, "coins": {"final"}}, "6"},
		// The medal range only judges mickey, the Tsum that earns medals.
		{url.Values{"maxMedals": {"100"}}, "1,3"},
		{url.Values{"minMedals": {"100"}}, "3,6"},
	} {
		if got := ids(c.q); got != c.want {
			t.Errorf("%v: got %s, want %s", c.q, got, c.want)
		}
	}
	if got, _ := MedalTsums(app.DB()); len(got) != 1 || got[0] != "mickey" {
		t.Fatalf("medal Tsums: %v", got)
	}
}

func TestTsumListReplaced(t *testing.T) {
	app := testApp(t)
	one := int64(1)
	if err := replaceTsumList(app.DB(), "tsum_list_20260920-140211.csv", "global", "tsum-left", "20260920-140211", []OwnedTsum{{Order: &one, Tsum: "abu"}}); err != nil {
		t.Fatal(err)
	}
	// The script rewrites the file after every page; the re-import replaces it.
	if err := replaceTsumList(app.DB(), "tsum_list_20260920-140211.csv", "global", "tsum-left", "20260920-140211", []OwnedTsum{{Tsum: "abu", SkillProgress: &one}, {Tsum: "mickey"}}); err != nil {
		t.Fatal(err)
	}
	l, err := LatestTsumList(app.DB(), "global", "tsum-left")
	if err != nil || l == nil || len(l.Items) != 2 || l.Tsums != 2 || *l.Items[0].SkillProgress != 1 {
		t.Fatalf("list: %+v %v", l, err)
	}
	if l, _ := LatestTsumList(app.DB(), "jp", "tsum-left"); l != nil {
		t.Fatal("no JP list was imported")
	}
}

func TestTsumListByDevice(t *testing.T) {
	app := testApp(t)
	for _, l := range []struct{ file, device, stamp, tsum string }{
		{"tsum_list_20260920-140211.csv", "tsum-left", "20260920-140211", "abu"},
		{"tsum_list_20260921-090000.csv", "tsum-right", "20260921-090000", "mickey"},
		{"tsum_list_20260901-090000.csv", "", "20260901-090000", "minnie"},
	} {
		if err := replaceTsumList(app.DB(), l.file, "global", l.device, l.stamp, []OwnedTsum{{Tsum: l.tsum}}); err != nil {
			t.Fatal(err)
		}
	}
	if l, _ := LatestTsumList(app.DB(), "global", "tsum-left"); l == nil || l.Items[0].Tsum != "abu" {
		t.Fatalf("tsum-left's list: %+v", l)
	}
	if l, _ := LatestTsumList(app.DB(), "global", ""); l == nil || l.Items[0].Tsum != "minnie" {
		t.Fatalf("lists with no device are their own: %+v", l)
	}
	src, err := TsumListSources(app.DB())
	if err != nil || len(src) != 3 || src[0].Device != "" || src[1].Device != "tsum-left" || src[2].Device != "tsum-right" {
		t.Fatalf("sources: %+v %v", src, err)
	}
}

func TestListDeviceFromFolder(t *testing.T) {
	root := filepath.Join(t.TempDir(), "collected")
	im := &Importer{dirs: []string{root}}
	for path, want := range map[string]string{
		filepath.Join(root, "127.0.0.1_5555", "tsum_record", "tsum_list_1.csv"): "127.0.0.1_5555",
		filepath.Join(root, "tsum_list_1.csv"):                                  "",
		filepath.Join(filepath.Dir(root), "elsewhere", "tsum_list_1.csv"):       "",
	} {
		if got := im.folderDevice(path); got != want {
			t.Errorf("%s: got %q, want %q", path, got, want)
		}
	}
}

func TestNormalizeTime(t *testing.T) {
	for in, want := range map[string]string{
		"2026-09-04 11:20:31":       "2026-09-04 11:20:31",
		"2026-09-04T11:20:31.118Z":  "2026-09-04 11:20:31",
		"2026-09-04T13:20:31+02:00": "2026-09-04 11:20:31",
	} {
		if got, ok := normalizeTime(in); !ok || got != want {
			t.Errorf("%s: got %q", in, got)
		}
	}
}

func TestHeartbeatAnnouncesDevices(t *testing.T) {
	var got []Device
	ev := NewEvents(nil, "", func(d []Device) { got = d }, nil)
	ev.update("tsum-left", func(d *Device) { d.conns++ })
	got = nil
	ev.handle("tsum-left", wireLine{Type: "heartbeat"})
	if len(got) != 1 || !got[0].Online {
		t.Fatalf("heartbeat announced %+v", got)
	}
}

func TestAddSkillProgress(t *testing.T) {
	app := testApp(t)
	// A database from before skill_progress, with a Tsum list already read.
	for _, q := range []string{
		`DROP TABLE ts_owned`,
		`CREATE TABLE ts_owned (list_id INTEGER, ord INTEGER, tsum TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
			level INTEGER, level_cap INTEGER, skill INTEGER, skill_max INTEGER, acquired TEXT NOT NULL DEFAULT '')`,
		`INSERT INTO ts_imports (path, size, mtime) VALUES ('a/tsum_list_1.csv', 1, 1), ('a/stats_1.csv', 1, 1)`,
	} {
		if _, err := app.DB().NewQuery(q).Execute(); err != nil {
			t.Fatal(err)
		}
	}
	if err := migrate(app); err != nil {
		t.Fatal(err)
	}
	var n int
	if err := app.DB().NewQuery(`SELECT COUNT(*) FROM ts_imports WHERE path NOT LIKE 'migration:%'`).Row(&n); err != nil || n != 1 {
		t.Fatalf("only the Tsum list is read again: %d %v", n, err)
	}
	if _, err := LatestTsumList(app.DB(), "global", ""); err != nil {
		t.Fatal(err)
	}
}
