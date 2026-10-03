package main

import (
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"time"
)

// dataDir is where a launched (double-clicked) Tsum Tsum Stats keeps its database
// unless --dir says otherwise: the user's config folder, so it survives the
// binary being moved or replaced.
func dataDir() string {
	base, err := os.UserConfigDir()
	if err != nil {
		return "pb_data"
	}
	return filepath.Join(base, "TsumTsumStats", "data")
}

// openWhenUp opens the site in the default browser once it answers.
func openWhenUp(url string) {
	for i := 0; i < 60; i++ {
		if resp, err := http.Get(url + "/api/health"); err == nil {
			resp.Body.Close()
			break
		}
		time.Sleep(500 * time.Millisecond)
	}
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", url)
	case "windows":
		cmd = exec.Command("rundll32", "url.dll,FileProtocolHandler", url)
	default:
		cmd = exec.Command("xdg-open", url)
	}
	_ = cmd.Start()
}
