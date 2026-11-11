package stats

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// gallery answers the preset routes (CONTRACT §2.7) for the fake Worker. The caller holds the lock.
func (f *fakeWorker) gallery(w http.ResponseWriter, r *http.Request, by int64) {
	if f.presets == nil {
		f.presets, f.presetBy = map[int64]PresetSubmit{}, map[int64]int64{}
	}
	switch {
	case r.URL.Path == "/api/v1/presets" && r.Method == http.MethodPost:
		var p PresetSubmit
		_ = json.NewDecoder(r.Body).Decode(&p)
		if !strings.HasPrefix(p.Code, "TSUM4-") {
			f.reply(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "bad-code"})
			return
		}
		id := int64(len(f.presetBy) + 1) // presetBy keeps deleted ids, so none is reused
		f.presets[id], f.presetBy[id] = p, by
		f.reply(w, http.StatusCreated, map[string]any{"ok": true, "id": id})
	case r.URL.Path == "/api/v1/presets/mine" && r.Method == http.MethodGet:
		list := []map[string]any{}
		for id, p := range f.presets {
			if f.presetBy[id] == by {
				list = append(list, map[string]any{"id": id, "name": p.Name, "code": p.Code})
			}
		}
		f.reply(w, http.StatusOK, map[string]any{"ok": true, "presets": list})
	case r.URL.Path == "/api/v1/presets/delete" && r.Method == http.MethodPost:
		var b struct {
			ID int64 `json:"id"`
		}
		_ = json.NewDecoder(r.Body).Decode(&b)
		if _, ok := f.presets[b.ID]; !ok || f.presetBy[b.ID] != by {
			f.reply(w, http.StatusNotFound, map[string]any{"ok": false, "error": "not-found"})
			return
		}
		delete(f.presets, b.ID)
		f.reply(w, http.StatusOK, map[string]any{"ok": true})
	default:
		f.t.Errorf("unexpected request %s %s", r.Method, r.URL.Path)
	}
}

func TestPresetGallery(t *testing.T) {
	app := testApp(t)
	f := newFakeWorker(t)
	c, _ := testContributor(t, app, f)

	// Only a contributor can share.
	if _, err := c.SubmitPreset(PresetSubmit{Code: "TSUM4-16.QAQg~", Name: "A"}); err != ErrNotJoined {
		t.Fatalf("before joining: %v", err)
	}
	if code, body := galleryError(ErrNotJoined); code != http.StatusBadRequest || body["code"] != "not-joined" {
		t.Fatalf("not joined reads %d %v", code, body)
	}
	if err := c.Join(); err != nil {
		t.Fatal(err)
	}

	id, err := c.SubmitPreset(PresetSubmit{Code: "TSUM4-16.QAQg~", Name: "Coins", Description: "first"})
	if err != nil || id != 1 {
		t.Fatalf("submit: %d %v", id, err)
	}
	// The site's refusal reaches the page as its code.
	_, err = c.SubmitPreset(PresetSubmit{Code: "nope"})
	if code, body := galleryError(err); code != http.StatusBadRequest || body["code"] != "bad-code" {
		t.Fatalf("refusal reads %d %v", code, body)
	}

	raw, err := c.MyPresets()
	var mine []struct {
		ID   int64  `json:"id"`
		Name string `json:"name"`
	}
	if err != nil || json.Unmarshal(raw, &mine) != nil || len(mine) != 1 || mine[0].Name != "Coins" {
		t.Fatalf("mine: %s %v", raw, err)
	}
	if err := c.DeletePreset(1); err != nil {
		t.Fatal(err)
	}
	if err := c.DeletePreset(1); err == nil {
		t.Fatal("deleting a preset twice was accepted")
	}
}
