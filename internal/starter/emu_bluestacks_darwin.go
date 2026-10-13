package starter

// BlueStacks Air on macOS: one instance, adb on 5555. The least certain back
// end. Verify on device: the app's path, its process name and that quitting
// and reopening it brings Android back.

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"time"
)

func hostEmulators() []Emulator {
	return []Emulator{&bsAirEmu{}}
}

type bsAirEmu struct{ app string }

func (*bsAirEmu) Host() string  { return "bluestacks" }
func (*bsAirEmu) Label() string { return "BlueStacks Air" }

func (*bsAirEmu) Find() Emulator {
	home, _ := os.UserHomeDir()
	for _, p := range []string{os.Getenv("GAP_BLUESTACKS_APP"), "/Applications/BlueStacks.app", filepath.Join(home, "Applications", "BlueStacks.app")} {
		if st, err := os.Stat(p); p != "" && err == nil && st.IsDir() {
			return &bsAirEmu{app: p}
		}
	}
	return nil
}

// bsAirProc is the app's process name for pgrep and pkill. Verify on device.
const bsAirProc = "BlueStacks"

func bsAirRunning(ctx context.Context) bool {
	_, err := runCmd(ctx, 5*time.Second, "pgrep", "-x", bsAirProc)
	return err == nil
}

func (b *bsAirEmu) Instances(ctx context.Context) ([]EmuInstance, error) {
	return []EmuInstance{{ID: "BlueStacks", Name: "BlueStacks Air", Port: 5555, Running: bsAirRunning(ctx)}}, nil
}

// Restart asks the app to quit, kills it after 15 s, then opens it again.
func (b *bsAirEmu) Restart(ctx context.Context, in EmuInstance, logf func(string)) error {
	logf(`osascript -e 'quit app "BlueStacks"'`)
	_, _ = runCmd(ctx, 20*time.Second, "osascript", "-e", `quit app "BlueStacks"`)
	if !waitStopped(ctx, b, in.ID, 15*time.Second) {
		logf("pkill -x " + bsAirProc)
		_, _ = runCmd(ctx, 5*time.Second, "pkill", "-x", bsAirProc)
		if !waitStopped(ctx, b, in.ID, 10*time.Second) {
			logf("pkill -9 -x " + bsAirProc)
			_, _ = runCmd(ctx, 5*time.Second, "pkill", "-9", "-x", bsAirProc)
			if !waitStopped(ctx, b, in.ID, 10*time.Second) {
				return errors.New("BlueStacks Air did not quit")
			}
		}
	}
	logf("open -a " + b.app)
	out, err := runCmd(ctx, 30*time.Second, "open", "-a", b.app)
	logLines(logf, out)
	return err
}
