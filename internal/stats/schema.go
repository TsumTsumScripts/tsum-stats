// Package stats is the Tsum Tsum stats site's server side: the tables, the CSV
// importer, the event listener and the /api/stats routes.
package stats

import (
	"strings"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

// Plain SQL tables rather than PocketBase collections: a collection's number
// field cannot hold NULL, and an unread score must stay NULL so it is left out
// of averages instead of counting as 0.
var schema = []string{
	`CREATE TABLE IF NOT EXISTS ts_rounds (
		round_id         TEXT PRIMARY KEY,
		played_at        TEXT NOT NULL,
		tsum             TEXT NOT NULL DEFAULT '',
		build            TEXT NOT NULL DEFAULT '',
		skill_type       TEXT NOT NULL DEFAULT '',
		script_version   TEXT NOT NULL DEFAULT '',
		duration_seconds REAL,
		score            INTEGER,
		base_coins       INTEGER,
		final_coins      INTEGER,
		medals           INTEGER,
		device           TEXT NOT NULL DEFAULT '',
		settings         TEXT NOT NULL DEFAULT '{}',
		source           TEXT NOT NULL
	)`,
	// With round_id, so the table's default order (newest first, id to break
	// ties) is a walk of this index rather than a sort.
	`CREATE INDEX IF NOT EXISTS ts_rounds_played ON ts_rounds (played_at, round_id)`,
	`CREATE INDEX IF NOT EXISTS ts_rounds_tsum ON ts_rounds (tsum, played_at)`,
	`CREATE INDEX IF NOT EXISTS ts_rounds_build ON ts_rounds (build, played_at)`,
	`CREATE INDEX IF NOT EXISTS ts_rounds_score ON ts_rounds (score)`,
	`CREATE INDEX IF NOT EXISTS ts_rounds_coins ON ts_rounds (final_coins)`,
	`CREATE TABLE IF NOT EXISTS ts_tsum_lists (
		id          INTEGER PRIMARY KEY,
		file        TEXT NOT NULL UNIQUE,
		build       TEXT NOT NULL,
		device      TEXT NOT NULL DEFAULT '',
		stamp       TEXT NOT NULL,
		imported_at TEXT NOT NULL,
		tsums       INTEGER NOT NULL
	)`,
	`CREATE TABLE IF NOT EXISTS ts_owned (
		list_id   INTEGER NOT NULL REFERENCES ts_tsum_lists (id) ON DELETE CASCADE,
		ord       INTEGER,
		tsum      TEXT NOT NULL,
		name      TEXT NOT NULL DEFAULT '',
		level     INTEGER,
		level_cap INTEGER,
		skill     INTEGER,
		skill_max INTEGER,
		skill_progress INTEGER,
		acquired  TEXT NOT NULL DEFAULT '',
		favorite  INTEGER
	)`,
	`CREATE INDEX IF NOT EXISTS ts_owned_list ON ts_owned (list_id)`,
	// What has been read, so a rescan skips files that have not changed.
	`CREATE TABLE IF NOT EXISTS ts_imports (
		path  TEXT PRIMARY KEY,
		size  INTEGER NOT NULL,
		mtime INTEGER NOT NULL
	)`,
	// The runs of rounds counted at another skill level than recorded, and why
	// (skillfix.go: Refile). Made again from the rounds, so nothing is lost with it.
	skillFixesTable,
	`CREATE INDEX IF NOT EXISTS ts_skill_fixes_tsum ON ts_skill_fixes (tsum)`,
	// Which game account a stretch of rounds (game, device name, device tag)
	// was played on, as the player said: list_file is one of that account's
	// Tsum Lists, '' for "not known" (accounts.go). Only the player's answers
	// are here; nothing in ts_rounds changes.
	`CREATE TABLE IF NOT EXISTS ts_account_links (
		build     TEXT NOT NULL,
		device    TEXT NOT NULL,
		tag       TEXT NOT NULL,
		list_file TEXT NOT NULL,
		PRIMARY KEY (build, device, tag)
	)`,
	// What the global stats site has taken (global.go), so a round is sent
	// again only when its record changes. hash is the record's fingerprint.
	`CREATE TABLE IF NOT EXISTS ts_global_sent (
		round_id TEXT PRIMARY KEY,
		hash     INTEGER NOT NULL,
		sent_at  TEXT NOT NULL
	)`,
}

// skillFixesTable is ts_skill_fixes; refileOnce makes it again when its columns change.
const skillFixesTable = `CREATE TABLE IF NOT EXISTS ts_skill_fixes (
		tsum        TEXT NOT NULL,
		player      TEXT NOT NULL,
		from_level  INTEGER NOT NULL,
		to_level    INTEGER NOT NULL,
		rounds      INTEGER NOT NULL,
		first       TEXT NOT NULL,
		last        TEXT NOT NULL,
		rule        TEXT NOT NULL,
		context     INTEGER NOT NULL,
		n           INTEGER NOT NULL,
		mid         REAL NOT NULL,
		against_n   INTEGER NOT NULL,
		against_mid REAL NOT NULL,
		ratio       REAL NOT NULL,
		confidence  TEXT NOT NULL,
		medals      INTEGER NOT NULL DEFAULT 0,
		list_device TEXT NOT NULL DEFAULT '',
		list_stamp  TEXT NOT NULL DEFAULT '',
		list_level  INTEGER NOT NULL DEFAULT 0,
		list_bound  TEXT NOT NULL DEFAULT ''
	)`

// legacyTables are the names databases from 0.6 and earlier use, which the
// program shipped under another name.
var legacyTables = []string{"rounds", "tsum_lists", "owned", "imports"}

// renameLegacyTables gives an old database its current table names and drops
// the old index names, which the schema below recreates.
func renameLegacyTables(app core.App) error {
	for _, t := range legacyTables {
		var old, cur int
		q := `SELECT COUNT(*) FROM sqlite_master WHERE type = 'table' AND name = {:n}`
		if err := app.DB().NewQuery(q).Bind(dbx.Params{"n": "gap_" + t}).Row(&old); err != nil {
			return err
		}
		if err := app.DB().NewQuery(q).Bind(dbx.Params{"n": "ts_" + t}).Row(&cur); err != nil {
			return err
		}
		if old == 0 || cur > 0 {
			continue
		}
		if _, err := app.DB().NewQuery(`ALTER TABLE gap_` + t + ` RENAME TO ts_` + t).Execute(); err != nil {
			return err
		}
	}
	for _, ix := range []string{"played", "tsum", "build", "score", "coins"} {
		if _, err := app.DB().NewQuery(`DROP INDEX IF EXISTS gap_rounds_` + ix).Execute(); err != nil {
			return err
		}
	}
	_, err := app.DB().NewQuery(`DROP INDEX IF EXISTS gap_owned_list`).Execute()
	return err
}

func migrate(app core.App) error {
	if err := renameLegacyTables(app); err != nil {
		return err
	}
	for _, q := range schema {
		if _, err := app.DB().NewQuery(q).Execute(); err != nil {
			return err
		}
	}
	if err := addListColumn(app, "ts_owned", "skill_progress", "INTEGER"); err != nil {
		return err
	}
	if err := addListColumn(app, "ts_owned", "favorite", "INTEGER"); err != nil {
		return err
	}
	if err := addListColumn(app, "ts_tsum_lists", "device", "TEXT NOT NULL DEFAULT ''"); err != nil {
		return err
	}
	if err := addItemsColumn(app); err != nil {
		return err
	}
	if err := rereadListsOnce(app, "device-from-folder"); err != nil {
		return err
	}
	return refileOnce(app)
}

// refileOnce works out every round's effective skill level (Refile) once per
// SkillFixVersion: for a database from before the correction, and again when
// its rules change. After that, whoever stores rounds keeps it up.
func refileOnce(app core.App) error {
	path := "migration:skill-fix-" + SkillFixVersion
	var n int
	err := app.DB().NewQuery(`SELECT COUNT(*) FROM ts_imports WHERE path = {:p}`).Bind(dbx.Params{"p": path}).Row(&n)
	if err != nil || n > 0 {
		return err
	}
	// The fixes are made from the rounds, so a table of an older shape is simply made again.
	for _, q := range []string{`DROP TABLE IF EXISTS ts_skill_fixes`, skillFixesTable, `CREATE INDEX IF NOT EXISTS ts_skill_fixes_tsum ON ts_skill_fixes (tsum)`} {
		if _, err := app.DB().NewQuery(q).Execute(); err != nil {
			return err
		}
	}
	if err := Refile(app.DB()); err != nil {
		return err
	}
	_, err = app.DB().NewQuery(`INSERT INTO ts_imports (path, size, mtime) VALUES ({:p}, 0, 0)`).Bind(dbx.Params{"p": path}).Execute()
	return err
}

// addItemsColumn gives ts_rounds the columns worked out from settings once
// instead of in every query: items, a round's boost-item bitmask (itemBits),
// NULL when its settings predate the items (itemsMaskSQL), and skill_level,
// its skill level 1-10 as text, '' when none (skillLevelOf), and skill_eff,
// the level it counts at (skillfix.go), which starts as skill_level and which
// Refile moves. Triggers keep them in step with settings whoever writes the
// row (so a round stored again counts as recorded until Refile runs), and
// rows from before a column are filled in here.
func addItemsColumn(app core.App) error {
	cols := []struct {
		name, def string
		value     func(settings string) string
	}{
		{"items", "INTEGER", itemsMaskSQL},
		{"skill_level", "TEXT NOT NULL DEFAULT ''", skillLevelOf},
		{"skill_eff", "TEXT NOT NULL DEFAULT ''", skillLevelOf},
	}
	var qs []string
	sets := make([]string, len(cols))
	for i, c := range cols {
		var n int
		err := app.DB().NewQuery(`SELECT COUNT(*) FROM pragma_table_info('ts_rounds') WHERE name = {:c}`).Bind(dbx.Params{"c": c.name}).Row(&n)
		if err != nil {
			return err
		}
		if n == 0 {
			qs = append(qs, `ALTER TABLE ts_rounds ADD COLUMN `+c.name+` `+c.def, `UPDATE ts_rounds SET `+c.name+` = `+c.value("settings"))
		}
		sets[i] = c.name + " = " + c.value("NEW.settings")
	}
	// Made again each start, so a column added since is in them.
	set := "UPDATE ts_rounds SET " + strings.Join(sets, ", ") + " WHERE rowid = NEW.rowid;"
	qs = append(qs,
		`DROP TRIGGER IF EXISTS ts_rounds_items_insert`,
		`DROP TRIGGER IF EXISTS ts_rounds_items_update`,
		`CREATE TRIGGER ts_rounds_items_insert AFTER INSERT ON ts_rounds BEGIN `+set+` END`,
		`CREATE TRIGGER ts_rounds_items_update AFTER UPDATE OF settings ON ts_rounds BEGIN `+set+` END`,
	)
	for _, q := range qs {
		if _, err := app.DB().NewQuery(q).Execute(); err != nil {
			return err
		}
	}
	return nil
}

// rereadListsOnce forgets which Tsum lists were read, once per marker, so a
// change in how a list is stored reaches the ones already imported.
func rereadListsOnce(app core.App, marker string) error {
	path := "migration:" + marker
	var n int
	err := app.DB().NewQuery(`SELECT COUNT(*) FROM ts_imports WHERE path = {:p}`).Bind(dbx.Params{"p": path}).Row(&n)
	if err != nil || n > 0 {
		return err
	}
	for _, q := range []string{
		`DELETE FROM ts_imports WHERE path LIKE '%tsum_list_%'`,
		`INSERT INTO ts_imports (path, size, mtime) VALUES ('` + path + `', 0, 0)`,
	} {
		if _, err := app.DB().NewQuery(q).Execute(); err != nil {
			return err
		}
	}
	return nil
}

// addListColumn adds a Tsum list column to a database made before it, and
// forgets which Tsum lists were read so the next scan fills it in.
func addListColumn(app core.App, table, column, def string) error {
	var n int
	err := app.DB().NewQuery(`SELECT COUNT(*) FROM pragma_table_info({:t}) WHERE name = {:c}`).
		Bind(dbx.Params{"t": table, "c": column}).Row(&n)
	if err != nil || n > 0 {
		return err
	}
	for _, q := range []string{
		`ALTER TABLE ` + table + ` ADD COLUMN ` + column + ` ` + def,
		`DELETE FROM ts_imports WHERE path LIKE '%tsum_list_%'`,
	} {
		if _, err := app.DB().NewQuery(q).Execute(); err != nil {
			return err
		}
	}
	return nil
}
