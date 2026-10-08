package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// The pin file Tsum Tsum Stats updates itself from (version, then url_/sha256_/size_
// per system), written by tools/build.sh. Set by the build; empty
// turns updating off, as in a `go run` checkout.
var updateURL = ""

// parsePin reads the pin's key=value lines; comments and blanks are skipped.
func parsePin(text string) map[string]string {
	kv := map[string]string{}
	sc := bufio.NewScanner(strings.NewReader(text))
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		if k, v, ok := strings.Cut(line, "="); ok {
			kv[strings.TrimSpace(k)] = strings.TrimSpace(v)
		}
	}
	return kv
}

// newerVersion reports whether dotted version a is newer than b.
func newerVersion(a, b string) bool {
	as, bs := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(as) || i < len(bs); i++ {
		var x, y int
		if i < len(as) {
			x, _ = strconv.Atoi(as[i])
		}
		if i < len(bs) {
			y, _ = strconv.Atoi(bs[i])
		}
		if x != y {
			return x > y
		}
	}
	return false
}

// fetchPin reads the published pin.
func fetchPin(pinURL string) (map[string]string, error) {
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get(pinURL)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%s answered %s", pinURL, resp.Status)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, err
	}
	return parsePin(string(body)), nil
}

// latestVersion is the version the pin publishes.
func latestVersion(pinURL string) (string, error) {
	pin, err := fetchPin(pinURL)
	if err != nil {
		return "", err
	}
	if pin["version"] == "" {
		return "", fmt.Errorf("%s names no version", pinURL)
	}
	return pin["version"], nil
}

// selfUpdate replaces this binary with the pinned one when the pin is newer.
// It returns true when it did, so the caller can start the new one. A failed
// check or download changes nothing: the running version stays usable.
func selfUpdate(pinURL string, log func(string, ...any)) (bool, error) {
	pin, err := fetchPin(pinURL)
	if err != nil {
		return false, err
	}
	if !newerVersion(pin["version"], version) {
		return false, nil
	}

	key := runtime.GOOS + "_" + runtime.GOARCH
	url, want := pin["url_"+key], pin["sha256_"+key]
	if url == "" || want == "" {
		return false, fmt.Errorf("version %s is not built for %s", pin["version"], key)
	}
	exe, err := os.Executable()
	if err != nil {
		return false, err
	}
	if exe, err = filepath.EvalSymlinks(exe); err != nil {
		return false, err
	}

	log("Updating Tsum Tsum Stats %s -> %s ...", version, pin["version"])
	tmp := exe + ".download"
	got, err := download(url, tmp)
	if err != nil {
		os.Remove(tmp)
		return false, err
	}
	if got != want {
		os.Remove(tmp)
		return false, fmt.Errorf("the download did not match its checksum and was deleted")
	}
	log("sha256 ok")
	if err := os.Chmod(tmp, 0o755); err != nil {
		os.Remove(tmp)
		return false, err
	}
	// Windows cannot overwrite a running exe but can rename it away.
	old := exe + ".old"
	os.Remove(old)
	if err := os.Rename(exe, old); err != nil {
		os.Remove(tmp)
		return false, err
	}
	if err := os.Rename(tmp, exe); err != nil {
		os.Rename(old, exe)
		return false, err
	}
	os.Remove(old) // fails on Windows while running; the next start clears it
	log("Installed tsum-stats %s.", pin["version"])
	return true, nil
}

// download saves url to path and returns the file's sha256.
func download(url, path string) (string, error) {
	resp, err := http.Get(url)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s answered %s", url, resp.Status)
	}
	f, err := os.Create(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	h := sha256.New()
	if _, err := io.Copy(io.MultiWriter(f, h), resp.Body); err != nil {
		return "", err
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// restart runs the (just replaced) binary with the same arguments and exits
// with its status.
func restart() {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	cmd := exec.Command(exe, os.Args[1:]...)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		if ee, ok := err.(*exec.ExitError); ok {
			os.Exit(ee.ExitCode())
		}
		os.Exit(1)
	}
	os.Exit(0)
}

// clearOld removes the binary an earlier update renamed away.
func clearOld() {
	if exe, err := os.Executable(); err == nil {
		os.Remove(exe + ".old")
	}
}
