package starter

// BlueStacks 5 (and the MSI App Player built on it). The ports come from
// bluestacks.conf; an instance is its HD-Player.exe --instance <Name> process.
// Verify on device: the paths, and that killing HD-Player then relaunching it
// with --instance brings that instance back.

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

type bs5Emu struct{ conf, player string }

func (*bs5Emu) Host() string  { return "bluestacks" }
func (*bs5Emu) Label() string { return "BlueStacks 5" }

func (*bs5Emu) Find() Emulator {
	var confs, players []string
	for _, dir := range []string{"BlueStacks_nxt", "BlueStacks_msi5"} {
		confs = append(confs, filepath.Join(os.Getenv("ProgramData"), dir, "bluestacks.conf"))
		for _, root := range programDirs() {
			if root != "" {
				players = append(players, filepath.Join(root, dir, "HD-Player.exe"))
			}
		}
	}
	conf := findTool("GAP_BLUESTACKS_CONF", confs, nil, nil)
	player := findTool("GAP_BLUESTACKS_PLAYER", players, []string{"HD-Player.exe"}, []string{"HD-Player.exe"})
	if conf == "" || player == "" {
		return nil
	}
	return &bs5Emu{conf: conf, player: player}
}

func (b *bs5Emu) Instances(ctx context.Context) ([]EmuInstance, error) {
	conf, err := os.ReadFile(b.conf)
	if err != nil {
		return nil, err
	}
	list := parseBlueStacksConf(string(conf))
	running := b.running(ctx, list)
	for i := range list {
		list[i].Running = len(running[list[i].ID]) > 0
	}
	return list, nil
}

// running maps each instance to its HD-Player processes. A process naming no
// instance is counted only when the conf has a single instance it can be.
func (b *bs5Emu) running(ctx context.Context, list []EmuInstance) map[string][]int {
	out := map[string][]int{}
	for _, p := range winProcs(ctx, "HD-Player.exe") {
		name := bsInstanceOf(p.Cmdline)
		if name == "" && len(list) == 1 {
			name = list[0].ID
		}
		if name != "" {
			out[name] = append(out[name], p.PID)
		}
	}
	return out
}

func (b *bs5Emu) Restart(ctx context.Context, in EmuInstance, logf func(string)) error {
	list, err := b.Instances(ctx)
	if err != nil {
		return err
	}
	for _, pid := range b.running(ctx, list)[in.ID] {
		logf("taskkill /PID " + strconv.Itoa(pid) + " /T /F (HD-Player " + in.ID + ")")
		out, _ := runCmd(ctx, 30*time.Second, "taskkill", "/PID", strconv.Itoa(pid), "/T", "/F")
		logLines(logf, out)
	}
	if !waitStopped(ctx, b, in.ID, 30*time.Second) {
		return fmt.Errorf("BlueStacks instance %s did not close", in.ID)
	}
	logf("HD-Player.exe --instance " + in.ID)
	return startDetached(b.player, "--instance", in.ID)
}
