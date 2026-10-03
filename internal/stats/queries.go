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
	Build   string
	From    string // sqlTime, inclusive, UTC
	To      string // sqlTime, exclusive, UTC
	// The outlier ranges, each bound inclusive. Coins are base or final coins
	// (never medals); the medal range only judges medal Tsums' rounds.
	MinCoins, MaxCoins   *int64
	MinScore, MaxScore   *int64
	MinMedals, MaxMedals *int64
	// Complete keeps only rounds with every figure read (completeSQL).
	Complete bool
	// FinalCoins counts coins after the coin bonus; the default is base coins.
	FinalCoins bool
	// Medals makes medals the primary stat instead of coins, and keeps only
	// rounds that earned medals.
	Medals bool

	// stat, when set, is the column the summary aggregates instead of coin();
	// onlyMedals keeps only rounds that earned medals. Both are for the
	// summary's medal figures, never read from the request.
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

// medalView is f for the summary's medal figures: medals, over rounds that earned any.
func (f Filter) medalView() Filter {
	f.stat, f.onlyMedals = "medals", true
	return f
}

// coin is the primary stat's column: what the figures and the rate use.
func (f Filter) coin() string {
	if f.Medals {
		return "medals"
	}
	if f.FinalCoins {
		return "final_coins"
	}
	return "base_coins"
}

// coins is the coin range's column: base or final coins, even in Medals mode.
func (f Filter) coins() string {
	if f.FinalCoins {
		return "final_coins"
	}
	return "base_coins"
}

// medalTsumsSQL is every Tsum that has earned medals in any round. Its rounds
// need a medal figure to be complete; other Tsums' rounds may leave it blank.
const medalTsumsSQL = "SELECT tsum FROM ts_rounds WHERE medals > 0"

// completeSQL keeps rounds with an identified Tsum and every figure read.
const completeSQL = "tsum <> '' AND score IS NOT NULL AND base_coins IS NOT NULL AND final_coins IS NOT NULL" +
	" AND duration_seconds IS NOT NULL AND (medals IS NOT NULL OR tsum NOT IN (" + medalTsumsSQL + "))"

var sqlTimeRE = regexp.MustCompile(`^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$`)

// ParseFilter reads tsum and device (comma lists), build, from, to, the outlier
// ranges (min/max Coins, Score, Medals), incomplete ("1" keeps rounds with an
// unread figure) and coins (the primary stat: "final", "medals", or base coins by default).
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
		parts = append(parts, "medals > 0")
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
	err = db.NewQuery(`SELECT ord, tsum, name, level, level_cap, skill, skill_max, skill_progress, acquired FROM ts_owned
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
