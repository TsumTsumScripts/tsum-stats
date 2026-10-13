package starter

// Watch mode's policy: what to do about one device, given what the last check
// saw. Pure (no adb, no clock, no files), so the tests can walk every case and
// the same rules can later run for cloud hosts.

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// WatchLimits are watch mode's thresholds, editable in watch.json.
type WatchLimits struct {
	StartAfterBootSec  int `json:"startAfterBootSec"`     // wait this long after Android starts before starting GAP
	StartsPerHour      int `json:"startsPerHour"`         // plain starts of a stopped GAP
	AliveStaleSec      int `json:"aliveStaleSec"`         // GAP's alive stamp older than this means it froze
	ForceStartsPerHour int `json:"forceStartsPerHour"`    // restarts of a frozen GAP; 0 = never
	AdbDeadSec         int `json:"adbDeadSec"`            // adb has lost the device this long: start recovering
	EmuRestartsPer6h   int `json:"emulatorRestartsPer6h"` // host-side emulator restarts; 0 = never
	EmuRestartGapMin   int `json:"emulatorRestartGapMin"` // at least this far apart, doubled per failure
	EmuGiveUpAfter     int `json:"emulatorGiveUpAfter"`   // failed emulator restarts in a row before giving up
	RequestMaxAgeSec   int `json:"requestMaxAgeSec"`      // GAP's restart request older than this is left to GAP
	BootStuckSec       int `json:"bootStuckSec"`          // Android still starting after this long counts as stuck
}

func defaultWatchLimits() WatchLimits {
	return WatchLimits{StartAfterBootSec: 20, StartsPerHour: 4, AliveStaleSec: 180, ForceStartsPerHour: 3,
		AdbDeadSec: 90, EmuRestartsPer6h: 3, EmuRestartGapMin: 10, EmuGiveUpAfter: 3, RequestMaxAgeSec: 50, BootStuckSec: 300}
}

// clamped keeps every limit in a safe range. The request age stays under the
// 60 s GAP waits for a taker before it reboots by itself, so the two never both act.
func (l WatchLimits) clamped() WatchLimits {
	c := func(v, lo, hi int) int { return max(lo, min(hi, v)) }
	l.StartAfterBootSec = c(l.StartAfterBootSec, 0, 600)
	l.StartsPerHour = c(l.StartsPerHour, 1, 60)
	l.AliveStaleSec = c(l.AliveStaleSec, 60, 3600)
	l.ForceStartsPerHour = c(l.ForceStartsPerHour, 0, 20)
	l.AdbDeadSec = c(l.AdbDeadSec, 30, 3600)
	l.EmuRestartsPer6h = c(l.EmuRestartsPer6h, 0, 20)
	l.EmuRestartGapMin = c(l.EmuRestartGapMin, 5, 720)
	l.EmuGiveUpAfter = c(l.EmuGiveUpAfter, 1, 20)
	l.RequestMaxAgeSec = c(l.RequestMaxAgeSec, 20, 55)
	l.BootStuckSec = c(l.BootStuckSec, 120, 3600)
	return l
}

// watchObs is one check of a device: the `watch` verb's reply
// (device/PROTOCOL.md), or why there was none.
type watchObs struct {
	Reachable     bool   // the watch verb answered
	AdbState      string // adb's state for the serial: device, offline, ... ; "" when not listed
	Now           int64  // the device's clock, epoch s; ages below are measured on it
	BootID        string
	Booted        bool
	Uptime        int64 // s since Android started
	Running       bool  // GAP's service process is up
	UID           string
	Alive         int64 // GAP's last alive stamp, epoch s; 0 = none (an older GAP)
	AliveActive   bool  // a run was active at that stamp
	RequestAt     int64 // GAP asked the host to restart the device; 0 = no request
	RequestReason string
	Warn          string // for the status line only: the device script could not write its stamp
}

// parseWatch reads the `watch` verb's key=value reply. ok is false when it is
// not a complete reply (another protocol, an old device script, a cut-off line).
func parseWatch(out string) (watchObs, bool) {
	if kv(out, "proto") != protoWant || kv(out, "rc") != "0" || kv(out, "boot_id") == "" {
		return watchObs{}, false
	}
	num := func(k string) int64 { n, _ := strconv.ParseInt(strings.TrimSpace(kv(out, k)), 10, 64); return n }
	o := watchObs{Reachable: true, AdbState: "device", Now: num("now"), BootID: strings.TrimSpace(kv(out, "boot_id")),
		Booted: kv(out, "booted") == "1", Uptime: num("uptime"), Running: kv(out, "running") == "1",
		UID: strings.TrimSpace(kv(out, "uid")), Alive: num("alive"), AliveActive: kv(out, "alive_active") == "1"}
	if at, reason, _ := strings.Cut(strings.TrimSpace(kv(out, "request")), " "); at != "" {
		o.RequestAt, _ = strconv.ParseInt(at, 10, 64)
		o.RequestReason = strings.TrimSpace(reason)
	}
	return o, true
}

// watchState is what watch mode remembers of one device between checks.
type watchState struct {
	BootID      string
	Rooted      bool      // GAP's service was seen running as root: the app manages it
	UserStopped bool      // Stop was pressed on the page; cleared by Start or a reboot
	DeadSince   time.Time // adb has not reached the device since; zero while it answers
	LastConnect time.Time
	RebootTried bool      // adb reboot was tried in this dead spell
	GraceUntil  time.Time // a restart we caused is under way
	Starts      []time.Time
	ForceStarts []time.Time
	EmuRestarts []time.Time // automatic ones, for the 6-hour limit
	EmuAt       time.Time   // the last emulator restart, automatic or from the page
	EmuPending  bool        // the last emulator restart has not been seen to work yet
	EmuFailures int         // emulator restarts in a row that did not bring the device back
	StuckAt     time.Time   // the last restart for Android stuck while starting
}

// hostInfo is what this computer can do about the device beyond adb.
type hostInfo struct {
	TCP    bool   // reached over adb connect (host:port), so a reconnect can help
	Local  bool   // the emulator runs on this computer
	Mapped bool   // exactly one emulator instance has this device's port
	Why    string // why the emulator cannot be restarted from here
}

type watchAction string

const (
	watchWait       watchAction = ""
	watchTake       watchAction = "take"        // drop a stale restart request, nothing else
	watchStart      watchAction = "start"       // start GAP's service
	watchForceStart watchAction = "start-force" // replace a frozen service
	watchConnect    watchAction = "connect"     // adb connect
	watchReboot     watchAction = "reboot"      // adb reboot
	watchEmulator   watchAction = "restart-emulator"
)

type decision struct {
	Act   watchAction
	Take  bool   // delete GAP's restart request before acting, so GAP does not reboot by itself too
	Why   string // the device's status line, and the log entry when Act is set
	Stuck bool   // the action is for Android stuck while starting
}

// How long a restart we caused is given before watch mode acts again, and how
// long an emulator restart may take to bring the device back.
const (
	watchGrace     = 3 * time.Minute
	emuSettle      = 5 * time.Minute
	connectEvery   = 60 * time.Second
	startMinGap    = 60 * time.Second
	rebootAfterSec = 30  // after adbDeadSec: adb connect had its chance
	emuAfterSec    = 150 // after adbDeadSec: adb reboot had its chance
	// GAP deletes its own request after 60 s and reboots by itself. One older
	// than this was left by a GAP that died waiting, so it is only deleted.
	requestStaleSec = 120
	stuckEvery      = time.Hour // at most one restart per hour for a stuck start
)

// observe folds one check into the state. Pure: now is the computer's clock.
func observe(st watchState, o watchObs, now time.Time) watchState {
	st.Starts = recent(st.Starts, now, time.Hour)
	st.ForceStarts = recent(st.ForceStarts, now, time.Hour)
	st.EmuRestarts = recent(st.EmuRestarts, now, 6*time.Hour)
	if !o.Reachable {
		if st.DeadSince.IsZero() {
			st.DeadSince = now
		}
		if st.EmuPending && now.Sub(st.EmuAt) > emuSettle {
			st.EmuPending = false
			st.EmuFailures++
		}
		return st
	}
	if st.BootID != "" && o.BootID != st.BootID {
		st.UserStopped = false // a new boot: Stop meant that boot
	}
	st.BootID = o.BootID
	if o.Running && o.UID == "0" {
		st.Rooted = true
	}
	st.DeadSince, st.RebootTried = time.Time{}, false
	if st.EmuPending && o.Booted {
		st.EmuPending, st.EmuFailures = false, 0
	}
	return st
}

// decide picks one action. In priority order: GAP's restart request, GAP not
// running, GAP frozen, adb unable to reach the device.
func decide(st watchState, o watchObs, now time.Time, lim WatchLimits, host hostInfo) decision {
	if !o.Reachable {
		return decideDead(st, o, now, lim, host)
	}
	// 1. GAP asked for a restart (gap-watch/request).
	if o.RequestAt > 0 {
		age := o.Now - o.RequestAt
		if age > requestStaleSec || age < -60 {
			return decision{Act: watchTake, Why: fmt.Sprintf("Dropped a restart request from %s ago.", ago(age))}
		}
		if age > int64(lim.RequestMaxAgeSec) {
			// Too late to take: GAP may stop waiting before it sees the request
			// gone, and then both would restart it. GAP restarts it by itself.
			return decision{Why: fmt.Sprintf("GAP asked for a restart %s ago and restarts by itself.", ago(age))}
		}
		why := "GAP asked for a restart"
		if o.RequestReason != "" {
			why += " (" + o.RequestReason + ")"
		}
		if ok, _ := emuAllowed(st, now, lim, host); ok {
			return decision{Act: watchEmulator, Take: true, Why: why + ". Restarting the emulator."}
		}
		return decision{Act: watchReboot, Take: true, Why: why + ". Restarting Android."}
	}
	if !o.Booted {
		return decideBooting(st, o, now, lim, host)
	}
	// 2. GAP is not running: after a reboot, or it stopped.
	if !o.Running {
		switch {
		case st.UserStopped:
			return decision{Why: "GAP was stopped on this page. Start service to keep it running again."}
		case st.Rooted:
			return decision{Why: "Rooted device: the app starts GAP itself."}
		case o.Uptime < int64(lim.StartAfterBootSec):
			return decision{Why: "Android just started. Starting GAP in a moment."}
		case len(st.Starts) >= lim.StartsPerHour:
			return decision{Why: fmt.Sprintf("GAP was started %d times this hour. Waiting before trying again.", len(st.Starts))}
		case now.Sub(lastStart(st)) < startMinGap:
			return decision{Why: "GAP was just started. Checking again shortly."}
		}
		return decision{Act: watchStart, Why: "GAP is not running. Starting it."}
	}
	// 3. GAP runs but its alive stamp is old: it froze. A root service is the app's.
	if o.Alive > 0 && o.UID != "0" {
		stale := o.Now - o.Alive
		limit := int64(lim.AliveStaleSec)
		if stale > limit && o.Uptime > limit && now.Sub(lastStart(st)) > time.Duration(limit)*time.Second {
			if len(st.ForceStarts) >= lim.ForceStartsPerHour {
				return decision{Why: fmt.Sprintf("GAP has not answered for %s, but was restarted %d times this hour. Waiting.", ago(stale), len(st.ForceStarts))}
			}
			return decision{Act: watchForceStart, Why: fmt.Sprintf("GAP has not answered for %s. Restarting it.", ago(stale))}
		}
	}
	return decision{Why: "GAP is running."}
}

// decideBooting waits while Android starts, and restarts it when it stays on
// its boot screen: the emulator when it may, else adb reboot, once an hour.
func decideBooting(st watchState, o watchObs, now time.Time, lim WatchLimits, host hostInfo) decision {
	if o.Uptime <= int64(lim.BootStuckSec) {
		return decision{Why: "Android is starting."}
	}
	why := fmt.Sprintf("Android has been starting for %s.", ago(o.Uptime))
	if ok, _ := emuAllowed(st, now, lim, host); ok {
		return decision{Act: watchEmulator, Stuck: true, Why: why + " Restarting the emulator."}
	}
	if !st.StuckAt.IsZero() && now.Sub(st.StuckAt) < stuckEvery {
		return decision{Why: why + " It was restarted recently. Waiting."}
	}
	return decision{Act: watchReboot, Stuck: true, Why: why + " Restarting Android."}
}

// decideDead walks the recovery ladder while adb cannot reach the device:
// adb connect, then adb reboot, then the emulator restarted from this computer.
func decideDead(st watchState, o watchObs, now time.Time, lim WatchLimits, host hostInfo) decision {
	dead := now.Sub(st.DeadSince)
	reconnect := host.TCP && now.Sub(st.LastConnect) >= connectEvery
	if now.Before(st.GraceUntil) {
		if reconnect {
			return decision{Act: watchConnect, Why: "Restarting. Reconnecting while it comes back."}
		}
		return decision{Why: "Restarting. Waiting for it to come back."}
	}
	wait := time.Duration(lim.AdbDeadSec) * time.Second
	if dead < wait {
		return decision{Why: fmt.Sprintf("adb lost the device %s ago. Waiting before acting.", ago(int64(dead.Seconds())))}
	}
	if reconnect && st.LastConnect.Before(st.DeadSince) {
		return decision{Act: watchConnect, Why: "adb lost the device. Reconnecting."}
	}
	if !st.RebootTried && o.AdbState != "" && dead >= wait+rebootAfterSec*time.Second {
		return decision{Act: watchReboot, Why: "adb still cannot reach it. Restarting Android."}
	}
	if dead >= wait+emuAfterSec*time.Second {
		ok, why := emuAllowed(st, now, lim, host)
		if ok {
			return decision{Act: watchEmulator, Why: "Still unreachable. Restarting the emulator."}
		}
		if reconnect {
			return decision{Act: watchConnect, Why: "Still unreachable. " + why}
		}
		return decision{Why: "Still unreachable. " + why}
	}
	if reconnect {
		return decision{Act: watchConnect, Why: "adb still cannot reach it. Reconnecting."}
	}
	return decision{Why: "adb still cannot reach it."}
}

// emuAllowed says whether an automatic emulator restart may happen now, and why not.
func emuAllowed(st watchState, now time.Time, lim WatchLimits, host hostInfo) (bool, string) {
	switch {
	case !host.Local || !host.Mapped:
		return false, host.Why
	case lim.EmuRestartsPer6h == 0:
		return false, "Emulator restarts are off in watch.json."
	case st.EmuFailures >= lim.EmuGiveUpAfter:
		return false, fmt.Sprintf("Gave up after %d emulator restarts that did not bring it back. Use Restart emulator now.", st.EmuFailures)
	case len(st.EmuRestarts) >= lim.EmuRestartsPer6h:
		return false, fmt.Sprintf("The emulator was restarted %d times in 6 hours. Waiting.", len(st.EmuRestarts))
	}
	// Backoff: the gap doubles with each failure in a row, up to a day.
	gap := min(time.Duration(lim.EmuRestartGapMin)*time.Minute<<min(st.EmuFailures, 10), 24*time.Hour)
	if next := st.EmuAt.Add(gap); now.Before(next) {
		return false, fmt.Sprintf("The emulator was restarted recently. The next restart may be in %s.", ago(int64(next.Sub(now).Seconds())))
	}
	return true, ""
}

// record folds what was done into the state. ok is whether the action itself worked.
func record(st watchState, d decision, ok bool, now time.Time) watchState {
	if d.Stuck {
		st.StuckAt = now
	}
	switch d.Act {
	case watchStart:
		st.Starts = append(st.Starts, now)
	case watchForceStart:
		st.ForceStarts = append(st.ForceStarts, now)
	case watchConnect:
		st.LastConnect = now
	case watchReboot:
		st.RebootTried = true
		st.GraceUntil = now.Add(watchGrace)
	case watchEmulator:
		st.EmuRestarts = append(st.EmuRestarts, now)
		st.EmuAt = now
		st.GraceUntil = now.Add(watchGrace)
		if ok {
			st.EmuPending = true
		} else {
			st.EmuFailures++
		}
	}
	return st
}

func recent(ts []time.Time, now time.Time, window time.Duration) []time.Time {
	out := ts[:0:0]
	for _, t := range ts {
		if now.Sub(t) < window {
			out = append(out, t)
		}
	}
	return out
}

func last(ts []time.Time) time.Time {
	if len(ts) == 0 {
		return time.Time{}
	}
	return ts[len(ts)-1]
}

func lastStart(st watchState) time.Time {
	a, b := last(st.Starts), last(st.ForceStarts)
	if a.After(b) {
		return a
	}
	return b
}

// ago is a duration in s as "40 s", "4 min" or "2 h".
func ago(sec int64) string {
	switch {
	case sec < 90:
		return fmt.Sprintf("%d s", max(sec, 0))
	case sec < 90*60:
		return fmt.Sprintf("%d min", (sec+30)/60)
	}
	return fmt.Sprintf("%d h", (sec+1800)/3600)
}
