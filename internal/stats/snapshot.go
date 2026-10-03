package stats

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
)

// A snapshot is Tsum Tsum Stats as a static site: the built site plus its data as
// files, for a host that only serves files (GitHub Pages). The page reads the
// data in the browser instead of asking the server (ui/src/lib/snapshot/).
//
// Rounds are split by month (UTC), one file each. A finished month never
// changes, so a host caches it and a repo only grows by the current month per
// publish. Each file is column by column, with repeated text (Tsum, device...)
// in a small dictionary, and the time as seconds since the last round: the
// same rounds cost a fraction of the row-by-row JSON the API sends.

// SnapshotDir is where the data lives under the exported site.
const SnapshotDir = "data/snapshot"

// SnapshotFormat is bumped when the files' layout changes in a way the page
// cannot read.
const SnapshotFormat = 1

// snapshotMeta is the tag added to the exported index.html: the page is a
// snapshot when it is there. (The live server answers unknown paths with
// index.html, so probing for a file cannot tell the two apart.)
const snapshotMeta = `<meta name="tsum-snapshot" content="1">`

// Device names are how a player's phones are called; a public page shows them
// only when asked to.
const (
	DevicesAnonymous = "anonymous" // "Device 1", "Device 2": told apart, not named
	DevicesKeep      = "keep"
	DevicesHide      = "hide"
)

// SnapshotOptions are the choices made when exporting.
type SnapshotOptions struct {
	Devices string // DevicesAnonymous (the default), DevicesKeep or DevicesHide
	NoOwned bool   // leave out the Tsum lists (the player's collection)
	Version string
	Now     time.Time // the generated-at stamp; zero means now
}

// SnapshotResult says what an export wrote.
type SnapshotResult struct {
	Rounds int
	Months int
	Files  int // written or changed; unchanged data files are left alone
	Bytes  int64
}

// snapshotManifest is manifest.json: what the page needs before it loads a month.
type snapshotManifest struct {
	Kind        string          `json:"kind"`
	Format      int             `json:"format"`
	GeneratedAt string          `json:"generatedAt"`
	Version     string          `json:"version"`
	Rounds      int             `json:"rounds"`
	First       string          `json:"first"`
	Last        string          `json:"last"`
	Months      []snapshotMonth `json:"months"`
	Tsums       []TsumStat      `json:"tsums"`
	Devices     []DeviceCount   `json:"devices"`
	// MedalTsums is medalTsumsSQL, for the engine's completeness and medal range.
	MedalTsums []string `json:"medalTsums"`
	Themes     []Theme  `json:"themes"`
	// Owned is each device's newest Tsum list per build, for the Catalog's device picker.
	Owned []snapshotOwned `json:"owned"`
}

// snapshotOwned is one device's newest Tsum list for a build.
type snapshotOwned struct {
	Device string `json:"device"`
	Build  string `json:"build"`
	Stamp  string `json:"stamp"`
	File   string `json:"file"`
}

type snapshotMonth struct {
	Month  string `json:"month"`
	File   string `json:"file"`
	Rounds int    `json:"rounds"`
	First  string `json:"first"`
	Last   string `json:"last"`
	// SHA is the file's hash, so a publisher can skip the months that did not change.
	SHA string `json:"sha"`
}

// monthFile is one month's rounds, column by column. A nullable column holds
// null where the script could not read the figure. Every column has N entries.
type monthFile struct {
	Format int    `json:"format"`
	Month  string `json:"month"`
	N      int    `json:"n"`
	// Dict lists each text column's distinct values; the column holds indexes into it.
	Dict struct {
		Tsum          []string `json:"tsum"`
		Build         []string `json:"build"`
		SkillType     []string `json:"skillType"`
		ScriptVersion []string `json:"scriptVersion"`
		Device        []string `json:"device"`
		Source        []string `json:"source"`
	} `json:"dict"`
	// At is the first round's time in seconds since 1970 (UTC), then each next
	// round's gap after the one before. Rounds are in time order.
	At            []int64    `json:"at"`
	Tsum          []int      `json:"tsum"`
	Build         []int      `json:"build"`
	SkillType     []int      `json:"skillType"`
	ScriptVersion []int      `json:"scriptVersion"`
	Device        []int      `json:"device"`
	Source        []int      `json:"source"`
	Duration      []*float64 `json:"duration"`
	Score         []*int64   `json:"score"`
	BaseCoins     []*int64   `json:"baseCoins"`
	FinalCoins    []*int64   `json:"finalCoins"`
	Medals        []*int64   `json:"medals"`
	// Items is the boost-item bitmask (see itemBits), null when unknown.
	Items []*int `json:"items"`
}

// dictionary numbers distinct strings in the order they first appear.
type dictionary struct {
	values []string
	index  map[string]int
}

func (d *dictionary) add(s string) int {
	if i, ok := d.index[s]; ok {
		return i
	}
	if d.index == nil {
		d.index = map[string]int{}
	}
	d.index[s] = len(d.values)
	d.values = append(d.values, s)
	return len(d.values) - 1
}

// encodeMonth builds one month's file from its rounds, which are in time order.
func encodeMonth(month string, rounds []Round, devices func(string) string) ([]byte, error) {
	m := monthFile{Format: SnapshotFormat, Month: month, N: len(rounds)}
	var tsum, build, skill, ver, device, source dictionary
	var prev int64
	for i, r := range rounds {
		t, err := time.Parse(sqlTime, r.PlayedAt)
		if err != nil {
			return nil, fmt.Errorf("round %s: bad time %q", r.ID, r.PlayedAt)
		}
		at := t.Unix()
		if i == 0 {
			m.At = append(m.At, at)
		} else {
			m.At = append(m.At, at-prev)
		}
		prev = at
		m.Tsum = append(m.Tsum, tsum.add(r.Tsum))
		m.Build = append(m.Build, build.add(r.Build))
		m.SkillType = append(m.SkillType, skill.add(r.SkillType))
		m.ScriptVersion = append(m.ScriptVersion, ver.add(r.ScriptVersion))
		m.Device = append(m.Device, device.add(devices(r.Device)))
		m.Source = append(m.Source, source.add(r.Source))
		m.Duration = append(m.Duration, r.Duration)
		m.Score = append(m.Score, r.Score)
		m.BaseCoins = append(m.BaseCoins, r.BaseCoins)
		m.FinalCoins = append(m.FinalCoins, r.FinalCoins)
		m.Medals = append(m.Medals, r.Medals)
		m.Items = append(m.Items, r.Items)
	}
	m.Dict.Tsum, m.Dict.Build, m.Dict.SkillType = orEmpty(tsum.values), orEmpty(build.values), orEmpty(skill.values)
	m.Dict.ScriptVersion, m.Dict.Device, m.Dict.Source = orEmpty(ver.values), orEmpty(device.values), orEmpty(source.values)
	return json.Marshal(m)
}

func orEmpty(s []string) []string {
	if s == nil {
		return []string{}
	}
	return s
}

// deviceNamer returns how a device is written in the snapshot.
func deviceNamer(mode string) func(string) string {
	switch mode {
	case DevicesKeep:
		return func(s string) string { return s }
	case DevicesHide:
		return func(string) string { return "" }
	}
	seen := map[string]string{}
	return func(s string) string {
		if s == "" {
			return ""
		}
		if n, ok := seen[s]; ok {
			return n
		}
		seen[s] = fmt.Sprintf("Device %d", len(seen)+1)
		return seen[s]
	}
}

// ExportSnapshot writes the site and its data into dir, ready to be served by
// any file host. Data files whose content did not change are not rewritten.
func ExportSnapshot(db dbx.Builder, site fs.FS, dir string, o SnapshotOptions) (SnapshotResult, error) {
	var res SnapshotResult
	if o.Devices == "" {
		o.Devices = DevicesAnonymous
	}
	if o.Devices != DevicesAnonymous && o.Devices != DevicesKeep && o.Devices != DevicesHide {
		return res, fmt.Errorf("devices must be %s, %s or %s", DevicesAnonymous, DevicesKeep, DevicesHide)
	}
	if o.Now.IsZero() {
		o.Now = time.Now()
	}

	var rounds []Round
	if err := db.NewQuery("SELECT " + roundColumns + " FROM ts_rounds ORDER BY played_at, round_id").All(&rounds); err != nil {
		return res, err
	}
	for i := range rounds {
		rounds[i].Items = itemsOf(rounds[i].Settings)
	}

	dataDir := filepath.Join(dir, filepath.FromSlash(SnapshotDir))
	if err := os.MkdirAll(dataDir, 0o755); err != nil {
		return res, err
	}
	put := func(path string, data []byte) error {
		if old, err := os.ReadFile(path); err == nil && bytes.Equal(old, data) {
			return nil
		}
		if err := os.WriteFile(path, data, 0o644); err != nil {
			return err
		}
		res.Files++
		res.Bytes += int64(len(data))
		return nil
	}

	man := snapshotManifest{
		Kind: "tsum-snapshot", Format: SnapshotFormat, GeneratedAt: o.Now.UTC().Format(time.RFC3339),
		Version: o.Version, Rounds: len(rounds), Months: []snapshotMonth{}, Owned: []snapshotOwned{},
	}
	namer := deviceNamer(o.Devices)
	wanted := map[string]bool{}
	for start := 0; start < len(rounds); {
		month := rounds[start].PlayedAt[:7]
		end := start
		for end < len(rounds) && rounds[end].PlayedAt[:7] == month {
			end++
		}
		group := rounds[start:end]
		data, err := encodeMonth(month, group, namer)
		if err != nil {
			return res, err
		}
		file := "rounds-" + month + ".json"
		if err := put(filepath.Join(dataDir, file), data); err != nil {
			return res, err
		}
		sum := sha256.Sum256(data)
		man.Months = append(man.Months, snapshotMonth{
			Month: month, File: file, Rounds: len(group), First: group[0].PlayedAt, Last: group[len(group)-1].PlayedAt,
			SHA: hex.EncodeToString(sum[:8]),
		})
		wanted[file] = true
		start = end
	}
	res.Months = len(man.Months)
	res.Rounds = len(rounds)
	if len(rounds) > 0 {
		man.First, man.Last = rounds[0].PlayedAt, rounds[len(rounds)-1].PlayedAt
	}

	// A month that no longer has rounds (deleted, or moved by a fix) leaves no stale file.
	old, _ := filepath.Glob(filepath.Join(dataDir, "rounds-*.json"))
	for _, p := range old {
		if !wanted[filepath.Base(p)] {
			_ = os.Remove(p)
		}
	}

	var err error
	if man.Tsums, err = PlayedTsums(db); err != nil {
		return res, err
	}
	played, err := PlayedDevices(db)
	if err != nil {
		return res, err
	}
	man.Devices = []DeviceCount{}
	for _, d := range played {
		if name := namer(d.Device); name != "" {
			man.Devices = append(man.Devices, DeviceCount{Device: name, Rounds: d.Rounds})
		}
	}
	if man.MedalTsums, err = MedalTsums(db); err != nil {
		return res, err
	}
	man.Themes = Themes(site)
	ownedFiles := map[string]bool{}
	if !o.NoOwned {
		if err := exportOwned(db, dataDir, namer, put, &man, ownedFiles); err != nil {
			return res, err
		}
	}
	// A device or build that no longer has a list leaves no stale file.
	old, _ = filepath.Glob(filepath.Join(dataDir, "owned-*.json"))
	for _, p := range old {
		if !ownedFiles[filepath.Base(p)] {
			_ = os.Remove(p)
		}
	}
	data, _ := json.MarshalIndent(man, "", "  ")
	if err := put(filepath.Join(dataDir, "manifest.json"), append(data, '\n')); err != nil {
		return res, err
	}

	if err := copySnapshotSite(site, dir, put); err != nil {
		return res, err
	}
	return res, nil
}

// copySnapshotSite copies the built site, tagging index.html as a snapshot,
// and adds .nojekyll so GitHub Pages serves the files as they are.
func copySnapshotSite(site fs.FS, dir string, put func(string, []byte) error) error {
	err := fs.WalkDir(site, ".", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		dst := filepath.Join(dir, filepath.FromSlash(path))
		if d.IsDir() {
			return os.MkdirAll(dst, 0o755)
		}
		data, err := fs.ReadFile(site, path)
		if err != nil {
			return err
		}
		if path == "index.html" {
			html := string(data)
			if !strings.Contains(html, "</head>") {
				return fmt.Errorf("index.html has no </head> to tag")
			}
			data = []byte(strings.Replace(html, "</head>", snapshotMeta+"\n</head>", 1))
		}
		return put(dst, data)
	})
	if err != nil {
		return err
	}
	return put(filepath.Join(dir, ".nojekyll"), nil)
}

// exportOwned writes each device's newest Tsum list per build as owned-<n>.json,
// devices named as namer says. Devices that share a name (all of them, when
// names are hidden) keep only the newest list per build.
func exportOwned(db dbx.Builder, dataDir string, namer func(string) string,
	put func(string, []byte) error, man *snapshotManifest, files map[string]bool) error {
	sources, err := TsumListSources(db)
	if err != nil {
		return err
	}
	sort.SliceStable(sources, func(i, j int) bool { return sources[i].Stamp > sources[j].Stamp })
	seen := map[string]bool{}
	for _, src := range sources {
		name := namer(src.Device)
		if key := src.Build + "|" + name; seen[key] {
			continue
		} else {
			seen[key] = true
		}
		list, err := LatestTsumList(db, src.Build, src.Device)
		if err != nil {
			return err
		}
		list.Device = name
		file := fmt.Sprintf("owned-%d.json", len(man.Owned)+1)
		data, _ := json.Marshal(map[string]any{"list": list})
		files[file] = true
		if err := put(filepath.Join(dataDir, file), data); err != nil {
			return err
		}
		man.Owned = append(man.Owned, snapshotOwned{Device: name, Build: src.Build, Stamp: src.Stamp, File: file})
	}
	sort.SliceStable(man.Owned, func(i, j int) bool {
		if a, b := man.Owned[i], man.Owned[j]; a.Device != b.Device {
			return a.Device < b.Device
		} else {
			return a.Build < b.Build
		}
	})
	return nil
}
