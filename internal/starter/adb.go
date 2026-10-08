package starter

import (
	"archive/zip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// The adb this tool uses, chosen the way the bundle's shell host chooses it
// (bin/posix/gap-device.sh resolve_adb): GAP_ADB, then a system adb at least as
// new as the pinned one, then the bundle's own adb/<os>/, downloaded once from
// the URL and sha256 in platform-tools.txt.
type adbInfo struct {
	Path     string `json:"path"`
	Source   string `json:"source"`            // "GAP_ADB", "system r37", "downloaded r37"
	Warning  string `json:"warning,omitempty"` // the server was replaced
	Missing  bool   `json:"missing"`           // nothing usable yet; the page offers the download
	Older    string `json:"older,omitempty"`   // a system adb too old to use
	Revision string `json:"revision"`          // the pinned one
	SizeMB   int    `json:"sizeMB"`
	URL      string `json:"url"`
}

func hostOS() string { return runtime.GOOS }

func exeName(name string) string {
	if runtime.GOOS == "windows" {
		return name + ".exe"
	}
	return name
}

func (s *Starter) ownADB() string {
	return filepath.Join(s.bundle, "adb", hostOS(), exeName("adb"))
}

// adbMembers is what comes out of the archive: adb.exe needs its three DLLs.
func adbMembers() []string {
	if runtime.GOOS == "windows" {
		return []string{"adb.exe", "AdbWinApi.dll", "AdbWinUsbApi.dll", "libwinpthread-1.dll", "NOTICE.txt"}
	}
	return []string{"adb", "NOTICE.txt"}
}

func (s *Starter) pin(key string) string {
	b, _ := os.ReadFile(filepath.Join(s.bundle, "platform-tools.txt"))
	return kv(string(b), key)
}

var adbVersionRE = regexp.MustCompile(`(?m)^Version (\d+)\.`)

// adbRevision is the major of "Version 37.0.0" in `adb version`, 0 when unreadable.
func adbRevision(path string) int {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	out, _ := exec.CommandContext(ctx, path, "version").Output()
	m := adbVersionRE.FindSubmatch(out)
	if m == nil {
		return 0
	}
	n, _ := strconv.Atoi(string(m[1]))
	return n
}

func isExec(p string) bool {
	st, err := os.Stat(p)
	return err == nil && !st.IsDir()
}

// resolveADB picks the adb, without downloading. Two adb clients of different
// versions fight over one server, so the user's own adb wins when it is new enough.
func (s *Starter) resolveADB() adbInfo {
	info := adbInfo{Revision: s.pin("revision"), URL: s.pin("url_" + hostOS())}
	if size, _ := strconv.Atoi(s.pin("size_" + hostOS())); size > 0 {
		info.SizeMB = (size + 524288) / 1048576
	}
	ownRev := adbRevision(s.ownADB())
	if ownRev == 0 {
		ownRev, _ = strconv.Atoi(strings.SplitN(info.Revision, ".", 2)[0])
	}

	if p := os.Getenv("GAP_ADB"); p != "" && isExec(p) {
		info.Path, info.Source = p, "GAP_ADB"
		return info
	}
	home, _ := os.UserHomeDir()
	cands := []string{}
	if p, err := exec.LookPath("adb"); err == nil {
		cands = append(cands, p)
	}
	for _, sdk := range []string{os.Getenv("ANDROID_HOME"), filepath.Join(home, "Library", "Android", "sdk"),
		filepath.Join(home, "Android", "Sdk"), filepath.Join(os.Getenv("LOCALAPPDATA"), "Android", "Sdk")} {
		if sdk != "" {
			cands = append(cands, filepath.Join(sdk, "platform-tools", exeName("adb")))
		}
	}
	for _, c := range cands {
		if !isExec(c) {
			continue
		}
		rev := adbRevision(c)
		if rev == 0 {
			continue
		}
		if rev >= ownRev {
			info.Path, info.Source = c, fmt.Sprintf("system r%d", rev)
			return info
		}
		info.Older = fmt.Sprintf("%s (r%d)", c, rev)
	}
	if isExec(s.ownADB()) {
		info.Path, info.Source = s.ownADB(), fmt.Sprintf("downloaded r%d", ownRev)
		return info
	}
	info.Missing = true
	return info
}

// downloadADB fetches platform-tools for this computer, checks the archive
// against the pin and keeps only adb out of it. Nothing half-done is left behind.
func (s *Starter) downloadADB(logf func(string)) error {
	osName := hostOS()
	url, want := s.pin("url_"+osName), s.pin("sha256_"+osName)
	if url == "" || want == "" {
		return fmt.Errorf("platform-tools.txt does not say where to download adb for %s; re-extract the bundle, or set GAP_ADB", osName)
	}
	if osName == "linux" && runtime.GOARCH != "amd64" {
		return fmt.Errorf("Google publishes adb for Linux on x86_64 only; install your distribution's adb (apt install adb) and set GAP_ADB to its full path")
	}
	dir := filepath.Dir(s.ownADB())
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("cannot write into %s; move this folder somewhere you can write to (Downloads, Desktop), or set GAP_ADB", dir)
	}
	fail := func(err error) error {
		os.RemoveAll(dir)
		os.Remove(filepath.Dir(dir)) // adb/, only when empty
		return err
	}
	logf("downloading platform-tools r" + s.pin("revision") + " ...")
	logf("  fetch : " + url)
	zipPath := filepath.Join(dir, "platform-tools.zip")
	got, err := fetchFile(url, zipPath)
	if err != nil {
		return fail(fmt.Errorf("could not download it (%v); check the internet connection, or set GAP_ADB", err))
	}
	if got != want {
		return fail(fmt.Errorf("the download did not match its checksum and was deleted; try again, and if it keeps failing get the newest -scripts bundle"))
	}
	logf("  sha256 ok")
	if err := extractMembers(zipPath, dir, adbMembers()); err != nil {
		return fail(fmt.Errorf("could not unpack it: %v", err))
	}
	os.Remove(zipPath)
	logf("  adb r" + strconv.Itoa(adbRevision(s.ownADB())) + " is ready in adb/" + osName)
	return nil
}

// fetchFile downloads url to dest and returns the file's sha256.
func fetchFile(url, dest string) (string, error) {
	resp, err := (&http.Client{Timeout: 10 * time.Minute}).Get(url)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s", resp.Status)
	}
	f, err := os.Create(dest)
	if err != nil {
		return "", err
	}
	h := sha256.New()
	_, err = io.Copy(io.MultiWriter(f, h), resp.Body)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		os.Remove(dest)
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

func sha256File(path string) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// extractMembers copies platform-tools/<m> for each member, flat into dir.
func extractMembers(zipPath, dir string, members []string) error {
	zr, err := zip.OpenReader(zipPath)
	if err != nil {
		return err
	}
	defer zr.Close()
	for _, m := range members {
		var src *zip.File
		for _, f := range zr.File {
			if f.Name == "platform-tools/"+m {
				src = f
				break
			}
		}
		if src == nil {
			return fmt.Errorf("the archive had no %s in it", m)
		}
		rc, err := src.Open()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(filepath.Join(dir, m), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o755)
		if err != nil {
			rc.Close()
			return err
		}
		_, err = io.Copy(out, rc)
		rc.Close()
		if cerr := out.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// startServer runs `adb start-server` and says when that replaced someone else's.
// It never kills the server on exit: other tools may be using it.
func (s *Starter) startServer(adb string) string {
	out, _ := exec.Command(adb, "start-server").CombinedOutput()
	if o := string(out); strings.Contains(o, "killing") || strings.Contains(o, "doesn't match") {
		return "Replaced the running ADB server. Android Studio, scrcpy or your emulator manager may briefly lose the device -- they reconnect automatically."
	}
	return ""
}

// restartServer is `adb kill-server` then `adb start-server`. It holds every
// device lock it knows of, so no action loses its connection halfway.
func (s *Starter) restartServer(ctx context.Context, logf func(string)) Result {
	s.mu.Lock()
	locks := make([]*sync.Mutex, 0, len(s.locks))
	for _, l := range s.locks {
		locks = append(locks, l)
	}
	s.mu.Unlock()
	for _, l := range locks {
		l.Lock()
		defer l.Unlock()
	}
	logf("adb kill-server ...")
	out, _ := s.run(ctx, 20*time.Second, "kill-server")
	logLines(logf, out)
	logf("adb start-server ...")
	out, err := s.run(ctx, 30*time.Second, "start-server")
	logLines(logf, out)
	if err != nil {
		return Result{Msg: "adb did not start again: " + err.Error()}
	}
	return Result{OK: true, Msg: "The adb server was restarted. Looking for devices again."}
}
