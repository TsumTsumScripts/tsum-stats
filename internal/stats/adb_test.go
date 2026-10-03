package stats

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

// A fake adb: `shell` lists two files (and noise), `pull -a REMOTE LOCAL`
// copies $FAKE_CSV, keeping its mtime as -a does.
const fakeADB = `#!/bin/sh
case "$3" in
  shell) printf '/sdcard/Download/GameAutomationPlatform/tsum/tsum_record/stats_20260904.csv\r\n/sdcard/other/stats_20260905.csv\r\nfind: denied\r\n' ;;
  pull)  cp -p "$FAKE_CSV" "$6" ;;
esac
`

func TestPullImportsDeviceFiles(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("the fake adb is a shell script")
	}
	dir := t.TempDir()
	adb := filepath.Join(dir, "adb")
	csv := filepath.Join(dir, "src.csv")
	_ = os.WriteFile(adb, []byte(fakeADB), 0o755)
	_ = os.WriteFile(csv, []byte(statsCSV), 0o644)
	t.Setenv("FAKE_CSV", csv)

	app := testApp(t)
	dest := filepath.Join(dir, "collected")
	p := NewPuller(adb, "", dest, NewImporter(app, []string{dest}, nil))

	res, err := p.Pull(context.Background(), []string{"127.0.0.1:16384"})
	if err != nil {
		t.Fatal(err)
	}
	r := res[0]
	if r.Found != 1 || r.Copied != 1 || r.Result.Rounds != 2 || r.Error != "" {
		t.Fatalf("first pull: %+v", r)
	}
	if _, err := os.Stat(filepath.Join(dest, "127.0.0.1_16384", "tsum", "tsum_record", "stats_20260904.csv")); err != nil {
		t.Fatal("the device layout should be kept under collected/<serial>/")
	}
	// The same file again is recognised, not re-read.
	res, _ = p.Pull(context.Background(), []string{"127.0.0.1:16384"})
	if res[0].Result.Unchanged != 1 || res[0].Result.Rounds != 0 {
		t.Fatalf("second pull: %+v", res[0])
	}
}
