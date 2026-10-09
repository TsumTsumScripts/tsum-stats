package main

import (
	"encoding/json"
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

// openWhenUp opens url in the default browser once the site at base answers.
func openWhenUp(base, url string) {
	for i := 0; i < 60 && !alreadyRunning(base); i++ {
		time.Sleep(500 * time.Millisecond)
	}
	openBrowser(url)
}

func openBrowser(url string) {
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

// alreadyRunning reports whether Tsum Tsum Stats already answers at url, so a
// second launch can just open the site.
func alreadyRunning(url string) bool {
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(url + "/api/health")
	if err != nil {
		return false
	}
	resp.Body.Close()
	return resp.StatusCode == http.StatusOK
}

// starterRunning reports whether the site at url also serves the starter.
func starterRunning(url string) bool {
	client := &http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(url + "/api/starter/status")
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	// An older tsum-stats answers any path with its page, so read the reply.
	var st struct{ Bundle string }
	return resp.StatusCode == http.StatusOK && json.NewDecoder(resp.Body).Decode(&st) == nil && st.Bundle != ""
}
