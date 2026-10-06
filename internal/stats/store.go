package stats

import (
	"strings"
	"time"

	"github.com/pocketbase/dbx"
)

// Round is one row of ts_rounds. Nil numbers are figures the script could not read.
type Round struct {
	ID            string   `db:"round_id" json:"id"`
	PlayedAt      string   `db:"played_at" json:"playedAt"`
	Tsum          string   `db:"tsum" json:"tsum"`
	Build         string   `db:"build" json:"build"`
	SkillType     string   `db:"skill_type" json:"skillType"`
	ScriptVersion string   `db:"script_version" json:"scriptVersion"`
	Duration      *float64 `db:"duration_seconds" json:"durationSeconds"`
	Score         *int64   `db:"score" json:"score"`
	BaseCoins     *int64   `db:"base_coins" json:"baseCoins"`
	FinalCoins    *int64   `db:"final_coins" json:"finalCoins"`
	Medals        *int64   `db:"medals" json:"medals"`
	Device        string   `db:"device" json:"device"`
	Settings      string   `db:"settings" json:"-"`
	Source        string   `db:"source" json:"source"`
	// Items is the boost-item bitmask from Settings (see itemBits); nil when unknown.
	Items *int `db:"-" json:"items"`
}

const (
	SourceCSV   = "csv"
	SourceEvent = "event"
)

const roundColumns = "round_id, played_at, tsum, build, skill_type, script_version, duration_seconds, score, base_coins, final_coins, medals, device, settings, source"

// A CSV row is the full record and overwrites what an event left; an event
// never overwrites a CSV row, only fills in which device played it.
const upsertFromCSV = `INSERT INTO ts_rounds (` + roundColumns + `)
	VALUES ({:id}, {:at}, {:tsum}, {:build}, {:skill}, {:ver}, {:dur}, {:score}, {:base}, {:final}, {:medals}, {:device}, {:settings}, 'csv')
	ON CONFLICT (round_id) DO UPDATE SET
		played_at = excluded.played_at, tsum = excluded.tsum, build = excluded.build,
		skill_type = excluded.skill_type, script_version = excluded.script_version,
		duration_seconds = excluded.duration_seconds, score = excluded.score,
		base_coins = excluded.base_coins, final_coins = excluded.final_coins,
		medals = excluded.medals, settings = excluded.settings, source = 'csv',
		device = CASE WHEN excluded.device <> '' THEN excluded.device ELSE ts_rounds.device END`

const upsertFromEvent = `INSERT INTO ts_rounds (` + roundColumns + `)
	VALUES ({:id}, {:at}, {:tsum}, {:build}, {:skill}, {:ver}, {:dur}, {:score}, {:base}, {:final}, {:medals}, {:device}, {:settings}, 'event')
	ON CONFLICT (round_id) DO UPDATE SET
		device = CASE WHEN ts_rounds.device = '' THEN excluded.device ELSE ts_rounds.device END`

func upsertRound(db dbx.Builder, r Round) error {
	q := upsertFromEvent
	if r.Source == SourceCSV {
		q = upsertFromCSV
	}
	if r.Settings == "" {
		r.Settings = "{}"
	}
	_, err := db.NewQuery(q).Bind(dbx.Params{
		"id": r.ID, "at": r.PlayedAt, "tsum": r.Tsum, "build": r.Build, "skill": r.SkillType,
		"ver": r.ScriptVersion, "dur": r.Duration, "score": r.Score, "base": r.BaseCoins,
		"final": r.FinalCoins, "medals": r.Medals, "device": r.Device, "settings": r.Settings,
	}).Execute()
	return err
}

// sqlTime is the played_at format: UTC, sortable as text, and the same as the
// CSV's datetime column so both sources compare directly.
const sqlTime = "2006-01-02 15:04:05"

// normalizeTime accepts the CSV's "2026-09-04 11:20:31" and an event's ISO
// "2026-09-04T11:20:31.118Z", and returns the sqlTime form.
func normalizeTime(s string) (string, bool) {
	s = strings.TrimSpace(s)
	for _, layout := range []string{sqlTime, time.RFC3339Nano, "2006-01-02T15:04:05"} {
		if t, err := time.Parse(layout, s); err == nil {
			return t.UTC().Format(sqlTime), true
		}
	}
	return "", false
}

// OwnedTsum is one row of a Tsum List export.
type OwnedTsum struct {
	Order    *int64 `db:"ord" json:"order"`
	Tsum     string `db:"tsum" json:"tsum"`
	Name     string `db:"name" json:"name"`
	Level    *int64 `db:"level" json:"level"`
	LevelCap *int64 `db:"level_cap" json:"levelCap"`
	Skill    *int64 `db:"skill" json:"skill"`
	SkillMax *int64 `db:"skill_max" json:"skillMax"`
	// SkillProgress is the percent (0-100) through the current skill level.
	SkillProgress *int64 `db:"skill_progress" json:"skillProgress"`
	Acquired      string `db:"acquired" json:"acquired"`
	// Favorite is the game's favourite star; nil on a list from before it was read.
	Favorite *bool `db:"favorite" json:"favorite"`
}

// replaceTsumList stores one export whole. The script rewrites the file after
// every page, so a re-import replaces the rows rather than adding to them.
func replaceTsumList(db dbx.Builder, file, build, device, stamp string, rows []OwnedTsum) error {
	for _, q := range []string{
		"DELETE FROM ts_owned WHERE list_id IN (SELECT id FROM ts_tsum_lists WHERE file = {:f})",
		"DELETE FROM ts_tsum_lists WHERE file = {:f}",
	} {
		if _, err := db.NewQuery(q).Bind(dbx.Params{"f": file}).Execute(); err != nil {
			return err
		}
	}
	res, err := db.NewQuery(`INSERT INTO ts_tsum_lists (file, build, device, stamp, imported_at, tsums)
		VALUES ({:f}, {:b}, {:d}, {:s}, {:at}, {:n})`).Bind(dbx.Params{
		"f": file, "b": build, "d": device, "s": stamp, "at": time.Now().UTC().Format(sqlTime), "n": len(rows),
	}).Execute()
	if err != nil {
		return err
	}
	listID, err := res.LastInsertId()
	if err != nil {
		return err
	}
	for _, r := range rows {
		_, err := db.NewQuery(`INSERT INTO ts_owned (list_id, ord, tsum, name, level, level_cap, skill, skill_max, skill_progress, acquired, favorite)
			VALUES ({:l}, {:o}, {:t}, {:n}, {:lv}, {:lc}, {:s}, {:sm}, {:sp}, {:a}, {:fv})`).Bind(dbx.Params{
			"l": listID, "o": r.Order, "t": r.Tsum, "n": r.Name, "lv": r.Level, "lc": r.LevelCap,
			"s": r.Skill, "sm": r.SkillMax, "sp": r.SkillProgress, "a": r.Acquired, "fv": r.Favorite,
		}).Execute()
		if err != nil {
			return err
		}
	}
	return nil
}
