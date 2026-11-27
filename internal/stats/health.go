package stats

import (
	"github.com/pocketbase/dbx"
)

// Health is the Stats page's Script versions panel: how well each script
// version (and each device) reads a round, and each version's expected coins
// per Tsum × skill level × item set, so the page can hold a version against
// the one before it like for like and catch one that costs coins.
type Health struct {
	Versions []ReadStat    `json:"versions"`
	Devices  []ReadStat    `json:"devices"`
	Cells    []VersionCell `json:"cells"`
}

// ReadStat is one version's or device's rounds and how many had each figure
// unread. Unread is the rounds with any (completeSQL's opposite); Medals
// counts only medal Tsums' rounds, the only ones that need it.
type ReadStat struct {
	Key    string `db:"k" json:"key"`
	Rounds int64  `db:"rounds" json:"rounds"`
	Unread int64  `db:"unread" json:"unread"`
	NoTsum int64  `db:"no_tsum" json:"noTsum"`
	Score  int64  `db:"score" json:"score"`
	Base   int64  `db:"base" json:"base"`
	Final  int64  `db:"final" json:"final"`
	Secs   int64  `db:"secs" json:"secs"`
	Medals int64  `db:"medals" json:"medals"`
	First  string `db:"first" json:"first"`
	Last   string `db:"last" json:"last"`
}

// VersionCell is one script version's expected coins on one Tsum at one skill
// level with one item set (Filter.skill's text, itemsSQL).
type VersionCell struct {
	Version string `db:"version" json:"version"`
	Tsum    string `db:"tsum" json:"tsum"`
	Skill   string `db:"skill" json:"skill"`
	Items   int    `db:"items" json:"items"`
	Expected
}

// readStats are ReadStat's columns.
const readStats = `COUNT(*) AS rounds, COUNT(CASE WHEN NOT (` + completeSQL + `) THEN 1 END) AS unread,
	COUNT(CASE WHEN tsum = '' THEN 1 END) AS no_tsum, COUNT(CASE WHEN score IS NULL THEN 1 END) AS score,
	COUNT(CASE WHEN base_coins IS NULL THEN 1 END) AS base, COUNT(CASE WHEN final_coins IS NULL THEN 1 END) AS final,
	COUNT(CASE WHEN duration_seconds IS NULL THEN 1 END) AS secs,
	COUNT(CASE WHEN medals IS NULL AND tsum IN (` + medalTsumsSQL + `) THEN 1 END) AS medals,
	MIN(played_at) AS first, MAX(played_at) AS last`

// DescribeHealth is Health within f. The read figures count every round the
// rest of f keeps, complete or not; the cells only the complete ones, as every
// other figure does.
func DescribeHealth(db dbx.Builder, f Filter) (Health, error) {
	h := Health{Versions: []ReadStat{}, Devices: []ReadStat{}, Cells: []VersionCell{}}
	all := f
	all.Complete = false
	aw, ap := all.where()
	where, p := f.where()
	err := runAll([]func() error{
		func() error {
			return db.NewQuery(`SELECT script_version AS k, ` + readStats + ` FROM ts_rounds` + aw + ` GROUP BY k ORDER BY first, k`).Bind(ap).All(&h.Versions)
		},
		func() error {
			return db.NewQuery(`SELECT device AS k, ` + readStats + ` FROM ts_rounds` + aw + ` GROUP BY k ORDER BY rounds DESC, k`).Bind(ap).All(&h.Devices)
		},
		func() error {
			return db.NewQuery(`SELECT script_version AS version, tsum, ` + f.skill() + ` AS skill, ` + itemsSQL + ` AS items, ` + expCols + `
				FROM ts_rounds` + where + ` GROUP BY version, tsum, skill, items ORDER BY version, tsum, skill, items`).Bind(p).All(&h.Cells)
		},
	})
	return h, err
}
