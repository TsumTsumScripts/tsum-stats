package main

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestNewerVersion(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want bool
	}{{"0.6", "0.5", true}, {"0.5", "0.5", false}, {"0.10", "0.9", true}, {"1.0", "0.9.9", true}, {"0.5", "0.5.1", false}, {"", "0.5", false}} {
		if got := newerVersion(c.a, c.b); got != c.want {
			t.Errorf("newerVersion(%q, %q) = %v", c.a, c.b, got)
		}
	}
}

func TestParsePin(t *testing.T) {
	kv := parsePin("# c\nversion=0.6\n\nurl_linux_amd64 = http://x/a=b\n")
	if kv["version"] != "0.6" || kv["url_linux_amd64"] != "http://x/a=b" {
		t.Errorf("got %v", kv)
	}
}

// fastWaits shortens swapBinary's retry waits for one test.
func fastWaits(t *testing.T, d ...time.Duration) {
	saved := renameWaits
	renameWaits = d
	t.Cleanup(func() { renameWaits = saved })
}

// swapDir makes a folder with the running program and its checked download.
func swapDir(t *testing.T) (exe, tmp string) {
	t.Helper()
	fastWaits(t, time.Millisecond)
	dir := t.TempDir()
	exe, tmp = filepath.Join(dir, "tsum-stats.exe"), filepath.Join(dir, "tsum-stats.exe.download")
	os.WriteFile(exe, []byte("old"), 0o755)
	os.WriteFile(tmp, []byte("new"), 0o755)
	return exe, tmp
}

func read(t *testing.T, path string) string {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func TestSwapBinary(t *testing.T) {
	exe, tmp := swapDir(t)
	os.WriteFile(exe+".old", []byte("stale"), 0o644)
	if err := swapBinary(exe, tmp); err != nil {
		t.Fatal(err)
	}
	if read(t, exe) != "new" {
		t.Error("exe was not replaced")
	}
	if _, err := os.Stat(tmp); !errors.Is(err, fs.ErrNotExist) {
		t.Error("the download is still there")
	}
}

// An earlier .old that cannot be deleted (a non-empty folder stands in for one
// still running) must not stop the update.
func TestSwapBinaryLockedOld(t *testing.T) {
	exe, tmp := swapDir(t)
	os.MkdirAll(filepath.Join(exe+".old", "x"), 0o755)
	if err := swapBinary(exe, tmp); err != nil {
		t.Fatal(err)
	}
	if read(t, exe) != "new" {
		t.Error("exe was not replaced")
	}
	// On Unix the renamed-away exe is deleted at once; Windows keeps it while it runs.
	os.WriteFile(exe+".old-123", []byte("old"), 0o755)
	os.RemoveAll(filepath.Join(exe+".old", "x"))
	clearOldOf(exe)
	entries, _ := os.ReadDir(filepath.Dir(exe))
	for _, e := range entries {
		if strings.Contains(e.Name(), ".old") {
			t.Errorf("clearOldOf left %s", e.Name())
		}
	}
}

// A rename refused for good leaves the program in place and says what to do.
func TestSwapBinaryDenied(t *testing.T) {
	if runtime.GOOS == "windows" || os.Geteuid() == 0 {
		t.Skip("needs a read-only folder that binds its owner")
	}
	exe, tmp := swapDir(t)
	dir := filepath.Dir(exe)
	os.Chmod(dir, 0o555)
	t.Cleanup(func() { os.Chmod(dir, 0o755) })
	err := swapBinary(exe, tmp)
	if err == nil || !strings.Contains(err.Error(), "Task Manager") {
		t.Fatalf("got %v", err)
	}
	if read(t, exe) != "old" {
		t.Error("exe changed")
	}
}

func TestRetryRename(t *testing.T) {
	fastWaits(t, 20*time.Millisecond, 20*time.Millisecond, 20*time.Millisecond)
	dir := t.TempDir()
	from := filepath.Join(dir, "a")
	// Appears only after the first try, as a lock that lifts would.
	go func() { time.Sleep(10 * time.Millisecond); os.WriteFile(from, nil, 0o644) }()
	if err := retryRename(from, filepath.Join(dir, "b")); err != nil {
		t.Fatal(err)
	}
}
