package stats

import (
	"encoding/json"
	"math"
	"strconv"
	"strings"
	"sync"

	"github.com/pocketbase/dbx"
)

// Summary is everything the Stats page draws above the tables. It is all
// GROUP BY results, so its size depends on days and Tsums, not rounds.
type Summary struct {
	Totals     Totals        `json:"totals"`
	Daily      []DayStat     `json:"daily"`
	Tsums      []TsumStat    `json:"tsums"`
	DailyTsums []DayTsumStat `json:"dailyTsums"`
	Hours      []HourStat    `json:"hours"`
	Mix        []MixStat     `json:"mix"`
	Histogram  CoinHistogram `json:"histogram"`
	// Medals are the same totals and per-Tsum figures for medals, over the
	// rounds that earned any, so the page can show them beside coins.
	Medals StatSet `json:"medals"`
}

// StatSet is the KPI totals and the per-Tsum table for one stat.
type StatSet struct {
	Totals Totals     `json:"totals"`
	Tsums  []TsumStat `json:"tsums"`
}

// Totals are the KPI cards. Coin rate figures only count rounds that have both
// coins and a time, so a round with an unread time does not inflate them.
type Totals struct {
	Rounds      int64    `db:"rounds" json:"rounds"`
	AvgScore    *float64 `db:"avg_score" json:"avgScore"`
	MaxScore    *int64   `db:"max_score" json:"maxScore"`
	AvgCoins    *float64 `db:"avg_coins" json:"avgCoins"`
	MinCoins    *int64   `db:"min_coins" json:"minCoins"`
	MaxCoins    *int64   `db:"max_coins" json:"maxCoins"`
	AvgBase     *float64 `db:"avg_base" json:"avgBaseCoins"`
	AvgFinal    *float64 `db:"avg_final" json:"avgFinalCoins"`
	VarCoins    *float64 `db:"var_coins" json:"-"`
	CoinRounds  int64    `db:"coin_rounds" json:"coinRounds"`
	TotalCoins  *int64   `db:"total_coins" json:"totalCoins"`
	TotalSecs   *float64 `db:"total_secs" json:"totalSeconds"`
	AvgSecs     *float64 `db:"avg_secs" json:"avgSeconds"`
	CoinsPerSec *float64 `db:"coins_per_sec" json:"coinsPerSec"`
	TotalMedals *int64   `db:"total_medals" json:"totalMedals"`
	First       *string  `db:"first" json:"first"`
	Last        *string  `db:"last" json:"last"`
	Spread
}

// Spread is where a set of rounds' coins fall; nil with no coin figures.
type Spread struct {
	StdCoins *float64 `db:"-" json:"stdCoins"`
	Q1       *int64   `db:"-" json:"q1Coins"`
	Median   *int64   `db:"-" json:"medianCoins"`
	Q3       *int64   `db:"-" json:"q3Coins"`
	P90      *int64   `db:"-" json:"p90Coins"`
}

type DayStat struct {
	Day         string   `db:"day" json:"day"`
	Rounds      int64    `db:"rounds" json:"rounds"`
	AvgScore    *float64 `db:"avg_score" json:"avgScore"`
	MinScore    *int64   `db:"min_score" json:"minScore"`
	MaxScore    *int64   `db:"max_score" json:"maxScore"`
	Coins       *int64   `db:"coins" json:"coins"`
	AvgCoins    *float64 `db:"avg_coins" json:"avgCoins"`
	MinCoins    *int64   `db:"min_coins" json:"minCoins"`
	MaxCoins    *int64   `db:"max_coins" json:"maxCoins"`
	CoinsPerSec *float64 `db:"coins_per_sec" json:"coinsPerSec"`
}

type TsumStat struct {
	Tsum        string   `db:"tsum" json:"tsum"`
	Rounds      int64    `db:"rounds" json:"rounds"`
	AvgScore    *float64 `db:"avg_score" json:"avgScore"`
	MaxScore    *int64   `db:"max_score" json:"maxScore"`
	AvgCoins    *float64 `db:"avg_coins" json:"avgCoins"`
	MinCoins    *int64   `db:"min_coins" json:"minCoins"`
	MaxCoins    *int64   `db:"max_coins" json:"maxCoins"`
	AvgBase     *float64 `db:"avg_base" json:"avgBaseCoins"`
	AvgFinal    *float64 `db:"avg_final" json:"avgFinalCoins"`
	VarCoins    *float64 `db:"var_coins" json:"-"`
	Coins       *int64   `db:"coins" json:"coins"`
	TotalSecs   *float64 `db:"total_secs" json:"totalSeconds"`
	AvgSecs     *float64 `db:"avg_secs" json:"avgSeconds"`
	CoinsPerSec *float64 `db:"coins_per_sec" json:"coinsPerSec"`
	Spread
}

// DayTsumStat is one Tsum on one day, for the per-day charts split by Tsum.
type DayTsumStat struct {
	Day         string   `db:"day" json:"day"`
	Tsum        string   `db:"tsum" json:"tsum"`
	Rounds      int64    `db:"rounds" json:"rounds"`
	Coins       *int64   `db:"coins" json:"coins"`
	AvgCoins    *float64 `db:"avg_coins" json:"avgCoins"`
	CoinsPerSec *float64 `db:"coins_per_sec" json:"coinsPerSec"`
}

// HourStat is one hour of the viewer's day, across every day in the filter.
type HourStat struct {
	Hour        int      `db:"hour" json:"hour"`
	Rounds      int64    `db:"rounds" json:"rounds"`
	Coins       *int64   `db:"coins" json:"coins"`
	AvgCoins    *float64 `db:"avg_coins" json:"avgCoins"`
	CoinsPerSec *float64 `db:"coins_per_sec" json:"coinsPerSec"`
}

// MixStat is one build × Tsum × boost-item combination. The page folds it
// into the sunburst and the items chart.
type MixStat struct {
	Build      string   `db:"build" json:"build"`
	Tsum       string   `db:"tsum" json:"tsum"`
	Items      int      `db:"items" json:"items"`
	Rounds     int64    `db:"rounds" json:"rounds"`
	Coins      *int64   `db:"coins" json:"coins"`
	CoinRounds int64    `db:"coin_rounds" json:"coinRounds"`
	RateCoin   *int64   `db:"rate_coins" json:"rateCoins"`
	RateSecs   *float64 `db:"rate_secs" json:"rateSeconds"`
}

// CoinHistogram counts rounds per coin bucket, split by Tsum. Rounds at
// or over Cap share the last bucket (From == Cap), so one freak round does not
// stretch the scale; Cap is nil when no round reaches it.
type CoinHistogram struct {
	Width int64     `json:"width"`
	Cap   *int64    `json:"cap"`
	Bins  []CoinBin `json:"bins"`
}

type CoinBin struct {
	From   int64  `db:"bucket" json:"from"`
	Tsum   string `db:"tsum" json:"tsum"`
	Rounds int64  `db:"rounds" json:"rounds"`
}

// Rate columns: coins and seconds over rounds that have both. c is the coin
// column the page asked for (Filter.coin), never user text.
func rateCoins(c string) string {
	return "SUM(CASE WHEN " + c + " IS NOT NULL AND duration_seconds > 0 THEN " + c + " END)"
}
func rateSecs(c string) string {
	return "SUM(CASE WHEN " + c + " IS NOT NULL AND duration_seconds > 0 THEN duration_seconds END)"
}
func rateExpr(c string) string { return rateCoins(c) + " * 1.0 / " + rateSecs(c) }

// coinStats are the per-group coin columns. Population variance; the square
// root is taken in Go. avg_base and avg_final are both kept for the coin bonus.
func coinStats(c string) string {
	return `AVG(` + c + `) AS avg_coins, MIN(` + c + `) AS min_coins, MAX(` + c + `) AS max_coins,
		AVG(base_coins) AS avg_base, AVG(final_coins) AS avg_final,
		AVG(` + c + ` * ` + c + ` * 1.0) - AVG(` + c + ` * 1.0) * AVG(` + c + ` * 1.0) AS var_coins, ` + rateExpr(c) + ` AS coins_per_sec`
}

// itemBits are the boost items, in the settings' names. The page has the same list.
var itemBits = []struct {
	key string
	bit int
}{
	{"bonusCoin", 1}, {"bonus5to4", 2}, {"bonusTime", 4}, {"bonusExp", 8},
	{"bonusScore", 16}, {"bonusBubble", 32}, {"bonusCombo", 64},
}

// itemsSQL is a round's item bitmask, or -1 when its settings predate the items.
var itemsSQL = func() string {
	parts := make([]string, len(itemBits))
	for i, b := range itemBits {
		parts[i] = "(CASE WHEN json_extract(settings, '$." + b.key + "') THEN " + strconv.Itoa(b.bit) + " ELSE 0 END)"
	}
	return "CASE WHEN json_valid(settings) AND json_type(settings, '$.bonusCoin') IS NOT NULL THEN " +
		strings.Join(parts, " + ") + " ELSE -1 END"
}()

// itemsOf is itemsSQL for one round's settings JSON.
func itemsOf(settings string) *int {
	var s map[string]any
	if json.Unmarshal([]byte(settings), &s) != nil {
		return nil
	}
	if _, ok := s["bonusCoin"]; !ok {
		return nil
	}
	mask := 0
	for _, b := range itemBits {
		if v, _ := s[b.key].(bool); v {
			mask |= b.bit
		}
	}
	return &mask
}

func stddev(v *float64) *float64 {
	if v == nil {
		return nil
	}
	s := math.Sqrt(math.Max(0, *v))
	return &s
}

// Summarize aggregates in SQL, so the page gets a few thousand numbers however
// many rounds match. tzMinutes shifts the per-day and per-hour buckets to the
// viewer's clock. The queries run at once, so db must be the pool (app.DB()),
// not a transaction.
func Summarize(db dbx.Builder, f Filter, tzMinutes int) (Summary, error) {
	s := Summary{Daily: []DayStat{}, DailyTsums: []DayTsumStat{}, Hours: []HourStat{}, Mix: []MixStat{}}
	c := f.col()
	where, p := f.where()
	p["shift"] = strconv.Itoa(tzMinutes) + " minutes"
	day := "date(played_at, {:shift})"

	var main StatSet
	steps := []func() error{
		func() (err error) { main, err = statSet(db, f); return err },
		func() (err error) {
			// With medals as the primary stat the two sets are the same rounds and column.
			if f.Medals {
				return nil
			}
			s.Medals, err = statSet(db, f.medalView())
			return err
		},
		func() error {
			return db.NewQuery(`SELECT ` + day + ` AS day, COUNT(*) AS rounds, AVG(score) AS avg_score,
				MIN(score) AS min_score, MAX(score) AS max_score, SUM(` + c + `) AS coins, AVG(` + c + `) AS avg_coins,
				MIN(` + c + `) AS min_coins, MAX(` + c + `) AS max_coins, ` + rateExpr(c) + ` AS coins_per_sec
				FROM ts_rounds` + where + ` GROUP BY day ORDER BY day`).Bind(p).All(&s.Daily)
		},
		func() error {
			return db.NewQuery(`SELECT ` + day + ` AS day, tsum, COUNT(*) AS rounds, SUM(` + c + `) AS coins,
				AVG(` + c + `) AS avg_coins, ` + rateExpr(c) + ` AS coins_per_sec FROM ts_rounds` + where + ` GROUP BY day, tsum ORDER BY day`).Bind(p).All(&s.DailyTsums)
		},
		func() error {
			return db.NewQuery(`SELECT CAST(strftime('%H', played_at, {:shift}) AS INTEGER) AS hour, COUNT(*) AS rounds,
				SUM(` + c + `) AS coins, AVG(` + c + `) AS avg_coins, ` + rateExpr(c) + ` AS coins_per_sec
				FROM ts_rounds` + where + ` GROUP BY hour ORDER BY hour`).Bind(p).All(&s.Hours)
		},
		func() error {
			return db.NewQuery(`SELECT build, tsum, ` + itemsSQL + ` AS items, COUNT(*) AS rounds, SUM(` + c + `) AS coins,
				COUNT(` + c + `) AS coin_rounds, ` + rateCoins(c) + ` AS rate_coins, ` + rateSecs(c) + ` AS rate_secs
				FROM ts_rounds` + where + ` GROUP BY build, tsum, items ORDER BY rounds DESC`).Bind(p).All(&s.Mix)
		},
	}
	if err := runAll(steps); err != nil {
		return s, err
	}
	s.Totals, s.Tsums = main.Totals, main.Tsums
	if f.Medals {
		s.Medals = main
	}

	var err error
	s.Histogram, err = coinHistogram(db, f, s.Totals)
	return s, err
}

// statSet is the totals and per-Tsum figures, with their spreads, of f.col().
func statSet(db dbx.Builder, f Filter) (StatSet, error) {
	set := StatSet{Tsums: []TsumStat{}}
	c := f.col()
	where, p := f.where()
	var spreads, all map[string]Spread
	err := runAll([]func() error{
		func() error {
			return db.NewQuery(`SELECT COUNT(*) AS rounds, AVG(score) AS avg_score, MAX(score) AS max_score, ` + coinStats(c) + `,
				COUNT(` + c + `) AS coin_rounds, SUM(` + c + `) AS total_coins, SUM(duration_seconds) AS total_secs,
				AVG(duration_seconds) AS avg_secs, SUM(medals) AS total_medals, MIN(played_at) AS first, MAX(played_at) AS last
				FROM ts_rounds` + where).Bind(p).One(&set.Totals)
		},
		func() error {
			return db.NewQuery(`SELECT tsum, COUNT(*) AS rounds, AVG(score) AS avg_score, MAX(score) AS max_score, ` + coinStats(c) + `,
				SUM(` + c + `) AS coins, SUM(duration_seconds) AS total_secs, AVG(duration_seconds) AS avg_secs
				FROM ts_rounds` + where + ` GROUP BY tsum ORDER BY rounds DESC`).Bind(p).All(&set.Tsums)
		},
		func() (err error) { spreads, err = coinSpreads(db, f, "tsum"); return err },
		func() (err error) { all, err = coinSpreads(db, f, "''"); return err },
	})
	if err != nil {
		return set, err
	}
	set.Totals.StdCoins = stddev(set.Totals.VarCoins)
	for i := range set.Tsums {
		set.Tsums[i].StdCoins = stddev(set.Tsums[i].VarCoins)
		if sp, ok := spreads[set.Tsums[i].Tsum]; ok {
			sp.StdCoins = set.Tsums[i].StdCoins
			set.Tsums[i].Spread = sp
		}
	}
	if sp, ok := all[""]; ok {
		sp.StdCoins = set.Totals.StdCoins
		set.Totals.Spread = sp
	}
	return set, nil
}

// runAll runs the steps at once and returns the first error. Each step fills
// its own field; on 50k rounds this takes the summary from about 0.7 s one
// after another to the slowest step's 0.2 s.
func runAll(steps []func() error) error {
	errs := make([]error, len(steps))
	var wg sync.WaitGroup
	for i, step := range steps {
		wg.Add(1)
		go func() { defer wg.Done(); errs[i] = step() }()
	}
	wg.Wait()
	for _, err := range errs {
		if err != nil {
			return err
		}
	}
	return nil
}

// coinSpreads returns the quartiles and 90th percentile of f.col() per group.
// Each is the lower nearest-rank value, so it is always a real round.
func coinSpreads(db dbx.Builder, f Filter, group string) (map[string]Spread, error) {
	c := f.col()
	where, p := f.whereAnd(c + " IS NOT NULL")
	var rows []struct {
		G   string `db:"g"`
		Q1  *int64 `db:"q1"`
		Med *int64 `db:"med"`
		Q3  *int64 `db:"q3"`
		P90 *int64 `db:"p90"`
	}
	at := func(frac string) string { return "MAX(CASE WHEN rn = 1 + (n - 1) * " + frac + " THEN v END)" }
	err := db.NewQuery(`SELECT g, ` + at("1 / 4") + ` AS q1, ` + at("1 / 2") + ` AS med, ` + at("3 / 4") + ` AS q3, ` + at("9 / 10") + ` AS p90
		FROM (SELECT ` + group + ` AS g, ` + c + ` AS v,
			ROW_NUMBER() OVER (PARTITION BY ` + group + ` ORDER BY ` + c + `) AS rn,
			COUNT(*) OVER (PARTITION BY ` + group + `) AS n
			FROM ts_rounds` + where + `) GROUP BY g`).Bind(p).All(&rows)
	out := map[string]Spread{}
	for _, r := range rows {
		out[r.G] = Spread{Q1: r.Q1, Median: r.Med, Q3: r.Q3, P90: r.P90}
	}
	return out, err
}

// coinHistogram buckets the chosen coins into about 24 bins of a round width,
// from the lowest round up to Q3 + 1.5 × the middle half's width (Tukey's fence).
func coinHistogram(db dbx.Builder, f Filter, t Totals) (CoinHistogram, error) {
	h := CoinHistogram{Bins: []CoinBin{}}
	if t.MinCoins == nil || t.MaxCoins == nil {
		return h, nil
	}
	lo, hi := *t.MinCoins, *t.MaxCoins
	if t.Q1 != nil && t.Q3 != nil {
		hi = min(hi, *t.Q3+3*(*t.Q3-*t.Q1)/2)
	}
	h.Width = niceStep(float64(hi-lo) / 24)
	limit := (hi/h.Width + 1) * h.Width
	if *t.MaxCoins >= limit {
		h.Cap = &limit
	}
	c := f.col()
	where, p := f.whereAnd(c + " IS NOT NULL")
	p["w"] = h.Width
	p["cap"] = limit
	err := db.NewQuery(`SELECT MIN((` + c + ` / {:w}) * {:w}, {:cap}) AS bucket, tsum, COUNT(*) AS rounds
		FROM ts_rounds` + where + ` GROUP BY bucket, tsum ORDER BY bucket`).Bind(p).All(&h.Bins)
	return h, err
}

// niceStep rounds up to 1, 2 or 5 times a power of ten, and at least 1.
func niceStep(raw float64) int64 {
	if raw <= 1 {
		return 1
	}
	mag := math.Pow(10, math.Floor(math.Log10(raw)))
	for _, m := range []float64{1, 2, 5, 10} {
		if raw <= m*mag {
			return int64(m * mag)
		}
	}
	return int64(10 * mag)
}
