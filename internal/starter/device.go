package starter

import (
	"context"
	"fmt"
	"net"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// The device side. The launch algorithm is device/gap-service.sh and is never
// duplicated here; this pushes it and reads its key=value reply (device/PROTOCOL.md).
const (
	appPackage   = "com.generalautomation.platform"
	stageDir     = "/data/local/tmp/gap"
	deviceScript = "/data/local/tmp/gap-service.sh"
	protoWant    = "1"
	// Config.Storage.PARENT + FOLDER in the app; build-starter.sh gates the
	// shell hosts' copy of it against Config.kt.
	defaultStorage = "/sdcard/Download/GeneralAutomationPlatform"
)

// Emulator adb ports, four instances per family: MuMu (16384 + 32i, 7555),
// LDPlayer (5555 + 2i), Nox (62001, 62025 + i), MEmu (21503 + 10i).
var emuPorts = []string{"16384", "16416", "16448", "16480", "7555", "5555", "5557", "5559", "5561",
	"62001", "62025", "62026", "62027", "21503", "21513", "21523"}

// Device is one row of the device list.
type Device struct {
	Serial    string `json:"serial"`
	State     string `json:"state"` // adb's: device, offline, unauthorized
	Model     string `json:"model"`
	ABI       string `json:"abi"`
	Service   string `json:"service"` // running, stopped, not installed, wrong ABI, unreadable, or State
	Installed string `json:"installed"`
	Err       string `json:"err,omitempty"`
	Busy      bool   `json:"busy,omitempty"` // an action is running on it; the row is the last one read
}

// kv is the last value of key in a protocol reply; `running` is sent twice.
func kv(out, key string) string {
	val := ""
	for _, line := range strings.Split(out, "\n") {
		if v, ok := strings.CutPrefix(strings.TrimRight(line, "\r"), key+"="); ok {
			val = v
		}
	}
	return val
}

// kvAll is every value of a repeatable key, such as step.
func kvAll(out, key string) []string {
	var vals []string
	for _, line := range strings.Split(out, "\n") {
		if v, ok := strings.CutPrefix(line, key+"="); ok {
			vals = append(vals, v)
		}
	}
	return vals
}

// extractLog is the raw service.log block between the sentinels.
func extractLog(out string) string {
	_, rest, ok := strings.Cut(out, "---BEGIN service.log---\n")
	if !ok {
		return ""
	}
	body, _, _ := strings.Cut(rest, "---END service.log---")
	return strings.TrimRight(body, "\n")
}

func (s *Starter) adb() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.adbPath
}

// run is one adb call with a time limit; output has \r stripped.
func (s *Starter) run(ctx context.Context, timeout time.Duration, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, s.adb(), args...).CombinedOutput()
	return strings.ReplaceAll(string(out), "\r", ""), err
}

type rawDevice struct{ serial, state, model string }

func (s *Starter) listDevices(ctx context.Context) []rawDevice {
	out, _ := s.run(ctx, 15*time.Second, "devices", "-l")
	var list []rawDevice
	for _, line := range strings.Split(out, "\n")[1:] {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		d := rawDevice{serial: f[0], state: f[1], model: "-"}
		for _, kv := range f[2:] {
			if m, ok := strings.CutPrefix(kv, "model:"); ok {
				d.model = strings.ReplaceAll(m, "_", " ")
			}
		}
		list = append(list, d)
	}
	return list
}

// probeEmulators kicks stale offline rows, then connects to every emulator port
// that is open. An offline row is a handshake that never finished, and adb
// never retries it on its own.
func (s *Starter) probeEmulators(ctx context.Context) {
	var stale []string
	for _, d := range s.listDevices(ctx) {
		if d.state == "offline" {
			stale = append(stale, d.serial)
			_, _ = s.run(ctx, 5*time.Second, "-s", d.serial, "reconnect")
		}
	}
	for i := 0; i < 10 && len(stale) > 0; i++ {
		left := false
		for _, d := range s.listDevices(ctx) {
			if d.state == "offline" && contains(stale, d.serial) {
				left = true
			}
		}
		if !left {
			break
		}
		time.Sleep(300 * time.Millisecond)
	}
	ports := append(append([]string{}, emuPorts...), strings.Fields(os.Getenv("GAP_EXTRA_PORTS"))...)
	var wg sync.WaitGroup
	for _, p := range ports {
		wg.Add(1)
		go func(addr string) {
			defer wg.Done()
			// Dialled first: a non-adb listener can stall `adb connect`.
			c, err := net.DialTimeout("tcp", addr, 300*time.Millisecond)
			if err != nil {
				return
			}
			c.Close()
			_, _ = s.run(ctx, 5*time.Second, "connect", addr)
		}("127.0.0.1:" + p)
	}
	wg.Wait()
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

// invokeVerb pushes the device script and runs one verb. A failed push answers
// in protocol form, so callers have one shape to read.
func (s *Starter) invokeVerb(ctx context.Context, serial string, verb ...string) string {
	script := filepath.Join(s.bundle, "device", "gap-service.sh")
	if _, err := s.run(ctx, 30*time.Second, "-s", serial, "push", script, deviceScript); err != nil {
		return fmt.Sprintf("proto=%s\nerr=push-failed\nmsg=could not push the device script to %s\nrc=1\n", protoWant, serial)
	}
	out, _ := s.run(ctx, 90*time.Second, "-s", serial, "shell", "sh "+deviceScript+" "+strings.Join(verb, " "))
	return out
}

// probeRow reads one device's service state. A device that is not usable keeps
// its adb state as the Service column, so the page can say why.
func (s *Starter) probeRow(ctx context.Context, d rawDevice) Device {
	row := Device{Serial: d.serial, State: d.state, Model: d.model, ABI: "-", Service: d.state, Installed: "-"}
	if d.state != "device" {
		return row
	}
	out := s.invokeVerb(ctx, d.serial, "probe")
	if kv(out, "proto") != protoWant {
		row.Service = "unreadable"
		return row
	}
	row.ABI = orDash(kv(out, "device_abi"))
	row.Installed = orDash(kv(out, "installed"))
	row.Err = kv(out, "err")
	row.Service = "stopped"
	if kv(out, "running") == "1" {
		row.Service = "running"
	}
	switch {
	case row.Err == "push-failed":
		row.Service = "unreadable"
	case row.Err == "no-libs":
		row.Service = "wrong ABI"
	case row.Installed == "0":
		row.Service = "not installed"
	}
	return row
}

func orDash(v string) string {
	if v == "" {
		return "-"
	}
	return v
}

// Devices scans for emulators and probes every device adb lists, in parallel.
// One emulator reached on two ports has one boot_id, so it is listed once.
func (s *Starter) Devices(ctx context.Context) []Device {
	s.probeEmulators(ctx)
	raw := s.listDevices(ctx)
	seen := map[string]bool{}
	var unique []rawDevice
	for _, d := range raw {
		if d.state == "device" {
			id, _ := s.run(ctx, 5*time.Second, "-s", d.serial, "shell", "cat /proc/sys/kernel/random/boot_id")
			if id = strings.TrimSpace(id); id == "" {
				id = d.serial
			}
			if seen[id] {
				continue
			}
			seen[id] = true
		}
		unique = append(unique, d)
	}
	rows := make([]Device, len(unique))
	var wg sync.WaitGroup
	for i, d := range unique {
		wg.Add(1)
		go func() {
			defer wg.Done()
			rows[i] = s.rowFor(ctx, d)
		}()
	}
	wg.Wait()
	return rows
}

// DeviceRow re-reads one device; ok is false when adb no longer lists it.
func (s *Starter) DeviceRow(ctx context.Context, serial string) (Device, bool) {
	for _, d := range s.listDevices(ctx) {
		if d.serial == serial {
			return s.rowFor(ctx, d), true
		}
	}
	return Device{}, false
}

// rowFor probes unless an action holds the device: a probe pushes the script
// the action may be running, so the last row read stands in, marked busy.
func (s *Starter) rowFor(ctx context.Context, d rawDevice) Device {
	lock := s.deviceLock(d.serial)
	if !lock.TryLock() {
		s.mu.Lock()
		row, ok := s.rows[d.serial]
		s.mu.Unlock()
		if !ok {
			row = Device{Serial: d.serial, State: d.state, Model: d.model, ABI: "-", Service: "busy", Installed: "-"}
		}
		row.Busy = true
		return row
	}
	defer lock.Unlock()
	row := s.probeRow(ctx, d)
	s.mu.Lock()
	s.rows[d.serial] = row
	s.mu.Unlock()
	return row
}

func (s *Starter) deviceLock(serial string) *sync.Mutex {
	s.mu.Lock()
	defer s.mu.Unlock()
	l, ok := s.locks[serial]
	if !ok {
		l = &sync.Mutex{}
		s.locks[serial] = l
	}
	return l
}

// The catalogue GAP lists Tsum Tsum releases from. GAP ships with no
// third-party source, so the starter offers this one after an install.
const sourceURL = "https://tsumtsumscripts.github.io/tsum-tsum-catalogue/catalogue.json"

// offerSource opens GAP's gap://add-source link on the device, where the
// player taps Add. OK is false only when the offer itself failed.
func (s *Starter) offerSource(ctx context.Context, serial string, logf func(string)) Result {
	logf("offering the Tsum Tsum library to GAP on " + serial + " ...")
	out, _ := s.run(ctx, 20*time.Second, "-s", serial, "shell",
		"am start -a android.intent.action.VIEW -d 'gap://add-source?url="+sourceURL+"' -p "+appPackage)
	switch {
	case strings.Contains(out, "unable to resolve"):
		// An older GAP, which lists the library by itself.
		return Result{OK: true, Msg: "This GAP lists the Tsum Tsum library by itself. Nothing to add."}
	case strings.Contains(out, "Error"), strings.Contains(out, "Exception"):
		logLines(logf, out)
		return Result{Msg: "Could not open GAP to add the Tsum Tsum library. See the log."}
	}
	return Result{OK: true, Msg: "On the device, tap Add to put the Tsum Tsum library in GAP's Sources."}
}

// installedVersion is the app's versionName, or "".
func (s *Starter) installedVersion(ctx context.Context, serial string) string {
	out, _ := s.run(ctx, 20*time.Second, "-s", serial, "shell", "dumpsys package "+appPackage)
	for _, line := range strings.Split(out, "\n") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(line), "versionName="); ok {
			return v
		}
	}
	return ""
}

// ------------------------------------------------- a script's files on the device

// deviceFiles lists files matching a name glob under the storage root. toybox
// find is on every Android the app runs on; ls covers the root and one level down.
func (s *Starter) deviceFiles(ctx context.Context, serial, glob string) []string {
	root := s.storage
	out, _ := s.run(ctx, 30*time.Second, "-s", serial, "shell", fmt.Sprintf("find '%s' -type f -name '%s' 2>/dev/null", root, glob))
	if !strings.Contains(out, root+"/") {
		out, _ = s.run(ctx, 30*time.Second, "-s", serial, "shell", fmt.Sprintf("ls -1d '%[1]s/%[2]s' '%[1]s'/*/'%[2]s' 2>/dev/null", root, glob))
	}
	var files []string
	for _, line := range strings.Split(out, "\n") {
		line = strings.TrimSpace(line)
		// Real paths only: errors and an unmatched glob come back on the same stream.
		if strings.HasPrefix(line, root+"/") && !strings.ContainsAny(line, "*?") {
			if ok, _ := path.Match(glob, path.Base(line)); ok {
				files = append(files, line)
			}
		}
	}
	sort.Strings(files)
	return files
}

// pullFile copies one file off the device. What landed on disk is the verdict:
// adb pull's exit status is not uniform across platform-tools revisions.
func (s *Starter) pullFile(ctx context.Context, serial, remote, local string) bool {
	if err := os.MkdirAll(filepath.Dir(local), 0o755); err != nil {
		return false
	}
	os.Remove(local)
	_, _ = s.run(ctx, 2*time.Minute, "-s", serial, "pull", remote, local)
	_, err := os.Stat(local)
	return err == nil
}

// deleteFiles removes paths in one shell call. It reports nothing: adb shell
// does not forward the remote status on older platform-tools, so callers re-list.
func (s *Starter) deleteFiles(ctx context.Context, serial string, files []string) {
	var quoted []string
	for _, f := range files {
		if !strings.Contains(f, "'") {
			quoted = append(quoted, "'"+f+"'")
		}
	}
	if len(quoted) > 0 {
		_, _ = s.run(ctx, 60*time.Second, "-s", serial, "shell", "rm -f "+strings.Join(quoted, " "))
	}
}

// safeName makes a serial usable as a folder name (Windows refuses the colon).
var unsafeChars = regexp.MustCompile(`[^A-Za-z0-9._-]`)

func safeName(serial string) string { return unsafeChars.ReplaceAllString(serial, "_") }

// relToStorage is a device path relative to the storage root, or "" when it is not under it.
func (s *Starter) relToStorage(remote string) string {
	rel := strings.TrimPrefix(remote, s.storage+"/")
	if rel == remote || !filepath.IsLocal(filepath.FromSlash(rel)) {
		return ""
	}
	return rel
}
