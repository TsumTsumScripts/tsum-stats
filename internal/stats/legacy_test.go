package stats

import (
	"testing"

	"github.com/pocketbase/pocketbase/core"
	_ "github.com/pocketbase/pocketbase/migrations"
)

// A database made by 0.6 or earlier keeps its rows under the new table names.
func TestRenameLegacyTables(t *testing.T) {
	app := core.NewBaseApp(core.BaseAppConfig{DataDir: t.TempDir()})
	if err := app.Bootstrap(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = app.ResetBootstrapState() })

	for _, q := range []string{
		`CREATE TABLE gap_rounds (round_id TEXT PRIMARY KEY, played_at TEXT NOT NULL, tsum TEXT NOT NULL DEFAULT '', build TEXT NOT NULL DEFAULT '',
			skill_type TEXT NOT NULL DEFAULT '', script_version TEXT NOT NULL DEFAULT '', duration_seconds REAL, score INTEGER, base_coins INTEGER,
			final_coins INTEGER, medals INTEGER, device TEXT NOT NULL DEFAULT '', settings TEXT NOT NULL DEFAULT '{}', source TEXT NOT NULL)`,
		`CREATE INDEX gap_rounds_tsum ON gap_rounds (tsum, played_at)`,
		`CREATE TABLE gap_tsum_lists (id INTEGER PRIMARY KEY, file TEXT NOT NULL UNIQUE, build TEXT NOT NULL, stamp TEXT NOT NULL,
			imported_at TEXT NOT NULL, tsums INTEGER NOT NULL)`,
		`CREATE TABLE gap_owned (list_id INTEGER NOT NULL REFERENCES gap_tsum_lists (id) ON DELETE CASCADE, ord INTEGER, tsum TEXT NOT NULL,
			name TEXT NOT NULL DEFAULT '', level INTEGER, level_cap INTEGER, skill INTEGER, skill_max INTEGER, acquired TEXT NOT NULL DEFAULT '')`,
		`CREATE TABLE gap_imports (path TEXT PRIMARY KEY, size INTEGER NOT NULL, mtime INTEGER NOT NULL)`,
		`INSERT INTO gap_rounds (round_id, played_at, source) VALUES ('r1', '2026-09-04 11:20:31', 'csv')`,
	} {
		if _, err := app.DB().NewQuery(q).Execute(); err != nil {
			t.Fatal(err)
		}
	}
	if err := migrate(app); err != nil {
		t.Fatal(err)
	}
	var n, old int
	if err := app.DB().NewQuery(`SELECT COUNT(*) FROM ts_rounds`).Row(&n); err != nil || n != 1 {
		t.Fatalf("ts_rounds rows = %d, err %v", n, err)
	}
	if err := app.DB().NewQuery(`SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'gap_%'`).Row(&old); err != nil || old != 0 {
		t.Fatalf("%d gap_ objects left, err %v", old, err)
	}
	if err := migrate(app); err != nil { // a second start changes nothing
		t.Fatal(err)
	}
}
