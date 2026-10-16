package stats

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestArtFetchesOnceAndRefusesOddIDs(t *testing.T) {
	var hits atomic.Int32
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		if r.URL.Path != "/block_rapunzelplus_l.png" {
			http.NotFound(w, r)
			return
		}
		w.Write([]byte("png bytes"))
	}))
	defer origin.Close()
	a := NewArt()
	a.URL = origin.URL + "/block_%s_l.png"

	for range 2 {
		w := httptest.NewRecorder()
		a.Serve(w, "rapunzelplus")
		if w.Code != http.StatusOK || w.Body.String() != "png bytes" || w.Header().Get("Content-Type") != "image/png" {
			t.Fatalf("got %d %q %q", w.Code, w.Body.String(), w.Header().Get("Content-Type"))
		}
	}
	if n := hits.Load(); n != 1 {
		t.Errorf("the second ask should come from memory, the origin saw %d", n)
	}

	w := httptest.NewRecorder()
	a.Serve(w, "nobody")
	if w.Code != http.StatusNotFound {
		t.Errorf("a missing portrait: got %d, want 404", w.Code)
	}
	for _, id := range []string{"", "../etc", "a/b", "x?y=1"} {
		w := httptest.NewRecorder()
		a.Serve(w, id)
		if w.Code != http.StatusBadRequest {
			t.Errorf("id %q: got %d, want 400", id, w.Code)
		}
	}
	if n := hits.Load(); n != 2 {
		t.Errorf("refused ids should not reach the origin, it saw %d asks", n)
	}
}
