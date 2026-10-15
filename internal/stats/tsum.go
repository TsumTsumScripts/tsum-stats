package stats

import (
	"github.com/pocketbase/dbx"
)

// TsumDetail is the Tsum page: one Tsum's summary, its figures split by what
// changes from round to round (each script setting, the script version, the
// device), its recent form, and every Tsum's rate in the same filter, for its
// rank.
type TsumDetail struct {
	Summary  Summary       `json:"summary"`
	Settings []SettingStat `json:"settings"`
	Versions []GroupStat   `json:"versions"`
	Devices  []GroupStat   `json:"devices"`
	Field    []FieldStat   `json:"field"`
	// Form is the newest FormRounds rounds (key "recent") and the FormRounds
	// before them ("before").
	Form []GroupStat `json:"form"`
	// SkillBins are the summary's histogram buckets split by skill level.
	SkillBins []SkillBin `json:"skillBins"`
	Earn      Earn       `json:"earn"`
	// Target counts the rounds under the page's target; nil without one.
	Target *TargetStat `json:"target"`
}

// FormRounds is how many rounds make up recent form.
const FormRounds = 50

// SkillBin is one histogram bucket's rounds at one skill level.
type SkillBin struct {
	Skill  string `db:"k" json:"skill"`
	From   int64  `db:"bucket" json:"from"`
	Rounds int64  `db:"rounds" json:"rounds"`
}

// Earn is what every Tsum in the filter earns a second of play, for how long
// boxes take: final coins (less item costs when net), and medals, with a
// round that has none counting as 0.
type Earn struct {
	CoinsPerSec  *float64 `db:"coins_per_sec" json:"coinsPerSec"`
	MedalsPerSec *float64 `db:"medals_per_sec" json:"medalsPerSec"`
}

// TargetStat is how many of the rounds with the primary stat fell under the target.
type TargetStat struct {
	Target int64 `db:"-" json:"target"`
	Rounds int64 `db:"rounds" json:"rounds"`
	Under  int64 `db:"under" json:"under"`
}

// GroupStat is the primary stat over the rounds that share one key.
type GroupStat struct {
	Key         string   `db:"k" json:"key"`
	Rounds      int64    `db:"rounds" json:"rounds"`
	AvgCoins    *float64 `db:"avg_coins" json:"avgCoins"`
	MaxCoins    *int64   `db:"max_coins" json:"maxCoins"`
	CoinsPerSec *float64 `db:"coins_per_sec" json:"coinsPerSec"`
	AvgScore    *float64 `db:"avg_score" json:"avgScore"`
	First       string   `db:"first" json:"first"`
	Last        string   `db:"last" json:"last"`
}

// SettingStat is a GroupStat for one value (Key) of one script setting.
type SettingStat struct {
	Setting string `db:"setting" json:"setting"`
	GroupStat
}

// FieldStat is one Tsum's rate, with the sums behind it so the page can add
// Tsums up.
type FieldStat struct {
	Tsum        string   `db:"tsum" json:"tsum"`
	Rounds      int64    `db:"rounds" json:"rounds"`
	RateCoins   *int64   `db:"rate_coins" json:"rateCoins"`
	RateSecs    *float64 `db:"rate_secs" json:"rateSeconds"`
	CoinsPerSec *float64 `db:"coins_per_sec" json:"coinsPerSec"`
}

// settingsSQL is a round's settings when they are a JSON object, else an empty
// one, so json_each never sees bad JSON.
const settingsSQL = "(CASE WHEN json_valid(settings) AND json_type(settings) = 'object' THEN settings ELSE '{}' END)"

// settingValueSQL is a setting's value as text: true, false, null, the number
// (a whole real without its ".0") or the string. The engine's settingText matches it.
const settingValueSQL = `(CASE j.type WHEN 'true' THEN 'true' WHEN 'false' THEN 'false' WHEN 'null' THEN 'null'
	WHEN 'real' THEN (CASE WHEN j.value = CAST(j.value AS INTEGER) THEN CAST(CAST(j.value AS INTEGER) AS TEXT) ELSE CAST(j.value AS TEXT) END)
	ELSE CAST(j.value AS TEXT) END)`

// groupStats are GroupStat's columns for the primary stat c.
func groupStats(c string) string {
	return `COUNT(*) AS rounds, AVG(` + c + `) AS avg_coins, MAX(` + c + `) AS max_coins, ` + rateExpr(c) + ` AS coins_per_sec,
		AVG(score) AS avg_score, MIN(played_at) AS first, MAX(played_at) AS last`
}

// skillSQL joins a round to its skillLevel setting as k (settingValueSQL).
const skillSQL = "json_each(" + settingsSQL + ") AS j"
const skillWhere = "j.key = 'skillLevel' AND j.type NOT IN ('object', 'array')"

// DescribeTsum is the Tsum page for tsum, within the rest of f (f.Tsums is
// ignored). target, when set, counts the rounds under it.
func DescribeTsum(db dbx.Builder, f Filter, tsum string, tzMinutes int, target *int64) (TsumDetail, error) {
	d := TsumDetail{Settings: []SettingStat{}, Versions: []GroupStat{}, Devices: []GroupStat{}, Field: []FieldStat{},
		Form: []GroupStat{}, SkillBins: []SkillBin{}}
	all := f
	all.Tsums = nil
	// What boxes are paid with, whatever the primary stat.
	earn := all
	earn.Medals, earn.FinalCoins = false, true
	f.Tsums = []string{tsum}
	c := f.col()
	where, p := f.where()
	pairs, pp := f.whereAnd("j.type NOT IN ('object', 'array')")
	err := runAll([]func() error{
		func() (err error) { d.Summary, err = Summarize(db, f, tzMinutes); return err },
		func() error {
			return db.NewQuery(`SELECT j.key AS setting, ` + settingValueSQL + ` AS k, ` + groupStats(c) + `
				FROM ts_rounds, json_each(` + settingsSQL + `) AS j` + pairs + `
				GROUP BY setting, k ORDER BY setting, k`).Bind(pp).All(&d.Settings)
		},
		func() error {
			return db.NewQuery(`SELECT script_version AS k, ` + groupStats(c) + ` FROM ts_rounds` + where +
				` GROUP BY k ORDER BY last DESC, k`).Bind(p).All(&d.Versions)
		},
		func() error {
			return db.NewQuery(`SELECT device AS k, ` + groupStats(c) + ` FROM ts_rounds` + where +
				` GROUP BY k ORDER BY rounds DESC, k`).Bind(p).All(&d.Devices)
		},
		func() error {
			q := withParam(p, "n", FormRounds)
			// round_id breaks ties, as the rounds table does.
			return db.NewQuery(`SELECT CASE WHEN rn <= {:n} THEN 'recent' ELSE 'before' END AS k, ` + groupStats(c) + `
				FROM (SELECT *, ROW_NUMBER() OVER (ORDER BY played_at DESC, round_id DESC) AS rn FROM ts_rounds` + where + `)
				WHERE rn <= 2 * {:n} GROUP BY k ORDER BY k DESC`).Bind(q).All(&d.Form)
		},
		func() error {
			w, ep := earn.where()
			return db.NewQuery(`SELECT ` + rateExpr(earn.coins()) + ` AS coins_per_sec, ` + rateExpr("COALESCE(medals, 0)") + ` AS medals_per_sec
				FROM ts_rounds` + w).Bind(ep).One(&d.Earn)
		},
		func() error {
			if target == nil {
				return nil
			}
			q := withParam(p, "target", *target)
			d.Target = &TargetStat{Target: *target}
			return db.NewQuery(`SELECT COUNT(` + c + `) AS rounds, COUNT(CASE WHEN ` + c + ` < {:target} THEN 1 END) AS under
				FROM ts_rounds` + where).Bind(q).One(d.Target)
		},
		func() error {
			w, ap := all.where()
			return db.NewQuery(`SELECT tsum, COUNT(*) AS rounds, ` + rateCoins(c) + ` AS rate_coins, ` + rateSecs(c) + ` AS rate_secs, ` +
				rateExpr(c) + ` AS coins_per_sec FROM ts_rounds` + w + ` GROUP BY tsum ORDER BY tsum`).Bind(ap).All(&d.Field)
		},
	})
	if err != nil {
		return d, err
	}
	// The skill levels' buckets match the summary's histogram, so it runs after.
	width, limit, ok := histBounds(d.Summary.Totals)
	if !ok {
		return d, nil
	}
	sw, sp := f.whereAnd(skillWhere, c+" IS NOT NULL")
	sp["w"], sp["cap"] = width, limit
	err = db.NewQuery(`SELECT k, ` + bucketSQL + ` AS bucket, COUNT(*) AS rounds
		FROM (SELECT ` + settingValueSQL + ` AS k, ` + c + ` AS v FROM ts_rounds, ` + skillSQL + sw + `)
		GROUP BY k, bucket ORDER BY k, bucket`).Bind(sp).All(&d.SkillBins)
	return d, err
}

// withParam is a copy of p with k set, since the queries share p while they run.
func withParam(p dbx.Params, k string, v any) dbx.Params {
	q := dbx.Params{k: v}
	for pk, pv := range p {
		q[pk] = pv
	}
	return q
}
