package starter

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func TestUpdateState(t *testing.T) {
	s := &Starter{version: "0.14", bundle: t.TempDir()}
	if st := s.updateState(); !st.Stats.Disabled || st.Stats.CanRestart || !st.Starter.Disabled {
		t.Fatalf("no updater, no update address: %+v", st)
	}
	latest, fail := "0.15", error(nil)
	s.SetUpdater(Updater{
		Latest:      func() (string, error) { return latest, fail },
		RestartCode: 75,
	})
	if st := s.checkUpdates().Stats; !st.Available || st.Latest != "0.15" || !st.CanRestart {
		t.Fatalf("newer out: %+v", st)
	}
	fail = errors.New("offline")
	if st := s.checkUpdates().Stats; st.Error != "offline" || st.Latest != "0.15" {
		t.Fatalf("a failed check keeps the last answer: %+v", st)
	}
	if s.RestartCode() != 0 {
		t.Fatal("no restart before an update is applied")
	}
}

func TestNewerVersion(t *testing.T) {
	for _, c := range []struct {
		a, b string
		want bool
	}{{"1.1", "1.0", true}, {"1.0", "1.0", false}, {"1.10", "1.9", true}, {"1.0", "", true}, {"", "1.0", false}} {
		if got := newerVersion(c.a, c.b); got != c.want {
			t.Errorf("newerVersion(%q, %q) = %v", c.a, c.b, got)
		}
	}
}

type tarFile struct {
	name, body string
	mode       int64
}

func tgz(t *testing.T, files []tarFile) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, f := range files {
		mode := f.mode
		if mode == 0 {
			mode = 0o644
		}
		if err := tw.WriteHeader(&tar.Header{Name: f.name, Mode: mode, Size: int64(len(f.body)), Typeflag: tar.TypeReg}); err != nil {
			t.Fatal(err)
		}
		tw.Write([]byte(f.body))
	}
	tw.Close()
	gz.Close()
	return buf.Bytes()
}

// A bundle at 1.0 and a published 1.1, served as starter.txt plus the archive.
func bundleFixture(t *testing.T, archive []byte, sum string) *Starter {
	t.Helper()
	if sum == "" {
		h := sha256.Sum256(archive)
		sum = hex.EncodeToString(h[:])
	}
	mux := http.NewServeMux()
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	mux.HandleFunc("/starter.txt", func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte("version=1.1\nurl=" + srv.URL + "/s.tar.gz\nsha256=" + sum + "\n"))
	})
	mux.HandleFunc("/s.tar.gz", func(w http.ResponseWriter, r *http.Request) { w.Write(archive) })

	dir := t.TempDir()
	for rel, body := range map[string]string{
		bundleVersionFile:   "version=1.0\nupdate_url=" + srv.URL + "/starter.txt\n",
		"bin/posix/gap.sh":  "old",
		"adb/darwin/adb":    "players adb",
		"Start-Windows.cmd": "old cmd",
		"channel.txt":       "https://x/alpha",
	} {
		p := filepath.Join(dir, filepath.FromSlash(rel))
		os.MkdirAll(filepath.Dir(p), 0o755)
		os.WriteFile(p, []byte(body), 0o644)
	}
	return &Starter{bundle: dir}
}

func scriptsArchive(t *testing.T, extra ...tarFile) []byte {
	files := []tarFile{
		{name: "TsumTsum-Starter/" + bundleVersionFile, body: "version=1.1\nupdate_url=x\n"},
		{name: "TsumTsum-Starter/device/gap-service.sh", body: "svc", mode: 0o755},
		{name: "TsumTsum-Starter/bin/posix/gap.sh", body: "new", mode: 0o755},
		{name: "TsumTsum-Starter/bin/posix/gap-site.sh", body: "site", mode: 0o755},
		{name: "TsumTsum-Starter/bin/win/gap.ps1", body: "ps"},
		{name: "TsumTsum-Starter/bin/win/gap-site.ps1", body: "ps"},
		{name: "TsumTsum-Starter/adb/darwin/adb", body: "not ours"},
		{name: "TsumTsum-Starter/Start-Windows.cmd", body: "new cmd"},
	}
	return tgz(t, append(files, extra...))
}

func read(t *testing.T, s *Starter, rel string) string {
	b, _ := os.ReadFile(filepath.Join(s.bundle, filepath.FromSlash(rel)))
	return string(b)
}

func TestApplyBundle(t *testing.T) {
	s := bundleFixture(t, scriptsArchive(t), "")
	if !s.bundleUpdatable() {
		t.Fatal("a built bundle with an update_url updates")
	}
	if v, _ := s.latestBundle(); v != "1.1" {
		t.Fatalf("latest: %q", v)
	}
	done, err := s.applyBundle(func(string) {})
	if err != nil || !done {
		t.Fatalf("apply: %v %v", done, err)
	}
	if v, _ := s.bundleVersion(); v != "1.1" {
		t.Errorf("version after: %q", v)
	}
	for rel, want := range map[string]string{
		"bin/posix/gap.sh": "new", "adb/darwin/adb": "players adb",
		"Start-Windows.cmd": "old cmd", "channel.txt": "https://x/alpha",
	} {
		if got := read(t, s, rel); got != want {
			t.Errorf("%s: %q, want %q", rel, got, want)
		}
	}
	if fi, _ := os.Stat(filepath.Join(s.bundle, "bin/posix/gap.sh")); runtime.GOOS != "windows" && fi.Mode()&0o111 == 0 {
		t.Error("gap.sh lost its execute bit")
	}
	if _, err := os.Stat(filepath.Join(s.bundle, ".update")); err == nil {
		t.Error(".update was left behind")
	}
	if done, _ := s.applyBundle(func(string) {}); done {
		t.Error("1.1 over 1.1 is not an update")
	}
}

func TestApplyBundleRefuses(t *testing.T) {
	for name, s := range map[string]*Starter{
		"bad checksum": bundleFixture(t, scriptsArchive(t), "00"),
		"escapes":      bundleFixture(t, scriptsArchive(t, tarFile{name: "TsumTsum-Starter/../../evil", body: "x"}), ""),
		"incomplete":   bundleFixture(t, tgz(t, []tarFile{{name: "TsumTsum-Starter/" + bundleVersionFile, body: "version=1.1\n"}}), ""),
	} {
		if _, err := s.applyBundle(func(string) {}); err == nil {
			t.Errorf("%s: installed", name)
		}
		if read(t, s, "bin/posix/gap.sh") != "old" {
			t.Errorf("%s: changed the bundle", name)
		}
	}
}

func TestSourceTreeNeverUpdates(t *testing.T) {
	s := bundleFixture(t, scriptsArchive(t), "")
	os.WriteFile(filepath.Join(s.bundle, "build-starter.sh"), nil, 0o644)
	if s.bundleUpdatable() {
		t.Fatal("the source tree must not overwrite itself")
	}
}
