package starter

// MuMu Player 12 through its MuMuManager.exe. Verify on device: the paths and
// the info / control commands were taken from MuMu's documentation.

import (
	"context"
	"fmt"
	"path/filepath"
	"time"
)

type mumuEmu struct{ exe string }

func (*mumuEmu) Host() string  { return "mumu" }
func (*mumuEmu) Label() string { return "MuMu Player 12" }

func (*mumuEmu) Find() Emulator {
	var usual []string
	for _, root := range programDirs() {
		for _, rel := range []string{`Netease\MuMuPlayer-12.0\shell`, `Netease\MuMuPlayerGlobal-12.0\shell`,
			`Netease\MuMu Player 12\shell`, `Netease\MuMuPlayer\nx_main`, `Netease\MuMu\nx_main`} {
			if root != "" {
				usual = append(usual, filepath.Join(root, rel, "MuMuManager.exe"))
			}
		}
	}
	// A running player's folder: shell\ holds MuMuPlayer.exe, nx_main\ MuMuNxMain.exe.
	exe := findTool("GAP_MUMU_MANAGER", usual, []string{"MuMuPlayer.exe", "MuMuNxMain.exe", "MuMuNxDevice.exe"},
		[]string{"MuMuManager.exe", `..\shell\MuMuManager.exe`, `..\nx_main\MuMuManager.exe`})
	if exe == "" {
		return nil
	}
	return &mumuEmu{exe: exe}
}

func (m *mumuEmu) Instances(ctx context.Context) ([]EmuInstance, error) {
	out, err := runCmd(ctx, 30*time.Second, m.exe, "info", "-v", "all")
	if err != nil && out == "" {
		return nil, err
	}
	return parseMuMuInfo([]byte(out))
}

func (m *mumuEmu) Restart(ctx context.Context, in EmuInstance, logf func(string)) error {
	logf("MuMuManager control -v " + in.ID + " shutdown")
	out, _ := runCmd(ctx, 60*time.Second, m.exe, "control", "-v", in.ID, "shutdown")
	logLines(logf, out)
	if !waitStopped(ctx, m, in.ID, 45*time.Second) {
		return fmt.Errorf("MuMu instance %s did not shut down", in.ID)
	}
	logf("MuMuManager control -v " + in.ID + " launch")
	out, err := runCmd(ctx, 60*time.Second, m.exe, "control", "-v", in.ID, "launch")
	logLines(logf, out)
	return err
}
