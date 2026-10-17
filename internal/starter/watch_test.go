package starter

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestParseWatch(t *testing.T) {
	o, ok := parseWatch(strings.ReplaceAll(string(fixture(t, "watch_reply.txt")), "\n", "\r\n"))
	if !ok {
		t.Fatal("a full reply parses")
	}
	want := watchObs{Reachable: true, AdbState: "device", Now: 1760000000, BootID: "8c1f2d6e-0b3a-4a7e-9d61-5d0f6a1b2c3d",
		Booted: true, Uptime: 345, Running: true, UID: "2000", Alive: 1759999990, AliveActive: true,
		RequestAt: 1759999995, RequestReason: "command"}
	if o != want {
		t.Fatalf("got %+v", o)
	}
	// An older GAP: no alive stamp and no request.
	o, ok = parseWatch("proto=1\nnow=10\nboot_id=b\nbooted=1\nuptime=5\nrunning=0\nuid=\nalive=\nalive_active=0\nrequest=\nrc=0\n")
	if !ok || o.Alive != 0 || o.RequestAt != 0 || o.UID != "" || o.Running {
		t.Fatalf("empty values: %+v %v", o, ok)
	}
	// What the device script adds (taken=, stamped=) is ignored.
	if _, ok := parseWatch("proto=1\nnow=10\nboot_id=b\nbooted=1\ntaken=1\nstamped=1\nrc=0\n"); !ok {
		t.Fatal("extra keys are fine")
	}
	for _, bad := range []string{
		"proto=1\nerr=bad-usage\nmsg=unknown option: watch\nrc=2\n", // a device script without the verb
		"proto=1\nnow=10\nboot_id=b\n",                              // cut off before rc
		"error: device offline\n",
		"proto=2\nboot_id=b\nrc=0\n",
	} {
		if _, ok := parseWatch(bad); ok {
			t.Errorf("should not parse: %q", bad)
		}
	}
}

func TestObserve(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	st := watchState{BootID: "a", UserStopped: true}
	st = observe(st, watchObs{Reachable: true, BootID: "a", Booted: true}, now)
	if !st.UserStopped {
		t.Fatal("Stop holds within a boot")
	}
	st = observe(st, watchObs{Reachable: true, BootID: "b", Booted: true, Running: true, UID: "0"}, now)
	if st.UserStopped || !st.Rooted || st.BootID != "b" {
		t.Fatalf("a new boot clears Stop; uid 0 means rooted: %+v", st)
	}
	st = observe(st, watchObs{}, now)
	if st.DeadSince != now {
		t.Fatal("dead spell starts")
	}
	st = observe(st, watchObs{}, now.Add(time.Minute))
	if st.DeadSince != now {
		t.Fatal("dead spell keeps its start")
	}
	st.RebootTried = true
	st = observe(st, watchObs{Reachable: true, BootID: "b"}, now.Add(2*time.Minute))
	if !st.DeadSince.IsZero() || st.RebootTried {
		t.Fatal("answering ends the dead spell")
	}

	// An emulator restart that brings the device back resets the failures;
	// one that does not within 5 minutes counts as one.
	st = watchState{EmuPending: true, EmuFailures: 2, EmuAt: now}
	if got := observe(st, watchObs{Reachable: true, BootID: "c", Booted: true}, now.Add(time.Minute)); got.EmuPending || got.EmuFailures != 0 {
		t.Fatalf("came back: %+v", got)
	}
	if got := observe(st, watchObs{}, now.Add(6*time.Minute)); got.EmuPending || got.EmuFailures != 3 {
		t.Fatalf("did not come back: %+v", got)
	}
	if got := observe(st, watchObs{}, now.Add(2*time.Minute)); !got.EmuPending || got.EmuFailures != 2 {
		t.Fatalf("still waiting: %+v", got)
	}

	// Old timestamps fall out of the windows.
	st = watchState{Starts: []time.Time{now.Add(-2 * time.Hour), now.Add(-time.Minute)}, EmuRestarts: []time.Time{now.Add(-7 * time.Hour)}}
	st = observe(st, watchObs{Reachable: true}, now)
	if len(st.Starts) != 1 || len(st.EmuRestarts) != 0 {
		t.Fatalf("pruning: %+v", st)
	}
}

func TestDecide(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	lim := defaultWatchLimits()
	const dev = 2_000_000 // the device's clock
	healthy := watchObs{Reachable: true, AdbState: "device", Now: dev, BootID: "b", Booted: true, Uptime: 600, Running: true, UID: "2000", Alive: dev - 10}
	with := func(f func(o *watchObs)) watchObs { o := healthy; f(&o); return o }
	mapped := hostInfo{TCP: true, Local: true, Mapped: true}
	unmapped := hostInfo{TCP: true, Local: true, Why: "No emulator instance found on port 5555."}
	remote := hostInfo{TCP: true, Why: "On another computer: only adb can restart it from here."}
	ago := func(d time.Duration) time.Time { return now.Add(-d) }
	times := func(n int, d time.Duration) []time.Time {
		var ts []time.Time
		for i := 0; i < n; i++ {
			ts = append(ts, ago(d))
		}
		return ts
	}
	dead := func(d time.Duration) watchState { return watchState{DeadSince: ago(d)} }
	request := with(func(o *watchObs) { o.RequestAt, o.RequestReason = dev-5, "command" })
	stale := with(func(o *watchObs) { o.Alive = dev - 200 })
	stopped := with(func(o *watchObs) { o.Running, o.UID = false, "" })
	offline := watchObs{AdbState: "offline"}
	gone := watchObs{}

	cases := []struct {
		name string
		st   watchState
		o    watchObs
		host hostInfo
		act  watchAction
		take bool
		why  string
	}{
		{"healthy", watchState{}, healthy, mapped, watchWait, false, "GAP is running"},
		{"old GAP without alive", watchState{}, with(func(o *watchObs) { o.Alive = 0 }), mapped, watchWait, false, "running"},

		// GAP restarting itself on a new build.
		{"updating, stopped", watchState{}, with(func(o *watchObs) { o.Running, o.UID, o.UpdatingAt = false, "", dev-10 }), mapped, watchWait, false, "updating itself"},
		{"updating, frozen", watchState{}, with(func(o *watchObs) { o.Alive, o.UpdatingAt = dev-200, dev-10 }), mapped, watchWait, false, "updating itself"},
		{"old update marker", watchState{}, with(func(o *watchObs) { o.Running, o.UID, o.UpdatingAt = false, "", dev-300 }), mapped, watchStart, false, "not running"},

		// 1. GAP's restart request.
		{"request, emulator mapped", watchState{}, request, mapped, watchEmulator, true, "GAP asked for a restart (command)"},
		{"request, no emulator", watchState{}, request, unmapped, watchReboot, true, "Restarting Android"},
		{"request, remote", watchState{}, request, remote, watchReboot, true, "Restarting Android"},
		{"request, emulator limit reached", watchState{EmuRestarts: times(3, time.Hour)}, request, mapped, watchReboot, true, ""},
		{"request left by a GAP that died", watchState{}, with(func(o *watchObs) { o.RequestAt = dev - 130 }), mapped, watchTake, false, "Dropped a restart request"},
		// GAP waits 60 s for a taker: a late take could make both restart it.
		{"request at 55 s: left to GAP", watchState{}, with(func(o *watchObs) { o.RequestAt = dev - 55 }), mapped, watchWait, false, "restarts by itself"},
		{"request at 90 s: left to GAP", watchState{}, with(func(o *watchObs) { o.RequestAt = dev - 90 }), mapped, watchWait, false, "restarts by itself"},
		{"request at 50 s", watchState{}, with(func(o *watchObs) { o.RequestAt = dev - 50 }), mapped, watchEmulator, true, ""},
		{"request beats a stopped GAP", watchState{}, with(func(o *watchObs) { o.RequestAt, o.Running = dev-1, false }), unmapped, watchReboot, true, ""},

		// 2. GAP not running.
		{"booting", watchState{}, with(func(o *watchObs) { o.Booted, o.Running, o.Uptime = false, false, 100 }), mapped, watchWait, false, "Android is starting"},
		{"stuck booting, emulator", watchState{}, with(func(o *watchObs) { o.Booted, o.Running = false, false }), mapped, watchEmulator, false, "starting for 10 min"},
		{"stuck booting, no emulator", watchState{}, with(func(o *watchObs) { o.Booted, o.Running = false, false }), remote, watchReboot, false, "Restarting Android"},
		{"stuck booting, restarted lately", watchState{StuckAt: ago(20 * time.Minute)}, with(func(o *watchObs) { o.Booted, o.Running = false, false }), remote, watchWait, false, "restarted recently"},
		{"just booted", watchState{}, with(func(o *watchObs) { o.Running, o.Uptime = false, 10 }), mapped, watchWait, false, "just started"},
		{"not running", watchState{}, stopped, mapped, watchStart, false, "not running"},
		{"stopped on the page", watchState{UserStopped: true}, stopped, mapped, watchWait, false, "stopped on this page"},
		{"rooted", watchState{Rooted: true}, stopped, mapped, watchWait, false, "Rooted"},
		{"start budget spent", watchState{Starts: times(4, 10*time.Minute)}, stopped, mapped, watchWait, false, "4 times this hour"},
		{"started a moment ago", watchState{Starts: times(1, 30*time.Second)}, stopped, mapped, watchWait, false, "just started"},
		{"started 2 min ago", watchState{Starts: times(1, 2*time.Minute)}, stopped, mapped, watchStart, false, ""},

		// 3. GAP frozen.
		{"frozen", watchState{}, stale, mapped, watchForceStart, false, "has not answered for 3 min"},
		{"frozen, root service", watchState{}, with(func(o *watchObs) { o.Alive, o.UID = dev-200, "0" }), mapped, watchWait, false, "running"},
		{"frozen, budget spent", watchState{ForceStarts: times(3, 10*time.Minute)}, stale, mapped, watchWait, false, "restarted 3 times this hour"},
		{"frozen, just restarted", watchState{ForceStarts: times(1, time.Minute)}, stale, mapped, watchWait, false, "running"},
		{"frozen, just booted", watchState{}, with(func(o *watchObs) { o.Alive, o.Uptime = dev-200, 100 }), mapped, watchWait, false, "running"},
		{"force starts off", watchState{}, stale, mapped, watchWait, false, "restarted 0 times"},

		// 4. adb cannot reach it.
		{"dead briefly", dead(30 * time.Second), offline, mapped, watchWait, false, "Waiting before acting"},
		{"dead, reconnect", dead(100 * time.Second), offline, mapped, watchConnect, false, "Reconnecting"},
		{"dead, usb: no reconnect", dead(100 * time.Second), offline, hostInfo{Why: "A USB device"}, watchWait, false, "still cannot reach"},
		{"dead, just reconnected", watchState{DeadSince: ago(100 * time.Second), LastConnect: ago(5 * time.Second)}, offline, mapped, watchWait, false, "still cannot reach"},
		{"dead, reboot", watchState{DeadSince: ago(130 * time.Second), LastConnect: ago(30 * time.Second)}, offline, mapped, watchReboot, false, "Restarting Android"},
		{"dead and unlisted: no reboot", watchState{DeadSince: ago(130 * time.Second), LastConnect: ago(30 * time.Second)}, gone, mapped, watchWait, false, ""},
		{"dead, emulator", watchState{DeadSince: ago(250 * time.Second), LastConnect: ago(10 * time.Second), RebootTried: true}, offline, mapped, watchEmulator, false, "Restarting the emulator"},
		{"dead, remote: adb only", watchState{DeadSince: ago(250 * time.Second), LastConnect: ago(10 * time.Second), RebootTried: true}, offline, remote, watchWait, false, "another computer"},
		{"dead, remote reconnects", watchState{DeadSince: ago(250 * time.Second), LastConnect: ago(70 * time.Second), RebootTried: true}, offline, remote, watchConnect, false, "another computer"},
		{"dead, gave up", watchState{DeadSince: ago(250 * time.Second), LastConnect: ago(10 * time.Second), RebootTried: true, EmuFailures: 3}, offline, mapped, watchWait, false, "Gave up after 3"},
		{"dead, backoff", watchState{DeadSince: ago(250 * time.Second), LastConnect: ago(10 * time.Second), RebootTried: true, EmuFailures: 1, EmuAt: ago(15 * time.Minute)}, offline, mapped, watchWait, false, "next restart may be in 5 min"},
		{"dead, backoff over", watchState{DeadSince: ago(250 * time.Second), LastConnect: ago(10 * time.Second), RebootTried: true, EmuFailures: 1, EmuAt: ago(25 * time.Minute)}, offline, mapped, watchEmulator, false, ""},
		{"restarting, reconnect", watchState{DeadSince: ago(time.Hour), GraceUntil: now.Add(time.Minute), LastConnect: ago(70 * time.Second)}, gone, mapped, watchConnect, false, "comes back"},
		{"restarting, wait", watchState{DeadSince: ago(time.Hour), GraceUntil: now.Add(time.Minute), LastConnect: ago(10 * time.Second)}, gone, mapped, watchWait, false, "Waiting for it to come back"},
	}
	for _, c := range cases {
		l := lim
		if c.name == "force starts off" {
			l.ForceStartsPerHour = 0
		}
		d := decide(c.st, c.o, now, l, c.host)
		if d.Act != c.act || d.Take != c.take || !strings.Contains(d.Why, c.why) {
			t.Errorf("%s: got %q take=%v %q", c.name, d.Act, d.Take, d.Why)
		}
		if strings.HasPrefix(c.name, "stuck") && c.act != watchWait && !d.Stuck {
			t.Errorf("%s: not marked stuck", c.name)
		}
	}
}

// The backoff stays positive (and capped) at the largest limits watch.json allows.
func TestEmuBackoffAtMaxLimits(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	lim := WatchLimits{EmuRestartsPer6h: 20, EmuRestartGapMin: 720, EmuGiveUpAfter: 20}.clamped()
	host := hostInfo{Local: true, Mapped: true}
	for f := 0; f < lim.EmuGiveUpAfter; f++ {
		st := watchState{EmuFailures: f, EmuAt: now.Add(-time.Minute)}
		if ok, why := emuAllowed(st, now, lim, host); ok {
			t.Fatalf("%d failures: restarted a minute after the last one", f)
		} else if !strings.Contains(why, "next restart") {
			t.Fatalf("%d failures: %q", f, why)
		}
	}
	st := watchState{EmuFailures: 19, EmuAt: now.Add(-25 * time.Hour)}
	if ok, _ := emuAllowed(st, now, lim, host); !ok {
		t.Fatal("the backoff is capped at a day")
	}
}

func TestRecord(t *testing.T) {
	now := time.Unix(1_000_000, 0)
	st := record(watchState{}, decision{Act: watchEmulator}, true, now)
	if len(st.EmuRestarts) != 1 || st.EmuAt != now || !st.EmuPending || !st.GraceUntil.After(now) {
		t.Fatalf("emulator restart: %+v", st)
	}
	st = record(watchState{}, decision{Act: watchEmulator}, false, now)
	if st.EmuPending || st.EmuFailures != 1 {
		t.Fatalf("failed emulator restart: %+v", st)
	}
	st = record(watchState{}, decision{Act: watchReboot}, true, now)
	if !st.RebootTried || !st.GraceUntil.After(now) {
		t.Fatalf("reboot: %+v", st)
	}
	if st = record(watchState{}, decision{Act: watchReboot, Stuck: true}, true, now); st.StuckAt != now {
		t.Fatalf("stuck start: %+v", st)
	}
	st = record(record(watchState{}, decision{Act: watchStart}, false, now), decision{Act: watchConnect}, false, now)
	if len(st.Starts) != 1 || st.LastConnect != now {
		t.Fatalf("start, connect: %+v", st)
	}
}

func TestWatchLimitsClamp(t *testing.T) {
	l := WatchLimits{StartsPerHour: 0, AliveStaleSec: 5, ForceStartsPerHour: 99, RequestMaxAgeSec: 120, EmuGiveUpAfter: -1, BootStuckSec: 1}.clamped()
	if l.StartsPerHour != 1 || l.AliveStaleSec != 60 || l.ForceStartsPerHour != 20 || l.RequestMaxAgeSec != 55 || l.EmuGiveUpAfter != 1 || l.BootStuckSec != 120 {
		t.Fatalf("clamped: %+v", l)
	}
	if d := defaultWatchLimits(); d.clamped() != d {
		t.Fatal("the defaults are in range")
	}
}

func TestWatchConfig(t *testing.T) {
	s, _ := watchStarter(t, "")
	w := s.watch
	path := filepath.Join(s.bundle, "watch.json")
	var cfg watchConfig
	if b, err := os.ReadFile(path); err != nil || json.Unmarshal(b, &cfg) != nil || cfg.Limits != defaultWatchLimits() || cfg.Help == "" {
		t.Fatalf("defaults written on first start: %v %+v", err, cfg)
	}
	if v := w.view(""); len(v.On) != 0 {
		t.Fatal("off by default")
	}
	if err := w.setOn("127.0.0.1:16384", true); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(path)
	if !strings.Contains(string(b), `"127.0.0.1:16384": {`) {
		t.Fatalf("saved: %s", b)
	}

	// A hand edit is picked up, clamped, and keeps the other defaults.
	later := time.Now().Add(time.Minute)
	_ = os.WriteFile(path, []byte(`{"devices":{"a:1":{"on":true}},"limits":{"startsPerHour":0}}`), 0o644)
	_ = os.Chtimes(path, later, later)
	v := w.view("a:1")
	if strings.Join(v.On, ",") != "a:1" || v.Limits.StartsPerHour != 1 || v.Limits.AliveStaleSec != 180 || v.Error != "" || !v.Device.On {
		t.Fatalf("edited: %+v", v)
	}

	// A broken file keeps the last good settings and is not overwritten.
	later = later.Add(time.Minute)
	_ = os.WriteFile(path, []byte(`{"devices": {`), 0o644)
	_ = os.Chtimes(path, later, later)
	v = w.view("")
	if v.Error == "" || strings.Join(v.On, ",") != "a:1" {
		t.Fatalf("broken: %+v", v)
	}
	if err := w.setOn("b:2", true); err == nil {
		t.Fatal("a broken file is not overwritten")
	}
	if b, _ := os.ReadFile(path); string(b) != `{"devices": {` {
		t.Fatal("the broken file was rewritten")
	}
}

// The fake adb for watch mode: `watch` answers with $FAKE_WATCH, start succeeds.
// $FAKE_TAKE_FAIL makes --take fail, $FAKE_PUSH_FAIL makes push fail.
const fakeWatchADB = `#!/bin/sh
echo "$*" >> "$FAKE_CALLS"
[ "$1" = -s ] && shift 2
case "$1" in
  devices) printf 'List of devices attached\n127.0.0.1:16384\tdevice model:x\n' ;;
  push)
    if [ -n "$FAKE_PUSH_FAIL" ]; then echo "adb: error: failed to copy: remote No space left on device"; exit 1; fi ;;
  connect|reboot) ;;
  shell)
    case "$2" in
      *" watch --take"*)
        if [ -n "$FAKE_TAKE_FAIL" ]; then printf 'proto=1\ntaken=0\nerr=watch-dir-unwritable\nrc=1\n'; else printf 'proto=1\ntaken=1\nrc=0\n'; fi ;;
      *" watch --emulator"*) printf 'proto=1\nrc=0\n' ;;
      *" watch"*) cat "$FAKE_WATCH" ;;
      *" start"*) printf 'proto=1\nrunning=0\nstep=launch\nrunning=1\nrc=0\n' ;;
    esac ;;
esac
`

func watchStarter(t *testing.T, reply string) (*Starter, string) {
	if runtime.GOOS == "windows" {
		t.Skip("the fake adb is a shell script")
	}
	dir := t.TempDir()
	_ = os.MkdirAll(filepath.Join(dir, "device"), 0o755)
	_ = os.WriteFile(filepath.Join(dir, "device", "gap-service.sh"), []byte("#!/bin/sh\n"), 0o644)
	adb := filepath.Join(dir, "adb")
	_ = os.WriteFile(adb, []byte(fakeWatchADB), 0o755)
	calls := filepath.Join(dir, "calls")
	t.Setenv("FAKE_CALLS", calls)
	watch := filepath.Join(dir, "watch-reply")
	_ = os.WriteFile(watch, []byte(reply), 0o644)
	t.Setenv("FAKE_WATCH", watch)
	t.Setenv("FAKE_TAKE_FAIL", "")
	t.Setenv("FAKE_PUSH_FAIL", "")
	s, err := New(dir, "test")
	if err != nil {
		t.Fatal(err)
	}
	s.adbPath = adb
	s.watch.emus = nil
	return s, calls
}

func TestWatchCheckStartsGAP(t *testing.T) {
	reply := "proto=1\nnow=1000\nboot_id=b1\nbooted=1\nuptime=100\nrunning=0\nuid=\nalive=\nalive_active=0\nrequest=\nrc=0\n"
	s, calls := watchStarter(t, reply)
	const serial = "127.0.0.1:16384"
	if err := s.watch.setOn(serial, true); err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	s.watch.check(ctx, serial, "device")
	_ = os.WriteFile(os.Getenv("FAKE_WATCH"), []byte(strings.Replace(reply, "running=0", "running=1", 1)), 0o644)
	s.watch.check(ctx, serial, "device")

	b, _ := os.ReadFile(calls)
	log := string(b)
	if !strings.Contains(log, "shell sh "+deviceScript+" start") {
		t.Fatalf("GAP was not started: %s", log)
	}
	// One push for watch (the script is then known to be there), one by start.
	if n := strings.Count(log, " push "); n != 2 {
		t.Fatalf("pushes: %d\n%s", n, log)
	}
	v := s.watch.view(serial)
	if v.Device.Status != "GAP is running." || len(v.Device.Events) < 2 || !strings.Contains(v.Device.Events[0].Msg, "Starting it") || !v.Device.Events[0].OK {
		t.Fatalf("view: %+v", v.Device)
	}
	if b, _ := os.ReadFile(filepath.Join(s.bundle, "watch.log")); !strings.Contains(string(b), serial+" = GAP is not running. Starting it.") {
		t.Fatalf("watch.log: %s", b)
	}

	// Stop on the page: watch mode leaves it stopped.
	_ = os.WriteFile(os.Getenv("FAKE_WATCH"), []byte(reply), 0o644)
	s.watch.setUserStopped(serial, true)
	s.watch.check(ctx, serial, "device")
	if v := s.watch.view(serial); !strings.Contains(v.Device.Status, "stopped on this page") {
		t.Fatalf("after Stop: %q", v.Device.Status)
	}
}

func TestWatchCheckTakesRequest(t *testing.T) {
	reply := "proto=1\nnow=1000\nboot_id=b1\nbooted=1\nuptime=900\nrunning=1\nuid=2000\nalive=995\nalive_active=1\nrequest=995 slow\nrc=0\n"
	s, calls := watchStarter(t, reply)
	s.watch.check(context.Background(), "127.0.0.1:16384", "device")
	b, _ := os.ReadFile(calls)
	log := string(b)
	take := strings.Index(log, "watch --take")
	reboot := strings.Index(log, "-s 127.0.0.1:16384 reboot")
	if take < 0 || reboot < take {
		t.Fatalf("the request is taken, then Android restarted (no emulator here): %s", log)
	}
}

func TestWatchCheckSkipsBusyDevice(t *testing.T) {
	s, calls := watchStarter(t, "")
	lock := s.deviceLock("127.0.0.1:16384")
	lock.Lock()
	s.watch.check(context.Background(), "127.0.0.1:16384", "device")
	lock.Unlock()
	if b, _ := os.ReadFile(calls); len(b) != 0 {
		t.Fatalf("a busy device is not touched: %s", b)
	}
}

func TestWatchOldDeviceScript(t *testing.T) {
	s, _ := watchStarter(t, "proto=1\nerr=bad-usage\nmsg=unknown option: watch\nrc=2\n")
	s.watch.check(context.Background(), "127.0.0.1:16384", "device")
	if v := s.watch.view("127.0.0.1:16384"); !strings.Contains(v.Device.Status, "no watch mode yet") {
		t.Fatalf("status: %q", v.Device.Status)
	}
}

// fakeEmu is one running instance on 127.0.0.1:16384 whose Restart fails or not.
type fakeEmu struct {
	err    error
	ctxErr error // ctx.Err() when Restart ran
}

func (*fakeEmu) Host() string     { return "mumu" }
func (*fakeEmu) Label() string    { return "Fake Player" }
func (f *fakeEmu) Find() Emulator { return f }
func (*fakeEmu) Instances(context.Context) ([]EmuInstance, error) {
	return []EmuInstance{{ID: "0", Name: "one", Port: 16384, Running: true}}, nil
}
func (f *fakeEmu) Restart(ctx context.Context, _ EmuInstance, _ func(string)) error {
	f.ctxErr = ctx.Err()
	return f.err
}

const requestReply = "proto=1\nnow=1000\nboot_id=b1\nbooted=1\nuptime=900\nrunning=1\nuid=2000\nalive=995\nalive_active=1\nrequest=995 slow\nrc=0\n"

// A failed emulator restart for GAP's (taken) request falls back to adb reboot.
func TestWatchRequestEmulatorFailsThenReboots(t *testing.T) {
	s, calls := watchStarter(t, requestReply)
	s.watch.emus = []Emulator{&fakeEmu{err: errors.New("MuMu instance 0 did not shut down")}}
	const serial = "127.0.0.1:16384"
	s.watch.refreshEmus(context.Background(), true) // as tick() does
	s.watch.check(context.Background(), serial, "device")
	b, _ := os.ReadFile(calls)
	log := string(b)
	take := strings.Index(log, "watch --take")
	reboot := strings.Index(log, "-s "+serial+" reboot")
	if take < 0 || reboot < take {
		t.Fatalf("taken, then adb reboot after the emulator failed: %s", log)
	}
	s.watch.mu.Lock()
	d := s.watch.devs[serial]
	st, status := d.state, d.status
	s.watch.mu.Unlock()
	if !st.RebootTried || !st.GraceUntil.After(time.Now()) || st.EmuFailures != 1 || !strings.Contains(status, "restarted instead") {
		t.Fatalf("state %+v, status %q", st, status)
	}
}

// A request that cannot be taken is left to GAP: no restart from here.
func TestWatchRequestNotTaken(t *testing.T) {
	s, calls := watchStarter(t, requestReply)
	t.Setenv("FAKE_TAKE_FAIL", "1")
	s.watch.check(context.Background(), "127.0.0.1:16384", "device")
	b, _ := os.ReadFile(calls)
	if strings.Contains(string(b), " reboot") {
		t.Fatalf("restarted although GAP will: %s", b)
	}
	if v := s.watch.view("127.0.0.1:16384"); !strings.Contains(v.Device.Status, "Could not take") {
		t.Fatalf("status: %q", v.Device.Status)
	}
}

// A device script that cannot be copied is reported; the device is never treated as dead.
func TestWatchPushFails(t *testing.T) {
	s, calls := watchStarter(t, requestReply)
	t.Setenv("FAKE_PUSH_FAIL", "1")
	const serial = "127.0.0.1:16384"
	s.watch.check(context.Background(), serial, "device")
	s.watch.mu.Lock()
	d := s.watch.devs[serial]
	dead, status := d.state.DeadSince, d.status
	s.watch.mu.Unlock()
	if !dead.IsZero() || !strings.Contains(status, "Could not copy the device script") {
		t.Fatalf("dead since %v, status %q", dead, status)
	}
	if b, _ := os.ReadFile(calls); strings.Contains(string(b), " reboot") || strings.Contains(string(b), " shell ") {
		t.Fatalf("acted: %s", b)
	}
}

// adb's own error, or a timeout, is the device being unreachable.
func TestWatchAdbErrorIsDead(t *testing.T) {
	s, _ := watchStarter(t, "error: closed\n")
	const serial = "127.0.0.1:16384"
	s.watch.check(context.Background(), serial, "device")
	s.watch.mu.Lock()
	dead := s.watch.devs[serial].state.DeadSince
	s.watch.mu.Unlock()
	if dead.IsZero() {
		t.Fatal("adb's error starts a dead spell")
	}
}

// Another tool replaced the device script with an older one: it is pushed again.
func TestWatchRepushesOverwrittenScript(t *testing.T) {
	s, calls := watchStarter(t, requestReply)
	const serial = "127.0.0.1:16384"
	t.Setenv("FAKE_TAKE_FAIL", "1") // keep it from acting
	s.watch.check(context.Background(), serial, "device")
	_ = os.WriteFile(os.Getenv("FAKE_WATCH"), []byte("proto=1\nerr=bad-usage\nmsg=unknown verb\nrc=2\n"), 0o644)
	s.watch.check(context.Background(), serial, "device")
	b, _ := os.ReadFile(calls)
	if n := strings.Count(string(b), " push "); n != 2 {
		t.Fatalf("pushes: %d\n%s", n, b)
	}
}

// Restart emulator now runs to the end even when the page goes away.
func TestRestartNowIgnoresClosedPage(t *testing.T) {
	s, _ := watchStarter(t, "")
	fe := &fakeEmu{}
	s.watch.emus = []Emulator{fe}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if r := s.watch.restartNow(ctx, "127.0.0.1:16384", func(string) {}); !r.OK || fe.ctxErr != nil {
		t.Fatalf("result %+v, ctx %v", r, fe.ctxErr)
	}
}
