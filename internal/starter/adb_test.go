package starter

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// A fake adb that reports revision 37, as `adb version` does.
const fakeVersionADB = "#!/bin/sh\necho 'Android Debug Bridge version 1.0.41'\necho 'Version 37.0.1-12345'\n"

// platformToolsZip is a platform-tools archive holding the given members.
func platformToolsZip(t *testing.T, members ...string) []byte {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for _, m := range members {
		w, err := zw.Create("platform-tools/" + m)
		if err != nil {
			t.Fatal(err)
		}
		body := "notice"
		if m == "adb" {
			body = fakeVersionADB
		}
		_, _ = w.Write([]byte(body))
	}
	_ = zw.Close()
	return buf.Bytes()
}

// adbBundle is a bundle whose pin names an archive served locally, on a
// computer with no other adb: an empty PATH, HOME and SDK variables.
func adbBundle(t *testing.T, archive []byte, sum string) *Starter {
	if runtime.GOOS == "windows" || runtime.GOOS == "linux" && runtime.GOARCH != "amd64" {
		t.Skip("the fake adb is a shell script, and Linux downloads are x86_64 only")
	}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write(archive) }))
	t.Cleanup(srv.Close)
	if sum == "" {
		h := sha256.Sum256(archive)
		sum = hex.EncodeToString(h[:])
	}
	dir := t.TempDir()
	_ = os.MkdirAll(filepath.Join(dir, "device"), 0o755)
	_ = os.WriteFile(filepath.Join(dir, "device", "gap-service.sh"), nil, 0o644)
	pin := fmt.Sprintf("revision=37.0.1\nurl_%[1]s=%[2]s/pt.zip\nsha256_%[1]s=%[3]s\nsize_%[1]s=%[4]d\n", hostOS(), srv.URL, sum, len(archive))
	_ = os.WriteFile(filepath.Join(dir, "platform-tools.txt"), []byte(pin), 0o644)
	for _, k := range []string{"PATH", "GAP_ADB", "ANDROID_HOME", "LOCALAPPDATA"} {
		t.Setenv(k, "")
	}
	t.Setenv("HOME", t.TempDir())
	s, err := New(dir, "test")
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestDownloadADB(t *testing.T) {
	s := adbBundle(t, platformToolsZip(t, "adb", "NOTICE.txt", "fastboot"), "")
	if info := s.resolveADB(); !info.Missing {
		t.Fatalf("with no adb anywhere it should be missing: %+v", info)
	}
	var log []string
	if err := s.downloadADB(func(l string) { log = append(log, l) }); err != nil {
		t.Fatal(err)
	}
	dir := filepath.Dir(s.ownADB())
	entries, _ := os.ReadDir(dir)
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	if strings.Join(names, " ") != "NOTICE.txt adb" {
		t.Fatalf("only adb and its notice are kept, and the zip is deleted: %v", names)
	}
	if !strings.Contains(strings.Join(log, "\n"), "sha256 ok") {
		t.Fatalf("log: %v", log)
	}
	info := s.resolveADB()
	if info.Missing || info.Path != s.ownADB() || info.Source != "downloaded r37" {
		t.Fatalf("the downloaded adb should be used: %+v", info)
	}
}

func TestDownloadADBRefusesBadChecksum(t *testing.T) {
	s := adbBundle(t, platformToolsZip(t, "adb", "NOTICE.txt"), strings.Repeat("0", 64))
	err := s.downloadADB(func(string) {})
	if err == nil || !strings.Contains(err.Error(), "checksum") {
		t.Fatalf("want a checksum error, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(s.bundle, "adb")); !os.IsNotExist(err) {
		t.Fatal("nothing should be left behind, not even the adb folder")
	}
}

func TestDownloadADBMissingMember(t *testing.T) {
	s := adbBundle(t, platformToolsZip(t, "NOTICE.txt"), "")
	err := s.downloadADB(func(string) {})
	if err == nil || !strings.Contains(err.Error(), "no adb") {
		t.Fatalf("want a missing-member error, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(s.bundle, "adb")); !os.IsNotExist(err) {
		t.Fatal("a half-unpacked download should be removed")
	}
}

func TestDownloadADBUnreachable(t *testing.T) {
	s := adbBundle(t, nil, "")
	// Point the pin at a port nothing listens on.
	pin := fmt.Sprintf("revision=37.0.1\nurl_%[1]s=http://127.0.0.1:1/pt.zip\nsha256_%[1]s=%[2]s\n", hostOS(), strings.Repeat("0", 64))
	_ = os.WriteFile(filepath.Join(s.bundle, "platform-tools.txt"), []byte(pin), 0o644)
	if err := s.downloadADB(func(string) {}); err == nil || !strings.Contains(err.Error(), "could not download") {
		t.Fatalf("want a download error, got %v", err)
	}
	if _, err := os.Stat(filepath.Join(s.bundle, "adb")); !os.IsNotExist(err) {
		t.Fatal("nothing should be left behind")
	}
}
