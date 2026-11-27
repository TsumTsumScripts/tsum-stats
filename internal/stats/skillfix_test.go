package stats

import (
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

// fixGen makes rounds for the correction's tests: a small deterministic
// generator, so a failure repeats.
type fixGen struct {
	seed  uint64
	clock int
}

func (g *fixGen) next(n int) int {
	g.seed = g.seed*6364136223846793005 + 1442695040888963407
	return int((g.seed >> 33) % uint64(n))
}

// stretch is n rounds of one player at a recorded level, their coins about
// coins (±10 %); every ninth has no coins read.
func (g *fixGen) stretch(player string, level, n int, coins float64, trusted bool, context int) []fixRound {
	out := make([]fixRound, n)
	for i := range out {
		g.clock++
		out[i] = fixRound{ID: fmt.Sprintf("r%06d", g.clock), At: fmt.Sprintf("2026-10-01 %08d", g.clock), Player: player, Level: level,
			Trusted: trusted, Context: context, Value: int64(math.Round(coins * (0.9 + float64(g.next(2001))/10000)))}
		if g.next(9) == 0 {
			out[i].Value = 0
		}
	}
	return out
}

func joinRounds(parts ...[]fixRound) []fixRound {
	var out []fixRound
	for _, p := range parts {
		out = append(out, p...)
	}
	return out
}

// TestSkillFixParity holds skillfix.go to ui/src/lib/skillFix.js: the same
// rounds, the same effective levels, the same reasons.
func TestSkillFixParity(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node is not installed")
	}
	script, _ := filepath.Abs("../../ui/tests/skill-fix-parity.mjs")
	if _, err := os.Stat(script); err != nil {
		t.Skip("no ui/tests/skill-fix-parity.mjs")
	}
	g := &fixGen{seed: 11}
	apart := func() []fixRound {
		return joinRounds(g.stretch("c", 3, 300, 5000, true, 2), g.stretch("c", 4, 200, 7000, true, 2), g.stretch("c", 6, 300, 12000, true, 2))
	}
	type fixCase struct {
		Name   string
		Rounds []fixRound
		// Moved is how many rounds must count at another level, -1 for any number.
		Moved int
	}
	cases := []fixCase{
		{"sandwich up", joinRounds(g.stretch("a", 5, 200, 9000, false, 2), g.stretch("a", 3, 60, 9000, false, 2), g.stretch("a", 5, 150, 9000, false, 2)), 60},
		{"sandwich down", joinRounds(g.stretch("a", 1, 100, 1700, false, 0), g.stretch("a", 3, 25, 1700, false, 0), g.stretch("a", 1, 600, 1700, false, 0)), 25},
		{"progression", joinRounds(g.stretch("a", 3, 250, 7000, false, 2), g.stretch("a", 4, 220, 9000, true, 2), g.stretch("a", 5, 900, 12000, true, 2)), 0},
		{"down, other coins", joinRounds(g.stretch("a", 5, 300, 8000, false, 2), g.stretch("a", 2, 70, 4400, false, 2), g.stretch("a", 5, 300, 8000, false, 2)), 0},
		{"down, no majority", joinRounds(g.stretch("a", 5, 100, 8000, false, 2), g.stretch("a", 3, 300, 8000, false, 2)), 0},
		{"down, majority", joinRounds(g.stretch("a", 5, 300, 8000, false, 2), g.stretch("a", 3, 100, 8000, false, 2)), 100},
		{"other items", joinRounds(g.stretch("a", 5, 200, 9000, false, 2), g.stretch("a", 3, 60, 9000, false, 0), g.stretch("a", 5, 150, 9000, false, 2)), 0},
		{"trusted rule", joinRounds(apart(), g.stretch("a", 3, 500, 11800, false, 2), g.stretch("a", 4, 100, 12100, false, 2), g.stretch("a", 6, 200, 12000, true, 2)), 600},
		{"trusted rule, a real step", joinRounds(apart(), g.stretch("a", 3, 500, 5100, false, 2), g.stretch("a", 6, 200, 12000, true, 2)), 0},
		{"flat Tsum", joinRounds(g.stretch("c", 3, 300, 1700, true, 0), g.stretch("c", 6, 300, 1800, true, 0), g.stretch("a", 3, 500, 1750, false, 0), g.stretch("a", 6, 200, 1800, true, 0)), 0},
		{"trusted lower wins", joinRounds(g.stretch("a", 6, 800, 150, false, 0), g.stretch("a", 1, 700, 155, true, 0)), 800},
		{"two players", joinRounds(g.stretch("a", 3, 300, 5000, true, 2), g.stretch("a", 6, 300, 12000, true, 2), g.stretch("b", 3, 500, 12000, false, 2)), 0},
	}
	// A mess: many players, short and long runs of every level in two item sets, some rounds with no level.
	var mess []fixRound
	for i := 0; i < 220; i++ {
		player := fmt.Sprintf("p%d", g.next(6))
		level := []int{0, 1, 2, 3, 3, 4, 5, 5, 6}[g.next(9)]
		n := []int{1, 2, 5, 19, 20, 21, 40, 90}[g.next(8)]
		// Three bands of coins, so some neighbours match and some do not.
		coins := []float64{4000, 4300, 9000}[g.next(3)]
		mess = append(mess, g.stretch(player, level, n, coins, g.next(3) == 0, []int{0, 2, -1}[g.next(3)])...)
	}
	cases = append(cases, fixCase{"a mess", mess, -1})

	type jsRound struct {
		ID      string `json:"id"`
		At      string `json:"at"`
		Player  string `json:"player"`
		Level   *int   `json:"level"`
		Trusted bool   `json:"trusted"`
		Context int    `json:"context"`
		Value   *int64 `json:"value"`
	}
	type jsCase struct {
		Name   string    `json:"name"`
		Rounds []jsRound `json:"rounds"`
	}
	var in []jsCase
	for _, c := range cases {
		rounds := make([]jsRound, len(c.Rounds))
		for i, r := range c.Rounds {
			rounds[i] = jsRound{ID: r.ID, At: r.At, Player: r.Player, Trusted: r.Trusted, Context: r.Context}
			if r.Level > 0 {
				rounds[i].Level = &r.Level
			}
			if r.Value > 0 {
				rounds[i].Value = &r.Value
			}
		}
		in = append(in, jsCase{c.Name, rounds})
	}
	data, _ := json.Marshal(in)
	file := filepath.Join(t.TempDir(), "cases.json")
	if err := os.WriteFile(file, data, 0o644); err != nil {
		t.Fatal(err)
	}
	out, err := exec.Command(node, script, file).Output()
	if err != nil {
		t.Fatalf("skill-fix-parity.mjs: %v\n%s", err, out)
	}
	var js []struct {
		Name   string     `json:"name"`
		Levels []int      `json:"levels"`
		Fixes  []SkillFix `json:"fixes"`
	}
	if err := json.Unmarshal(out, &js); err != nil {
		t.Fatal(err)
	}
	near := func(a, b float64) bool { return math.Abs(a-b) <= 1e-9*math.Max(1, math.Abs(a)) }
	for k, c := range cases {
		levels, _, fixes := fixRefileRounds(c.Rounds)
		moved := 0
		for i, r := range c.Rounds {
			if levels[i] != r.Level {
				moved++
			}
			if levels[i] != js[k].Levels[i] {
				t.Fatalf("%s: round %d counts at %d in Go, %d in JS", c.Name, i, levels[i], js[k].Levels[i])
			}
		}
		if c.Moved >= 0 && moved != c.Moved {
			t.Errorf("%s: %d rounds moved, want %d (%+v)", c.Name, moved, c.Moved, fixes)
		}
		if c.Moved < 0 && moved == 0 {
			t.Errorf("%s: nothing moved, so it tests nothing", c.Name)
		}
		if len(fixes) != len(js[k].Fixes) {
			t.Fatalf("%s: %d fixes in Go, %d in JS", c.Name, len(fixes), len(js[k].Fixes))
		}
		for i, f := range fixes {
			j := js[k].Fixes[i]
			if f.Player != j.Player || f.From != j.From || f.To != j.To || f.Rounds != j.Rounds || f.First != j.First || f.Last != j.Last || f.Rule != j.Rule ||
				f.Context != j.Context || f.N != j.N || !near(f.Mid, j.Mid) || f.AgainstN != j.AgainstN || !near(f.AgainstMid, j.AgainstMid) ||
				!near(f.Ratio, j.Ratio) || f.Confidence != j.Confidence {
				t.Errorf("%s: fix %d differs:\n Go %+v\n JS %+v", c.Name, i, f, j)
			}
		}
	}
}

func TestTrustedVersion(t *testing.T) {
	for _, v := range []string{"6.0a19", "6.0a20", "6.0b1", "6.0b33", "6.0", "6.0.1", "6.1a1", "7.0", "10.2b3"} {
		if !trustedVersion(v) {
			t.Errorf("%q should be trusted", v)
		}
	}
	for _, v := range []string{"6.0a18", "6.0a1", "6.0a", "5.0", "5.0b3", "0.11", "3.0b", "", "dev", "4.0a2"} {
		if trustedVersion(v) {
			t.Errorf("%q should not be trusted", v)
		}
	}
}

// fillRefiled stores rounds of one device with a run the correction moves:
// "donald" at level 5, then 30 rounds recorded at 3 with the same coins, then
// 5 again; and "daisy", a real progression it must leave. Returns how many
// rounds it moves once Refile has run.
func fillRefiled(t *testing.T, app core.App) int {
	t.Helper()
	g := &fixGen{seed: 5}
	start := time.Date(2026, 9, 10, 8, 0, 0, 0, time.UTC)
	n := 0
	add := func(tsum string, level, rounds int, coins float64, version string) {
		for i := 0; i < rounds; i++ {
			n++
			base := int64(math.Round(coins * (0.9 + float64(g.next(2001))/10000)))
			final, score, medals, secs := base*13/10, base*900, int64(0), 100+float64(g.next(400))/10
			r := Round{
				// A UUIDv7's shape, so every round is one device's (deviceTagSQL).
				ID: fmt.Sprintf("%08x-0000-7000-8000-00000000f1f1", n), PlayedAt: start.Add(time.Duration(n) * 4 * time.Minute).Format(sqlTime),
				Tsum: tsum, Build: "global", SkillType: "burst", ScriptVersion: version, Device: "pixel-7", Source: SourceCSV,
				Duration: &secs, Score: &score, BaseCoins: &base, FinalCoins: &final, Medals: &medals,
				Settings: fmt.Sprintf(`{"skillLevel": %d, "bonusCoin": true, "bonus5to4": true, "maxChain": 4}`, level),
			}
			if err := upsertRound(app.DB(), r); err != nil {
				t.Fatal(err)
			}
		}
	}
	add("donald", 5, 45, 6000, "5.0")
	add("donald", 3, 30, 6000, "5.0")
	add("donald", 5, 40, 6000, "5.0")
	add("daisy", 3, 40, 3000, "6.0b5")
	add("daisy", 4, 40, 3900, "6.0b5")
	return 30
}

func TestRefile(t *testing.T) {
	app := testApp(t)
	moved := fillRefiled(t, app)
	count := func(where string) int {
		var n int
		if err := app.DB().NewQuery(`SELECT COUNT(*) FROM ts_rounds WHERE ` + where).Row(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}
	// Stored rounds count as recorded until Refile runs.
	if n := count("skill_eff <> skill_level"); n != 0 {
		t.Fatalf("%d rounds re-filed before Refile", n)
	}
	if err := Refile(app.DB()); err != nil {
		t.Fatal(err)
	}
	if n := count("skill_eff <> skill_level"); n != moved {
		t.Fatalf("%d rounds re-filed, want %d", n, moved)
	}
	if n := count("tsum = 'donald' AND skill_level = '3' AND skill_eff = '5'"); n != moved {
		t.Fatalf("%d of donald's level 3 rounds count at 5, want %d", n, moved)
	}
	// The recorded level is as it was sent.
	if n := count("tsum = 'donald' AND json_extract(settings, '$.skillLevel') = 3"); n != moved {
		t.Fatalf("the settings changed: %d rounds recorded at 3", n)
	}
	fixes, err := SkillFixes(app.DB(), "donald")
	if err != nil || len(fixes) != 1 {
		t.Fatalf("fixes: %+v, %v", fixes, err)
	}
	if f := fixes[0]; f.From != 3 || f.To != 5 || f.Rounds != moved || f.Rule != "order" || f.Player != "global|00000000f1f1" || f.N != moved || math.Abs(f.Ratio-1) > 0.12 {
		t.Fatalf("fix: %+v", f)
	}
	if all, _ := SkillFixes(app.DB(), ""); len(all) != 1 {
		t.Fatalf("daisy's progression was moved: %+v", all)
	}

	levels := func(q url.Values) map[string]int64 {
		s, err := Summarize(app.DB(), ParseFilter(q), 0)
		if err != nil {
			t.Fatal(err)
		}
		out := map[string]int64{"refiled": 0}
		for _, m := range s.Mix {
			if m.Tsum == "donald" {
				out[m.Skill] += m.Rounds
			}
		}
		for _, r := range s.Refiled {
			out["refiled"] += r.Rounds
		}
		return out
	}
	if got := levels(url.Values{}); got["5"] != 115 || got["3"] != 0 || got["refiled"] != 30 {
		t.Fatalf("corrected: %v", got)
	}
	if got := levels(url.Values{"levels": {"recorded"}}); got["5"] != 85 || got["3"] != 30 || got["refiled"] != 30 {
		t.Fatalf("as recorded: %v", got)
	}
	// The skill filter goes by the level the rounds count at, or the recorded one.
	if got := levels(url.Values{"skill": {"3"}}); got["3"] != 0 || got["refiled"] != 0 {
		t.Fatalf("skill 3, corrected: %v", got)
	}
	if got := levels(url.Values{"skill": {"3"}, "levels": {"recorded"}}); got["3"] != 30 {
		t.Fatalf("skill 3, as recorded: %v", got)
	}
	rows, err := RoundsPage(app.DB(), ParseFilter(url.Values{"tsum": {"donald"}, "skill": {"5"}}), "playedAt", 1, 200)
	if err != nil || len(rows) != 115 {
		t.Fatalf("rounds at 5: %d, %v", len(rows), err)
	}
	if r := rows[50]; r.SkillLevel != "3" || r.SkillEff != "5" {
		t.Fatalf("a re-filed round's levels: %q, %q", r.SkillLevel, r.SkillEff)
	}
	d, err := DescribeTsum(app.DB(), ParseFilter(url.Values{}), "donald", 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range d.Settings {
		if s.Setting == "skillLevel" && (s.Key != "5" || s.Rounds != 115) {
			t.Fatalf("the Tsum page's skill levels: %+v", s.GroupStat)
		}
	}

	// A round stored again is back at its recorded level until Refile, which then writes nothing new.
	var again Round
	if err := app.DB().NewQuery(`SELECT ` + roundColumns + ` FROM ts_rounds WHERE skill_eff <> skill_level LIMIT 1`).One(&again); err != nil {
		t.Fatal(err)
	}
	again.Source = SourceCSV
	if err := upsertRound(app.DB(), again); err != nil {
		t.Fatal(err)
	}
	if n := count("skill_eff <> skill_level"); n != moved-1 {
		t.Fatalf("a round stored again kept its effective level: %d", n)
	}
	if err := Refile(app.DB(), "donald"); err != nil {
		t.Fatal(err)
	}
	if n := count("skill_eff <> skill_level"); n != moved {
		t.Fatalf("after storing a round again: %d re-filed, want %d", n, moved)
	}
}
