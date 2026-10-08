package starter

import (
	"archive/zip"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

// ExportParts are what an export can carry; the page ticks all of them by default.
var ExportParts = []string{"script", "service", "stats", "lists"}

// ExportRequest is one export: every part, per device, in one zip.
type ExportRequest struct {
	Serials []string `json:"serials"`
	Parts   []string `json:"parts"`
}

// exportName is the zip's suggested file name.
func exportName(serials []string) string {
	who := "devices"
	if len(serials) == 1 {
		who = safeName(serials[0])
	}
	return fmt.Sprintf("tsum-export-%s-%s.zip", who, time.Now().Format("20060102-1504"))
}

// writeExport streams the zip to w: <serial>/<device layout>, the service log,
// and a device.txt that says what the device was and what was not found.
func (s *Starter) writeExport(ctx context.Context, w io.Writer, req ExportRequest) error {
	tmp, err := os.MkdirTemp("", "tsum-export-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(tmp)
	zw := zip.NewWriter(w)
	for _, serial := range req.Serials {
		if err := s.exportDevice(ctx, zw, tmp, serial, req.Parts); err != nil {
			return err
		}
	}
	return zw.Close()
}

func (s *Starter) exportDevice(ctx context.Context, zw *zip.Writer, tmp, serial string, parts []string) error {
	lock := s.deviceLock(serial)
	lock.Lock()
	defer lock.Unlock()
	dir := safeName(serial)
	var notes []string
	add := func(name string, r io.Reader) error {
		f, err := zw.CreateHeader(&zip.FileHeader{Name: dir + "/" + name, Method: zip.Deflate, Modified: time.Now()})
		if err != nil {
			return err
		}
		_, err = io.Copy(f, r)
		return err
	}
	for _, part := range parts {
		if part == "service" {
			body := extractLog(s.invokeVerb(ctx, serial, "log"))
			if body == "" {
				notes = append(notes, "service.log: empty or not found")
				continue
			}
			if err := add("service.log", strings.NewReader(body+"\n")); err != nil {
				return err
			}
			continue
		}
		k, ok := fileKinds[part]
		if !ok {
			continue
		}
		files := s.deviceFiles(ctx, serial, k.glob)
		if len(files) == 0 {
			notes = append(notes, fmt.Sprintf("%s: nothing matched %s", k.what, k.glob))
		}
		for _, remote := range files {
			rel := s.relToStorage(remote)
			if rel == "" {
				continue
			}
			local := filepath.Join(tmp, dir, filepath.FromSlash(rel))
			if !s.pullFile(ctx, serial, remote, local) {
				notes = append(notes, rel+": could not be copied")
				continue
			}
			f, err := os.Open(local)
			if err != nil {
				return err
			}
			err = add(rel, f)
			f.Close()
			if err != nil {
				return err
			}
		}
	}
	s.mu.Lock()
	row := s.rows[serial]
	s.mu.Unlock()
	info := fmt.Sprintf("serial   : %s\nmodel    : %s\nabi      : %s\nservice  : %s\napp      : %s\nexported : %s\nstorage  : %s\n",
		serial, row.Model, row.ABI, row.Service, orDash(s.installedVersion(ctx, serial)), time.Now().Format(time.RFC3339), s.storage)
	if len(notes) > 0 {
		info += "\nnot included:\n  " + strings.Join(notes, "\n  ") + "\n"
	}
	return add("device.txt", strings.NewReader(info))
}

// errNoDialog means this computer has no save dialog the server can show; the
// page falls back to a browser download.
var errNoDialog = errors.New("no save dialog on this computer")

// errCancelled means the user closed the dialog.
var errCancelled = errors.New("cancelled")

// saveDialog asks where to save name, with this computer's own dialog. It is
// only used when the browser has no save picker (Safari, Firefox).
func saveDialog(ctx context.Context, name string) (string, error) {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		script := fmt.Sprintf(`activate
POSIX path of (choose file name with prompt "Save the export as" default name %q default location (path to downloads folder))`, name)
		cmd = exec.CommandContext(ctx, "osascript", "-e", script)
	case "windows":
		// An owner form that is TopMost keeps the dialog in front of the browser.
		ps := fmt.Sprintf(`Add-Type -AssemblyName System.Windows.Forms; $d = New-Object System.Windows.Forms.SaveFileDialog; $d.FileName = '%s'; $d.Filter = 'Zip archive (*.zip)|*.zip'; $d.InitialDirectory = Join-Path $env:USERPROFILE 'Downloads'; $f = New-Object System.Windows.Forms.Form -Property @{TopMost = $true}; if ($d.ShowDialog($f) -eq 'OK') { $d.FileName }`,
			strings.ReplaceAll(name, "'", "''"))
		cmd = exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-STA", "-Command", ps)
	default:
		home, _ := os.UserHomeDir()
		if p, err := exec.LookPath("zenity"); err == nil {
			cmd = exec.CommandContext(ctx, p, "--file-selection", "--save", "--confirm-overwrite", "--title=Save the export as", "--filename="+filepath.Join(home, name))
		} else if p, err := exec.LookPath("kdialog"); err == nil {
			cmd = exec.CommandContext(ctx, p, "--getsavefilename", filepath.Join(home, name), "*.zip")
		} else {
			return "", errNoDialog
		}
	}
	out, err := cmd.Output()
	path := strings.TrimSpace(string(out))
	if errors.Is(err, exec.ErrNotFound) {
		return "", errNoDialog
	}
	if path == "" {
		return "", errCancelled
	}
	if !strings.HasSuffix(strings.ToLower(path), ".zip") {
		path += ".zip"
	}
	return path, nil
}

// openFolder shows a folder in Finder, Explorer or the file manager.
func openFolder(dir string) error {
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		cmd = exec.Command("open", dir)
	case "windows":
		cmd = exec.Command("explorer", dir)
	default:
		cmd = exec.Command("xdg-open", dir)
	}
	return cmd.Start()
}

// revealFile shows a file selected in its folder where the system can.
func revealFile(path string) error {
	switch runtime.GOOS {
	case "darwin":
		return exec.Command("open", "-R", path).Start()
	case "windows":
		return exec.Command("explorer", "/select,", path).Start()
	}
	return openFolder(filepath.Dir(path))
}
