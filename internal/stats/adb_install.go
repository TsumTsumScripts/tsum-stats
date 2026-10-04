package stats

import (
	"archive/zip"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// platformToolsURL is Google's own download of adb; the OS name is its.
func platformToolsURL() (string, error) {
	switch runtime.GOOS {
	case "darwin", "linux", "windows":
		return "https://dl.google.com/android/repository/platform-tools-latest-" + runtime.GOOS + ".zip", nil
	}
	return "", fmt.Errorf("no adb download for %s", runtime.GOOS)
}

// InstallADB downloads Google's platform-tools for this OS into dir (once) and
// uses its adb. Run it in the background; failures are logged and Import from
// devices keeps saying adb was not found. Google publishes no checksum, so
// trust rests on HTTPS.
func (p *Puller) InstallADB(dir string) {
	exe := "adb"
	if runtime.GOOS == "windows" {
		exe = "adb.exe"
	}
	adb := filepath.Join(dir, "platform-tools", exe)
	if _, err := os.Stat(adb); err != nil {
		log.Printf("adb not found; downloading platform-tools ...")
		if err := downloadPlatformTools(dir); err != nil {
			log.Printf("could not download adb: %v", err)
			return
		}
	}
	p.adbMu.Lock()
	p.adb = adb
	p.adbMu.Unlock()
}

func downloadPlatformTools(dir string) error {
	url, err := platformToolsURL()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "platform-tools-*.zip")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	resp, err := (&http.Client{Timeout: 5 * time.Minute}).Get(url)
	if err != nil {
		tmp.Close()
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		tmp.Close()
		return fmt.Errorf("%s: %s", url, resp.Status)
	}
	_, err = io.Copy(tmp, resp.Body)
	if cerr := tmp.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	// Unpack beside the final place, then rename, so a half-extracted folder is never used.
	stage := filepath.Join(dir, "staging")
	os.RemoveAll(stage)
	if err := unzip(tmp.Name(), stage); err != nil {
		os.RemoveAll(stage)
		return err
	}
	final := filepath.Join(dir, "platform-tools")
	os.RemoveAll(final)
	return os.Rename(filepath.Join(stage, "platform-tools"), final)
}

func unzip(src, dest string) error {
	zr, err := zip.OpenReader(src)
	if err != nil {
		return err
	}
	defer zr.Close()
	root := filepath.Clean(dest) + string(os.PathSeparator)
	for _, f := range zr.File {
		target := filepath.Join(dest, f.Name)
		if !strings.HasPrefix(target, root) { // zip-slip
			return fmt.Errorf("unsafe path in zip: %s", f.Name)
		}
		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		rc, err := f.Open()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, f.Mode()|0o600)
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
