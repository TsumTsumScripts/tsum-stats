package stats

import (
	"bufio"
	"encoding/json"
	"log/slog"
	"net"
	"sort"
	"sync"
	"time"

	"github.com/pocketbase/pocketbase/core"
)

// Device is what the listener knows about one emulator, from its event stream.
type Device struct {
	Device        string     `json:"device"`
	Script        string     `json:"script"`
	ScriptVersion string     `json:"scriptVersion"`
	Active        bool       `json:"active"`
	Paused        bool       `json:"paused"`
	Online        bool       `json:"online"`
	LastSeen      time.Time  `json:"lastSeen"`
	Round         *LiveRound `json:"round,omitempty"`
	conns         int
}

// LiveRound is a round that has started and not yet ended.
type LiveRound struct {
	ID        string `json:"id"`
	Round     int    `json:"round"`
	Tsum      string `json:"tsum"`
	Skill     string `json:"skill"`
	Build     string `json:"build"`
	StartedAt string `json:"startedAt"`
	// Tally is true once the board is over and the score is being counted.
	Tally bool `json:"tally"`
}

// A device that has sent nothing for this long is shown offline; the host
// sends a heartbeat every 15s.
const staleAfter = 45 * time.Second

// wireLine is one line of docs/EVENTS.md's wire format.
type wireLine struct {
	Type    string          `json:"type"`
	Token   string          `json:"token"`
	Device  string          `json:"device"`
	At      string          `json:"at"`
	Script  string          `json:"script"`
	Active  bool            `json:"active"`
	Paused  bool            `json:"paused"`
	Event   string          `json:"event"`
	Data    json.RawMessage `json:"data"`
	Seq     int64           `json:"seq"`
	Dropped int64           `json:"dropped"`
}

// roundData is the union of the round.* payloads (app.gap.Tsum/EVENTS.md).
type roundData struct {
	ID         string          `json:"id"`
	Round      int             `json:"round"`
	MyTsum     string          `json:"myTsum"`
	Skill      string          `json:"skill"`
	Build      string          `json:"build"`
	Seconds    *float64        `json:"seconds"`
	Score      *int64          `json:"score"`
	BaseCoins  *int64          `json:"baseCoins"`
	FinalCoins *int64          `json:"finalCoins"`
	Medals     *int64          `json:"medals"`
	Settings   json.RawMessage `json:"settings"`
	Version    string          `json:"version"`
}

// Events receives the host's script event stream. It only ever reads: nothing
// is written back to a device.
type Events struct {
	app     core.App
	token   string
	mu      sync.Mutex
	devices map[string]*Device
	// devicesChanged and roundStored feed the site's realtime updates.
	devicesChanged func([]Device)
	roundStored    func(Round)
}

func NewEvents(app core.App, token string, devicesChanged func([]Device), roundStored func(Round)) *Events {
	return &Events{app: app, token: token, devices: map[string]*Device{}, devicesChanged: devicesChanged, roundStored: roundStored}
}

// Listen accepts devices dialling in (EVENTS.md case 3).
func (ev *Events) Listen(addr string) (net.Listener, error) {
	l, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, err
	}
	go func() {
		for {
			conn, err := l.Accept()
			if err != nil {
				return
			}
			go ev.consume(conn)
		}
	}()
	return l, nil
}

// Dial connects to a device's own listener through `adb forward` (EVENTS.md
// case 1), and reconnects every few seconds until stop is closed.
func (ev *Events) Dial(addr string, stop <-chan struct{}) {
	for {
		if conn, err := net.DialTimeout("tcp", addr, 3*time.Second); err == nil {
			done := make(chan struct{})
			go func() {
				select {
				case <-stop:
					conn.Close()
				case <-done:
				}
			}()
			ev.consume(conn)
			close(done)
		}
		select {
		case <-stop:
			return
		case <-time.After(5 * time.Second):
		}
	}
}

// Devices is a snapshot, sorted by name, with Online worked out now.
func (ev *Events) Devices() []Device {
	ev.mu.Lock()
	defer ev.mu.Unlock()
	return ev.snapshotLocked()
}

func (ev *Events) snapshotLocked() []Device {
	out := make([]Device, 0, len(ev.devices))
	for _, d := range ev.devices {
		c := *d
		c.Online = d.conns > 0 && time.Since(d.LastSeen) < staleAfter
		out = append(out, c)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Device < out[j].Device })
	return out
}

func (ev *Events) consume(conn net.Conn) {
	defer conn.Close()
	sc := bufio.NewScanner(conn)
	sc.Buffer(make([]byte, 64*1024), 1<<20)
	device := ""
	defer func() {
		if device != "" {
			ev.update(device, func(d *Device) { d.conns-- })
		}
	}()
	for sc.Scan() {
		var line wireLine
		if err := json.Unmarshal(sc.Bytes(), &line); err != nil {
			continue
		}
		if device == "" {
			// The first line must be the hello, and it must carry our token.
			if line.Type != "hello" || (ev.token != "" && line.Token != ev.token) || line.Device == "" {
				ev.app.Logger().Warn("Refused an event connection", slog.String("from", conn.RemoteAddr().String()),
					slog.String("type", line.Type), slog.String("device", line.Device))
				return
			}
			device = line.Device
			ev.update(device, func(d *Device) {
				d.conns++
				d.Script, d.Active, d.Paused = line.Script, line.Active, line.Paused
			})
			continue
		}
		ev.handle(device, line)
	}
}

func (ev *Events) handle(device string, line wireLine) {
	switch line.Type {
	case "state":
		ev.update(device, func(d *Device) {
			d.Script, d.Active, d.Paused = line.Script, line.Active, line.Paused
			if !d.Active {
				d.Round = nil
			}
		})
	case "heartbeat":
		// Announced like any change: the page judges online from lastSeen,
		// so a quiet heartbeat would let an idle device go stale there.
		ev.update(device, func(*Device) {})
	case "event":
		ev.handleEvent(device, line)
	}
}

func (ev *Events) handleEvent(device string, line wireLine) {
	var data roundData
	_ = json.Unmarshal(line.Data, &data)
	switch line.Event {
	case "run.started":
		ev.update(device, func(d *Device) { d.ScriptVersion = data.Version })
	case "run.stopped":
		ev.update(device, func(d *Device) { d.Round = nil })
	case "round.start":
		ev.update(device, func(d *Device) {
			d.Round = &LiveRound{ID: data.ID, Round: data.Round, Tsum: data.MyTsum, Skill: data.Skill, Build: data.Build, StartedAt: line.At}
		})
	case "round.over":
		ev.update(device, func(d *Device) {
			if d.Round != nil && d.Round.ID == data.ID {
				d.Round.Tally = true
			}
		})
	case "round.end":
		ev.roundEnd(device, line, data)
	}
}

func (ev *Events) roundEnd(device string, line wireLine, data roundData) {
	if data.ID == "" {
		return
	}
	at, ok := normalizeTime(line.At)
	if !ok {
		at = time.Now().UTC().Format(sqlTime)
	}
	r := Round{
		ID: data.ID, PlayedAt: at, Tsum: data.MyTsum, Build: data.Build, SkillType: data.Skill,
		Duration: data.Seconds, Score: data.Score, BaseCoins: data.BaseCoins, FinalCoins: data.FinalCoins,
		Medals: data.Medals, Device: device, Source: SourceEvent,
	}
	if len(data.Settings) > 0 && data.Settings[0] == '{' {
		r.Settings = string(data.Settings)
	}
	ev.update(device, func(d *Device) {
		r.ScriptVersion = d.ScriptVersion
		// A host older than the build/myTsum fields on round.end: take them from the start.
		if d.Round != nil && d.Round.ID == data.ID {
			if r.Tsum == "" {
				r.Tsum = d.Round.Tsum
			}
			if r.Build == "" {
				r.Build = d.Round.Build
			}
			if r.SkillType == "" {
				r.SkillType = d.Round.Skill
			}
		}
		d.Round = nil
	})
	if err := upsertRound(ev.app.DB(), r); err != nil {
		ev.app.Logger().Error("Could not store a round from an event", slog.String("id", r.ID), slog.String("error", err.Error()))
		return
	}
	if ev.roundStored != nil {
		ev.roundStored(r)
	}
}

// update applies fn to a device's record, creating it, and announces the result.
func (ev *Events) update(device string, fn func(*Device)) {
	ev.mu.Lock()
	d := ev.devices[device]
	if d == nil {
		d = &Device{Device: device}
		ev.devices[device] = d
	}
	d.LastSeen = time.Now()
	fn(d)
	snap := ev.snapshotLocked()
	ev.mu.Unlock()
	if ev.devicesChanged != nil {
		ev.devicesChanged(snap)
	}
}
