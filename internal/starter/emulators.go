package starter

// Emulators this computer can restart from outside Android, for watch mode.
// Each family has its own file, built only where it runs (emu_*_windows.go,
// emu_bluestacks_darwin.go, emu_other.go); hostEmulators lists them. The
// parsers live here, untagged, so the tests run on every OS.

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os/exec"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// Emulator is one emulator family's command line.
type Emulator interface {
	Host() string  // the name GAP reports for it (wire protocol `host`): mumu, ldplayer, bluestacks
	Label() string // for people: "MuMu Player 12"
	// Find looks for the tools on this computer. It returns a new value set up
	// with their paths (never changed afterwards, so a restart can run while
	// the next Find does), or nil when the family is not installed.
	Find() Emulator
	Instances(ctx context.Context) ([]EmuInstance, error)
	Restart(ctx context.Context, in EmuInstance, logf func(string)) error
}

// EmuInstance is one emulator instance and the adb port it listens on.
type EmuInstance struct {
	ID      string `json:"id"`   // what its command line takes: an index, or a BlueStacks instance name
	Name    string `json:"name"` // its title in the emulator's manager
	Port    int    `json:"port"` // adb port on 127.0.0.1; 0 when unknown
	Running bool   `json:"running"`
}

// emuMatch is the instance a device serial belongs to.
type emuMatch struct {
	Host  string `json:"host"`
	Label string `json:"label"`
	EmuInstance
}

// hostMapping is what the page and watch mode know of a serial's emulator.
type hostMapping struct {
	Match *emuMatch `json:"match,omitempty"`
	Local bool      `json:"local"`
	TCP   bool      `json:"tcp"`
	Why   string    `json:"why,omitempty"` // why it cannot be restarted from here
}

func (m hostMapping) info() hostInfo {
	return hostInfo{TCP: m.TCP, Local: m.Local, Mapped: m.Match != nil, Why: m.Why}
}

// emuFound is one family's instances as last listed.
type emuFound struct {
	Host, Label string
	Inst        []EmuInstance
	Err         string
	emu         Emulator
}

// serialPort is the host and adb port behind an adb serial. emulator-5554 is
// the console port; its adb port is one more. ok is false for a USB serial.
func serialPort(serial string) (host string, port int, ok bool) {
	if n, found := strings.CutPrefix(serial, "emulator-"); found {
		p, err := strconv.Atoi(n)
		return "127.0.0.1", p + 1, err == nil
	}
	h, p, err := net.SplitHostPort(serial)
	if err != nil {
		return "", 0, false
	}
	port, err = strconv.Atoi(p)
	return h, port, err == nil && port > 0
}

func isLoopback(host string) bool {
	ip := net.ParseIP(host)
	return host == "localhost" || ip != nil && ip.IsLoopback()
}

// mapSerial finds the one instance behind a serial. It never guesses: two
// candidates on one port (LDPlayer and BlueStacks both use 5555) is no match.
func mapSerial(serial string, found []emuFound, supported []string) hostMapping {
	host, port, ok := serialPort(serial)
	if !ok {
		return hostMapping{Why: "A USB device: only adb can restart it."}
	}
	m := hostMapping{TCP: strings.Contains(serial, ":")}
	if !isLoopback(host) {
		m.Why = "On another computer: only adb can restart it from here."
		return m
	}
	m.Local = true
	if len(found) == 0 {
		if len(supported) == 0 {
			m.Why = "Restarting an emulator from here is not supported on this computer."
		} else if len(supported) == 1 {
			m.Why = supported[0] + " is not installed here."
		} else {
			m.Why = "None of " + strings.Join(supported[:len(supported)-1], ", ") + " or " + supported[len(supported)-1] + " is installed here."
		}
		return m
	}
	var cands []emuMatch
	var errs []string
	for _, f := range found {
		if f.Err != "" {
			errs = append(errs, f.Label+": "+f.Err)
		}
		for _, in := range f.Inst {
			// MuMu's first instance also answers on its old port, 7555.
			if in.Port == port || f.Host == "mumu" && port == 7555 && in.Port == 16384 {
				cands = append(cands, emuMatch{Host: f.Host, Label: f.Label, EmuInstance: in})
			}
		}
	}
	if len(cands) > 1 {
		var running []emuMatch
		for _, c := range cands {
			if c.Running {
				running = append(running, c)
			}
		}
		if len(running) > 0 {
			cands = running
		}
	}
	switch len(cands) {
	case 1:
		m.Match = &cands[0]
	case 0:
		m.Why = fmt.Sprintf("No emulator instance found on port %d.", port)
		if len(errs) > 0 {
			m.Why += " " + strings.Join(errs, "; ")
		}
	default:
		var names []string
		for _, c := range cands {
			names = append(names, c.Label+" "+c.Name)
		}
		m.Why = fmt.Sprintf("%d emulator instances use port %d (%s), so none is restarted from here.", len(cands), port, strings.Join(names, ", "))
	}
	return m
}

// ------------------------------------------------------------------ parsers

// mumuInfo is one instance in `MuMuManager.exe info -v all`.
type mumuInfo struct {
	Index            json.RawMessage `json:"index"` // "0", or 0 on some builds
	Name             string          `json:"name"`
	AdbPort          json.RawMessage `json:"adb_port"`
	IsProcessStarted bool            `json:"is_process_started"`
	IsAndroidStarted bool            `json:"is_android_started"`
}

// parseMuMuInfo reads `info -v all`: an object keyed by index, or one bare
// instance when only one exists. A stopped instance has no adb_port; MuMu
// gives instance i port 16384 + 32i. Verify on device: the key names.
func parseMuMuInfo(b []byte) ([]EmuInstance, error) {
	if i := strings.IndexByte(string(b), '{'); i > 0 {
		b = b[i:] // a warning printed before the JSON
	}
	var one mumuInfo
	if err := json.Unmarshal(b, &one); err == nil && len(one.Index) > 0 {
		return []EmuInstance{mumuInstance(one)}, nil
	}
	var all map[string]json.RawMessage
	if err := json.Unmarshal(b, &all); err != nil {
		return nil, fmt.Errorf("unreadable MuMuManager info: %w", err)
	}
	var out []EmuInstance
	for _, raw := range all {
		var in mumuInfo
		if json.Unmarshal(raw, &in) == nil && len(in.Index) > 0 {
			out = append(out, mumuInstance(in))
		}
	}
	sortInstances(out)
	return out, nil
}

func mumuInstance(in mumuInfo) EmuInstance {
	id := strings.Trim(string(in.Index), `"`)
	port, _ := strconv.Atoi(strings.Trim(string(in.AdbPort), `"`))
	if n, err := strconv.Atoi(id); port == 0 && err == nil {
		port = 16384 + 32*n
	}
	return EmuInstance{ID: id, Name: in.Name, Port: port, Running: in.IsProcessStarted || in.IsAndroidStarted}
}

// parseLDList2 reads `ldconsole list2`: one line per instance, "index,title,
// top window,bind window,android started,pid,vbox pid[,width,height,dpi]".
// Instance N's adb port is 5555 + 2N.
func parseLDList2(out string) []EmuInstance {
	var list []EmuInstance
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		f := strings.Split(strings.TrimSpace(sc.Text()), ",")
		if len(f) < 5 {
			continue
		}
		n, err := strconv.Atoi(f[0])
		if err != nil || n < 0 {
			continue
		}
		list = append(list, EmuInstance{ID: f[0], Name: f[1], Port: 5555 + 2*n, Running: f[4] == "1"})
	}
	sortInstances(list)
	return list
}

var bsPortRE = regexp.MustCompile(`^bst\.instance\.([A-Za-z0-9_.-]+)\.status\.adb_port="?(\d+)"?`)

// parseBlueStacksConf reads the instances and their adb ports from
// bluestacks.conf (`bst.instance.<Name>.status.adb_port="5555"`).
func parseBlueStacksConf(conf string) []EmuInstance {
	var list []EmuInstance
	sc := bufio.NewScanner(strings.NewReader(conf))
	for sc.Scan() {
		if m := bsPortRE.FindStringSubmatch(strings.TrimSpace(sc.Text())); m != nil {
			port, _ := strconv.Atoi(m[2])
			list = append(list, EmuInstance{ID: m[1], Name: m[1], Port: port})
		}
	}
	sortInstances(list)
	return list
}

var bsInstanceRE = regexp.MustCompile(`--instance[ =]"?([A-Za-z0-9_.-]+)`)

// bsInstanceOf is the instance an HD-Player.exe command line runs, "" when it names none.
func bsInstanceOf(cmdline string) string {
	if m := bsInstanceRE.FindStringSubmatch(cmdline); m != nil {
		return m[1]
	}
	return ""
}

// winProc is one process from PowerShell's Win32_Process listing.
type winProc struct {
	PID     int    `json:"ProcessId"`
	Path    string `json:"ExecutablePath"`
	Cmdline string `json:"CommandLine"`
}

// parseWinProcs reads ConvertTo-Json output: one object, an array, or nothing.
func parseWinProcs(b []byte) []winProc {
	s := strings.TrimSpace(string(b))
	if s == "" {
		return nil
	}
	if strings.HasPrefix(s, "{") {
		s = "[" + s + "]"
	}
	var list []winProc
	_ = json.Unmarshal([]byte(s), &list)
	return list
}

func sortInstances(list []EmuInstance) {
	sort.SliceStable(list, func(i, j int) bool {
		a, errA := strconv.Atoi(list[i].ID)
		b, errB := strconv.Atoi(list[j].ID)
		if errA == nil && errB == nil {
			return a < b
		}
		return list[i].ID < list[j].ID
	})
}

// ------------------------------------------------------------------ commands

// runCmd runs a host command with a time limit; output has \r stripped.
func runCmd(ctx context.Context, timeout time.Duration, name string, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	out, err := exec.CommandContext(ctx, name, args...).CombinedOutput()
	return strings.ReplaceAll(string(out), "\r", ""), err
}

// startDetached launches a program that keeps running after this one exits.
func startDetached(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	if err := cmd.Start(); err != nil {
		return err
	}
	go func() { _ = cmd.Wait() }()
	return nil
}

// waitStopped polls until the instance is no longer running, up to limit.
func waitStopped(ctx context.Context, e Emulator, id string, limit time.Duration) bool {
	deadline := time.Now().Add(limit)
	for time.Now().Before(deadline) {
		list, err := e.Instances(ctx)
		if err == nil {
			running := false
			for _, in := range list {
				if in.ID == id && in.Running {
					running = true
				}
			}
			if !running {
				return true
			}
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(2 * time.Second):
		}
	}
	return false
}

// emuLabels names the families this computer supports, for the status line.
func emuLabels(list []Emulator) []string {
	var out []string
	for _, e := range list {
		out = append(out, e.Label())
	}
	return out
}
