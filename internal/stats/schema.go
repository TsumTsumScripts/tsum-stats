// Package stats is the Tsum Tsum stats site's server side: the tables, the CSV
// importer, the event listener and the /api/stats routes.
package stats

import (
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
		acquired  TEXT NOT NULL DEFAULT ''
	)`,
	`CREATE INDEX IF NOT EXISTS ts_owned_list ON ts_owned (list_id)`,
	// What has been read, so a rescan skips files that have not changed.
	`CREATE TABLE IF NOT EXISTS ts_imports (
		path  TEXT PRIMARY KEY,
		size  INTEGER NOT NULL,
		mtime INTEGER NOT NULL
	)`,
}

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
	if err := addListColumn(app, "ts_tsum_lists", "device", "TEXT NOT NULL DEFAULT ''"); err != nil {
		return err
	}
	return rereadListsOnce(app, "device-from-folder")
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
