package stats

import (
	"context"
	"errors"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"time"
)

// DefaultDeviceStorage is where the app keeps a script's files on the device;
// --device-storage overrides it.
const DefaultDeviceStorage = "/sdcard/Download/GeneralAutomationPlatform"

// LegacyDeviceStorage is the folder before the app's rename; the app moves it to
// DefaultDeviceStorage when it next starts, so a device not yet updated still has it.
const LegacyDeviceStorage = "/sdcard/Download/GameAutomationPlatform"

// emuPorts are the adb ports emulators listen on, the usual ones. BlueStacks' 5555 and the AVD emulator's
// own ports show up without a connect.
var emuPorts = []int{16384, 16416, 16448, 16480, 7555, 5555, 5557, 5559, 5561, 62001, 62025, 62026, 62027, 21503, 21513, 21523}

// Puller copies stats_*.csv and tsum_list_*.csv off devices through adb into
// dest/<serial>/, keeping the device's layout, then imports them.
type Puller struct {
	adbMu    sync.RWMutex
	adb      string // "" when none was found
	storage  string
	dest     string
	importer *Importer
	busy     sync.Mutex
}

// ADBDevice is one row of `adb devices -l`.
type ADBDevice struct {
	Serial string `json:"serial"`
	State  string `json:"state"` // device, offline, unauthorized
	Model  string `json:"model"`
}

// DevicePull says what an import did for one device.
type DevicePull struct {
	Serial string       `json:"serial"`
	Found  int          `json:"found"`
	Copied int          `json:"copied"`
	Result ImportResult `json:"result"`
	Error  string       `json:"error,omitempty"`
}

var ErrPullBusy = errors.New("an import from devices is already running")

func NewPuller(adb, storage, dest string, importer *Importer) *Puller {
	if storage == "" {
		storage = DefaultDeviceStorage
	}
	return &Puller{adb: FindADB(adb), storage: strings.TrimRight(storage, "/"), dest: dest, importer: importer}
}

func (p *Puller) ADB() string {
	p.adbMu.RLock()
	defer p.adbMu.RUnlock()
	return p.adb
}

// SetADB switches the adb used from now on: the starter's, once it has one.
func (p *Puller) SetADB(adb string) {
	p.adbMu.Lock()
	p.adb = adb
	p.adbMu.Unlock()
}

// FindADB returns explicit when given, else the first adb on PATH or in the
// usual Android SDK folders, else "".
func FindADB(explicit string) string {
	if explicit != "" {
		return explicit
	}
	if p, err := exec.LookPath("adb"); err == nil {
		return p
	}
	exe := "adb"
	if runtime.GOOS == "windows" {
		exe = "adb.exe"
	}
	home, _ := os.UserHomeDir()
	for _, sdk := range []string{
		os.Getenv("ANDROID_HOME"), os.Getenv("ANDROID_SDK_ROOT"),
		filepath.Join(home, "Library", "Android", "sdk"),
		filepath.Join(home, "Android", "Sdk"),
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Android", "Sdk"),
	} {
		if sdk == "" {
			continue
		}
		cand := filepath.Join(sdk, "platform-tools", exe)
		if st, err := os.Stat(cand); err == nil && !st.IsDir() {
			return cand
		}
	}
	return ""
}

func (p *Puller) run(ctx context.Context, timeout time.Duration, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, p.ADB(), args...).Output()
	return strings.ReplaceAll(string(out), "\r", ""), err
}

// Devices connects to emulators on the known ports, then lists every device
// once: an emulator reached on two ports has one boot_id.
func (p *Puller) Devices(ctx context.Context) ([]ADBDevice, error) {
	if p.ADB() == "" {
		return nil, errors.New("adb was not found")
	}
	p.connectEmulators(ctx)
	out, err := p.run(ctx, 15*time.Second, "devices", "-l")
	if err != nil {
		return nil, fmt.Errorf("adb devices: %w", err)
	}
	devices := []ADBDevice{}
	seen := map[string]bool{}
	for _, line := range strings.Split(out, "\n")[1:] {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		d := ADBDevice{Serial: f[0], State: f[1]}
		for _, kv := range f[2:] {
			if m, ok := strings.CutPrefix(kv, "model:"); ok {
				d.Model = strings.ReplaceAll(m, "_", " ")
			}
		}
		if d.State == "device" {
			id, _ := p.run(ctx, 5*time.Second, "-s", d.Serial, "shell", "cat /proc/sys/kernel/random/boot_id")
			if id = strings.TrimSpace(id); id == "" {
				id = d.Serial
			}
			if seen[id] {
				continue
			}
			seen[id] = true
		}
		devices = append(devices, d)
	}
	return devices, nil
}

// connectEmulators runs `adb connect` on each known port that is open. The
// port is dialled first because a non-adb listener can stall a connect.
func (p *Puller) connectEmulators(ctx context.Context) {
	var wg sync.WaitGroup
	for _, port := range emuPorts {
		wg.Add(1)
		go func(addr string) {
			defer wg.Done()
			c, err := net.DialTimeout("tcp", addr, 300*time.Millisecond)
			if err != nil {
				return
			}
			c.Close()
			_, _ = p.run(ctx, 5*time.Second, "connect", addr)
		}(fmt.Sprintf("127.0.0.1:%d", port))
	}
	wg.Wait()
}

// Pull copies and imports each device's files, one device at a time.
func (p *Puller) Pull(ctx context.Context, serials []string) ([]DevicePull, error) {
	if p.ADB() == "" {
		return nil, errors.New("adb was not found")
	}
	if !p.busy.TryLock() {
		return nil, ErrPullBusy
	}
	defer p.busy.Unlock()
	results := make([]DevicePull, 0, len(serials))
	for _, s := range serials {
		results = append(results, p.pullOne(ctx, s))
	}
	return results, nil
}

func (p *Puller) pullOne(ctx context.Context, serial string) DevicePull {
	res := DevicePull{Serial: serial}
	root, files, err := p.deviceFiles(ctx, serial)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	res.Found = len(files)
	if len(files) == 0 {
		res.Error = fmt.Sprintf("no stats files under %s", p.storage)
		return res
	}
	var local []string
	for _, remote := range files {
		rel := filepath.FromSlash(strings.TrimPrefix(remote, root+"/"))
		if !filepath.IsLocal(rel) {
			continue
		}
		to := filepath.Join(p.dest, safeName(serial), rel)
		if err := os.MkdirAll(filepath.Dir(to), 0o755); err != nil {
			res.Result.Errors = append(res.Result.Errors, err.Error())
			continue
		}
		// -a keeps the device's mtime, so a file that has not changed is
		// skipped by the import and by the folder scan.
		if _, err := p.run(ctx, 60*time.Second, "-s", serial, "pull", "-a", remote, to); err != nil {
			if _, statErr := os.Stat(to); statErr != nil {
				res.Result.Errors = append(res.Result.Errors, fmt.Sprintf("%s: copy failed", rel))
				continue
			}
		}
		res.Copied++
		local = append(local, to)
	}
	r := p.importer.ImportFiles(local)
	r.Errors = append(res.Result.Errors, r.Errors...)
	res.Result = r
	return res
}

// deviceFiles lists the stats files under storage, and the root they are under:
// LegacyDeviceStorage when the default storage has none and the old folder does.
func (p *Puller) deviceFiles(ctx context.Context, serial string) (string, []string, error) {
	files, err := p.filesUnder(ctx, serial, p.storage)
	if err == nil && len(files) == 0 && p.storage == DefaultDeviceStorage {
		if old, oerr := p.filesUnder(ctx, serial, LegacyDeviceStorage); oerr == nil && len(old) > 0 {
			return LegacyDeviceStorage, old, nil
		}
	}
	return p.storage, files, err
}

// filesUnder lists the stats files under root. toybox `find` is on every
// Android the app runs on; the ls fallback covers root and one level down.
func (p *Puller) filesUnder(ctx context.Context, serial, root string) ([]string, error) {
	if strings.Contains(root, "'") {
		return nil, fmt.Errorf("device storage %q cannot be quoted", root)
	}
	out, err := p.run(ctx, 30*time.Second, "-s", serial, "shell",
		fmt.Sprintf("find '%s' -type f \\( -name 'stats_*.csv' -o -name 'tsum_list_*.csv' \\) 2>/dev/null", root))
	if err != nil && out == "" {
		return nil, fmt.Errorf("could not list files: %v", err)
	}
	if !strings.Contains(out, root+"/") {
		out, _ = p.run(ctx, 30*time.Second, "-s", serial, "shell",
			fmt.Sprintf("ls -1d '%[1]s'/stats_*.csv '%[1]s'/*/stats_*.csv '%[1]s'/tsum_list_*.csv '%[1]s'/*/tsum_list_*.csv 2>/dev/null", root))
	}
	var files []string
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		name := path.Base(line)
		if strings.HasPrefix(line, root+"/") && (statsFileRE.MatchString(name) || tsumListFileRE.MatchString(name)) {
			files = append(files, line)
		}
	}
	return files, nil
}

// safeName makes a serial usable as a folder name: 127.0.0.1:16384 has a colon,
// which Windows refuses. Illegal characters become underscores.
var unsafeChars = regexp.MustCompile(`[^A-Za-z0-9._-]`)

func safeName(serial string) string { return unsafeChars.ReplaceAllString(serial, "_") }
