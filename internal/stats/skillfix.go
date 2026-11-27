package stats

import (
	"cmp"
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"

	"github.com/pocketbase/dbx"
)

// The skill level correction: which rounds were most likely played at another
// skill level than the one recorded, and the level they count at instead
// (ts_rounds.skill_eff, the effective level). The recorded level
// (settings.skillLevel, skill_level) is never changed.
//
// This is the Go port of ui/src/lib/skillFix.js, which has the reasoning and
// is what the global Worker runs; TestSkillFixParity holds the two to the same
// answers. docs/INTERNALS.md § The skill level correction is the long form.

// The thresholds (skillFix.js: FIX).
const (
	fixMinRounds = 20   // rounds a run needs in one item context before its coins are compared
	fixSame      = 0.12 // |ln(a / b)| at or under this is the same performance
	fixGap       = 0.25 // ln(a / b) at or over this is two levels' references clearly apart
	fixRefRounds = 50   // trusted rounds a level's reference needs in an item context
	fixWTrusted  = 6    // a round's weight in the order rule: trusted,
	fixWDefault  = 1    // the default level before 6.0a19,
	fixWPlain    = 2    // any other
	fixDefault   = 3    // the level the script starts with
)

// SkillFixVersion names the rules; a database corrected under another is
// corrected again at the next start (refileOnce).
const SkillFixVersion = "2"

var fixVersionRE = regexp.MustCompile(`^(\d+)\.(\d+)(?:\.\d+)*(?:([ab])(\d+)?)?`)

// trustedVersion is true for a script version with Auto Set Skill Level:
// 6.0a19 and every later alpha, beta and release.
func trustedVersion(version string) bool {
	m := fixVersionRE.FindStringSubmatch(strings.TrimSpace(version))
	if m == nil {
		return false
	}
	major, _ := strconv.Atoi(m[1])
	minor, _ := strconv.Atoi(m[2])
	if major != 6 || minor != 0 {
		return major > 6 || (major == 6 && minor > 0)
	}
	if m[3] == "a" {
		n, _ := strconv.Atoi(m[4])
		return n >= 19
	}
	return true
}

// fixContext is the item context a round's coins are compared within: its
// item set less +Coin, +Exp and +Score, -1 when the items are not known.
func fixContext(items *int) int {
	if items == nil || *items < 0 {
		return -1
	}
	return *items &^ (1 | 8 | 16)
}

// fixRound is one round as the correction reads it. Level 0 is none; Value is
// its base coins (medals for a medal Tsum), 0 or less for none.
type fixRound struct {
	ID, At, Player string
	Level          int
	Trusted        bool
	Context        int
	Value          int64
}

type fixContextSum struct {
	Context, N int
	Mid        float64
}

// fixRun is one player's consecutive rounds under one recorded level.
type fixRun struct {
	Player      string
	Level       int
	First, Last string
	N, Trusted  int
	Rounds      []int
	Contexts    []fixContextSum
}

// fixDecision is a run's effective level, and why when it moved (Rule "").
type fixDecision struct {
	Level      int
	Rule       string
	Context, N int
	Mid        float64
	Against    struct {
		Level, N int
		Mid      float64
	}
	Ratio      float64
	Confidence string
}

func lowerMedian(v []int64) float64 {
	s := slices.Clone(v)
	slices.Sort(s)
	return float64(s[(len(s)-1)>>1])
}

// fixRunsOf is skillFix.js's runsOf.
func fixRunsOf(rounds []fixRound) []*fixRun {
	var order []int
	for i, r := range rounds {
		if r.Level > 0 {
			order = append(order, i)
		}
	}
	slices.SortStableFunc(order, func(a, b int) int {
		return cmp.Or(strings.Compare(rounds[a].Player, rounds[b].Player), strings.Compare(rounds[a].At, rounds[b].At),
			strings.Compare(rounds[a].ID, rounds[b].ID))
	})
	var runs []*fixRun
	var run *fixRun
	var values map[int][]int64
	closeRun := func() {
		if run == nil {
			return
		}
		for c, v := range values {
			run.Contexts = append(run.Contexts, fixContextSum{c, len(v), lowerMedian(v)})
		}
		slices.SortFunc(run.Contexts, func(a, b fixContextSum) int { return a.Context - b.Context })
	}
	for _, i := range order {
		r := rounds[i]
		if run == nil || run.Player != r.Player || run.Level != r.Level {
			closeRun()
			run = &fixRun{Player: r.Player, Level: r.Level, First: r.At, Last: r.At}
			values = map[int][]int64{}
			runs = append(runs, run)
		}
		run.Rounds = append(run.Rounds, i)
		run.N++
		run.Last = r.At
		if r.Trusted {
			run.Trusted++
		}
		if r.Value > 0 {
			values[r.Context] = append(values[r.Context], r.Value)
		}
	}
	closeRun()
	return runs
}

func (r *fixRun) weight() int {
	w := fixWPlain
	if r.Level == fixDefault {
		w = fixWDefault
	}
	return r.Trusted*fixWTrusted + (r.N-r.Trusted)*w
}

func (r *fixRun) isTrusted() bool { return r.Trusted*2 > r.N }

func (r *fixRun) judged() int {
	n := 0
	for _, c := range r.Contexts {
		n = max(n, c.N)
	}
	return n
}

func (r *fixRun) context(c int) *fixContextSum {
	for i := range r.Contexts {
		if r.Contexts[i].Context == c {
			return &r.Contexts[i]
		}
	}
	return nil
}

// fixCompared is two runs' coins in the item context both have most rounds of.
type fixCompared struct {
	Context, N int
	Log        float64
}

func fixCompare(a, b *fixRun) *fixCompared {
	var best *fixCompared
	for _, ca := range a.Contexts {
		if ca.N < fixMinRounds || !(ca.Mid > 0) {
			continue
		}
		cb := b.context(ca.Context)
		if cb == nil || cb.N < fixMinRounds || !(cb.Mid > 0) {
			continue
		}
		if n := min(ca.N, cb.N); best == nil || n > best.N {
			best = &fixCompared{ca.Context, n, math.Log(ca.Mid / cb.Mid)}
		}
	}
	return best
}

type fixOrdered struct {
	Level, Margin, Weight int
}

const fixNever = math.MaxInt / 4

// fixOrderRule is skillFix.js's orderRule: one player's runs in time order.
func fixOrderRule(runs []*fixRun) []fixOrdered {
	var levels []int
	for _, r := range runs {
		if !slices.Contains(levels, r.Level) {
			levels = append(levels, r.Level)
		}
	}
	slices.Sort(levels)
	w := make([]int, len(runs))
	same := make([]int, len(runs))
	for i, r := range runs {
		w[i] = r.weight()
		if i > 0 {
			if c := fixCompare(r, runs[i-1]); c != nil && math.Abs(c.Log) <= fixSame {
				same[i] = min(w[i], w[i-1])
			}
		}
	}
	solve := func(pin int) (int, []int) {
		cost := make([]int, len(levels))
		from := make([][]int, 0, len(runs))
		for i := range runs {
			next, back := make([]int, len(levels)), make([]int, len(levels))
			for l := range levels {
				next[l] = fixNever
				label := w[i]
				if levels[l] == runs[i].Level {
					label = 0
				} else if i == pin {
					label = fixNever
				}
				if i == 0 {
					next[l] = label
					continue
				}
				for k := 0; k <= l; k++ {
					c := min(cost[k]+label, fixNever)
					if k != l {
						c = min(c+same[i], fixNever)
					}
					if c < next[l] {
						next[l], back[l] = c, k
					}
				}
			}
			cost = next
			from = append(from, back)
		}
		l := 0
		for k := 1; k < len(levels); k++ {
			if cost[k] < cost[l] {
				l = k
			}
		}
		total, out := cost[l], make([]int, len(runs))
		for i := len(runs) - 1; i >= 0; i-- {
			out[i] = levels[l]
			l = from[i][l]
		}
		return total, out
	}
	best, bestLevels := solve(-1)
	out := make([]fixOrdered, len(runs))
	for i, r := range runs {
		out[i].Level = bestLevels[i]
		if bestLevels[i] != r.Level {
			pinned, _ := solve(i)
			out[i].Margin, out[i].Weight = pinned-best, w[i]
		}
	}
	return out
}

// fixRefile is skillFix.js's refile, without its `prev`: each run's effective level.
func fixRefile(runs []*fixRun) []fixDecision {
	out := make([]fixDecision, len(runs))
	for i, r := range runs {
		out[i].Level = r.Level
	}
	why := func(i, target int, rule string, c *fixCompared, againstN int, againstMid float64) {
		mine := runs[i].context(c.Context)
		d := fixDecision{Level: target, Rule: rule, Context: c.Context, N: mine.N, Mid: mine.Mid, Ratio: math.Exp(c.Log), Confidence: "medium"}
		d.Against.Level, d.Against.N, d.Against.Mid = target, againstN, againstMid
		if math.Abs(c.Log) <= fixSame/2 && c.N >= 2*fixMinRounds {
			d.Confidence = "high"
		}
		out[i] = d
	}

	// Per player, in time order; only the runs with enough rounds to judge.
	var names []string
	players := map[string][]int{}
	for i, r := range runs {
		if r.judged() < fixMinRounds {
			continue
		}
		if _, ok := players[r.Player]; !ok {
			names = append(names, r.Player)
		}
		players[r.Player] = append(players[r.Player], i)
	}
	for _, list := range players {
		slices.SortStableFunc(list, func(a, b int) int {
			return cmp.Or(strings.Compare(runs[a].First, runs[b].First), strings.Compare(runs[a].Last, runs[b].Last), a-b)
		})
	}

	// The order rule.
	for _, name := range names {
		list := players[name]
		mine := make([]*fixRun, len(list))
		down := false
		for k, i := range list {
			mine[k] = runs[i]
			down = down || (k > 0 && mine[k].Level < mine[k-1].Level)
		}
		if !down {
			continue
		}
		solved := fixOrderRule(mine)
		for k, s := range solved {
			if s.Level == mine[k].Level || s.Margin < s.Weight {
				continue
			}
			var near []int
			for j := range mine {
				if j != k && solved[j].Level == s.Level && mine[j].Level == s.Level {
					near = append(near, j)
				}
			}
			dist := func(j int) int { return max(j-k, k-j) }
			slices.SortStableFunc(near, func(a, b int) int { return cmp.Or(dist(a)-dist(b), a-b) })
			for _, j := range near {
				c := fixCompare(mine[k], mine[j])
				if c == nil || math.Abs(c.Log) > fixSame {
					continue
				}
				other := mine[j].context(c.Context)
				why(list[k], s.Level, "order", c, other.N, other.Mid)
				break
			}
		}
	}

	// The trusted rule's references: per level and context, the trusted runs that kept their level.
	type ref struct {
		level, context, n int
		sum, mid          float64
	}
	var refs []*ref
	for i, r := range runs {
		if !r.isTrusted() || out[i].Rule != "" {
			continue
		}
		for _, c := range r.Contexts {
			if !(c.Mid > 0) {
				continue
			}
			at := slices.IndexFunc(refs, func(x *ref) bool { return x.level == r.Level && x.context == c.Context })
			if at < 0 {
				refs = append(refs, &ref{level: r.Level, context: c.Context})
				at = len(refs) - 1
			}
			refs[at].n += c.N
			refs[at].sum += float64(c.N) * c.Mid
		}
	}
	refs = slices.DeleteFunc(refs, func(x *ref) bool { return x.n < fixRefRounds })
	if len(refs) == 0 {
		return out
	}
	for _, x := range refs {
		x.mid = x.sum / float64(x.n)
	}
	apart := func(context, from, to int) bool {
		at := slices.IndexFunc(refs, func(x *ref) bool { return x.context == context && x.level == to })
		if at < 0 {
			return false
		}
		return slices.ContainsFunc(refs, func(x *ref) bool {
			return x.context == context && x.level >= from && x.level < to && math.Log(refs[at].mid/x.mid) >= fixGap
		})
	}

	// The trusted rule, each player's runs from the newest back.
	for _, name := range names {
		list := players[name]
		for k := len(list) - 1; k >= 0; k-- {
			i, run := list[k], runs[list[k]]
			if out[i].Rule != "" || run.isTrusted() {
				continue
			}
			for m := k + 1; m < len(list); m++ {
				j, later := list[m], runs[list[m]]
				if !later.isTrusted() || out[j].Rule != "" || later.Level <= run.Level {
					continue
				}
				c := fixCompare(run, later)
				if c == nil || math.Abs(c.Log) > fixSame || !apart(c.Context, run.Level, later.Level) {
					continue
				}
				inOrder := true
				for n, x := range list {
					if (n < k && out[x].Level > later.Level) || (n > k && out[x].Level < later.Level) {
						inOrder = false
					}
				}
				if !inOrder {
					continue
				}
				other := later.context(c.Context)
				why(i, later.Level, "trusted", c, other.N, other.Mid)
				break
			}
		}
	}
	return out
}

// SkillFix is one run of rounds counted at another skill level than recorded,
// and why: the page's "why was this re-filed".
type SkillFix struct {
	Tsum string `db:"tsum" json:"tsum"`
	// Player is the build and the device tag the rounds came from (deviceTagSQL).
	Player string `db:"player" json:"player"`
	From   int    `db:"from_level" json:"from"`
	To     int    `db:"to_level" json:"to"`
	Rounds int    `db:"rounds" json:"rounds"`
	First  string `db:"first" json:"first"`
	Last   string `db:"last" json:"last"`
	// Rule is "list" (a Tsum List of the account says the level could not be
	// the one recorded), "order" (the player's levels went down) or "trusted"
	// (the same coins as the player's own later rounds with Auto Set Skill Level).
	Rule string `db:"rule" json:"rule"`
	// For "list": the list that says so (its device name and stamp, UTC), the
	// level it read, and whether it was read after the rounds ("cap": the
	// level was at most that) or before ("floor": at least that). The other
	// rules leave these empty, and the fields below them at zero for "list".
	ListDevice string `db:"list_device" json:"listDevice"`
	ListStamp  string `db:"list_stamp" json:"listStamp"`
	ListLevel  int    `db:"list_level" json:"listLevel"`
	ListBound  string `db:"list_bound" json:"listBound"`
	// Context is the item context the coins were compared in (fixContext); N
	// and Mid the run's rounds and median there, AgainstN and AgainstMid the
	// run's it was held to; Ratio is Mid over AgainstMid. Medals for a medal Tsum.
	Context    int     `db:"context" json:"context"`
	N          int     `db:"n" json:"n"`
	Mid        float64 `db:"mid" json:"mid"`
	AgainstN   int     `db:"against_n" json:"againstN"`
	AgainstMid float64 `db:"against_mid" json:"againstMid"`
	Ratio      float64 `db:"ratio" json:"ratio"`
	Confidence string  `db:"confidence" json:"confidence"`
	Medals     bool    `db:"medals" json:"medals"`
}

// fixRefileRounds is skillFix.js's refileRounds: every round's effective level
// (its own when it stands) and the runs that moved.
func fixRefileRounds(rounds []fixRound) ([]int, []SkillFix) {
	runs := fixRunsOf(rounds)
	decided := fixRefile(runs)
	levels := make([]int, len(rounds))
	for i, r := range rounds {
		levels[i] = r.Level
	}
	var fixes []SkillFix
	for k, d := range decided {
		if d.Rule == "" {
			continue
		}
		run := runs[k]
		for _, i := range run.Rounds {
			levels[i] = d.Level
		}
		fixes = append(fixes, SkillFix{Player: run.Player, From: run.Level, To: d.Level, Rounds: run.N, First: run.First, Last: run.Last,
			Rule: d.Rule, Context: d.Context, N: d.N, Mid: d.Mid, AgainstN: d.Against.N, AgainstMid: d.Against.Mid, Ratio: d.Ratio, Confidence: d.Confidence})
	}
	return levels, fixes
}

// refileMu keeps two corrections of the same rounds from crossing.
var refileMu sync.Mutex

// Refile works out the effective skill level (skill_eff) of every round of
// the given Tsums, all of them with none given, from all of each Tsum's
// rounds, and records the runs that moved in ts_skill_fixes. It writes only
// the rows whose effective level changed. Whoever stores rounds calls it for
// their Tsums afterwards: a stored round starts at its recorded level (the
// table's triggers), and one more round can change a run's verdict. A new
// Tsum List or account link can move any Tsum's rounds: all of them then.
//
// Per round, in this order: the Tsum Lists of the account it was played on
// (accounts.go) hold its recorded level within what they read, since a level
// never goes down (at most the oldest later reading, at least the newest
// earlier one); the coin rules (fixRefileRounds) then judge the runs of
// those levels, a round the lists pin to one level counting as trusted; and
// a coin verdict the lists rule out is dropped.
func Refile(db dbx.Builder, tsums ...string) error {
	refileMu.Lock()
	defer refileMu.Unlock()
	lk, err := newLinker(db)
	if err != nil {
		return err
	}
	if len(tsums) == 0 {
		if err := db.NewQuery(`SELECT DISTINCT tsum FROM ts_rounds WHERE tsum <> ''`).Column(&tsums); err != nil {
			return err
		}
	}
	for _, tsum := range tsums {
		if tsum == "" {
			continue
		}
		if err := refileTsum(db, tsum, lk); err != nil {
			return err
		}
	}
	return nil
}

func refileTsum(db dbx.Builder, tsum string, lk *linker) error {
	var rows []struct {
		ID      string `db:"round_id"`
		At      string `db:"played_at"`
		Build   string `db:"build"`
		Device  string `db:"device"`
		Tag     string `db:"tag"`
		Stretch string `db:"stretch"`
		Version string `db:"script_version"`
		Level   string `db:"skill_level"`
		Eff     string `db:"skill_eff"`
		Items   *int   `db:"items"`
		Base    *int64 `db:"base_coins"`
		Medals  *int64 `db:"medals"`
	}
	p := dbx.Params{"t": tsum}
	if err := db.NewQuery(`SELECT round_id, played_at, build, device, ` + deviceTagSQL + ` AS tag, ` + stretchTagSQL + ` AS stretch, script_version, skill_level, skill_eff, items, base_coins, medals
		FROM ts_rounds WHERE tsum = {:t} ORDER BY played_at, round_id`).Bind(p).All(&rows); err != nil {
		return err
	}
	// A medal Tsum is judged on its medals (medalTsumsSQL: one that has earned any).
	medal := false
	for _, r := range rows {
		if r.Medals != nil && *r.Medals > 0 {
			medal = true
			break
		}
	}
	rounds := make([]fixRound, len(rows))
	bounds := make([]listBound, len(rows))
	// The rounds the lists moved, by player, levels and list: one fix each.
	type listKey struct {
		player   string
		from, to int
		list     *AccountList
		bound    string
	}
	var listFixes []*SkillFix
	listFix := map[listKey]*SkillFix{}
	for i, r := range rows {
		level, _ := strconv.Atoi(r.Level)
		trusted := trustedVersion(r.Version)
		if a, _ := lk.account(r.Build, r.Device, r.Stretch); a != nil {
			bounds[i] = a.bound(tsum, r.At)
			to, list, which := bounds[i].clamp(level)
			if list != nil {
				k := listKey{r.Build + "|" + r.Tag, level, to, list, which}
				f := listFix[k]
				if f == nil {
					f = &SkillFix{Player: k.player, From: level, To: to, First: r.At, Rule: "list", Confidence: "high",
						ListDevice: list.Device, ListStamp: list.Stamp, ListLevel: to, ListBound: which}
					listFix[k] = f
					listFixes = append(listFixes, f)
				}
				f.Rounds++
				f.Last = r.At
				level = to
			}
			// Read the same before and after: the level is known.
			trusted = trusted || (level > 0 && bounds[i].Floor == bounds[i].Cap && bounds[i].Floor == level)
		}
		rounds[i] = fixRound{ID: r.ID, At: r.At, Player: r.Build + "|" + r.Tag, Level: level, Trusted: trusted, Context: fixContext(r.Items)}
		v := r.Base
		if medal {
			v = r.Medals
		}
		if v != nil {
			rounds[i].Value = *v
		}
	}
	levels, fixes := fixRefileRounds(rounds)
	// A coin verdict outside what the lists read is dropped.
	for i := range rounds {
		if kept, list, _ := bounds[i].clamp(levels[i]); list != nil && kept != levels[i] {
			levels[i] = rounds[i].Level
		}
	}
	for _, f := range listFixes {
		fixes = append(fixes, *f)
	}
	// The rounds whose effective level is not the one stored, by the level to store.
	changed := map[string][]string{}
	for i, r := range rows {
		want := r.Level
		if levels[i] > 0 {
			want = strconv.Itoa(levels[i])
		}
		if want != r.Eff {
			changed[want] = append(changed[want], r.ID)
		}
	}
	for level, ids := range changed {
		for chunk := range slices.Chunk(ids, 400) {
			names := make([]string, len(chunk))
			cp := dbx.Params{"l": level}
			for i, id := range chunk {
				k := "i" + strconv.Itoa(i)
				names[i], cp[k] = "{:"+k+"}", id
			}
			if _, err := db.NewQuery(`UPDATE ts_rounds SET skill_eff = {:l} WHERE round_id IN (` + strings.Join(names, ",") + `)`).Bind(cp).Execute(); err != nil {
				return err
			}
		}
	}
	var had int
	if err := db.NewQuery(`SELECT COUNT(*) FROM ts_skill_fixes WHERE tsum = {:t}`).Bind(p).Row(&had); err != nil {
		return err
	}
	if had == 0 && len(fixes) == 0 {
		return nil
	}
	if _, err := db.NewQuery(`DELETE FROM ts_skill_fixes WHERE tsum = {:t}`).Bind(p).Execute(); err != nil {
		return err
	}
	for _, f := range fixes {
		if _, err := db.NewQuery(`INSERT INTO ts_skill_fixes (tsum, player, from_level, to_level, rounds, first, last, rule, context, n, mid, against_n, against_mid, ratio, confidence, medals,
				list_device, list_stamp, list_level, list_bound)
			VALUES ({:t}, {:p}, {:f}, {:to}, {:r}, {:first}, {:last}, {:rule}, {:c}, {:n}, {:mid}, {:an}, {:am}, {:ratio}, {:conf}, {:medals}, {:ld}, {:ls}, {:ll}, {:lb})`).Bind(dbx.Params{
			"ld": f.ListDevice, "ls": f.ListStamp, "ll": f.ListLevel, "lb": f.ListBound,
			"t": tsum, "p": f.Player, "f": f.From, "to": f.To, "r": f.Rounds, "first": f.First, "last": f.Last, "rule": f.Rule, "c": f.Context,
			"n": f.N, "mid": f.Mid, "an": f.AgainstN, "am": f.AgainstMid, "ratio": f.Ratio, "conf": f.Confidence, "medals": medal,
		}).Execute(); err != nil {
			return err
		}
	}
	return nil
}

// SkillFixes is every run counted at another level than recorded, of one
// Tsum or, with "", of all, by Tsum then time.
func SkillFixes(db dbx.Builder, tsum string) ([]SkillFix, error) {
	out := []SkillFix{}
	q, p := `SELECT * FROM ts_skill_fixes`, dbx.Params{}
	if tsum != "" {
		q += ` WHERE tsum = {:t}`
		p["t"] = tsum
	}
	err := db.NewQuery(q + ` ORDER BY tsum, first, player, from_level, to_level, rule`).Bind(p).All(&out)
	return out, err
}

// Refiled is the rounds a filter keeps that count at another level than
// recorded, per Tsum and pair of levels: what the page's markers say.
type Refiled struct {
	Tsum   string `db:"tsum" json:"tsum"`
	From   string `db:"from_level" json:"from"`
	To     string `db:"to_level" json:"to"`
	Rounds int64  `db:"rounds" json:"rounds"`
}

// refiledStats is f's Refiled rows, the same whether or not f counts by the
// recorded level, so the page can say what the correction would move.
func refiledStats(db dbx.Builder, f Filter) ([]Refiled, error) {
	where, p := f.whereAnd("skill_eff <> skill_level")
	out := []Refiled{}
	err := db.NewQuery(`SELECT tsum, skill_level AS from_level, skill_eff AS to_level, COUNT(*) AS rounds FROM ts_rounds` + where + `
		GROUP BY tsum, from_level, to_level ORDER BY tsum, from_level, to_level`).Bind(p).All(&out)
	return out, err
}
