package stats

import (
	"io"
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

// DefaultArtURL is where a Tsum's portrait lives, with %s its id (IMAGE_URL in
// ui/src/lib/util.js). That origin sends no CORS headers, so the page cannot
// read the files to put them in a copied card's picture; Art fetches them for
// it, same origin, at /api/stats/art/{id}.
const DefaultArtURL = "https://tsum-assets.gapscripts.app/tsums/block_%s_l.png"

// artID is what a Tsum id looks like; anything else is refused before a fetch.
var artID = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,64}$`)

// artKeep is how many portraits Art keeps in memory: more than there are Tsums.
const artKeep = 1024

// Art fetches Tsum portraits for the page and keeps the ones it has fetched.
type Art struct {
	URL    string // with %s for the id
	Client *http.Client

	mu   sync.Mutex
	kept map[string][]byte
}

// NewArt returns an Art for DefaultArtURL.
func NewArt() *Art {
	return &Art{URL: DefaultArtURL, Client: &http.Client{Timeout: 15 * time.Second}}
}

// Serve writes the portrait of Tsum id as a PNG, 404 when there is none.
func (a *Art) Serve(w http.ResponseWriter, id string) {
	if !artID.MatchString(id) {
		http.Error(w, "not a Tsum id", http.StatusBadRequest)
		return
	}
	a.mu.Lock()
	b, ok := a.kept[id]
	a.mu.Unlock()
	if !ok {
		var status int
		if b, status = a.fetch(id); b == nil {
			http.Error(w, http.StatusText(status), status)
			return
		}
		a.mu.Lock()
		if a.kept == nil || len(a.kept) >= artKeep {
			a.kept = map[string][]byte{}
		}
		a.kept[id] = b
		a.mu.Unlock()
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	w.Write(b)
}

// fetch gets the portrait, or nil and the status to answer with.
func (a *Art) fetch(id string) ([]byte, int) {
	res, err := a.Client.Get(strings.Replace(a.URL, "%s", id, 1))
	if err != nil {
		return nil, http.StatusBadGateway
	}
	defer res.Body.Close()
	if res.StatusCode == http.StatusNotFound {
		return nil, http.StatusNotFound
	}
	if res.StatusCode != http.StatusOK {
		return nil, http.StatusBadGateway
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if err != nil {
		return nil, http.StatusBadGateway
	}
	return b, http.StatusOK
}
