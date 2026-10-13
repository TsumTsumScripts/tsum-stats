package starter

// LDPlayer 9 through its ldconsole.exe. Verify on device: the paths and the
// list2 / quit / launch commands were taken from LDPlayer's documentation.

import (
	"context"
	"fmt"
	"path/filepath"
	"time"
)

type ldEmu struct{ exe string }

func (*ldEmu) Host() string  { return "ldplayer" }
func (*ldEmu) Label() string { return "LDPlayer 9" }

func (*ldEmu) Find() Emulator {
	usual := []string{`C:\LDPlayer\LDPlayer9\ldconsole.exe`, `D:\LDPlayer\LDPlayer9\ldconsole.exe`}
	for _, root := range programDirs() {
		if root != "" {
			usual = append(usual, filepath.Join(root, `LDPlayer\LDPlayer9\ldconsole.exe`))
		}
	}
	exe := findTool("GAP_LDCONSOLE", usual, []string{"dnplayer.exe"}, []string{"ldconsole.exe"})
	if exe == "" {
		return nil
	}
	return &ldEmu{exe: exe}
}

func (l *ldEmu) Instances(ctx context.Context) ([]EmuInstance, error) {
	out, err := runCmd(ctx, 30*time.Second, l.exe, "list2")
	if err != nil && out == "" {
		return nil, err
	}
	return parseLDList2(out), nil
}

func (l *ldEmu) Restart(ctx context.Context, in EmuInstance, logf func(string)) error {
	logf("ldconsole quit --index " + in.ID)
	out, _ := runCmd(ctx, 60*time.Second, l.exe, "quit", "--index", in.ID)
	logLines(logf, out)
	if !waitStopped(ctx, l, in.ID, 45*time.Second) {
		return fmt.Errorf("LDPlayer instance %s did not quit", in.ID)
	}
	logf("ldconsole launch --index " + in.ID)
	out, err := runCmd(ctx, 60*time.Second, l.exe, "launch", "--index", in.ID)
	logLines(logf, out)
	return err
}
