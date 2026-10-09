package stats

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"

	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
)

// OverrideManifest names the versions a --web-dir was written for. Without it,
// or when the running version is not listed, the folder is ignored.
const OverrideManifest = "override.json"

// WebDirReadme is written into a new --web-dir so a player finds out what the
// folder is for.
const WebDirReadme = `Files here replace the stats website's built-in files of the same path.

Themes: put a CSS file in themes/ (themes/mine.css) and pick it from the
Theme menu at the top of the page. A theme sets the colour and font tokens
on :root; copy a built-in one to start (tsum-stats web export, then
themes/daylight-felt.css). A first line of "/* @name My theme */" names it.
Themes are always used, whatever override.json says.

Other files: assets/app.js here is served instead of the built-in one.
Anything not here still comes from the built-in site.

This folder is only used when override.json lists the running tsum-stats
version, since a newer tsum-stats may need its own newer files:

  {"supports": ["0.2.0", "0.3.*"]}

An entry is an exact version, a prefix ending in .* or * for any. Otherwise
the whole folder is ignored and the page says why.

Files are read on every request: edit, save, refresh the browser.
To start from the built-in files (override.json included), run:

  tsum-stats web export <this folder>
`

// Manifest is override.json.
type Manifest struct {
	Supports []string `json:"supports"`
}

// Allows reports whether version matches one of m's entries. A source
// build ("dev") matches any.
func (m Manifest) Allows(version string) bool {
	if version == "dev" {
		return true
	}
	return slices.ContainsFunc(m.Supports, func(p string) bool {
		if prefix, ok := strings.CutSuffix(p, "*"); ok {
			return strings.HasPrefix(version, prefix)
		}
		return p == version
	})
}

// OverrideState is what /api/stats/status reports about --web-dir.
type OverrideState struct {
	Dir    string `json:"dir"`
	Active bool   `json:"active"`
	Unused bool   `json:"unused"`           // nothing in it but the README
	Reason string `json:"reason,omitempty"` // why it is ignored
}

// Overlay serves files from disk, falling back to base for anything disk does
// not have. Disk is used only while its manifest supports version.
type Overlay struct {
	dir, version string
	disk, base   fs.FS

	mu     sync.Mutex
	logged string // last state logged, so a change is logged once
}

// State reads the manifest; it is re-read on every call so edits apply on
// refresh.
func (o *Overlay) State() OverrideState {
	st := OverrideState{Dir: o.dir}
	data, err := fs.ReadFile(o.disk, OverrideManifest)
	var m Manifest
	switch {
	case errors.Is(err, fs.ErrNotExist) && o.unused():
		st.Unused = true
	case errors.Is(err, fs.ErrNotExist):
		st.Reason = fmt.Sprintf("it has no %s listing the versions it supports", OverrideManifest)
	case err != nil:
		st.Reason = fmt.Sprintf("%s could not be read: %v", OverrideManifest, err)
	case json.Unmarshal(data, &m) != nil:
		st.Reason = fmt.Sprintf("%s is not valid JSON", OverrideManifest)
	case !m.Allows(o.version):
		st.Reason = fmt.Sprintf("%s supports %s, not tsum-stats %s", OverrideManifest, strings.Join(m.Supports, ", "), o.version)
	default:
		st.Active = true
	}

	o.mu.Lock()
	defer o.mu.Unlock()
	if msg := st.Reason; msg != o.logged {
		o.logged = msg
		if st.Unused {
			// Nothing to say about a folder nobody has used.
		} else if st.Active {
			log.Printf("site files in %s replace the built-in ones", o.dir)
		} else {
			log.Printf("site files in %s are ignored: %s", o.dir, msg)
		}
	}
	return st
}

// unused reports whether dir holds nothing but the README SiteFS wrote.
func (o *Overlay) unused() bool {
	entries, err := fs.ReadDir(o.disk, ".")
	return err == nil && !slices.ContainsFunc(entries, func(e fs.DirEntry) bool { return e.Name() != "README.txt" })
}

// Open serves name from disk while the manifest allows. A theme is only token
// overrides and cannot break a newer page, so themes/ is served either way.
func (o *Overlay) Open(name string) (fs.File, error) {
	if isTheme(name) || o.State().Active {
		f, err := o.disk.Open(name)
		if err == nil {
			return f, nil
		}
		if !errors.Is(err, fs.ErrNotExist) {
			return nil, err
		}
	}
	return o.base.Open(name)
}

// Themes lists the built-in themes and, from disk, the player's own.
func (o *Overlay) Themes() []Theme {
	return Themes(o.base, o.disk)
}

// ThemeDir holds the themes: CSS files of token overrides the page can switch to.
const ThemeDir = "themes"

func isTheme(name string) bool {
	dir, file := path.Split(name)
	return dir == ThemeDir+"/" && strings.HasSuffix(file, ".css")
}

// Theme is one themes/*.css file.
type Theme struct {
	File string `json:"file"` // under themes/
	Name string `json:"name"` // its @name, else from the file name
}

// themeName is a theme's "@name Daylight" line, near the top of the file.
var themeName = regexp.MustCompile(`@name[ \t]+([^\r\n*]+)`)

// themeOrder puts the built-in themes first, in this order; the first is the
// page's default (DEFAULT_THEME in ui/src/lib/ui.svelte.js).
var themeOrder = []string{"halloween.css", "midnight-felt.css", "daylight-felt.css", "ember.css"}

// Themes lists themes/*.css across fsyses: those in themeOrder first, in that
// order, then the rest sorted by name. A later fs's file
// replaces an earlier one's of the same name; a file starting with _ is left
// out, so a template can sit beside the themes.
func Themes(fsyses ...fs.FS) []Theme {
	byFile := map[string]Theme{}
	for _, fsys := range fsyses {
		if fsys == nil {
			continue
		}
		matches, _ := fs.Glob(fsys, ThemeDir+"/*.css")
		for _, m := range matches {
			file := path.Base(m)
			if strings.HasPrefix(file, "_") {
				continue
			}
			t := Theme{File: file, Name: strings.ReplaceAll(strings.TrimSuffix(file, ".css"), "-", " ")}
			t.Name = strings.ToUpper(t.Name[:1]) + t.Name[1:]
			if data, err := fs.ReadFile(fsys, m); err == nil {
				if sub := themeName.FindSubmatch(data[:min(len(data), 1024)]); sub != nil {
					t.Name = strings.TrimSpace(string(sub[1]))
				}
			}
			byFile[file] = t
		}
	}
	themes := make([]Theme, 0, len(byFile))
	for _, t := range byFile {
		themes = append(themes, t)
	}
	rank := func(t Theme) int {
		if i := slices.Index(themeOrder, t.File); i >= 0 {
			return i
		}
		return len(themeOrder)
	}
	slices.SortFunc(themes, func(a, b Theme) int {
		if c := rank(a) - rank(b); c != 0 {
			return c
		}
		return strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name))
	})
	return themes
}

// SiteFS layers dir over the embedded site; nil overlay when dir is "". It
// creates dir, with a README, when it is missing. os.Root keeps symlinks from
// reaching outside dir.
func SiteFS(embedded fs.FS, dir, version string) (fs.FS, *Overlay, error) {
	if dir == "" {
		return embedded, nil, nil
	}
	if _, err := os.Stat(dir); errors.Is(err, fs.ErrNotExist) {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, nil, err
		}
		if err := os.WriteFile(filepath.Join(dir, "README.txt"), []byte(WebDirReadme), 0o644); err != nil {
			return nil, nil, err
		}
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return nil, nil, err
	}
	o := &Overlay{dir: dir, version: version, disk: root.FS(), base: embedded}
	o.State() // log the starting state
	return o, o, nil
}

// ExportSite copies the embedded site into dir, with a manifest supporting
// version. Existing files are kept unless force is set.
func ExportSite(embedded fs.FS, dir, version string, force bool) (written, kept int, err error) {
	put := func(dst string, data []byte) error {
		if _, err := os.Stat(dst); err == nil && !force {
			kept++
			return nil
		}
		if err := os.WriteFile(dst, data, 0o644); err != nil {
			return fmt.Errorf("writing %s: %w", dst, err)
		}
		written++
		return nil
	}
	err = fs.WalkDir(embedded, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		dst := filepath.Join(dir, filepath.FromSlash(path))
		if d.IsDir() {
			return os.MkdirAll(dst, 0o755)
		}
		data, err := fs.ReadFile(embedded, path)
		if err != nil {
			return err
		}
		return put(dst, data)
	})
	if err != nil {
		return written, kept, err
	}
	manifest, _ := json.MarshalIndent(Manifest{Supports: []string{version}}, "", "  ")
	return written, kept, put(filepath.Join(dir, OverrideManifest), append(manifest, '\n'))
}

// serveSite serves site with no-cache, so an edited file shows on refresh.
func serveSite(site fs.FS) func(*core.RequestEvent) error {
	static := apis.Static(site, true)
	return func(e *core.RequestEvent) error {
		e.Response.Header().Set("Cache-Control", "no-cache")
		return static(e)
	}
}
