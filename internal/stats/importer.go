package stats

import (
	"bytes"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

// Importer reads stats_*.csv and tsum_list_*.csv out of the folders it is given.
type Importer struct {
	app  core.App
	dirs []string
	mu   sync.Mutex
	// changed is called after an import that stored something.
	changed func(ImportResult)
}

// ImportResult says what one scan or upload stored.
type ImportResult struct {
	Files  int `json:"files"`
	Rounds int `json:"rounds"`
	Lists  int `json:"lists"`
	// Unchanged counts files already imported at this size and mtime.
	Unchanged int      `json:"unchanged,omitempty"`
	Errors    []string `json:"errors,omitempty"`
}

// Folders a scan never descends into: debug captures, and anything too deep
// to be the script's own tsum_record/.
var skipDirs = map[string]bool{"corpus": true, ".git": true, "node_modules": true}

const maxScanDepth = 8

func NewImporter(app core.App, dirs []string, changed func(ImportResult)) *Importer {
	return &Importer{app: app, dirs: dirs, changed: changed}
}

func (im *Importer) Dirs() []string { return im.dirs }

// Run scans now and then every interval until stop is closed.
func (im *Importer) Run(interval time.Duration, stop <-chan struct{}) {
	t := time.NewTicker(interval)
	defer t.Stop()
	for {
		im.Scan()
		select {
		case <-stop:
			return
		case <-t.C:
		}
	}
}

// Scan imports every new or changed file under the folders. Overlapping calls
// return at once rather than scanning twice.
func (im *Importer) Scan() ImportResult {
	var res ImportResult
	if !im.mu.TryLock() {
		return res
	}
	defer im.mu.Unlock()
	for _, root := range im.dirs {
		if _, err := os.Stat(root); err != nil {
			continue
		}
		rootDepth := strings.Count(filepath.Clean(root), string(filepath.Separator))
		_ = filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
			if err != nil {
				return nil
			}
			if d.IsDir() {
				if skipDirs[d.Name()] || strings.Count(path, string(filepath.Separator))-rootDepth > maxScanDepth {
					return filepath.SkipDir
				}
				return nil
			}
			name := d.Name()
			if !statsFileRE.MatchString(name) && !tsumListFileRE.MatchString(name) {
				return nil
			}
			info, err := d.Info()
			if err != nil || im.seen(path, info) {
				return nil
			}
			data, err := os.ReadFile(path)
			if err != nil {
				res.Errors = append(res.Errors, err.Error())
				return nil
			}
			if err := im.importData(name, data, im.folderDevice(path), &res); err != nil {
				res.Errors = append(res.Errors, fmt.Sprintf("%s: %v", path, err))
				return nil
			}
			im.remember(path, info)
			return nil
		})
	}
	im.notify(res)
	return res
}

// ImportFiles imports the given files now, waiting for a running scan rather
// than skipping. A file already imported unchanged is counted, not re-read.
func (im *Importer) ImportFiles(paths []string) ImportResult {
	var res ImportResult
	im.mu.Lock()
	defer im.mu.Unlock()
	for _, path := range paths {
		info, err := os.Stat(path)
		if err != nil {
			res.Errors = append(res.Errors, err.Error())
			continue
		}
		if im.seen(path, info) {
			res.Unchanged++
			continue
		}
		data, err := os.ReadFile(path)
		if err != nil {
			res.Errors = append(res.Errors, err.Error())
			continue
		}
		if err := im.importData(filepath.Base(path), data, im.folderDevice(path), &res); err != nil {
			res.Errors = append(res.Errors, fmt.Sprintf("%s: %v", filepath.Base(path), err))
			continue
		}
		im.remember(path, info)
	}
	im.notify(res)
	return res
}

// Import stores one uploaded file, recognised by its name.
func (im *Importer) Import(name string, r io.Reader) (ImportResult, error) {
	var res ImportResult
	name = filepath.Base(name)
	if !statsFileRE.MatchString(name) && !tsumListFileRE.MatchString(name) {
		return res, fmt.Errorf("%s is neither stats_YYYYMMDD.csv nor tsum_list_<stamp>.csv", name)
	}
	data, err := io.ReadAll(io.LimitReader(r, 64<<20))
	if err != nil {
		return res, err
	}
	im.mu.Lock()
	defer im.mu.Unlock()
	if err := im.importData(name, data, "", &res); err != nil {
		return res, err
	}
	im.notify(res)
	return res, nil
}

// folderDevice is the device a file was pulled from when the file does not say:
// the first folder under an import folder (collected/<serial>/...), which is one
// emulator. "" for a file straight in an import folder.
func (im *Importer) folderDevice(path string) string {
	for _, dir := range im.dirs {
		rel, err := filepath.Rel(dir, path)
		if err != nil || strings.HasPrefix(rel, "..") {
			continue
		}
		if parts := strings.Split(filepath.ToSlash(rel), "/"); len(parts) > 1 {
			return parts[0]
		}
	}
	return ""
}

// importData stores one file. fallbackDevice names the device of a Tsum list
// whose CSV has no device column or an empty one.
func (im *Importer) importData(name string, data []byte, fallbackDevice string, res *ImportResult) error {
	if m := tsumListFileRE.FindStringSubmatch(name); m != nil {
		build, device, rows, err := parseTsumListCSV(bytes.NewReader(data))
		if err != nil {
			return err
		}
		if device == "" {
			device = fallbackDevice
		}
		err = im.app.RunInTransaction(func(tx core.App) error {
			return replaceTsumList(tx.DB(), name, build, device, m[1], rows)
		})
		if err == nil {
			res.Files++
			res.Lists++
		}
		return err
	}
	rounds, err := parseStatsCSV(bytes.NewReader(data))
	if err != nil {
		return err
	}
	err = im.app.RunInTransaction(func(tx core.App) error {
		for _, r := range rounds {
			if err := upsertRound(tx.DB(), r); err != nil {
				return err
			}
		}
		return nil
	})
	if err == nil {
		res.Files++
		res.Rounds += len(rounds)
	}
	return err
}

func (im *Importer) seen(path string, info fs.FileInfo) bool {
	var n int
	err := im.app.DB().NewQuery("SELECT COUNT(*) FROM ts_imports WHERE path = {:p} AND size = {:s} AND mtime = {:m}").
		Bind(dbx.Params{"p": path, "s": info.Size(), "m": info.ModTime().UnixNano()}).Row(&n)
	return err == nil && n > 0
}

func (im *Importer) remember(path string, info fs.FileInfo) {
	_, _ = im.app.DB().NewQuery(`INSERT INTO ts_imports (path, size, mtime) VALUES ({:p}, {:s}, {:m})
		ON CONFLICT (path) DO UPDATE SET size = excluded.size, mtime = excluded.mtime`).
		Bind(dbx.Params{"p": path, "s": info.Size(), "m": info.ModTime().UnixNano()}).Execute()
}

func (im *Importer) notify(res ImportResult) {
	if res.Files > 0 && im.changed != nil {
		im.changed(res)
	}
}

// DefaultImportDirs are the places the script's files land on this PC without
// being asked: MuMu mounts the guest's Download folder here.
func DefaultImportDirs() []string {
	home, err := os.UserHomeDir()
	if err != nil {
		return nil
	}
	var dirs []string
	for _, d := range []string{filepath.Join(home, "Documents", "MuMuSharedFolder")} {
		if st, err := os.Stat(d); err == nil && st.IsDir() {
			dirs = append(dirs, d)
		}
	}
	return dirs
}
