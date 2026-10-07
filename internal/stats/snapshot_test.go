package stats

import (
	"encoding/json"
	"fmt"
	"github.com/pocketbase/pocketbase/core"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"testing/fstest"
	"time"
)

// fillRounds stores about 500 varied rounds over six weeks: three months, unread
// figures, zero and missing times, unidentified Tsums and both builds.
func fillRounds(t *testing.T, add func(Round)) int {
	t.Helper()
	seed := uint64(7)
	next := func(n int) int { // a small deterministic generator, so a failure repeats
		seed = seed*6364136223846793005 + 1442695040888963407
		return int((seed >> 33) % uint64(n))
	}
	tsums := []string{"mickey", "abu", "elsa", "stitch", "", "mickey", "mickey"}
	devices := []string{"pixel-7", "tab-s8", ""}
	start := time.Date(2026, 8, 20, 6, 0, 0, 0, time.UTC)
	n := 500
	for i := 0; i < n; i++ {
		at := start.Add(time.Duration(i)*130*time.Minute + time.Duration(next(50))*time.Second)
		r := Round{
			ID: fmt.Sprintf("r%04d", i), PlayedAt: at.Format(sqlTime), Tsum: tsums[next(len(tsums))],
			Build: []string{"global", "global", "jp"}[next(3)], SkillType: "burst", ScriptVersion: "4.0b1",
			Device: devices[next(len(devices))], Source: SourceCSV, Settings: "{}",
		}
		num := func(max int) *int64 {
			if next(10) == 0 {
				return nil
			}
			v := int64(next(max))
			return &v
		}
		r.Score, r.BaseCoins, r.Medals = num(4000000), num(9000), num(600)
		// stitch never earns medals, so its blank medals leave a round complete.
		if r.Tsum == "stitch" && r.Medals != nil {
			*r.Medals = 0
		}
		if r.BaseCoins != nil {
			f := *r.BaseCoins * 13 / 10
			r.FinalCoins = &f
		}
		switch next(12) {
		case 0:
		case 1:
			d := 0.0
			r.Duration = &d
		default:
			d := 40 + float64(next(1500))/10
			r.Duration = &d
		}
		if next(5) != 0 {
			settings := map[string]bool{}
			for _, b := range itemBits {
				settings[b.key] = next(2) == 0
			}
			data, _ := json.Marshal(settings)
			r.Settings = string(data)
		}
		add(r)
	}
	return n
}

func TestSnapshotFiles(t *testing.T) {
	app := testApp(t)
	fillRounds(t, func(r Round) {
		if err := upsertRound(app.DB(), r); err != nil {
			t.Fatal(err)
		}
	})
	addTsumLists(t, app)
	site := fstest.MapFS{
		"index.html":        {Data: []byte("<html><head><title>x</title></head><body></body></html>")},
		"themes/ember.css":    {Data: []byte("/* @name Ember */")},
		"assets/app.js":     {Data: []byte("1")},
		"data/catalog.json": {Data: []byte("{}")},
	}
	dir := t.TempDir()
	res, err := ExportSnapshot(app.DB(), site, dir, SnapshotOptions{Version: "test", Now: time.Unix(0, 0)})
	if err != nil {
		t.Fatal(err)
	}
	if res.Rounds != 500 || res.Months != 3 {
		t.Fatalf("want 500 rounds in 3 months (Aug, Sep, Oct), got %+v", res)
	}
	html, _ := os.ReadFile(filepath.Join(dir, "index.html"))
	if !strings.Contains(string(html), snapshotMeta) {
		t.Fatal("index.html is not tagged as a snapshot")
	}
	for _, f := range []string{".nojekyll", "assets/app.js", "data/catalog.json", "data/snapshot/manifest.json", "data/snapshot/rounds-2026-09.json", "data/snapshot/owned-1.json"} {
		if _, err := os.Stat(filepath.Join(dir, f)); err != nil {
			t.Errorf("missing %s", f)
		}
	}

	// A second export of the same data changes nothing, so a publisher has nothing to upload.
	res, err = ExportSnapshot(app.DB(), site, dir, SnapshotOptions{Version: "test", Now: time.Unix(0, 0)})
	if err != nil || res.Files != 0 {
		t.Fatalf("an unchanged export wrote %d files (%v)", res.Files, err)
	}

	// Only the newest month changes when a round arrives.
	late := Round{ID: "z", PlayedAt: "2026-10-30 12:00:00", Tsum: "mickey", Build: "global", Source: SourceCSV}
	if err := upsertRound(app.DB(), late); err != nil {
		t.Fatal(err)
	}
	res, err = ExportSnapshot(app.DB(), site, dir, SnapshotOptions{Version: "test", Now: time.Unix(0, 0)})
	if err != nil || res.Files != 2 { // that month's file and the manifest that lists it
		t.Fatalf("a new round should rewrite its month and the manifest, wrote %d (%v)", res.Files, err)
	}

	// Devices are anonymous by default.
	data, _ := os.ReadFile(filepath.Join(dir, "data/snapshot/rounds-2026-09.json"))
	var m monthFile
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatal(err)
	}
	for _, d := range m.Dict.Device {
		if d != "" && !strings.HasPrefix(d, "Device ") {
			t.Errorf("device %q leaked into the snapshot", d)
		}
	}
	if m.N != len(m.At) || m.N != len(m.Score) || m.N != len(m.Items) {
		t.Errorf("columns disagree about the row count: %+v", m.N)
	}
	// So are the manifest's devices and each device's Tsum list.
	data, _ = os.ReadFile(filepath.Join(dir, "data/snapshot/manifest.json"))
	var man snapshotManifest
	if err := json.Unmarshal(data, &man); err != nil {
		t.Fatal(err)
	}
	for _, d := range man.Devices {
		if !strings.HasPrefix(d.Device, "Device ") {
			t.Errorf("device %q leaked into the manifest", d.Device)
		}
	}
	lists := man.Owned
	if len(lists) != 2 || !strings.HasPrefix(lists[0].Device, "Device ") {
		t.Fatalf("per-device Tsum lists: %+v", lists)
	}
	data, _ = os.ReadFile(filepath.Join(dir, "data/snapshot", lists[0].File))
	if strings.Contains(string(data), "pixel-7") || strings.Contains(string(data), "tab-s8") {
		t.Errorf("a device name leaked into %s", lists[0].File)
	}
}

// addTsumLists gives two of fillRounds' devices a global Tsum list each.
func addTsumLists(t *testing.T, app core.App) {
	t.Helper()
	for _, l := range []struct{ file, device, stamp, tsum string }{
		{"tsum_list_20260920-140211.csv", "pixel-7", "20260920-140211", "abu"},
		{"tsum_list_20260921-090000.csv", "tab-s8", "20260921-090000", "mickey"},
	} {
		if err := replaceTsumList(app.DB(), l.file, "global", l.device, l.stamp, []OwnedTsum{{Tsum: l.tsum}}); err != nil {
			t.Fatal(err)
		}
	}
}

// TestSnapshotParity holds the browser engine to the server's answers: the same
// rounds, the same filters, the same numbers.
func TestSnapshotParity(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	script, _ := filepath.Abs("../../ui/tests/parity.mjs")
	if _, err := os.Stat(script); err != nil {
		t.Skip("no ui/tests/parity.mjs")
	}

	app := testApp(t)
	fillRounds(t, func(r Round) {
		if err := upsertRound(app.DB(), r); err != nil {
			t.Fatal(err)
		}
	})
	addTsumLists(t, app)
	dir := t.TempDir()
	// Keep the device names so rounds can be compared whole.
	if _, err := ExportSnapshot(app.DB(), fstest.MapFS{"index.html": {Data: []byte("<head></head>")}}, dir, SnapshotOptions{Devices: DevicesKeep}); err != nil {
		t.Fatal(err)
	}

	type testCase struct {
		Name       string         `json:"name"`
		Route      string         `json:"route"`
		Params     map[string]any `json:"params"`
		Expected   any            `json:"expected"`
		TieProne   bool           `json:"tieProne,omitempty"`
		SortColumn string         `json:"sortColumn,omitempty"`
		CoinColumn string         `json:"coinColumn,omitempty"`
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
	values := func(p map[string]string) url.Values {
		q := url.Values{}
		for k, v := range p {
			q.Set(k, v)
		}
		return q
	}
	summary := func(name string, p map[string]string) {
		tz := 0
		fmt.Sscan(p["tz"], &tz)
		s, err := Summarize(app.DB(), ParseFilter(values(p)), tz)
		if err != nil {
			t.Fatal(err)
		}
		params := map[string]any{}
		for k, v := range p {
			params[k] = v
		}
		cases = append(cases, testCase{Name: "summary " + name, Route: "summary", Params: params, Expected: roundtrip(s)})
	}
	roundsCase := func(name string, p map[string]string, tieProne bool) {
		page, perPage := 0, 0
		fmt.Sscan(p["page"], &page)
		fmt.Sscan(p["perPage"], &perPage)
		f := ParseFilter(values(p))
		rows, err := RoundsPage(app.DB(), f, p["sort"], page, perPage)
		if err != nil {
			t.Fatal(err)
		}
		params := map[string]any{}
		for k, v := range p {
			params[k] = v
		}
		c := testCase{Name: "rounds " + name, Route: "rounds", Params: params,
			Expected: roundtrip(map[string]any{"items": rows, "page": max(page, 1)}), TieProne: tieProne,
			SortColumn: strings.TrimPrefix(p["sort"], "-"), CoinColumn: map[bool]string{true: "finalCoins", false: "baseCoins"}[p["coins"] == "final"]}
		if p["net"] == "1" {
			c.CoinColumn = "net:" + c.CoinColumn
		}
		cases = append(cases, c)
	}

	summary("everything", map[string]string{})
	summary("east of UTC", map[string]string{"tz": "540"})
	summary("west of UTC", map[string]string{"tz": "-300"})
	summary("half-hour zone", map[string]string{"tz": "330"})
	summary("two Tsums", map[string]string{"tsum": "mickey, abu"})
	summary("not identified", map[string]string{"tsum": ""})
	summary("jp", map[string]string{"build": "jp"})
	summary("two devices", map[string]string{"device": "pixel-7, tab-s8"})
	summary("one device and a Tsum", map[string]string{"device": "tab-s8", "tsum": "mickey"})
	summary("final coins", map[string]string{"coins": "final"})
	summary("medals", map[string]string{"coins": "medals", "tz": "60"})
	summary("minimums", map[string]string{"minCoins": "3000", "minScore": "1000000"})
	summary("minimums on final", map[string]string{"minCoins": "3000", "coins": "final"})
	summary("minimum on medals", map[string]string{"minCoins": "200", "coins": "medals"})
	summary("incomplete kept", map[string]string{"incomplete": "1"})
	summary("incomplete kept, minimums", map[string]string{"incomplete": "1", "minCoins": "3000", "minScore": "1000000"})
	summary("ranges", map[string]string{"minCoins": "1000", "maxCoins": "7000", "minScore": "500000", "maxScore": "3500000"})
	summary("medal range", map[string]string{"minMedals": "100", "maxMedals": "500"})
	summary("medal range, incomplete kept", map[string]string{"maxMedals": "300", "incomplete": "1", "coins": "final"})
	summary("ranges in medal mode", map[string]string{"maxCoins": "5000", "minMedals": "50", "coins": "medals"})
	summary("range, sql time", map[string]string{"from": "2026-09-01 00:00:00", "to": "2026-09-08 00:00:00"})
	summary("range, iso", map[string]string{"from": "2026-08-31T22:00:00.000Z", "to": "2026-09-15T22:00:00.000Z", "tz": "120"})
	summary("range inside one month", map[string]string{"from": "2026-09-10T00:00:00Z", "to": "2026-09-11T00:00:00Z"})
	summary("nothing matches", map[string]string{"from": "2030-01-01T00:00:00Z"})
	summary("unknown Tsum", map[string]string{"tsum": "nope"})
	summary("junk numbers", map[string]string{"minCoins": "abc", "minScore": "12.7"})
	summary("net", map[string]string{"net": "1"})
	summary("net final", map[string]string{"net": "1", "coins": "final", "tz": "-300"})
	summary("net, incomplete kept", map[string]string{"net": "1", "incomplete": "1"})
	summary("net range", map[string]string{"net": "1", "minCoins": "-1000", "maxCoins": "4000"})
	summary("net range in medal mode", map[string]string{"net": "1", "maxCoins": "3000", "coins": "medals"})
	summary("everything filtered", map[string]string{"tsum": "elsa", "build": "global", "minCoins": "100", "coins": "final", "from": "2026-09-01T00:00:00Z", "tz": "-480"})

	roundsCase("newest first", map[string]string{}, false)
	roundsCase("oldest first", map[string]string{"sort": "playedAt", "perPage": "30", "page": "3"}, false)
	roundsCase("score", map[string]string{"sort": "-score", "perPage": "40"}, true)
	roundsCase("score ascending", map[string]string{"sort": "score", "perPage": "40", "page": "2"}, true)
	roundsCase("final coins", map[string]string{"sort": "-finalCoins", "perPage": "25"}, true)
	roundsCase("medals", map[string]string{"sort": "medals", "perPage": "25"}, true)
	roundsCase("duration", map[string]string{"sort": "-durationSeconds", "perPage": "25"}, true)
	roundsCase("tsum", map[string]string{"sort": "tsum", "perPage": "60", "page": "2"}, true)
	roundsCase("device", map[string]string{"sort": "-device", "perPage": "60"}, true)
	roundsCase("coins a second", map[string]string{"sort": "-coinsPerSec", "perPage": "25"}, true)
	roundsCase("coins a second, final", map[string]string{"sort": "coinsPerSec", "perPage": "25", "coins": "final"}, true)
	roundsCase("medals a second", map[string]string{"sort": "-medalsPerSec", "perPage": "25", "coins": "medals"}, true)
	roundsCase("coins a second, net", map[string]string{"sort": "-coinsPerSec", "perPage": "25", "net": "1"}, true)
	roundsCase("coins a second, net final", map[string]string{"sort": "coinsPerSec", "perPage": "25", "coins": "final", "net": "1"}, true)
	roundsCase("net range", map[string]string{"net": "1", "minCoins": "0", "sort": "-playedAt"}, false)
	roundsCase("unknown sort", map[string]string{"sort": "bogus"}, false)
	roundsCase("largest page", map[string]string{"perPage": "200"}, false)
	roundsCase("too large a page size", map[string]string{"perPage": "500", "page": "1"}, false)
	roundsCase("past the end", map[string]string{"page": "999"}, false)
	roundsCase("incomplete kept", map[string]string{"incomplete": "1", "sort": "-score", "perPage": "40"}, true)
	roundsCase("ranges", map[string]string{"maxCoins": "6000", "minMedals": "10", "sort": "-playedAt"}, false)
	roundsCase("filtered", map[string]string{"tsum": "mickey", "build": "jp", "minScore": "500000", "sort": "-playedAt", "perPage": "20", "from": "2026-09-01T00:00:00Z"}, false)

	tsums, _ := PlayedTsums(app.DB())
	devices, _ := PlayedDevices(app.DB())
	cases = append(cases, testCase{Name: "played devices", Route: "round-devices", Params: map[string]any{}, Expected: roundtrip(devices)})
	srcs, _ := TsumListSources(app.DB())
	cases = append(cases, testCase{Name: "owned sources", Route: "owned-sources", Params: map[string]any{}, Expected: roundtrip(srcs)})
	for _, src := range srcs {
		l, _ := LatestTsumList(app.DB(), src.Build, src.Device)
		cases = append(cases, testCase{Name: "owned " + src.Device, Route: "owned", Params: map[string]any{"build": src.Build, "device": src.Device},
			Expected: roundtrip(map[string]any{"list": l})})
	}
	cases = append(cases, testCase{Name: "played Tsums", Route: "tsums", Params: map[string]any{}, Expected: roundtrip(tsums)})

	data, _ := json.Marshal(cases)
	if err := os.WriteFile(filepath.Join(dir, "cases.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command(node, script, dir).CombinedOutput()
	t.Logf("%s", out)
	if err != nil {
		t.Fatalf("the snapshot's answers differ from the server's:\n%s", out)
	}
}
