package starter

// Watch mode keeps GAP running on the devices it is turned on for, for as long
// as this program runs. Every 15 s it runs the device script's `watch` verb on
// each of them (device/PROTOCOL.md), folds the reply into that device's state
// and lets decide() pick at most one action (watchpolicy.go). Its settings are
// <bundle>/watch.json and what it did goes to <bundle>/watch.log.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	watchEvery   = 15 * time.Second
	watchRingCap = 200
	watchLogMax  = 1 << 20 // watch.log is rotated to watch.1.log past this
	emuCacheFor  = time.Minute
	emuFindFor   = 10 * time.Minute
)

const watchHelp = "Watch mode keeps GAP running on the devices turned on under devices, while the starter runs. " +
	"limits: startAfterBootSec = wait after Android starts before starting GAP; startsPerHour = most starts of a stopped GAP; " +
	"aliveStaleSec = GAP not answering this long counts as frozen; forceStartsPerHour = most restarts of a frozen GAP (0 = never); " +
	"adbDeadSec = adb unable to reach the device this long before recovering (adb connect, adb reboot, then the emulator); " +
	"emulatorRestartsPer6h = most emulator restarts in 6 hours (0 = never); emulatorRestartGapMin = minutes between them, doubled after each failure; " +
	"emulatorGiveUpAfter = failed emulator restarts in a row before giving up; requestMaxAgeSec = GAP's restart requests older than this are left to GAP, which restarts by itself; " +
	"bootStuckSec = Android still starting after this long is restarted (the emulator, else adb reboot, once an hour)."

type watchConfig struct {
	Devices map[string]watchDeviceConfig `json:"devices"`
	Limits  WatchLimits                  `json:"limits"`
	Help    string                       `json:"help"`
}

type watchDeviceConfig struct {
	On bool `json:"on"`
}

func defaultWatchConfig() watchConfig {
	return watchConfig{Devices: map[string]watchDeviceConfig{}, Limits: defaultWatchLimits(), Help: watchHelp}
}

// watchEvent is one thing watch mode did, for the page and watch.log.
type watchEvent struct {
	At     time.Time `json:"at"`
	Serial string    `json:"serial"`
	Msg    string    `json:"msg"`
	OK     bool      `json:"ok"`
}

type watchDevice struct {
	state   watchState
	status  string
	checked time.Time
	busy    bool   // a check is running
	emuSent string // "host|boot id" last written to gap-watch/emulator
}

// Watcher is watch mode for one starter.
type Watcher struct {
	s       *Starter
	path    string // watch.json
	logPath string // watch.log
	emus    []Emulator

	mu      sync.Mutex
	cfg     watchConfig
	cfgErr  string
	cfgMod  time.Time
	devs    map[string]*watchDevice
	ring    []watchEvent
	pushed  map[string]string // serial -> hash of the device script pushed there
	script  struct{ hash, stamp string }
	found   []emuFound
	foundAt time.Time
	finding bool

	emuMu       sync.Mutex // one emulator listing at a time
	installed   []Emulator
	installedAt time.Time
	logMu       sync.Mutex
	once        sync.Once
}

func newWatcher(s *Starter) *Watcher {
	w := &Watcher{s: s, path: filepath.Join(s.bundle, "watch.json"), logPath: filepath.Join(s.bundle, "watch.log"),
		emus: hostEmulators(), cfg: defaultWatchConfig(), devs: map[string]*watchDevice{}, pushed: map[string]string{}}
	w.mu.Lock()
	w.load()
	w.mu.Unlock()
	return w
}

// start runs the loop, once.
func (w *Watcher) start() {
	w.once.Do(func() {
		go func() {
			t := time.NewTicker(watchEvery)
			defer t.Stop()
			for range t.C {
				w.tick(context.Background())
			}
		}()
	})
}

// ------------------------------------------------------------------ watch.json

// load re-reads watch.json when it changed. A missing file is written with the
// defaults, so there is one to edit. A bad one is left alone: the last good
// settings stay in use and the page says what is wrong. Caller holds mu.
func (w *Watcher) load() {
	st, err := os.Stat(w.path)
	if errors.Is(err, fs.ErrNotExist) {
		w.cfgErr = ""
		_ = w.save() // best effort: a bundle on read-only media just keeps the defaults
		return
	}
	if err != nil || st.ModTime().Equal(w.cfgMod) {
		return
	}
	w.cfgMod = st.ModTime()
	b, err := os.ReadFile(w.path)
	if err != nil {
		w.cfgErr = "Could not read watch.json: " + err.Error()
		return
	}
	cfg := defaultWatchConfig() // keys missing from the file keep their defaults
	if err := json.Unmarshal(b, &cfg); err != nil {
		w.cfgErr = "watch.json has a mistake, so the last good settings are in use: " + err.Error()
		w.logLine("", w.cfgErr)
		return
	}
	if cfg.Devices == nil {
		cfg.Devices = map[string]watchDeviceConfig{}
	}
	cfg.Limits = cfg.Limits.clamped()
	cfg.Help = watchHelp
	w.cfg, w.cfgErr = cfg, ""
}

// save writes watch.json through a temp file. Caller holds mu.
func (w *Watcher) save() error {
	b, err := json.MarshalIndent(w.cfg, "", "  ")
	if err != nil {
		return err
	}
	tmp := w.path + ".tmp"
	if err := os.WriteFile(tmp, append(b, '\n'), 0o644); err != nil {
		return err
	}
	if err := os.Rename(tmp, w.path); err != nil {
		os.Remove(tmp)
		return err
	}
	if st, err := os.Stat(w.path); err == nil {
		w.cfgMod = st.ModTime()
	}
	return nil
}

// setOn turns watch mode on or off for one serial.
func (w *Watcher) setOn(serial string, on bool) error {
	if err := w.saveOn(serial, on); err != nil {
		return err
	}
	w.event(serial, map[bool]string{true: "Watch mode turned on.", false: "Watch mode turned off."}[on], true)
	return nil
}

func (w *Watcher) saveOn(serial string, on bool) error {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.load()
	if w.cfgErr != "" {
		return errors.New(w.cfgErr + "\nFix or delete watch.json in the starter folder, then try again.")
	}
	if on {
		w.cfg.Devices[serial] = watchDeviceConfig{On: true}
		d := w.dev(serial)
		d.state.UserStopped, d.state.EmuFailures = false, 0
		d.status = "Checking …"
	} else {
		delete(w.cfg.Devices, serial)
	}
	if err := w.save(); err != nil {
		return errors.New("Could not save watch.json: " + err.Error())
	}
	return nil
}

func (w *Watcher) isOn(serial string) bool {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.cfg.Devices[serial].On
}

// dev is a serial's state, made on first use. Caller holds mu.
func (w *Watcher) dev(serial string) *watchDevice {
	d, ok := w.devs[serial]
	if !ok {
		d = &watchDevice{}
		w.devs[serial] = d
	}
	return d
}

// ------------------------------------------------------------------ the loop

// tick checks every watched device, each in its own goroutine so a slow
// emulator restart does not hold up the others.
func (w *Watcher) tick(ctx context.Context) {
	w.mu.Lock()
	w.load()
	var serials []string
	for serial, c := range w.cfg.Devices {
		if c.On {
			serials = append(serials, serial)
		}
	}
	w.mu.Unlock()
	if len(serials) == 0 || w.s.adb() == "" {
		return
	}
	states := map[string]string{}
	for _, d := range w.s.listDevices(ctx) {
		states[d.serial] = d.state
	}
	w.refreshEmus(ctx, false)
	for _, serial := range serials {
		w.mu.Lock()
		d := w.dev(serial)
		busy := d.busy
		d.busy = true
		w.mu.Unlock()
		if busy {
			continue
		}
		go func() {
			defer func() {
				w.mu.Lock()
				d.busy = false
				w.mu.Unlock()
			}()
			w.check(ctx, serial, states[serial])
		}()
	}
}

// check looks at one device and does what decide() says. It holds the device
// lock, and skips the device while a page action holds it.
func (w *Watcher) check(ctx context.Context, serial, adbState string) {
	lock := w.s.deviceLock(serial)
	if !lock.TryLock() {
		w.mu.Lock()
		w.dev(serial).status = "An action is running on this device. Checking again shortly."
		w.mu.Unlock()
		return
	}
	defer lock.Unlock()

	o, problem := w.look(ctx, serial, adbState)
	now := time.Now()
	w.mu.Lock()
	d := w.dev(serial)
	d.checked = now
	if problem != "" {
		d.status = problem
		w.mu.Unlock()
		return
	}
	d.state = observe(d.state, o, now)
	m := w.mappingLocked(serial)
	dec := decide(d.state, o, now, w.cfg.Limits, m.info())
	sent := d.emuSent
	w.mu.Unlock()

	// Tell GAP which emulator it runs in, once per boot (gap-watch/emulator).
	if o.Reachable && m.Match != nil && sent != m.Match.Host+"|"+o.BootID {
		if r := w.watchVerb(ctx, serial, "--emulator", m.Match.Host); kv(r.out, "rc") == "0" {
			w.mu.Lock()
			d.emuSent = m.Match.Host + "|" + o.BootID
			w.mu.Unlock()
		}
	}

	// Take GAP's request first. A request that stays (gap-watch not writable)
	// means GAP reboots by itself after 60 s, so acting too would restart it twice.
	if dec.Take && !w.take(ctx, serial) {
		dec = decision{Why: "Could not take GAP's restart request (gap-watch is not writable), so GAP restarts by itself."}
		w.event(serial, dec.Why, false)
	}
	res := acted{ok: true}
	if dec.Act != watchWait {
		res = w.act(ctx, serial, dec)
	}
	w.mu.Lock()
	d.state = record(d.state, dec, res.ok, time.Now())
	d.status = dec.Why + o.Warn
	switch {
	case res.rebooted:
		d.state.RebootTried = true // record() already gave it the emulator's grace
		d.status = dec.Why + " The emulator restart did not work, so Android was restarted instead." + o.Warn
	case !res.ok:
		d.status += " That did not work; watch.log has the details."
	}
	w.mu.Unlock()
}

// take deletes GAP's restart request; false when it is still there.
func (w *Watcher) take(ctx context.Context, serial string) bool {
	r := w.watchVerb(ctx, serial, "--take")
	if kv(r.out, "taken") == "1" {
		w.logLine(serial, "took GAP's restart request")
		return true
	}
	w.logLine(serial, "could not delete GAP's restart request: "+orDash(firstLine(r.out+r.problem)))
	return false
}

// look runs the watch verb. problem is set when the device answers but the
// answer cannot be used, which no action can fix; a restart is then never
// tried. Only adb failing to reach the device leads to the recovery ladder.
func (w *Watcher) look(ctx context.Context, serial, adbState string) (watchObs, string) {
	if adbState != "device" {
		return watchObs{AdbState: adbState}, ""
	}
	r := w.watchVerb(ctx, serial)
	if r.problem != "" {
		return watchObs{}, r.problem
	}
	out := r.out
	if o, ok := parseWatch(out); ok {
		if kv(out, "stamped") == "0" {
			o.Warn = " GAP cannot see watch mode: " + orDash(kv(out, "msg")) + "."
		}
		return o, ""
	}
	switch got := kv(out, "proto"); {
	case kv(out, "err") == "bad-usage":
		return watchObs{}, "This starter's device script has no watch mode yet. Update the starter (Updates, below)."
	case got != "" && got != protoWant:
		return watchObs{}, protoMismatch(out).Msg
	case r.dead:
		return watchObs{AdbState: adbState}, ""
	}
	return watchObs{}, "The device answered, but not with a watch reply: " + orDash(firstLine(out)) + ". Nothing is done until it does."
}

// verbReply is one run of the watch verb. dead is set when adb could not reach
// the device (a timeout, or adb's own "error: ..."); problem when the starter
// could not run the verb for a reason no restart fixes.
type verbReply struct {
	out, problem string
	dead         bool
}

// adbFailed is adb's own error line ("error: device offline", "error: closed").
func adbFailed(out string) bool {
	return strings.HasPrefix(strings.TrimSpace(out), "error:")
}

func firstLine(s string) string {
	line, _, _ := strings.Cut(strings.TrimSpace(s), "\n")
	return line
}

// watchVerb runs `gap-service.sh watch [args]`. Unlike the page's actions it
// pushes the device script only when the bundle's copy changed since the last
// push, or the device's copy is missing or another version (another tool may
// have pushed an older one).
func (w *Watcher) watchVerb(ctx context.Context, serial string, args ...string) verbReply {
	hash := w.scriptHash()
	w.mu.Lock()
	fresh := hash != "" && w.pushed[serial] == hash
	w.mu.Unlock()
	run := func() verbReply {
		rctx, cancel := context.WithTimeout(ctx, 20*time.Second)
		defer cancel()
		out, _ := w.s.run(rctx, 21*time.Second, "-s", serial, "shell", strings.Join(append([]string{"sh", deviceScript, "watch"}, args...), " "))
		return verbReply{out: out, dead: rctx.Err() != nil || adbFailed(out)}
	}
	if fresh {
		r := run()
		if r.dead || !needsPush(r.out) {
			return r
		}
	}
	script := filepath.Join(w.s.bundle, "device", "gap-service.sh")
	if hash == "" {
		return verbReply{problem: "The starter folder has no device/gap-service.sh. Update the starter, or extract it again."}
	}
	pctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if out, err := w.s.run(pctx, 31*time.Second, "-s", serial, "push", script, deviceScript); err != nil {
		if pctx.Err() != nil || adbFailed(out) {
			return verbReply{out: out, dead: true}
		}
		return verbReply{out: out, problem: "Could not copy the device script to the device: " + orDash(firstLine(out)) + "."}
	}
	w.mu.Lock()
	w.pushed[serial] = hash
	w.mu.Unlock()
	return run()
}

// needsPush is a reply from a device script that is missing, too old for the
// watch verb, or speaks another protocol.
func needsPush(out string) bool {
	missing := kv(out, "proto") == "" &&
		(strings.Contains(out, "No such file") || strings.Contains(out, "can't open") || strings.Contains(out, "not found"))
	proto := kv(out, "proto")
	return missing || kv(out, "err") == "bad-usage" || proto != "" && proto != protoWant
}

// scriptHash is the bundle's device script's sha256, re-read when its size or mtime changes.
func (w *Watcher) scriptHash() string {
	path := filepath.Join(w.s.bundle, "device", "gap-service.sh")
	st, err := os.Stat(path)
	if err != nil {
		return ""
	}
	stamp := fmt.Sprintf("%d:%d", st.Size(), st.ModTime().UnixNano())
	w.mu.Lock()
	defer w.mu.Unlock()
	if w.script.stamp != stamp {
		h, _ := sha256File(path)
		w.script.hash, w.script.stamp = h, stamp
	}
	return w.script.hash
}

// acted is what act did. rebooted is set when a failed emulator restart fell
// back to adb reboot.
type acted struct{ ok, rebooted bool }

// act carries out one decision; the result goes to watch.log and the page.
// GAP's request (d.Take) has been taken already.
func (w *Watcher) act(ctx context.Context, serial string, d decision) acted {
	logf := func(line string) { w.logLine(serial, "  "+line) }
	w.logLine(serial, d.Why)
	ok := false
	switch d.Act {
	case watchTake:
		ok = kv(w.watchVerb(ctx, serial, "--take").out, "taken") == "1"
	case watchStart, watchForceStart:
		r := w.s.start(ctx, serial, d.Act == watchForceStart, logf)
		logLines(logf, r.Msg)
		ok = r.OK
	case watchConnect:
		out, err := w.s.run(ctx, 15*time.Second, "connect", serial)
		logLines(logf, out)
		ok = err == nil && strings.Contains(out, "connected to")
		if ok {
			w.event(serial, "Reconnected with adb connect.", true)
		}
		return acted{ok: ok} // a failed reconnect repeats every minute; only watch.log has those
	case watchReboot:
		out, err := w.s.run(ctx, 30*time.Second, "-s", serial, "reboot")
		logLines(logf, out)
		ok = err == nil
	case watchEmulator:
		err := w.restartEmulator(ctx, serial, logf)
		if err == nil {
			ok = true
			break
		}
		logf(err.Error())
		// GAP's request was taken, so GAP will not reboot by itself; a stuck
		// start has nothing else to fall back on. Try adb reboot.
		if d.Take || d.Stuck {
			logf("the emulator restart did not work; trying adb reboot")
			out, rerr := w.s.run(ctx, 30*time.Second, "-s", serial, "reboot")
			logLines(logf, out)
			if rerr == nil {
				w.event(serial, d.Why+" The emulator restart did not work, so Android was restarted instead.", true)
				return acted{rebooted: true}
			}
			logf("adb reboot: " + rerr.Error())
		}
	}
	msg := d.Why
	if !ok {
		msg += " It did not work."
	}
	w.event(serial, msg, ok)
	return acted{ok: ok}
}

// ------------------------------------------------------------- emulators

// refreshEmus lists the emulators' instances, at most once a minute unless
// forced. Which families are installed is looked up every 10 minutes.
func (w *Watcher) refreshEmus(ctx context.Context, force bool) {
	w.emuMu.Lock()
	defer w.emuMu.Unlock()
	w.mu.Lock()
	fresh := !force && !w.foundAt.IsZero() && time.Since(w.foundAt) < emuCacheFor
	w.mu.Unlock()
	if fresh {
		return
	}
	if w.installedAt.IsZero() || time.Since(w.installedAt) > emuFindFor {
		w.installed = nil
		for _, e := range w.emus {
			if found := e.Find(); found != nil {
				w.installed = append(w.installed, found)
			}
		}
		w.installedAt = time.Now()
	}
	var found []emuFound
	for _, e := range w.installed {
		f := emuFound{Host: e.Host(), Label: e.Label(), emu: e}
		list, err := e.Instances(ctx)
		if err != nil {
			f.Err = err.Error()
		}
		f.Inst = list
		found = append(found, f)
	}
	w.mu.Lock()
	w.found, w.foundAt = found, time.Now()
	w.mu.Unlock()
}

// mappingLocked is the serial's emulator from the last listing. Caller holds mu.
func (w *Watcher) mappingLocked(serial string) hostMapping {
	m := mapSerial(serial, w.found, emuLabels(w.emus))
	if m.Local && m.Match == nil && w.foundAt.IsZero() {
		m.Why = "Looking for emulators on this computer …"
	}
	return m
}

// restartEmulator finds the serial's instance afresh and restarts it.
func (w *Watcher) restartEmulator(ctx context.Context, serial string, logf func(string)) error {
	w.refreshEmus(ctx, true)
	w.mu.Lock()
	m := w.mappingLocked(serial)
	var e Emulator
	for _, f := range w.found {
		if m.Match != nil && f.Host == m.Match.Host {
			e = f.emu
		}
	}
	w.mu.Unlock()
	if m.Match == nil || e == nil {
		return errors.New(m.Why)
	}
	in := m.Match.EmuInstance
	logf(fmt.Sprintf("restarting %s instance %s (%s, adb port %d) ...", m.Match.Label, in.ID, in.Name, in.Port))
	ctx, cancel := context.WithTimeout(ctx, 4*time.Minute)
	defer cancel()
	err := e.Restart(ctx, in, logf)
	w.mu.Lock()
	w.foundAt = time.Time{} // its state changed
	w.mu.Unlock()
	return err
}

// ------------------------------------------------------- from the page's actions

// restartNow is the page's confirmed "Restart emulator now". The caller (Run)
// holds the device lock. It also lifts the give-up after failed restarts.
// A closed page does not cancel it: stopping between shutdown and launch
// would leave the emulator off (restartEmulator still has its own time limit).
func (w *Watcher) restartNow(ctx context.Context, serial string, logf func(string)) Result {
	err := w.restartEmulator(context.WithoutCancel(ctx), serial, func(l string) { logf(l); w.logLine(serial, "  "+l) })
	now := time.Now()
	w.mu.Lock()
	st := &w.dev(serial).state
	st.EmuAt, st.EmuFailures, st.EmuPending = now, 0, err == nil
	st.GraceUntil = now.Add(watchGrace)
	w.mu.Unlock()
	if err != nil {
		w.event(serial, "Restart emulator now did not work: "+err.Error(), false)
		return Result{Msg: "The emulator was not restarted: " + err.Error()}
	}
	w.event(serial, "Restarted the emulator (Restart emulator now).", true)
	msg := "The emulator is restarting. It takes a minute or two to come back."
	if w.isOn(serial) {
		msg += "\nWatch mode starts GAP again once Android is up."
	}
	return Result{OK: true, Msg: msg}
}

// rebooted notes a restart started from the page, so watch mode waits for it.
func (w *Watcher) rebooted(serial string) {
	w.mu.Lock()
	st := &w.dev(serial).state
	st.GraceUntil, st.RebootTried = time.Now().Add(watchGrace), true
	w.mu.Unlock()
	w.event(serial, "Restarted Android (Restart Android).", true)
}

// setUserStopped is told about the page's Stop (true) and Start/Restart (false):
// watch mode leaves a stopped GAP alone until then, or until the next boot.
func (w *Watcher) setUserStopped(serial string, stopped bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	w.dev(serial).state.UserStopped = stopped
}

// ------------------------------------------------------------- log and view

// event records something watch mode did, for the page and watch.log.
func (w *Watcher) event(serial, msg string, ok bool) {
	ev := watchEvent{At: time.Now(), Serial: serial, Msg: msg, OK: ok}
	w.mu.Lock()
	w.ring = append(w.ring, ev)
	if len(w.ring) > watchRingCap {
		w.ring = w.ring[len(w.ring)-watchRingCap:]
	}
	w.mu.Unlock()
	w.logLine(serial, "= "+msg)
}

// logLine appends one line to watch.log, rotating it past 1 MB.
func (w *Watcher) logLine(serial, line string) {
	w.logMu.Lock()
	defer w.logMu.Unlock()
	if st, err := os.Stat(w.logPath); err == nil && st.Size() > watchLogMax {
		_ = os.Rename(w.logPath, strings.TrimSuffix(w.logPath, ".log")+".1.log")
	}
	f, err := os.OpenFile(w.logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	who := serial
	if who == "" {
		who = "-"
	}
	fmt.Fprintf(f, "%s %s %s\n", time.Now().Format("2006-01-02 15:04:05"), who, line)
}

type watchView struct {
	File   string           `json:"file"`
	Log    string           `json:"log"`
	Error  string           `json:"error,omitempty"`
	Every  int              `json:"everySec"`
	On     []string         `json:"on"` // the watched serials
	Limits WatchLimits      `json:"limits"`
	Device *watchDeviceView `json:"device,omitempty"`
}

type watchDeviceView struct {
	Serial  string       `json:"serial"`
	On      bool         `json:"on"`
	Status  string       `json:"status"`
	Checked *time.Time   `json:"checked,omitempty"`
	Mapping hostMapping  `json:"mapping"`
	Events  []watchEvent `json:"events"` // newest first
}

// view is GET /api/starter/watch. It never runs adb; a stale emulator listing
// is refreshed in the background.
func (w *Watcher) view(serial string) watchView {
	w.mu.Lock()
	w.load()
	v := watchView{File: w.path, Log: w.logPath, Error: w.cfgErr, Every: int(watchEvery / time.Second), On: []string{}, Limits: w.cfg.Limits}
	for s, c := range w.cfg.Devices {
		if c.On {
			v.On = append(v.On, s)
		}
	}
	sort.Strings(v.On)
	stale := !w.finding && (w.foundAt.IsZero() || time.Since(w.foundAt) > emuCacheFor)
	if serial != "" {
		dv := &watchDeviceView{Serial: serial, On: w.cfg.Devices[serial].On, Mapping: w.mappingLocked(serial), Events: []watchEvent{}}
		if d, ok := w.devs[serial]; ok {
			dv.Status = d.status
			if !d.checked.IsZero() {
				t := d.checked
				dv.Checked = &t
			}
		}
		for i := len(w.ring) - 1; i >= 0 && len(dv.Events) < 6; i-- {
			if w.ring[i].Serial == serial {
				dv.Events = append(dv.Events, w.ring[i])
			}
		}
		v.Device = dv
	}
	if stale {
		w.finding = true
	}
	w.mu.Unlock()
	if stale {
		go func() {
			w.refreshEmus(context.Background(), false)
			w.mu.Lock()
			w.finding = false
			w.mu.Unlock()
		}()
	}
	return v
}
