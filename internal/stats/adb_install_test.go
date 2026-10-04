package stats

import (
	"archive/zip"
	"os"
	"path/filepath"
	"testing"
)

func TestUnzipRejectsEscape(t *testing.T) {
	zp := filepath.Join(t.TempDir(), "x.zip")
	f, _ := os.Create(zp)
	zw := zip.NewWriter(f)
	w, _ := zw.Create("../evil")
	_, _ = w.Write([]byte("x"))
	zw.Close()
	f.Close()
	if err := unzip(zp, t.TempDir()); err == nil {
		t.Fatal("expected an error for a path outside the destination")
	}
}
