package starter

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Options are the answers the terminal menu used to ask for.
type Options struct {
	APK     string `json:"apk"`     // install: a file in apk/; "" takes the one built for the device
	Confirm bool   `json:"confirm"` // delete-*: the page showed the list and the user agreed
}

// Result is an action's verdict, shown under its log.
type Result struct {
	OK   bool   `json:"ok"`
	Msg  string `json:"msg"`
	Path string `json:"path,omitempty"` // a folder on this computer the page can open
	// The program is about to restart into a new version; the page waits for it.
	Restart bool `json:"restart,omitempty"`
}

// What the file actions match. Rotated script logs are script.1.log and on.
var fileKinds = map[string]struct{ glob, what string }{
	"script": {"script*.log", "script log"},
	"stats":  {"stats_*.csv", "round stats"},
	"lists":  {"tsum_list_*.csv", "Tsum lists"},
}

// Run does one action on one device, streaming commentary through logf. Every
// action but follow holds the device, so a refresh cannot push the device
// script while an action is running it.
func (s *Starter) Run(ctx context.Context, serial, action string, opt Options, logf func(string)) Result {
	if action != "follow" {
		lock := s.deviceLock(serial)
		lock.Lock()
		defer lock.Unlock()
	}
	switch action {
	case "reconnect":
		logf("reconnecting " + serial + " ...")
		_, _ = s.run(ctx, 10*time.Second, "disconnect", serial)
		out, _ := s.run(ctx, 15*time.Second, "connect", serial)
		logLines(logf, out)
		return Result{OK: true, Msg: "Reconnect attempted. Refresh to see the result."}
	case "start", "restart":
		return s.start(ctx, serial, action == "restart", logf)
	case "stop":
		logf("stopping the service on " + serial + " ...")
		out := s.invokeVerb(ctx, serial, "stop")
		if kv(out, "proto") != protoWant {
			return protoMismatch(out)
		}
		// A root-started service survives the kill; the device script says why.
		if kv(out, "running") == "1" {
			msg := explain(out)
			if msg == "" {
				msg = "The service is still running."
			}
			return Result{Msg: msg}
		}
		return Result{OK: true, Msg: "Service stopped."}
	case "log":
		out := s.invokeVerb(ctx, serial, "log")
		for _, l := range strings.Split(extractLog(out), "\n") {
			logf(l)
		}
		return Result{OK: true, Msg: "Service log from " + stageDir + "/service.log"}
	case "follow":
		return s.follow(ctx, serial, logf)
	case "install":
		return s.install(ctx, serial, opt.APK, logf)
	case "update":
		return s.update(ctx, serial, logf)
	case "add-source":
		if s.installedVersion(ctx, serial) == "" {
			return Result{Msg: "GAP is not installed on " + serial + ". Install it first; that adds the library too."}
		}
		return s.offerSource(ctx, serial, logf)
	case "copy-script":
		return s.copyFiles(ctx, serial, "script", logf)
	case "import-stats":
		return s.importStats(ctx, serial, logf)
	case "delete-script", "delete-stats":
		return s.deleteKind(ctx, serial, strings.TrimPrefix(action, "delete-"), opt.Confirm, logf)
	}
	return Result{Msg: "unknown action: " + action}
}

func protoMismatch(out string) Result {
	got := kv(out, "proto")
	if got == "" {
		got = "none"
	}
	return Result{Msg: fmt.Sprintf("The device script speaks protocol %q, this tool speaks %s. The bundle is inconsistent -- extract it again.", got, protoWant)}
}

// explain turns a reply's err into English; "" when there is none.
func explain(out string) string {
	switch err := kv(out, "err"); err {
	case "":
		return ""
	case "not-installed":
		return "General Automation Platform is not installed on this device."
	case "no-libs":
		if libs := strings.TrimSpace(kv(out, "libs_present")); libs != "" {
			return fmt.Sprintf("The installed APK carries %s only, and this device runs %s.\nInstall a build for %s.", libs, kv(out, "device_abi"), kv(out, "device_abi"))
		}
		return fmt.Sprintf("The installed APK has no extracted native libraries.\nIt must be built for %s with extractNativeLibs=true.", kv(out, "device_abi"))
	case "push-failed":
		return "Could not push the helper script to the device.\nIs /data/local/tmp writable? Try reconnecting."
	default:
		if msg := kv(out, "msg"); msg != "" {
			return msg
		}
		return "Failed: " + err
	}
}

func (s *Starter) start(ctx context.Context, serial string, force bool, logf func(string)) Result {
	verb := []string{"start"}
	if force {
		verb = append(verb, "--force")
	}
	logf("starting the service on " + serial + " ...")
	out := s.invokeVerb(ctx, serial, verb...)
	if kv(out, "proto") != protoWant {
		return protoMismatch(out)
	}
	if abi := kv(out, "abi"); abi != "" {
		logf(fmt.Sprintf("  abi    : %s (%s)", abi, kv(out, "loader")))
	}
	if lib := kv(out, "libdir"); lib != "" {
		logf("  libs   : " + lib)
	}
	steps := kvAll(out, "step")
	for _, st := range steps {
		logf("  step   : " + st)
	}
	if body := extractLog(out); body != "" {
		logf("  --- service log ---")
		logLines(logf, body)
	}
	// rc too: running=1 is also what a refused restart says of the service it could not replace.
	if kv(out, "rc") == "0" && kv(out, "running") == "1" {
		if len(steps) > 0 && steps[len(steps)-1] == "already-running" {
			return Result{OK: true, Msg: "Service was already running from this build - left alone.\nUse Restart to force it."}
		}
		return Result{OK: true, Msg: "Service is running.\nIt survives an app reinstall, and stays up until the device reboots."}
	}
	msg := explain(out)
	// The one failure the bundle can fix by itself.
	if e := kv(out, "err"); e == "not-installed" || e == "no-libs" {
		dabi := kv(out, "device_abi")
		switch {
		case s.hasExactAPK(dabi):
			msg += "\n\nAn APK for " + dabi + " is in this bundle - use Install APK."
		case e == "no-libs":
			msg += "\n\nThis bundle carries no " + dabi + "-only APK - use Download latest APK to fetch one."
		case len(s.bundledAPKs(dabi)) > 0:
			msg += "\n\nAn APK is in this bundle - use Install APK."
		}
	}
	if msg == "" {
		msg = "The service failed to start. See the log."
	}
	return Result{Msg: msg}
}

// follow streams the service log until the page stops it (the request ends).
func (s *Starter) follow(ctx context.Context, serial string, logf func(string)) Result {
	logf("following " + stageDir + "/service.log on " + serial + " -- Stop following ends it")
	cmd := exec.CommandContext(ctx, s.adb(), "-s", serial, "shell", "tail -n 200 -f "+stageDir+"/service.log")
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return Result{Msg: err.Error()}
	}
	cmd.Stderr = cmd.Stdout
	if err := cmd.Start(); err != nil {
		return Result{Msg: err.Error()}
	}
	sc := bufio.NewScanner(stdout)
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	for sc.Scan() {
		logf(strings.TrimRight(sc.Text(), "\r"))
	}
	_ = cmd.Wait()
	return Result{OK: true, Msg: "Stopped following the service log."}
}

func (s *Starter) install(ctx context.Context, serial, name string, logf func(string)) Result {
	abi := kv(s.invokeVerb(ctx, serial, "probe"), "device_abi")
	apks := s.bundledAPKs(abi)
	if len(apks) == 0 {
		return Result{Msg: "No APK in the bundle.\nPut one in the apk/ folder next to Start, then try again."}
	}
	if name == "" {
		// A failed probe has no ABI, and guessing would install whatever sorts first.
		if abi == "" || !apks[0].Default {
			return Result{Msg: "Could not read the device's ABI, so no APK was chosen.\nThe device may have gone offline -- Refresh and try again, or choose an APK."}
		}
		name = apks[0].Name
	}
	if filepath.Base(name) != name || !strings.HasSuffix(name, ".apk") {
		return Result{Msg: "Not an APK in the bundle: " + name}
	}
	path := filepath.Join(s.bundle, "apk", name)
	if !isExec(path) {
		return Result{Msg: "Not an APK in the bundle: " + name}
	}
	logf("installing " + name + " on " + serial + " ...")
	if s.installAPK(ctx, serial, path, logf) {
		return Result{OK: true, Msg: "Installed " + name + ".\n" + s.offerSource(ctx, serial, logf).Msg}
	}
	return Result{Msg: "Install failed. See the log."}
}

func (s *Starter) update(ctx context.Context, serial string, logf func(string)) Result {
	logf("checking for a newer APK ...")
	base := s.releaseBase()
	if base != defaultReleaseBase {
		logf("  channel: " + base)
	}
	man, err := s.fetchManifest(ctx)
	if err != nil {
		return Result{Msg: "Could not reach the release page.\nCheck the internet connection. Install APK still works offline from the bundle."}
	}
	ver := kv(man, "version")
	if ver == "" {
		return Result{Msg: "The release manifest is unreadable. Try again later."}
	}
	probe := s.invokeVerb(ctx, serial, "probe")
	abi := kv(probe, "device_abi")
	if abi == "" {
		return Result{Msg: "Could not read the device's ABI, so no APK was chosen.\nThe device may have gone offline -- Refresh and try again."}
	}
	name, want := kv(man, "apk_"+abi), kv(man, "sha256_"+abi)
	if name == "" {
		name, want = kv(man, "apk_universal"), kv(man, "sha256_universal")
	}
	if name == "" || filepath.Base(name) != name {
		return Result{Msg: "The latest release publishes no APK for " + abi + "."}
	}
	// A wrong-ABI install has the same version as the APK that fixes it.
	have := s.installedVersion(ctx, serial)
	if have != "" && have == ver && kv(probe, "err") != "no-libs" {
		return Result{OK: true, Msg: "Already on " + ver + " -- nothing to download."}
	}
	_ = os.MkdirAll(filepath.Join(s.bundle, "apk"), 0o755)
	dest := filepath.Join(s.bundle, "apk", name)
	chanName := kv(man, "channel")
	label := ver
	if chanName != "" {
		label += ", " + chanName
	}
	logf("downloading " + name + " (" + label + ") ...")
	got, err := fetchFile(base+"/"+name, dest)
	if err != nil {
		return Result{Msg: "Could not download " + name + "."}
	}
	if want != "" {
		if got != want {
			os.Remove(dest)
			return Result{Msg: name + " did not match its published checksum and was deleted.\nNothing was installed."}
		}
		logf("  sha256 ok")
	}
	logf("installing " + name + " on " + serial + " ...")
	if !s.installAPK(ctx, serial, dest, logf) {
		return Result{Msg: "Install failed. See the log."}
	}
	msg := "Updated to " + ver
	if chanName != "" {
		msg += " (" + chanName + ")"
	}
	if have != "" {
		msg += " (was " + have + ")"
	}
	return Result{OK: true, Msg: msg + ".\n" + s.offerSource(ctx, serial, logf).Msg}
}

// collectedDir is where files copied off a device land: collected/<serial>/,
// keeping the device's layout so two scripts' files cannot collide.
func (s *Starter) collectedDir(serial string) string {
	return filepath.Join(s.bundle, "collected", safeName(serial))
}

func (s *Starter) copyFiles(ctx context.Context, serial, kind string, logf func(string)) Result {
	k := fileKinds[kind]
	logf("looking for " + k.glob + " under " + s.storage + " ...")
	files := s.deviceFiles(ctx, serial, k.glob)
	if len(files) == 0 {
		return s.nothingFound(k.what, k.glob)
	}
	dest := s.collectedDir(serial)
	n, bad := 0, 0
	for _, f := range files {
		rel := s.relToStorage(f)
		if rel == "" {
			continue
		}
		if s.pullFile(ctx, serial, f, filepath.Join(dest, filepath.FromSlash(rel))) {
			n++
			logf("  " + rel)
		} else {
			bad++
			logf("  FAILED " + rel)
		}
	}
	if n == 0 {
		return Result{Msg: fmt.Sprintf("Found %d file(s) but could not copy any. See the log.", len(files))}
	}
	msg := fmt.Sprintf("Copied %d file(s) into\n%s", n, dest)
	if bad > 0 {
		msg += fmt.Sprintf("\n%d could not be copied -- see the log.", bad)
	}
	return Result{OK: true, Msg: msg, Path: dest}
}

func (s *Starter) nothingFound(what, glob string) Result {
	return Result{Msg: fmt.Sprintf("No %s on this device.\nNothing matched %s under %s.\nA service started with --root= needs GAP_STORAGE_ROOT set to the same folder.", what, glob, s.storage)}
}

// importStats copies the round stats and Tsum lists into collected/ and
// imports them into Stats, through the stats site's own device import.
func (s *Starter) importStats(ctx context.Context, serial string, logf func(string)) Result {
	if s.importer == nil {
		return Result{Msg: "Stats importing is not available."}
	}
	logf("copying stats_*.csv and tsum_list_*.csv under " + s.storage + " ...")
	r := s.importer(ctx, serial)
	for _, e := range r.Errors {
		logf("  " + e)
	}
	if r.Err != "" {
		return Result{Msg: r.Err}
	}
	return Result{OK: true, Path: s.collectedDir(serial),
		Msg: fmt.Sprintf("Copied %d file(s); %d new round(s) and %d Tsum list(s) imported into Stats.", r.Copied, r.Rounds, r.Lists)}
}

// deleteKind removes a kind of file from the device after the page confirmed
// the list. Deleting the script log stops the service around the delete: it
// holds script.log open, and an emulator whose storage is a host folder cannot
// unlink an open file. It is started again only if it was running.
func (s *Starter) deleteKind(ctx context.Context, serial, kind string, confirmed bool, logf func(string)) Result {
	k, ok := fileKinds[kind]
	if !ok || kind == "lists" {
		return Result{Msg: "unknown files: " + kind}
	}
	logf("looking for " + k.glob + " under " + s.storage + " ...")
	files := s.deviceFiles(ctx, serial, k.glob)
	if len(files) == 0 {
		return s.nothingFound(k.what, k.glob)
	}
	for _, f := range files {
		logf("  " + strings.TrimPrefix(f, s.storage+"/"))
	}
	if !confirmed {
		return Result{Msg: "Nothing was deleted: the delete was not confirmed."}
	}
	wasRunning := false
	if kind == "script" {
		logf("The service holds script.log open, so it is stopped for the delete and started again afterwards.")
		logf("stopping the service on " + serial + " ...")
		out := s.invokeVerb(ctx, serial, "stop")
		if kv(out, "proto") == protoWant {
			wasRunning = kv(out, "step") == "kill"
			if kv(out, "running") == "1" {
				logf("the service did not stop; files it holds open may survive the delete")
			}
		}
	}
	s.deleteFiles(ctx, serial, files)
	// Counted before the restart, which writes a fresh script.log.
	left := len(s.deviceFiles(ctx, serial, k.glob))
	gone := len(files) - left
	note := ""
	if wasRunning {
		logf("starting the service on " + serial + " ...")
		if kv(s.invokeVerb(ctx, serial, "start"), "running") == "1" {
			note = "\nThe service was stopped for the delete and is running again,\nso a new script.log is already on the device."
		} else {
			note = "\nThe service was stopped for the delete and did not come back --\nuse Start service, then Show service log if it still will not."
		}
	}
	switch {
	case left == 0:
		return Result{OK: true, Msg: fmt.Sprintf("Deleted %d file(s) from %s.%s", gone, serial, note)}
	case gone > 0:
		return Result{OK: true, Msg: fmt.Sprintf("Deleted %d file(s); %d could not be removed.\nA file the running script still holds open is the usual reason.%s", gone, left, note)}
	}
	return Result{Msg: "Nothing could be deleted. Is the storage writable?" + note}
}
