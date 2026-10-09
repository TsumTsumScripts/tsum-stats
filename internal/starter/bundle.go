package starter

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// The bundle's own scripts, updated in place. build-starter.sh writes
// starter-version.txt (version=, update_url=) into every bundle, and a
// --scripts-only build writes the starter.txt that update_url names:
// version=, then url=, sha256= and size= of the scripts .tar.gz.

const bundleVersionFile = "starter-version.txt"

// Never touched by an update: what the player's copy has gathered, the
// staging folder, and Start-Windows.cmd, which cmd re-reads by byte offset
// while it runs, so replacing it mid-run would execute garbage.
var bundleKeep = map[string]bool{
	"adb": true, "apk": true, "collected": true, "server": true, ".update": true,
	"channel.txt": true, "last-device.txt": true, "Start-Windows.cmd": true,
}

// What a scripts archive must carry to be installed at all.
var bundleRequired = []string{
	bundleVersionFile, "device/gap-service.sh", "bin/posix/gap.sh", "bin/posix/gap-site.sh",
	"bin/win/gap.ps1", "bin/win/gap-site.ps1",
}

// Far above a scripts bundle (a few hundred KB); refuses anything else.
const bundleMaxSize = 32 << 20

func (s *Starter) bundleVersion() (version, updateURL string) {
	b, _ := os.ReadFile(filepath.Join(s.bundle, bundleVersionFile))
	text := strings.ReplaceAll(string(b), "\r", "")
	return kv(text, "version"), kv(text, "update_url")
}

// bundleUpdatable: a built bundle that says where its updates are. The source
// tree (it still has build-starter.sh) never updates itself.
func (s *Starter) bundleUpdatable() bool {
	if _, err := os.Stat(filepath.Join(s.bundle, "build-starter.sh")); err == nil {
		return false
	}
	_, u := s.bundleVersion()
	return strings.HasPrefix(u, "https://") || strings.HasPrefix(u, "http://")
}

func fetchText(url string) (string, error) {
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s answered %s", url, resp.Status)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return strings.ReplaceAll(string(b), "\r", ""), err
}

func (s *Starter) bundlePin() (string, error) {
	_, u := s.bundleVersion()
	pin, err := fetchText(u)
	if err != nil {
		return "", err
	}
	if kv(pin, "version") == "" {
		return "", fmt.Errorf("%s names no version", u)
	}
	return pin, nil
}

// latestBundle is the newest published starter version.
func (s *Starter) latestBundle() (string, error) {
	pin, err := s.bundlePin()
	if err != nil {
		return "", err
	}
	return kv(pin, "version"), nil
}

// applyBundle installs the published scripts over this bundle when they are
// newer. Every file is staged and checked first; a failure while moving them
// in puts back the ones already moved.
func (s *Starter) applyBundle(logf func(string)) (bool, error) {
	pin, err := s.bundlePin()
	if err != nil {
		return false, err
	}
	current, _ := s.bundleVersion()
	want := kv(pin, "version")
	if !newerVersion(want, current) {
		return false, nil
	}
	url, sum := kv(pin, "url"), strings.ToLower(kv(pin, "sha256"))
	if url == "" || sum == "" {
		return false, errors.New("the published starter.txt names no archive")
	}

	stage := filepath.Join(s.bundle, ".update")
	if err := os.RemoveAll(stage); err != nil {
		return false, err
	}
	defer os.RemoveAll(stage)
	if err := os.MkdirAll(stage, 0o755); err != nil {
		return false, err
	}

	logf(fmt.Sprintf("Updating the starter %s -> %s ...", orUnknown(current), want))
	archive := filepath.Join(stage, "scripts.tar.gz")
	got, err := downloadFile(url, archive)
	if err != nil {
		return false, err
	}
	if got != sum {
		return false, errors.New("the download did not match its checksum")
	}
	logf("sha256 ok")

	fresh := filepath.Join(stage, "new")
	if err := untar(archive, fresh); err != nil {
		return false, fmt.Errorf("unpacking: %w", err)
	}
	for _, f := range bundleRequired {
		if _, err := os.Stat(filepath.Join(fresh, filepath.FromSlash(f))); err != nil {
			return false, fmt.Errorf("the archive has no %s", f)
		}
	}
	b, _ := os.ReadFile(filepath.Join(fresh, bundleVersionFile))
	if v := kv(strings.ReplaceAll(string(b), "\r", ""), "version"); v != want {
		return false, fmt.Errorf("the archive says version %s, not %s", v, want)
	}

	n, err := swapIn(fresh, s.bundle, filepath.Join(stage, "old"))
	if err != nil {
		return false, err
	}
	logf(fmt.Sprintf("Installed starter %s (%d files).", want, n))
	return true, nil
}

func orUnknown(v string) string {
	if v == "" {
		return "?"
	}
	return v
}

// downloadFile saves url to path and returns its sha256.
func downloadFile(url, path string) (string, error) {
	client := &http.Client{Timeout: 2 * time.Minute}
	resp, err := client.Get(url)
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
	n, err := io.Copy(io.MultiWriter(f, h), io.LimitReader(resp.Body, bundleMaxSize+1))
	if err != nil {
		return "", err
	}
	if n > bundleMaxSize {
		return "", errors.New("the archive is far larger than a scripts bundle")
	}
	return hex.EncodeToString(h.Sum(nil)), nil
}

// untar unpacks a bundle archive into dir, dropping its top folder
// (TsumTsum-Starter/). Only plain files and folders, only inside dir.
func untar(archive, dir string) error {
	f, err := os.Open(archive)
	if err != nil {
		return err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return err
	}
	tr := tar.NewReader(gz)
	for {
		h, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		_, rel, ok := strings.Cut(strings.TrimPrefix(h.Name, "./"), "/")
		if !ok || rel == "" {
			continue
		}
		rel = filepath.FromSlash(strings.TrimSuffix(rel, "/"))
		if !filepath.IsLocal(rel) {
			return fmt.Errorf("refusing %s", h.Name)
		}
		dest := filepath.Join(dir, rel)
		switch h.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(dest, 0o755); err != nil {
				return err
			}
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
				return err
			}
			out, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, fs.FileMode(h.Mode&0o777)|0o600)
			if err != nil {
				return err
			}
			_, err = io.Copy(out, io.LimitReader(tr, bundleMaxSize))
			if cerr := out.Close(); err == nil {
				err = cerr
			}
			if err != nil {
				return err
			}
		}
	}
}

// swapIn moves every file of fresh into bundle, the replaced ones into old.
// Renames, never rewrites: a shell still reading a script keeps the old file.
// On a failure the files already moved are put back.
func swapIn(fresh, bundle, old string) (int, error) {
	type moved struct{ target, backup string }
	var done []moved
	undo := func() {
		for i := len(done) - 1; i >= 0; i-- {
			os.Remove(done[i].target)
			if done[i].backup != "" {
				os.Rename(done[i].backup, done[i].target)
			}
		}
	}
	err := filepath.WalkDir(fresh, func(path string, d fs.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(fresh, path)
		if bundleKeep[strings.SplitN(filepath.ToSlash(rel), "/", 2)[0]] {
			return nil
		}
		target := filepath.Join(bundle, rel)
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		m := moved{target: target}
		if _, err := os.Lstat(target); err == nil {
			m.backup = filepath.Join(old, rel)
			if err := os.MkdirAll(filepath.Dir(m.backup), 0o755); err != nil {
				return err
			}
			if err := os.Rename(target, m.backup); err != nil {
				return err
			}
		}
		if err := os.Rename(path, target); err != nil {
			if m.backup != "" {
				os.Rename(m.backup, target)
			}
			return err
		}
		done = append(done, m)
		return nil
	})
	if err != nil {
		undo()
		return 0, err
	}
	return len(done), nil
}
