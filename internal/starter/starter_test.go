package starter

import (
	"archive/zip"
	"bytes"
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestProtocolParsing(t *testing.T) {
	out := "proto=1\nrunning=0\nstep=kill\nstep=launch\n---BEGIN service.log---\nline one\nline two\n---END service.log---\nrunning=1\nrc=0\n"
	if kv(out, "running") != "1" {
		t.Fatal("the last running= is the verdict")
	}
	if kv(out, "nosuch") != "" {
		t.Fatal("a missing key is empty")
	}
	if got := kvAll(out, "step"); strings.Join(got, ",") != "kill,launch" {
		t.Fatalf("steps: %v", got)
	}
	if got := extractLog(out); got != "line one\nline two" {
		t.Fatalf("log block: %q", got)
	}
}

func TestChannelFolder(t *testing.T) {
	for in, want := range map[string]string{
		"https://x.dev/alpha/alpha.json": "https://x.dev/alpha",
		"https://x.dev/alpha/":           "https://x.dev/alpha",
		"https://x.dev/a/gap-latest.txt": "https://x.dev/a",
	} {
		if got, ok := channelFolder(in); !ok || got != want {
			t.Errorf("%s: got %q", in, got)
		}
	}
	for _, bad := range []string{"ftp://x.dev/a", "https://x.dev", "https://x.dev/a?b=1", "alpha"} {
		if _, ok := channelFolder(bad); ok {
			t.Errorf("%s should be refused", bad)
		}
	}
}

// A fake adb: two ports of one emulator, a probe reply, two script logs, and a
// record of every call in $FAKE_CALLS.
const fakeADB = `#!/bin/sh
echo "$*" >> "$FAKE_CALLS"
[ "$1" = -s ] && shift 2
case "$1" in
  devices) printf 'List of devices attached\n127.0.0.1:16384\tdevice product:x model:MuMu_12 transport_id:1\nemulator-5554\tdevice model:MuMu_12\nZX1\tunauthorized\n' ;;
  push|connect|kill-server|start-server|reconnect) ;;
  pull) echo "log body" > "$3" ;;
  shell)
    case "$2" in
      *boot_id*) echo same-boot ;;
      *probe*) printf 'proto=1\r\ndevice_abi=x86_64\r\ninstalled=1\r\nrunning=1\r\nrc=0\r\n' ;;
      *" log"*) printf 'proto=1\n---BEGIN service.log---\nready\n---END service.log---\nrc=0\n' ;;
      find*script*) printf '/sdcard/Download/GeneralAutomationPlatform/logs/script.log\n/sdcard/Download/GeneralAutomationPlatform/logs/script.1.log\nfind: denied\n' ;;
      dumpsys*) echo '    versionName=3.1' ;;
    esac ;;
esac
`

func fakeStarter(t *testing.T) (*Starter, string) {
	if runtime.GOOS == "windows" {
		t.Skip("the fake adb is a shell script")
	}
	dir := t.TempDir()
	_ = os.MkdirAll(filepath.Join(dir, "device"), 0o755)
	_ = os.WriteFile(filepath.Join(dir, "device", "gap-service.sh"), []byte("#!/bin/sh\n"), 0o644)
	adb := filepath.Join(dir, "adb")
	_ = os.WriteFile(adb, []byte(fakeADB), 0o755)
	calls := filepath.Join(dir, "calls")
	t.Setenv("FAKE_CALLS", calls)
	s, err := New(dir, "test")
	if err != nil {
		t.Fatal(err)
	}
	s.adbPath = adb
	return s, calls
}

func TestDevicesProbeAndMerge(t *testing.T) {
	s, _ := fakeStarter(t)
	rows := s.Devices(context.Background())
	if len(rows) != 2 {
		t.Fatalf("one emulator on two ports is one row, plus the unauthorized phone: %+v", rows)
	}
	d := rows[0]
	if d.Serial != "127.0.0.1:16384" || d.Model != "MuMu 12" || d.ABI != "x86_64" || d.Service != "running" {
		t.Fatalf("probed row: %+v", d)
	}
	if rows[1].Service != "unauthorized" {
		t.Fatalf("an unusable device keeps adb's state as its service: %+v", rows[1])
	}
}

func TestExportZip(t *testing.T) {
	s, _ := fakeStarter(t)
	var buf bytes.Buffer
	err := s.writeExport(context.Background(), &buf, ExportRequest{Serials: []string{"127.0.0.1:16384"}, Parts: []string{"script", "service", "stats"}})
	if err != nil {
		t.Fatal(err)
	}
	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, f := range zr.File {
		names = append(names, f.Name)
	}
	want := "127.0.0.1_16384/logs/script.1.log 127.0.0.1_16384/logs/script.log 127.0.0.1_16384/service.log 127.0.0.1_16384/device.txt"
	if strings.Join(names, " ") != want {
		t.Fatalf("zip holds %v", names)
	}
}

func TestRestartServer(t *testing.T) {
	s, calls := fakeStarter(t)
	if r := s.restartServer(context.Background(), func(string) {}); !r.OK {
		t.Fatalf("restart: %+v", r)
	}
	b, _ := os.ReadFile(calls)
	if string(b) != "kill-server\nstart-server\n" {
		t.Fatalf("calls: %q", b)
	}
}
