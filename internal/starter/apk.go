package starter

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Where `update` finds the published APKs: a stable-name redirect to the newest
// release, the same base the app's own updater uses (gated in build-starter.sh).
const (
	defaultReleaseBase = "https://github.com/game-automation-platform/game-automation-catalogue/releases/latest/download"
	manifestName       = "gap-latest.txt"
	channelFile        = "channel.txt"
)

// APK is one file in the bundle's apk/ folder.
type APK struct {
	Name      string `json:"name"`
	Default   bool   `json:"default"`   // the one built for this device
	Universal bool   `json:"universal"` // every ABI; the device chooses
}

// bundledAPKs lists apk/ with the best match for abi first and marked default.
// An exact ABI match beats the universal build, which an emulator that
// translates ARM can resolve to the wrong libraries.
func (s *Starter) bundledAPKs(abi string) []APK {
	names, _ := filepath.Glob(filepath.Join(s.bundle, "apk", "*.apk"))
	sort.Strings(names)
	def := ""
	if abi != "" && abi != "-" {
		for _, n := range names {
			if strings.Contains(filepath.Base(n), abi) {
				def = n
				break
			}
		}
		if def == "" {
			for _, n := range names {
				if strings.Contains(filepath.Base(n), "universal") {
					def = n
					break
				}
			}
		}
		if def == "" && len(names) > 0 {
			def = names[0]
		}
	}
	var list []APK
	for _, n := range names {
		a := APK{Name: filepath.Base(n), Default: n == def, Universal: strings.Contains(filepath.Base(n), "universal")}
		if a.Default {
			list = append([]APK{a}, list...)
		} else {
			list = append(list, a)
		}
	}
	return list
}

func (s *Starter) hasExactAPK(abi string) bool {
	for _, a := range s.bundledAPKs(abi) {
		if strings.Contains(a.Name, abi) {
			return true
		}
	}
	return false
}

// installAPK retries a signature or downgrade mismatch once, after an uninstall;
// the app's scripts live on shared storage, which the uninstall leaves alone.
func (s *Starter) installAPK(ctx context.Context, serial, apk string, logf func(string)) bool {
	out, _ := s.run(ctx, 5*time.Minute, "-s", serial, "install", "-r", apk)
	logLines(logf, out)
	if strings.Contains(out, "Success") {
		return true
	}
	if strings.Contains(out, "UPDATE_INCOMPATIBLE") || strings.Contains(out, "VERSION_DOWNGRADE") || strings.Contains(out, "SIGNATURE") {
		logf("  install failed; uninstalling " + appPackage + " and retrying")
		_, _ = s.run(ctx, time.Minute, "-s", serial, "uninstall", appPackage)
		out, _ = s.run(ctx, 5*time.Minute, "-s", serial, "install", apk)
		logLines(logf, out)
		return strings.Contains(out, "Success")
	}
	return false
}

func logLines(logf func(string), out string) {
	for _, l := range strings.Split(strings.TrimRight(out, "\n"), "\n") {
		if strings.TrimSpace(l) != "" {
			logf("  " + l)
		}
	}
}

// ------------------------------------------------------------------ the channel

// channelFolder turns a tester's URL into the folder holding gap-latest.txt: a
// trailing .json or .txt is the catalogue file beside it. A query is refused,
// since "<base>/<file>" cannot carry one.
func channelFolder(raw string) (string, bool) {
	u := strings.TrimRight(strings.TrimSpace(raw), "/")
	if !strings.HasPrefix(u, "http://") && !strings.HasPrefix(u, "https://") || strings.ContainsAny(u, "?#") {
		return "", false
	}
	if !strings.Contains(strings.SplitN(u, "://", 2)[1], "/") {
		return "", false
	}
	if last := u[strings.LastIndex(u, "/")+1:]; strings.HasSuffix(last, ".json") || strings.HasSuffix(last, ".txt") {
		u = u[:strings.LastIndex(u, "/")]
	}
	if _, err := url.Parse(u); err != nil {
		return "", false
	}
	return u, true
}

// releaseBase is GAP_RELEASE_BASE, else channel.txt, else the published releases.
func (s *Starter) releaseBase() string {
	base := os.Getenv("GAP_RELEASE_BASE")
	if base == "" {
		b, _ := os.ReadFile(filepath.Join(s.bundle, channelFile))
		base = strings.TrimSpace(strings.SplitN(strings.ReplaceAll(string(b), "\r", ""), "\n", 2)[0])
	}
	if base == "" {
		return defaultReleaseBase
	}
	if f, ok := channelFolder(base); ok {
		return f
	}
	return base
}

// setChannel pins a pre-release folder, or "off" deletes channel.txt.
func (s *Starter) setChannel(raw string) (string, error) {
	p := filepath.Join(s.bundle, channelFile)
	if raw == "" || raw == "off" {
		if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
			return "", err
		}
		return defaultReleaseBase, nil
	}
	folder, ok := channelFolder(raw)
	if !ok {
		return "", fmt.Errorf("a channel is an http(s) folder URL with no ?query")
	}
	return folder, os.WriteFile(p, []byte(folder+"\n"), 0o644)
}

func (s *Starter) fetchManifest(ctx context.Context) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, s.releaseBase()+"/"+manifestName, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("%s", resp.Status)
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	return strings.ReplaceAll(string(b), "\r", ""), err
}
