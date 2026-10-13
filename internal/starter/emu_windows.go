package starter

// Windows: the emulator families watch mode can restart, and the helpers they share.

import (
	"context"
	"encoding/base64"
	"encoding/binary"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unicode/utf16"
)

func hostEmulators() []Emulator {
	return []Emulator{&mumuEmu{}, &ldEmu{}, &bs5Emu{}}
}

// powershell runs a script passed as -EncodedCommand (UTF-16LE base64), which
// sidesteps every quoting rule between Go, CreateProcess and PowerShell.
func powershell(ctx context.Context, timeout time.Duration, script string) (string, error) {
	u := utf16.Encode([]rune(script))
	b := make([]byte, 2*len(u))
	for i, c := range u {
		binary.LittleEndian.PutUint16(b[2*i:], c)
	}
	return runCmd(ctx, timeout, "powershell", "-NoProfile", "-NonInteractive", "-EncodedCommand", base64.StdEncoding.EncodeToString(b))
}

// winProcs lists the running processes with one of these image names.
func winProcs(ctx context.Context, names ...string) []winProc {
	var filter []string
	for _, n := range names {
		filter = append(filter, "Name='"+n+"'")
	}
	out, err := powershell(ctx, 20*time.Second, `Get-CimInstance Win32_Process -Filter "`+strings.Join(filter, " OR ")+
		`" | Select-Object ProcessId,ExecutablePath,CommandLine | ConvertTo-Json -Compress`)
	if err != nil {
		return nil
	}
	return parseWinProcs([]byte(out))
}

// findTool is the first of: the env override, a usual install path, or the
// file beside (or near) a running process of the emulator.
func findTool(env string, usual []string, procs []string, near []string) string {
	if p := os.Getenv(env); p != "" && isExec(p) {
		return p
	}
	for _, p := range usual {
		if p != "" && isExec(p) {
			return p
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	for _, pr := range winProcs(ctx, procs...) {
		if pr.Path == "" {
			continue
		}
		for _, rel := range near {
			if p := filepath.Join(filepath.Dir(pr.Path), rel); isExec(p) {
				return p
			}
		}
	}
	return ""
}

// programDirs are the folders emulators install under.
func programDirs() []string {
	return []string{os.Getenv("ProgramFiles"), os.Getenv("ProgramFiles(x86)"), `C:\Program Files`, `D:\Program Files`}
}
