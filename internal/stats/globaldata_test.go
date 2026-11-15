package stats

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestGlobalDataKeepsAndPassesOn(t *testing.T) {
	hits := map[string]int{}
	site := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits[r.URL.Path]++
		switch r.URL.Path {
		case "/data/global/manifest.json":
			_, _ = w.Write([]byte(`{"parts":[]}`))
		case "/data/global/days/2026-10-01.json":
			_, _ = w.Write([]byte(`{"format":5}`))
		case "/data/global/broken.json":
			w.WriteHeader(http.StatusInternalServerError)
		default:
			http.NotFound(w, r)
		}
	}))
	defer site.Close()
	clock := time.Date(2026, 11, 15, 0, 0, 0, 0, time.UTC)
	g := NewGlobalData(site.URL)
	g.now = func() time.Time { return clock }

	get := func(name string, fresh bool) (int, string) {
		t.Helper()
		status, body, err := g.Get(name, fresh)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		return status, string(body)
	}
	if s, b := get("manifest.json", false); s != 200 || b != `{"parts":[]}` {
		t.Fatalf("manifest: %d %q", s, b)
	}
	get("manifest.json", false)
	if hits["/data/global/manifest.json"] != 1 {
		t.Fatalf("the manifest was not kept: %v", hits)
	}
	get("manifest.json", true)
	clock = clock.Add(TTLManifest + time.Second)
	get("manifest.json", false)
	if hits["/data/global/manifest.json"] != 3 {
		t.Fatalf("fresh and an old copy should read again: %v", hits)
	}
	if s, _ := get("days/2026-10-01.json", false); s != 200 {
		t.Fatalf("part: %d", s)
	}
	if s, _ := get("days/gone.json", false); s != 404 {
		t.Fatalf("a missing part should pass on its 404, got %d", s)
	}
	if _, _, err := g.Get("broken.json", false); err == nil {
		t.Fatal("a server error should be one")
	}
	for _, bad := range []string{"../secret", "a/../b", "", "/abs", "a//b"} {
		if s, _ := get(bad, false); s != 400 {
			t.Fatalf("%q: %d", bad, s)
		}
	}
	if s, _, _ := NewGlobalData("").Get("manifest.json", false); s != 404 {
		t.Fatalf("contributing off: %d", s)
	}
}
