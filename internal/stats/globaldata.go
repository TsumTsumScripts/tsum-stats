package stats

import (
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sync"
	"time"
)

// GlobalData reads the global site's published files (global/CONTRACT.md §3.3,
// GET /data/global/<name>) for the local page, so it can run the global
// engine over everyone's rounds without asking the browser to reach another
// origin: the Catalog's "what to max next" needs the skill levels every
// player's rounds cover, which one player's rarely do. It keeps each file a
// while (the manifest TTLManifest, the rest TTLParts); a part replaced on the
// site answers 404 there, which is passed on, so the engine reads the
// manifest again.
type GlobalData struct {
	url  string // "" when contributing is off: nothing is fetched
	http *http.Client
	now  func() time.Time

	mu    sync.Mutex
	files map[string]globalFile
}

type globalFile struct {
	status int
	body   []byte
	at     time.Time
}

const (
	TTLManifest = 5 * time.Minute
	TTLParts    = time.Hour
	// globalFileMax is the most of one file kept; the site splits a part longer than its value limit.
	globalFileMax = 16 << 20
)

// globalName is a published file's name: path segments of letters, digits, '.', '_' and '-', never "..".
var globalName = regexp.MustCompile(`^[A-Za-z0-9_-][A-Za-z0-9._-]*(/[A-Za-z0-9_-][A-Za-z0-9._-]*)*$`)

// NewGlobalData reads from siteURL ("" for none).
func NewGlobalData(siteURL string) *GlobalData {
	return &GlobalData{url: siteURL, http: &http.Client{Timeout: 60 * time.Second}, now: time.Now, files: map[string]globalFile{}}
}

// Get is one file: its status and body. fresh skips the copy kept.
func (g *GlobalData) Get(name string, fresh bool) (int, []byte, error) {
	if g.url == "" {
		return http.StatusNotFound, nil, nil
	}
	if !globalName.MatchString(name) {
		return http.StatusBadRequest, nil, nil
	}
	ttl := TTLParts
	if name == "manifest.json" {
		ttl = TTLManifest
	}
	g.mu.Lock()
	f, ok := g.files[name]
	g.mu.Unlock()
	if ok && !fresh && g.now().Sub(f.at) < ttl {
		return f.status, f.body, nil
	}
	res, err := g.http.Get(g.url + "/data/global/" + name)
	if err != nil {
		return 0, nil, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, globalFileMax+1))
	if err != nil {
		return 0, nil, err
	}
	if len(body) > globalFileMax {
		return 0, nil, fmt.Errorf("%s: over %d bytes", name, globalFileMax)
	}
	if res.StatusCode != http.StatusOK && res.StatusCode != http.StatusNotFound {
		return 0, nil, fmt.Errorf("%s: %s", name, res.Status)
	}
	f = globalFile{status: res.StatusCode, body: body, at: g.now()}
	g.mu.Lock()
	g.files[name] = f
	g.mu.Unlock()
	return f.status, f.body, nil
}
