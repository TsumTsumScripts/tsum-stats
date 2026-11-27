package stats

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

// ownedAt is a Tsum List's rows from tsum → skill; each Tsum's level is ten times its skill.
func ownedAt(skills map[string]int64) []OwnedTsum {
	var out []OwnedTsum
	for t, s := range skills {
		level := s * 10
		out = append(out, OwnedTsum{Tsum: t, Skill: &s, Level: &level})
	}
	return out
}

func addList(t *testing.T, app core.App, build, device, stamp string, skills map[string]int64) string {
	t.Helper()
	file := "tsum_list_" + stamp + ".csv"
	if err := replaceTsumList(app.DB(), file, build, device, stamp, ownedAt(skills)); err != nil {
		t.Fatal(err)
	}
	return file
}

// addLevelRounds stores n rounds of tsum recorded at level, four minutes apart from start, on one device tag.
func addLevelRounds(t *testing.T, app core.App, build, device, tag, tsum string, level, n int, start time.Time) {
	t.Helper()
	for i := 0; i < n; i++ {
		base, secs := int64(1000+i), 100.0
		at := start.Add(time.Duration(i) * 4 * time.Minute)
		r := Round{ID: fmt.Sprintf("%08x-%04x-7000-8000-%s", at.Unix(), len(tsum)*97+level, tag), PlayedAt: at.Format(sqlTime), Tsum: tsum, Build: build,
			ScriptVersion: "5.0", Device: device, Source: SourceCSV, Duration: &secs, Score: &base, BaseCoins: &base, FinalCoins: &base,
			Settings: fmt.Sprintf(`{"skillLevel": %d, "bonusCoin": false}`, level)}
		if err := upsertRound(app.DB(), r); err != nil {
			t.Fatal(err)
		}
	}
}

// fillListed stores twelve "minnie" rounds recorded at level 6 on pixel-7, and
// a later Tsum List of that device reading level 2: the list rule counts them at 2.
func fillListed(t *testing.T, app core.App) {
	t.Helper()
	addLevelRounds(t, app, "global", "pixel-7", "00000000f1f1", "minnie", 6, 12, time.Date(2026, 9, 12, 8, 0, 0, 0, time.UTC))
	addList(t, app, "global", "pixel-7", "20260925-100000", map[string]int64{"minnie": 2, "pluto": 3, "goofy": 1, "chip": 4, "dale": 4, "pooh": 6})
}

var roster = map[string]int64{"a": 1, "b": 2, "c": 3, "d": 4, "e": 5, "f": 6, "g": 1, "h": 2}

func with(base map[string]int64, changes map[string]int64) map[string]int64 {
	out := map[string]int64{}
	for k, v := range base {
		out[k] = v
	}
	for k, v := range changes {
		if v == 0 {
			delete(out, k)
		} else {
			out[k] = v
		}
	}
	return out
}

func TestAccountsAreGroupedByWhatTheListsSay(t *testing.T) {
	app := testApp(t)
	// One account under two device names, levelling up and gaining a Tsum; a partial scan of it.
	addList(t, app, "global", "emu", "20260901-000000", roster)
	addList(t, app, "global", "emu", "20260903-000000", with(roster, map[string]int64{"a": 2, "i": 1}))
	addList(t, app, "global", "emu-renamed", "20260905-000000", with(roster, map[string]int64{"a": 2, "i": 1, "b": 0, "c": 0}))
	// The same emulator later holds a new account: the same Tsums, lower levels.
	fresh := map[string]int64{"a": 1, "b": 1, "c": 1, "d": 1, "e": 1, "f": 1}
	addList(t, app, "global", "emu", "20260910-000000", fresh)
	// An older account whose list comes later and never contradicts the new one, but shares no levels with it.
	addList(t, app, "global", "other", "20260912-000000", map[string]int64{"a": 6, "b": 6, "c": 6, "d": 6, "e": 6, "f": 6})
	// Another game is another account whatever it says; a list with nothing read is none.
	addList(t, app, "jp", "emu", "20260902-000000", roster)
	if err := replaceTsumList(app.DB(), "tsum_list_20260902-010101.csv", "global", "blank", "20260902-010101", []OwnedTsum{{Tsum: "a"}}); err != nil {
		t.Fatal(err)
	}
	accounts, err := loadAccounts(app.DB())
	if err != nil {
		t.Fatal(err)
	}
	var got []string
	for _, a := range accounts {
		got = append(got, fmt.Sprintf("%s:%s:%d lists:%d tsums", a.Build, a.Label, len(a.Lists), a.Tsums))
	}
	want := []string{"global:emu, emu-renamed:3 lists:9 tsums", "global:emu:1 lists:6 tsums", "global:other:1 lists:6 tsums", "jp:emu:1 lists:8 tsums"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("accounts:\n got %v\nwant %v", got, want)
	}
	// One misread in a long roster does not split an account; a few do.
	long := map[string]int64{}
	for i := 0; i < 60; i++ {
		long[fmt.Sprintf("t%02d", i)] = 3
	}
	a := &Account{skill: map[string]int64{}, level: map[string]int64{}}
	a.add(AccountList{skill: long, level: map[string]int64{}})
	if !a.joins(&AccountList{skill: with(long, map[string]int64{"t00": 2}), level: map[string]int64{}}) {
		t.Error("one misread of 60 split the account")
	}
	if a.joins(&AccountList{skill: with(long, map[string]int64{"t00": 2, "t01": 2, "t02": 1}), level: map[string]int64{}}) {
		t.Error("three levels going down still joined")
	}
}

func TestListBounds(t *testing.T) {
	list := func(at string, skill int64) AccountList {
		return AccountList{At: at, Stamp: at, skill: map[string]int64{"x": skill}, level: map[string]int64{}}
	}
	a := &Account{Lists: []AccountList{list("2026-10-02 00:00:00", 2), list("2026-10-06 00:00:00", 2), list("2026-10-10 00:00:00", 4)}}
	for _, c := range []struct {
		at        string
		level     int
		want      int
		which, by string
	}{
		{"2026-10-01 00:00:00", 6, 2, "cap", "2026-10-02 00:00:00"}, // before every list: at most the oldest reading
		{"2026-10-01 00:00:00", 1, 1, "", ""},                       // under it: stands, it may have levelled up since
		{"2026-10-04 00:00:00", 6, 2, "cap", "2026-10-06 00:00:00"}, // read 2 before and after
		{"2026-10-04 00:00:00", 1, 2, "floor", "2026-10-02 00:00:00"},
		{"2026-10-08 00:00:00", 3, 3, "", ""},                         // a level-up between two lists: anything from 2 to 4 stands
		{"2026-10-08 00:00:00", 1, 2, "floor", "2026-10-06 00:00:00"}, // the newest list before it
		{"2026-10-08 00:00:00", 6, 4, "cap", "2026-10-10 00:00:00"},
		{"2026-10-12 00:00:00", 6, 6, "", ""}, // after every list: no cap
		{"2026-10-12 00:00:00", 3, 4, "floor", "2026-10-10 00:00:00"},
		{"2026-10-04 00:00:00", 0, 0, "", ""}, // no level recorded: none given
	} {
		got, l, which := a.bound("x", c.at).clamp(c.level)
		by := ""
		if l != nil {
			by = l.At
		}
		if got != c.want || which != c.which || by != c.by {
			t.Errorf("level %d at %s: got %d (%s by %s), want %d (%s by %s)", c.level, c.at, got, which, by, c.want, c.which, c.by)
		}
	}
	if b := a.bound("y", "2026-10-04 00:00:00"); b.Floor != 0 || b.Cap != 0 {
		t.Errorf("a Tsum no list holds has bounds: %+v", b)
	}
	// Lists that read lower after than before say nothing of that Tsum.
	bad := &Account{Lists: []AccountList{list("2026-10-02 00:00:00", 5), list("2026-10-06 00:00:00", 2)}}
	if got, _, _ := bad.bound("x", "2026-10-04 00:00:00").clamp(6); got != 6 {
		t.Errorf("contradicting lists moved a round to %d", got)
	}
	if stampTime("20261006-054039") != "2026-10-06 05:40:39" {
		t.Error("a stamp is not read as UTC in played_at's form")
	}
}

func TestListsBoundTheLevelsOfLinkedRounds(t *testing.T) {
	app := testApp(t)
	day := func(d int) time.Time { return time.Date(2026, 10, d, 12, 0, 0, 0, time.UTC) }
	main := map[string]int64{"goofy": 5, "ariel": 6, "beast": 6, "abu": 3, "elsa": 4, "olaf": 2}
	fresh := map[string]int64{"goofy": 1, "ariel": 1, "beast": 1, "abu": 1, "elsa": 1, "olaf": 1}
	mainList := addList(t, app, "global", "emu-main", "20261005-000000", main)
	addList(t, app, "global", "phone", "20261020-000000", fresh)
	jp := addList(t, app, "jp", "jp-emu", "20261006-000000", map[string]int64{"goofy": 1, "ariel": 2, "beast": 4, "abu": 1, "elsa": 1})

	// JP has one account: its rounds are linked whatever their device. "6" was left in the setting.
	addLevelRounds(t, app, "jp", "", "aaaaaaaaaaaa", "goofy", 6, 30, day(1))
	addLevelRounds(t, app, "jp", "JP", "aaaaaaaaaaaa", "beast", 3, 5, day(2)) // under the cap: stands
	addLevelRounds(t, app, "jp", "", "aaaaaaaaaaaa", "beast", 3, 4, day(8))   // after the list read 4: at least 4
	addLevelRounds(t, app, "jp", "", "aaaaaaaaaaaa", "olaf", 6, 3, day(1))    // no list holds olaf
	// INTL has two accounts: a device name with lists of one is linked, an unnamed device is not.
	addLevelRounds(t, app, "global", "phone", "bbbbbbbbbbbb", "ariel", 3, 6, day(18))
	addLevelRounds(t, app, "global", "", "cccccccccccc", "ariel", 3, 40, day(3))
	if err := Refile(app.DB()); err != nil {
		t.Fatal(err)
	}
	levels := func() string {
		var rows []struct {
			K string `db:"k"`
			N int    `db:"n"`
		}
		if err := app.DB().NewQuery(`SELECT build || ' ' || tsum || ' ' || ` + stretchTagSQL + ` || ' ' || skill_level || '>' || skill_eff AS k, COUNT(*) AS n
			FROM ts_rounds GROUP BY k ORDER BY k`).All(&rows); err != nil {
			t.Fatal(err)
		}
		out := ""
		for _, r := range rows {
			out += fmt.Sprintf("%s x%d\n", r.K, r.N)
		}
		return out
	}
	want := "global ariel bbbbbbbbbbbb 3>1 x6\nglobal ariel cccccccccccc 3>3 x40\n" +
		"jp beast aaaaaaaaaaaa 3>3 x5\njp beast aaaaaaaaaaaa 3>4 x4\njp goofy aaaaaaaaaaaa 6>1 x30\njp olaf aaaaaaaaaaaa 6>6 x3\n"
	if got := levels(); got != want {
		t.Fatalf("levels:\n%s\nwant:\n%s", got, want)
	}
	fixes, _ := SkillFixes(app.DB(), "goofy")
	if len(fixes) != 1 || fixes[0].Rule != "list" || fixes[0].ListDevice != "jp-emu" || fixes[0].ListStamp != "20261006-000000" || fixes[0].ListLevel != 1 ||
		fixes[0].ListBound != "cap" || fixes[0].Rounds != 30 || fixes[0].From != 6 || fixes[0].To != 1 {
		t.Fatalf("goofy's fix: %+v", fixes)
	}

	acc, err := DescribeAccounts(app.DB())
	if err != nil {
		t.Fatal(err)
	}
	how := map[string]string{}
	for _, s := range acc.Stretches {
		how[s.Build+"/"+s.Device+"/"+s.Tag] = fmt.Sprintf("%s %d", s.How, s.Account)
	}
	if len(acc.Accounts) != 3 || how["jp//aaaaaaaaaaaa"] != "build 3" || how["jp/JP/aaaaaaaaaaaa"] != "build 3" ||
		how["global/phone/bbbbbbbbbbbb"] != "device 2" || how["global//cccccccccccc"] != " 0" {
		t.Fatalf("accounts %d, links %v", len(acc.Accounts), how)
	}
	var unnamed Stretch
	for _, s := range acc.Stretches {
		if s.Tag == "cccccccccccc" {
			unnamed = s
		}
	}
	if unnamed.Rounds != 40 || unnamed.TsumCount != 1 || len(unnamed.Tsums) != 1 || unnamed.Tsums[0].Tsum != "ariel" {
		t.Fatalf("the unnamed stretch: %+v", unnamed)
	}

	// The player names the unnamed device's account: the main one's list read ariel at 6 after its rounds, so 3 may stand...
	if err := LinkAccount(app.DB(), "global", "", "cccccccccccc", &mainList); err != nil {
		t.Fatal(err)
	}
	if got := levels(); got != want {
		t.Fatalf("a cap above the recorded level moved rounds:\n%s", got)
	}
	// ...the JP one's read 2: at most 2. (Any account can be named, a wrong game's too.)
	if err := LinkAccount(app.DB(), "global", "", "cccccccccccc", &jp); err != nil {
		t.Fatal(err)
	}
	moved := "global ariel bbbbbbbbbbbb 3>1 x6\nglobal ariel cccccccccccc 3>2 x40\n" +
		"jp beast aaaaaaaaaaaa 3>3 x5\njp beast aaaaaaaaaaaa 3>4 x4\njp goofy aaaaaaaaaaaa 6>1 x30\njp olaf aaaaaaaaaaaa 6>6 x3\n"
	if got := levels(); got != moved {
		t.Fatalf("after naming the account:\n%s\nwant:\n%s", got, moved)
	}
	// "Not known" for a stretch that would be linked by its game unlinks it; forgetting the answer links it again.
	none := ""
	if err := LinkAccount(app.DB(), "jp", "", "aaaaaaaaaaaa", &none); err != nil {
		t.Fatal(err)
	}
	var n int
	_ = app.DB().NewQuery(`SELECT COUNT(*) FROM ts_rounds WHERE tsum = 'goofy' AND skill_eff = '6'`).Row(&n)
	if n != 30 {
		t.Fatalf("an unlinked stretch kept its list levels: %d rounds at 6", n)
	}
	if err := LinkAccount(app.DB(), "jp", "", "aaaaaaaaaaaa", nil); err != nil {
		t.Fatal(err)
	}
	if err := LinkAccount(app.DB(), "global", "", "cccccccccccc", nil); err != nil {
		t.Fatal(err)
	}
	if got := levels(); got != want {
		t.Fatalf("after forgetting the answers:\n%s", got)
	}
	// The recorded levels never changed.
	_ = app.DB().NewQuery(`SELECT COUNT(*) FROM ts_rounds WHERE tsum = 'goofy' AND json_extract(settings, '$.skillLevel') = 6 AND skill_level = '6'`).Row(&n)
	if n != 30 {
		t.Fatalf("recorded levels changed: %d", n)
	}
}

// TestAccountsParity holds accounts.go to ui/src/lib/accounts.js, which the
// global Worker runs: the same lists, the same accounts, the same bounds.
func TestAccountsParity(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	script, _ := filepath.Abs("../../ui/tests/accounts-parity.mjs")
	if _, err := os.Stat(script); err != nil {
		t.Skip("no ui/tests/accounts-parity.mjs")
	}
	type jsList struct {
		ID    string           `json:"id"`
		Build string           `json:"build"`
		At    string           `json:"at"`
		Skill map[string]int64 `json:"skill"`
		Level map[string]int64 `json:"level"`
	}
	type ask struct {
		Account int    `json:"account"`
		Tsum    string `json:"tsum"`
		At      string `json:"at"`
		Level   int    `json:"level"`
	}
	type jsCase struct {
		Name  string   `json:"name"`
		Lists []jsList `json:"lists"`
		Asks  []ask    `json:"asks"`
	}
	g := &fixGen{seed: 3}
	tsums := []string{"a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"}
	var cases []jsCase
	var accounts [][]*Account
	for n := 0; n < 40; n++ {
		// A few accounts' lists in one stream: each account levels up now and then, a list may be partial,
		// misread a Tsum, read no skill at all, or come from the other game.
		type acct struct {
			build string
			skill map[string]int64
		}
		var accts []acct
		for k := 0; k < 1+g.next(3); k++ {
			a := acct{[]string{"global", "global", "jp"}[g.next(3)], map[string]int64{}}
			for _, ts := range tsums[:6+g.next(7)] {
				a.skill[ts] = int64(1 + g.next(6))
			}
			accts = append(accts, a)
		}
		var lists []AccountList
		var builds []string
		c := jsCase{Name: fmt.Sprintf("stream %d", n), Lists: []jsList{}}
		for i := 0; i < 3+g.next(10); i++ {
			a := accts[g.next(len(accts))]
			if g.next(3) == 0 {
				ts := tsums[g.next(len(tsums))]
				if a.skill[ts] > 0 && a.skill[ts] < 6 {
					a.skill[ts]++
				}
			}
			l := AccountList{File: fmt.Sprintf("list-%02d", i), At: fmt.Sprintf("2026-10-%02d 00:00:00", 1+i), skill: map[string]int64{}, level: map[string]int64{}}
			for ts, s := range a.skill {
				if g.next(8) == 0 {
					continue
				}
				if g.next(40) == 0 {
					s = max(1, s-1)
				}
				if g.next(15) != 0 {
					l.level[ts] = s * 10
				}
				l.skill[ts] = s
			}
			if g.next(12) == 0 {
				l.skill, l.level = map[string]int64{}, map[string]int64{}
			}
			c.Lists = append(c.Lists, jsList{l.File, a.build, l.At, l.skill, l.level})
			// loadAccounts leaves a list with nothing read out before grouping; accounts.js does it itself.
			if len(l.skill) > 0 {
				lists, builds = append(lists, l), append(builds, a.build)
			}
		}
		got := groupAccounts(lists, builds)
		for q := 0; q < 30 && len(got) > 0; q++ {
			c.Asks = append(c.Asks, ask{g.next(len(got)), tsums[g.next(len(tsums))], fmt.Sprintf("2026-10-%02d %02d:00:00", g.next(16), 12*g.next(2)), g.next(8)})
		}
		cases = append(cases, c)
		accounts = append(accounts, got)
	}
	data, _ := json.Marshal(cases)
	file := filepath.Join(t.TempDir(), "cases.json")
	if err := os.WriteFile(file, data, 0o644); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command(node, script, file).Output()
	if err != nil {
		t.Fatalf("accounts-parity.mjs: %v\n%s", err, out)
	}
	var js []struct {
		Accounts [][]string `json:"accounts"`
		Answers  [][2]int   `json:"answers"`
	}
	if err := json.Unmarshal(out, &js); err != nil {
		t.Fatal(err)
	}
	several, moved := 0, 0
	for k, c := range cases {
		var ids [][]string
		for _, a := range accounts[k] {
			var of []string
			for _, l := range a.Lists {
				of = append(of, l.File)
			}
			ids = append(ids, of)
		}
		if fmt.Sprint(ids) != fmt.Sprint(js[k].Accounts) {
			t.Fatalf("%s: accounts differ:\n Go %v\n JS %v", c.Name, ids, js[k].Accounts)
		}
		if len(ids) > 1 {
			several++
		}
		for i, q := range c.Asks {
			want, _, _ := accounts[k][q.Account].bound(q.Tsum, q.At).clamp(q.Level)
			if js[k].Answers[i] != [2]int{want, want} {
				t.Fatalf("%s: %+v counts at %d in Go, %v in JS (by the bound, by the segments)", c.Name, q, want, js[k].Answers[i])
			}
			if want != q.Level {
				moved++
			}
		}
	}
	if several < 10 || moved < 50 {
		t.Fatalf("%d cases with several accounts, %d levels moved: the data tests too little", several, moved)
	}
}
