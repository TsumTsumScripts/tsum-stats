package stats

// The preset gallery from this computer (CONTRACT §2.7, §7.3): the global site
// takes presets only with a contributor key, and the key lives here, so the
// page's Submit and "my presets" go through these calls. Nothing is kept
// locally; every answer is the site's.

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"time"
)

// ErrNotJoined is a gallery call before this computer joined the global stats.
var ErrNotJoined = errors.New("join the global stats first: only contributors can share presets")

// PresetSubmit is what the page sends: one share code, as the site takes it.
type PresetSubmit struct {
	Code        string `json:"code"`
	Name        string `json:"name,omitempty"`
	Description string `json:"description,omitempty"`
	Tsum        string `json:"tsum,omitempty"`
}

// gallerySite is the site with this computer's key, or ErrNotJoined.
func (c *Contributor) gallerySite() (*GlobalSite, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.url == "" || !c.joined() {
		return nil, ErrNotJoined
	}
	return c.site(c.saved.Key), nil
}

func (c *Contributor) galleryCall(method, endpoint string, body, out any) error {
	site, err := c.gallerySite()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	return site.do(ctx, method, endpoint, body, out)
}

// SubmitPreset sends one preset to the gallery; the site's id back.
func (c *Contributor) SubmitPreset(p PresetSubmit) (int64, error) {
	var r struct {
		ID int64 `json:"id"`
	}
	err := c.galleryCall(http.MethodPost, "/api/v1/presets", p, &r)
	return r.ID, err
}

// MyPresets is the site's list of this contributor's presets, as it sent it.
func (c *Contributor) MyPresets() (json.RawMessage, error) {
	var r struct {
		Presets json.RawMessage `json:"presets"`
	}
	err := c.galleryCall(http.MethodGet, "/api/v1/presets/mine", nil, &r)
	return r.Presets, err
}

// DeletePreset removes one of this contributor's presets from the gallery.
func (c *Contributor) DeletePreset(id int64) error {
	return c.galleryCall(http.MethodPost, "/api/v1/presets/delete", map[string]int64{"id": id}, nil)
}

// galleryError is a refusal as the page shows it: the site's code when it
// gave one (the page words it), else the error's text.
func galleryError(err error) (int, map[string]string) {
	var ge *GlobalError
	switch {
	case errors.As(err, &ge):
		return http.StatusBadRequest, map[string]string{"code": ge.Code}
	case errors.Is(err, ErrGlobalKey):
		return http.StatusBadRequest, map[string]string{"code": "unauthorized"}
	case errors.Is(err, ErrNotJoined):
		return http.StatusBadRequest, map[string]string{"code": "not-joined", "message": err.Error()}
	}
	return http.StatusBadGateway, map[string]string{"code": "unreachable", "message": err.Error()}
}
