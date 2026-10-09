package stats

import (
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"testing/fstest"
)

func TestSiteFSOverridesOnlyWhenTheManifestAllows(t *testing.T) {
	embedded := fstest.MapFS{
		"index.html":    {Data: []byte("built-in index")},
		"js/catalog.js": {Data: []byte("built-in catalog")},
	}
	dir := filepath.Join(t.TempDir(), "web")
	site, overlay, err := SiteFS(embedded, dir, "0.2.1")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "README.txt")); err != nil {
		t.Fatalf("a new web dir should get a README: %v", err)
	}
	if st := overlay.State(); !st.Unused || st.Reason != "" {
		t.Errorf("a folder holding only the README should be unused, not a mismatch: %+v", st)
	}
	os.MkdirAll(filepath.Join(dir, "js"), 0o755)
	os.WriteFile(filepath.Join(dir, "js", "catalog.js"), []byte("edited"), 0o644)
	catalog := func() string { b, _ := fs.ReadFile(site, "js/catalog.js"); return string(b) }

	// Written after SiteFS: the manifest and files are read per request.
	for _, c := range []struct{ manifest, want string }{
		{"", "built-in catalog"}, // no manifest
		{`not json`, "built-in catalog"},
		{`{"supports": ["0.2.0", "0.3.*"]}`, "built-in catalog"},
		{`{"supports": ["0.2.1"]}`, "edited"},
		{`{"supports": ["0.2.*"]}`, "edited"},
		{`{"supports": ["*"]}`, "edited"},
	} {
		path := filepath.Join(dir, OverrideManifest)
		os.Remove(path)
		if c.manifest != "" {
			os.WriteFile(path, []byte(c.manifest), 0o644)
		}
		if got := catalog(); got != c.want {
			t.Errorf("manifest %q: js/catalog.js = %q, want %q (%+v)", c.manifest, got, c.want, overlay.State())
		}
		if active := overlay.State().Active; active != (c.want == "edited") {
			t.Errorf("manifest %q: Active = %v", c.manifest, active)
		}
	}
	if b, _ := fs.ReadFile(site, "index.html"); string(b) != "built-in index" {
		t.Errorf("index.html = %q, want the built-in one", b)
	}
}

func TestDevAllowsAnyManifest(t *testing.T) {
	if !(Manifest{Supports: []string{"0.1.0"}}).Allows("dev") {
		t.Error("a source build should accept any override")
	}
}

func TestExportSiteKeepsEdits(t *testing.T) {
	embedded := fstest.MapFS{"a.js": {Data: []byte("new")}, "css/b.css": {Data: []byte("new")}}
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.js"), []byte("mine"), 0o644)

	written, kept, err := ExportSite(embedded, dir, "0.2.0", false)
	if err != nil || written != 2 || kept != 1 {
		t.Fatalf("written %d kept %d err %v, want 2 1 nil", written, kept, err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "a.js")); string(b) != "mine" {
		t.Errorf("an existing file was replaced without --force")
	}
	if _, o, _ := SiteFS(embedded, dir, "0.2.0"); !o.State().Active {
		t.Errorf("an exported folder should load on the version that exported it: %+v", o.State())
	}
	if _, _, err := ExportSite(embedded, dir, "0.2.0", true); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "a.js")); string(b) != "new" {
		t.Errorf("--force did not replace a.js")
	}
}

func TestThemesBuiltInOrderFirst(t *testing.T) {
	fsys := fstest.MapFS{
		"themes/aurora.css":        {Data: []byte(":root {}")},
		"themes/ember.css":         {Data: []byte("/* @name Ember */")},
		"themes/daylight-felt.css": {Data: []byte("/* @name Daylight Felt */")},
		"themes/halloween.css":     {Data: []byte("/* @name Halloween */")},
		"themes/midnight-felt.css": {Data: []byte("/* @name Midnight Felt */")},
	}
	got := Themes(fsys)
	want := []Theme{{"halloween.css", "Halloween"}, {"midnight-felt.css", "Midnight Felt"},
		{"daylight-felt.css", "Daylight Felt"}, {"ember.css", "Ember"}, {"aurora.css", "Aurora"}}
	if !slices.Equal(got, want) {
		t.Errorf("Themes() = %v, want %v", got, want)
	}
}

func TestThemesMergeAndServeWithoutAManifest(t *testing.T) {
	embedded := fstest.MapFS{
		"themes/daylight.css":  {Data: []byte("/* @name Daylight */\n:root { color-scheme: light; }")},
		"themes/deep-sea.css":  {Data: []byte(":root {}")},
		"themes/_template.css": {Data: []byte(":root {}")},
	}
	dir := t.TempDir()
	site, overlay, err := SiteFS(embedded, dir, "0.3.0")
	if err != nil {
		t.Fatal(err)
	}
	os.MkdirAll(filepath.Join(dir, "themes"), 0o755)
	os.WriteFile(filepath.Join(dir, "themes", "daylight.css"), []byte("/* @name My daylight */"), 0o644)
	os.WriteFile(filepath.Join(dir, "themes", "mine.css"), []byte(":root {}"), 0o644)

	got := overlay.Themes()
	want := []Theme{{"deep-sea.css", "Deep sea"}, {"mine.css", "Mine"}, {"daylight.css", "My daylight"}}
	if !slices.Equal(got, want) {
		t.Errorf("Themes() = %v, want %v", got, want)
	}
	// No override.json: other files are ignored, themes are not.
	if b, _ := fs.ReadFile(site, "themes/mine.css"); string(b) != ":root {}" {
		t.Errorf("a player's theme should be served without a manifest, got %q", b)
	}
	if overlay.State().Active {
		t.Errorf("themes alone should not turn the override on")
	}
}
