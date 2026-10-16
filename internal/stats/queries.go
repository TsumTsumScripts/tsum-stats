package stats

import (
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"regexp"
	"strings"

	"github.com/pocketbase/dbx"
)

// Filter is the Stats page's filter bar. Every field is optional.
type Filter struct {
	Tsums   []string
	Devices []string // empty means every device
	// SkillTypes are the script's skill types (skill_type) to keep; empty is
	// every one, and "" is the rounds sent without one.
	SkillTypes []string
	// Play is the values to keep of each play setting, by its parameter
	// (PlaySettings); "" is the rounds where it is not recorded.
	Play  map[string][]string
	Build string
	From  string // sqlTime, inclusive, UTC
	To    string // sqlTime, exclusive, UTC
	// The outlier ranges, each bound inclusive. Coins are base or final coins
	// (never medals); the medal range only judges medal Tsums' rounds.
	MinCoins, MaxCoins   *int64
	MinScore, MaxScore   *int64
	MinMedals, MaxMedals *int64
	// Complete keeps only rounds with every figure read (completeSQL).
	Complete bool
	// FinalCoins counts coins after the coin bonus; the default is base coins.
	FinalCoins bool
	// Net subtracts what the round's boost items cost from its coins. A round
	// recorded before items were has no net coins.
	Net bool
	// Medals makes medals the primary stat instead of coins, and keeps only
	// medal Tsums' rounds with a medal figure (medalRoundsSQL), 0s included.
	Medals bool

	// stat, when set, is the column the summary aggregates instead of coin();
	// onlyMedals keeps only medal Tsums' rounds, as Medals does. Both are for
	// the summary's medal figures, never read from the request.
	stat       string
	onlyMedals bool
}

// col is the column the summary aggregates.
func (f Filter) col() string {
	if f.stat != "" {
		return f.stat
	}
	return f.coin()
}

// medalView is f for the summary's medal figures: medals, over medal Tsums' rounds.
func (f Filter) medalView() Filter {
	f.stat, f.onlyMedals = "medals", true
	return f
}

// coin is the primary stat's column: what the figures and the rate use.
func (f Filter) coin() string {
	if f.Medals {
		return "medals"
	}
	return f.coins()
}

// coins is the coin range's column: base or final coins, net when asked, even
// in Medals mode.
func (f Filter) coins() string {
	c := "base_coins"
	if f.FinalCoins {
		c = "final_coins"
	}
	if f.Net {
		return "(" + c + " - " + costSQL + ")"
	}
	return c
}

// medalTsumsSQL is every Tsum that has earned medals in any round. Its rounds
// need a medal figure to be complete; other Tsums' rounds may leave it blank.
const medalTsumsSQL = "SELECT tsum FROM ts_rounds WHERE medals > 0"

// medalRoundsSQL keeps the rounds medal figures count: a medal Tsum's, with
// medals read. A round that earned none counts as 0, so a medal rate is what
// the Tsum earns an hour, not what its lucky rounds do.
const medalRoundsSQL = "medals IS NOT NULL AND tsum IN (" + medalTsumsSQL + ")"

// completeSQL keeps rounds with an identified Tsum and every figure read.
const completeSQL = "tsum <> '' AND score IS NOT NULL AND base_coins IS NOT NULL AND final_coins IS NOT NULL" +
	" AND duration_seconds IS NOT NULL AND (medals IS NOT NULL OR tsum NOT IN (" + medalTsumsSQL + "))"

var sqlTimeRE = regexp.MustCompile(`^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$`)

// NoSkillType is how the skillType list names the rounds without a skill
// type, and a play setting's list the rounds where it is not recorded.
const NoSkillType = "-"

// PlaySetting is a script setting the filters, and the global site's cells,
// go by: Key in the settings, Param its query parameter. A Number setting is
// a whole number, else an id.
type PlaySetting struct {
	Param, Key string
	Number     bool
}

// PlaySettings are how many chains a board scan may take, the longest chain,
// and how bubbles are spent (the engines' PLAY_SETTINGS).
var PlaySettings = []PlaySetting{
	{"scan", "maxChainsPerScan", true}, {"chain", "maxChain", true}, {"bubble", "bubbleStrategy", false},
}

// playSettingSQL is a round's value of ps as text, as the engines' playValue
// and the global site keep it: a Number setting's whole value 0-999, an id
// setting's value of letters, digits, '_', '.' and '-', at most 64; anything
// else, or none, is ” (not recorded).
func playSettingSQL(ps PlaySetting) string {
	v := "json_extract(" + settingsSQL + ", '$." + ps.Key + "')"
	t := "json_type(" + settingsSQL + ", '$." + ps.Key + "')"
	if ps.Number {
		return "(CASE WHEN " + t + " IN ('integer', 'real') AND " + v + " BETWEEN 0 AND 999 AND " + v + " = CAST(" + v + " AS INTEGER)" +
			" THEN CAST(CAST(" + v + " AS INTEGER) AS TEXT) ELSE '' END)"
	}
	return "(CASE WHEN " + t + " = 'text' AND length(" + v + ") BETWEEN 1 AND 64 AND " + v + " NOT GLOB '*[^A-Za-z0-9_.-]*'" +
		" THEN " + v + " ELSE '' END)"
}

// ParseFilter reads tsum, device and skillType (comma lists; NoSkillType is
// the rounds without one), build, from, to, the outlier
// ranges (min/max Coins, Score, Medals), incomplete ("1" keeps rounds with an
// unread figure), coins (the primary stat: "final", "medals", or base coins by
// default) and net ("1" subtracts the items' cost from coins).
// from/to are UTC in either the sqlTime or the ISO form; the page sends the
// user's local day bounds already converted.
func ParseFilter(q url.Values) Filter {
	var f Filter
	for _, t := range strings.Split(q.Get("tsum"), ",") {
		if t = strings.TrimSpace(t); t != "" {
			f.Tsums = append(f.Tsums, t)
		}
	}
	for _, d := range strings.Split(q.Get("device"), ",") {
		if d = strings.TrimSpace(d); d != "" {
			f.Devices = append(f.Devices, d)
		}
	}
	for _, s := range strings.Split(q.Get("skillType"), ",") {
		if s = strings.TrimSpace(s); s == NoSkillType {
			f.SkillTypes = append(f.SkillTypes, "")
		} else if s != "" {
			f.SkillTypes = append(f.SkillTypes, s)
		}
	}
	for _, ps := range PlaySettings {
		for _, s := range strings.Split(q.Get(ps.Param), ",") {
			if s = strings.TrimSpace(s); s == NoSkillType {
				s = ""
			} else if s == "" {
				continue
			}
			if f.Play == nil {
				f.Play = map[string][]string{}
			}
			f.Play[ps.Param] = append(f.Play[ps.Param], s)
		}
	}
	if b := q.Get("build"); b == "global" || b == "jp" {
		f.Build = b
	}
	if t, ok := normalizeTime(q.Get("from")); ok {
		f.From = t
	}
	if t, ok := normalizeTime(q.Get("to")); ok {
		f.To = t
	}
	f.MinCoins, f.MaxCoins = intCell(q.Get("minCoins")), intCell(q.Get("maxCoins"))
	f.MinScore, f.MaxScore = intCell(q.Get("minScore")), intCell(q.Get("maxScore"))
	f.MinMedals, f.MaxMedals = intCell(q.Get("minMedals")), intCell(q.Get("maxMedals"))
	f.Complete = q.Get("incomplete") != "1"
	f.FinalCoins = q.Get("coins") == "final"
	f.Medals = q.Get("coins") == "medals"
	f.Net = q.Get("net") == "1"
	return f
}

// whereAnd is where() with extra conditions, which are trusted SQL.
func (f Filter) whereAnd(extra ...string) (string, dbx.Params) {
	w, p := f.where()
	if len(extra) == 0 {
		return w, p
	}
	if w == "" {
		return " WHERE " + strings.Join(extra, " AND "), p
	}
	return w + " AND " + strings.Join(extra, " AND "), p
}

// where builds the WHERE clause. Values are always bound, never spliced.
func (f Filter) where() (string, dbx.Params) {
	var parts []string
	p := dbx.Params{}
	if len(f.Tsums) > 0 {
		names := make([]string, len(f.Tsums))
		for i, t := range f.Tsums {
			key := fmt.Sprintf("t%d", i)
			names[i] = "{:" + key + "}"
			p[key] = t
		}
		parts = append(parts, "tsum IN ("+strings.Join(names, ",")+")")
	}
	if len(f.Devices) > 0 {
		names := make([]string, len(f.Devices))
		for i, d := range f.Devices {
			key := fmt.Sprintf("d%d", i)
			names[i] = "{:" + key + "}"
			p[key] = d
		}
		parts = append(parts, "device IN ("+strings.Join(names, ",")+")")
	}
	if len(f.SkillTypes) > 0 {
		names := make([]string, len(f.SkillTypes))
		for i, s := range f.SkillTypes {
			key := fmt.Sprintf("st%d", i)
			names[i] = "{:" + key + "}"
			p[key] = s
		}
		parts = append(parts, "skill_type IN ("+strings.Join(names, ",")+")")
	}
	for _, ps := range PlaySettings {
		values := f.Play[ps.Param]
		if len(values) == 0 {
			continue
		}
		names := make([]string, len(values))
		for i, v := range values {
			key := fmt.Sprintf("%s%d", ps.Param, i)
			names[i] = "{:" + key + "}"
			p[key] = v
		}
		parts = append(parts, playSettingSQL(ps)+" IN ("+strings.Join(names, ",")+")")
	}
	if f.Build != "" {
		parts = append(parts, "build = {:build}")
		p["build"] = f.Build
	}
	if f.From != "" {
		parts = append(parts, "played_at >= {:from}")
		p["from"] = f.From
	}
	if f.To != "" {
		parts = append(parts, "played_at < {:to}")
		p["to"] = f.To
	}
	if f.Complete {
		parts = append(parts, completeSQL)
	}
	bound := func(col, key string, v *int64, op string) {
		if v != nil {
			parts = append(parts, col+" "+op+" {:"+key+"}")
			p[key] = *v
		}
	}
	bound(f.coins(), "minCoins", f.MinCoins, ">=")
	bound(f.coins(), "maxCoins", f.MaxCoins, "<=")
	bound("score", "minScore", f.MinScore, ">=")
	bound("score", "maxScore", f.MaxScore, "<=")
	if f.MinMedals != nil || f.MaxMedals != nil {
		var in []string
		if f.MinMedals != nil {
			in = append(in, "medals >= {:minMedals}")
			p["minMedals"] = *f.MinMedals
		}
		if f.MaxMedals != nil {
			in = append(in, "medals <= {:maxMedals}")
			p["maxMedals"] = *f.MaxMedals
		}
		parts = append(parts, "(tsum NOT IN ("+medalTsumsSQL+") OR ("+strings.Join(in, " AND ")+"))")
	}
	if f.Medals || f.onlyMedals {
		parts = append(parts, medalRoundsSQL)
	}
	if len(parts) == 0 {
		return "", p
	}
	return " WHERE " + strings.Join(parts, " AND "), p
}

// Sortable columns, by the name the page uses. Anything else sorts by date.
var sortColumns = map[string]string{
	"playedAt": "played_at", "tsum": "tsum", "score": "score", "baseCoins": "base_coins",
	"finalCoins": "final_coins", "medals": "medals", "medalsPerSec": coinsPerSec("medals"), "durationSeconds": "duration_seconds", "device": "device",
}

// coinsPerSec is one round's coin rate; NULL when either figure is missing.
func coinsPerSec(c string) string { return c + " * 1.0 / NULLIF(duration_seconds, 0)" }

const MaxPerPage = 200

// RoundsPage is one page of the rounds table. The total is the summary's
// round count, so it is not counted twice.
func RoundsPage(db dbx.Builder, f Filter, sort string, page, perPage int) ([]Round, error) {
	desc := strings.HasPrefix(sort, "-")
	col, ok := sortColumns[strings.TrimPrefix(sort, "-")]
	if strings.TrimPrefix(sort, "-") == "coinsPerSec" {
		col, ok = coinsPerSec(f.coin()), true
	}
	if !ok {
		col, desc = "played_at", true
	}
	dir := "ASC"
	if desc {
		dir = "DESC"
	}
	if perPage < 1 || perPage > MaxPerPage {
		perPage = 50
	}
	if page < 1 {
		page = 1
	}
	where, p := f.where()
	p["limit"] = perPage
	p["offset"] = (page - 1) * perPage
	// Unread figures sort last either way; the id breaks ties so paging is
	// stable. played_at is never NULL, so it sorts straight off its index.
	order := col + " " + dir
	if col != "played_at" {
		order += " NULLS LAST"
	}
	q := "SELECT " + roundColumns + " FROM ts_rounds" + where +
		" ORDER BY " + order + ", round_id " + dir + " LIMIT {:limit} OFFSET {:offset}"
	var rows []Round
	err := db.NewQuery(q).Bind(p).All(&rows)
	if rows == nil {
		rows = []Round{}
	}
	for i := range rows {
		rows[i].Items = itemsOf(rows[i].Settings)
	}
	return rows, err
}

// PlayedTsums is every Tsum with at least one round, for the filter's options.
func PlayedTsums(db dbx.Builder) ([]TsumStat, error) {
	var out []TsumStat
	err := db.NewQuery(`SELECT tsum, COUNT(*) AS rounds FROM ts_rounds WHERE tsum <> '' GROUP BY tsum ORDER BY rounds DESC`).All(&out)
	if out == nil {
		out = []TsumStat{}
	}
	return out, err
}

// SkillTypeCount is a skill type, "" for none, and how many rounds it played.
type SkillTypeCount struct {
	SkillType string `db:"skill_type" json:"skillType"`
	Rounds    int64  `db:"rounds" json:"rounds"`
}

// PlayedSkillTypes is every skill type with at least one round, the rounds
// without one included as "", for the filter's options.
func PlayedSkillTypes(db dbx.Builder) ([]SkillTypeCount, error) {
	out := []SkillTypeCount{}
	err := db.NewQuery(`SELECT skill_type, COUNT(*) AS rounds FROM ts_rounds GROUP BY skill_type ORDER BY rounds DESC, skill_type`).All(&out)
	return out, err
}

// PlayValue is one value of a play setting, "" for not recorded, and how
// many rounds played with it.
type PlayValue struct {
	Value  string `db:"value" json:"value"`
	Rounds int64  `db:"rounds" json:"rounds"`
}

// PlayedPlaySettings is each play setting's values with at least one round,
// not recorded among them as "", by parameter, for the filters' options.
func PlayedPlaySettings(db dbx.Builder) (map[string][]PlayValue, error) {
	out := map[string][]PlayValue{}
	for _, ps := range PlaySettings {
		values := []PlayValue{}
		if err := db.NewQuery(`SELECT ` + playSettingSQL(ps) + ` AS value, COUNT(*) AS rounds FROM ts_rounds
			GROUP BY value ORDER BY rounds DESC, value`).All(&values); err != nil {
			return nil, err
		}
		out[ps.Param] = values
	}
	return out, nil
}

// MedalTsums is every Tsum that has earned medals, by name.
func MedalTsums(db dbx.Builder) ([]string, error) {
	out := []string{}
	err := db.NewQuery("SELECT DISTINCT tsum FROM (" + medalTsumsSQL + ") ORDER BY tsum").Column(&out)
	return out, err
}

// DeviceCount is a device name and how many rounds it played.
type DeviceCount struct {
	Device string `db:"device" json:"device"`
	Rounds int64  `db:"rounds" json:"rounds"`
}

// PlayedDevices is every named device with at least one round, for the filter's options.
func PlayedDevices(db dbx.Builder) ([]DeviceCount, error) {
	var out []DeviceCount
	err := db.NewQuery(`SELECT device, COUNT(*) AS rounds FROM ts_rounds WHERE device <> '' GROUP BY device ORDER BY rounds DESC, device`).All(&out)
	if out == nil {
		out = []DeviceCount{}
	}
	return out, err
}

// TsumList is the newest export for one build.
type TsumList struct {
	File       string      `db:"file" json:"file"`
	Build      string      `db:"build" json:"build"`
	Device     string      `db:"device" json:"device"`
	Stamp      string      `db:"stamp" json:"stamp"`
	ImportedAt string      `db:"imported_at" json:"importedAt"`
	Tsums      int         `db:"tsums" json:"tsums"`
	Items      []OwnedTsum `db:"-" json:"items"`
}

// LatestTsumList returns nil when that device has no export for the build yet.
// A device is exactly that name; "" is the lists that came with none.
func LatestTsumList(db dbx.Builder, build, device string) (*TsumList, error) {
	var row struct {
		ID         int64  `db:"id"`
		File       string `db:"file"`
		Build      string `db:"build"`
		Device     string `db:"device"`
		Stamp      string `db:"stamp"`
		ImportedAt string `db:"imported_at"`
		Tsums      int    `db:"tsums"`
	}
	err := db.NewQuery(`SELECT id, file, build, device, stamp, imported_at, tsums FROM ts_tsum_lists
		WHERE build = {:b} AND device = {:d} ORDER BY stamp DESC LIMIT 1`).
		Bind(dbx.Params{"b": build, "d": device}).One(&row)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	l := &TsumList{File: row.File, Build: row.Build, Device: row.Device, Stamp: row.Stamp, ImportedAt: row.ImportedAt, Tsums: row.Tsums}
	err = db.NewQuery(`SELECT ord, tsum, name, level, level_cap, skill, skill_max, skill_progress, acquired, favorite FROM ts_owned
		WHERE list_id = {:id} ORDER BY ord`).Bind(dbx.Params{"id": row.ID}).All(&l.Items)
	if l.Items == nil {
		l.Items = []OwnedTsum{}
	}
	return l, err
}

// ListSource is one device's newest Tsum list for a build.
type ListSource struct {
	Device string `db:"device" json:"device"`
	Build  string `db:"build" json:"build"`
	Stamp  string `db:"stamp" json:"stamp"`
}

// TsumListSources is every device and build that has a Tsum list, by device then build.
func TsumListSources(db dbx.Builder) ([]ListSource, error) {
	out := []ListSource{}
	err := db.NewQuery(`SELECT device, build, MAX(stamp) AS stamp FROM ts_tsum_lists
		GROUP BY device, build ORDER BY device, build`).All(&out)
	return out, err
}
