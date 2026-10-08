package starter

import (
	"context"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/router"
)

// Updater is how the page updates the program serving it. main supplies it,
// since only main knows the pin address and its own binary.
type Updater struct {
	Latest func() (string, error)                // the newest published version
	Apply  func(logf func(string)) (bool, error) // replaces the binary when newer
	// The exit status the launcher answers by starting the program again; 0
	// when nothing waits for it, and the player restarts it by hand.
	RestartCode int
}

// How often the running program looks for newer versions by itself.
const updateEvery = 6 * time.Hour

// UpdateState is what the page shows about one of the two updates.
type UpdateState struct {
	Current    string `json:"current"`
	Latest     string `json:"latest,omitempty"`
	Available  bool   `json:"available"`
	Error      string `json:"error,omitempty"`
	Disabled   bool   `json:"disabled"`   // nothing to update from
	CanRestart bool   `json:"canRestart"` // the launcher starts the new version
	Installed  bool   `json:"installed"`  // in place; takes effect on a restart
}

// Updates is GET /api/starter/update: tsum-stats, the bundle's scripts, and
// when they were last checked.
type Updates struct {
	Stats   UpdateState `json:"stats"`
	Starter UpdateState `json:"starter"`
	Checked string      `json:"checked,omitempty"` // RFC 3339
	Boot    string      `json:"boot"`              // this process; a restart changes it
}

// Tells the page a restarted starter from the one it asked to restart.
var boot = strconv.FormatInt(time.Now().UnixNano(), 36)

type updates struct {
	mu       sync.Mutex
	u        *Updater
	stats    UpdateState
	starter  UpdateState
	checked  string
	applying sync.Mutex
	exitCode int // set once an update asked the launcher for a restart
}

// SetUpdater turns on updating tsum-stats from the page. Call it before serving.
func (s *Starter) SetUpdater(u Updater) { s.upd.u = &u }

// RestartCode is the exit status to leave with: non-zero once an update asked
// for a restart.
func (s *Starter) RestartCode() int {
	s.upd.mu.Lock()
	defer s.upd.mu.Unlock()
	return s.upd.exitCode
}

// The exit status the launcher answers by starting itself again, scripts and
// all (GAP_STARTER_RELOAD_CODE); 0 for a launcher that cannot.
func reloadCode() int {
	n, _ := strconv.Atoi(os.Getenv("GAP_STARTER_RELOAD_CODE"))
	return n
}

func (s *Starter) updateState() Updates {
	s.upd.mu.Lock()
	defer s.upd.mu.Unlock()
	st := s.upd.stats
	st.Current = s.version
	st.Disabled = s.upd.u == nil
	st.CanRestart = s.upd.u != nil && s.upd.u.RestartCode != 0
	bs := s.upd.starter
	bs.Current, _ = s.bundleVersion()
	bs.Disabled = !s.bundleUpdatable()
	bs.CanRestart = reloadCode() != 0
	return Updates{Stats: st, Starter: bs, Checked: s.upd.checked, Boot: boot}
}

// checkUpdates asks both pins for their newest version and remembers the answers.
func (s *Starter) checkUpdates() Updates {
	var statsLatest, starterLatest string
	var statsErr, starterErr error
	var wg sync.WaitGroup
	if s.upd.u != nil {
		wg.Add(1)
		go func() { defer wg.Done(); statsLatest, statsErr = s.upd.u.Latest() }()
	}
	if s.bundleUpdatable() {
		wg.Add(1)
		go func() { defer wg.Done(); starterLatest, starterErr = s.latestBundle() }()
	}
	wg.Wait()
	current, _ := s.bundleVersion()

	s.upd.mu.Lock()
	s.upd.checked = time.Now().UTC().Format(time.RFC3339)
	note := func(st *UpdateState, latest, current string, err error) {
		if err != nil {
			st.Error = err.Error()
			return
		}
		st.Error, st.Latest = "", latest
		st.Available = !st.Installed && newerVersion(latest, current)
	}
	if s.upd.u != nil {
		note(&s.upd.stats, statsLatest, s.version, statsErr)
	}
	if s.bundleUpdatable() {
		note(&s.upd.starter, starterLatest, current, starterErr)
	}
	s.upd.mu.Unlock()
	return s.updateState()
}

// newerVersion reports whether dotted version a is newer than b; a missing
// part counts as 0.
func newerVersion(a, b string) bool {
	as, bs := strings.Split(a, "."), strings.Split(b, ".")
	for i := 0; i < len(as) || i < len(bs); i++ {
		var x, y int
		if i < len(as) {
			x, _ = strconv.Atoi(as[i])
		}
		if i < len(bs) {
			y, _ = strconv.Atoi(bs[i])
		}
		if x != y {
			return x > y
		}
	}
	return false
}

// mountUpdates adds /api/starter/update{,/check,/apply,/starter} and the
// background check.
func (s *Starter) mountUpdates(se *core.ServeEvent, g *router.RouterGroup[*core.RequestEvent]) {
	server := se.Server
	if os.Getenv("TSUM_STATS_NO_UPDATE") == "" && (s.upd.u != nil || s.bundleUpdatable()) {
		go func() {
			for {
				s.checkUpdates()
				time.Sleep(updateEvery)
			}
		}()
	}

	g.GET("/update", func(e *core.RequestEvent) error {
		return e.JSON(http.StatusOK, s.updateState())
	})

	g.POST("/update/check", func(e *core.RequestEvent) error {
		return e.JSON(http.StatusOK, s.checkUpdates())
	})

	// Installs an update, then, when the launcher waits for it, stops serving
	// so the launcher starts the new one. The page reloads once it answers.
	apply := func(e *core.RequestEvent, what string, state *UpdateState, code int,
		run func(logf func(string)) (bool, error)) error {
		if !s.upd.applying.TryLock() {
			return e.JSON(http.StatusConflict, map[string]any{"message": "An update is already running."})
		}
		defer s.upd.applying.Unlock()
		restart := false
		err := stream(e, func(logf func(string)) Result {
			done, err := run(logf)
			if err != nil {
				return Result{Msg: "The update failed: " + err.Error() + ". Nothing was changed."}
			}
			if !done {
				return Result{OK: true, Msg: "The " + what + " is already the newest version."}
			}
			s.upd.mu.Lock()
			state.Installed, state.Available = true, false
			restart = code != 0
			if restart {
				s.upd.exitCode = code
			}
			s.upd.mu.Unlock()
			if restart {
				return Result{OK: true, Restart: true, Msg: "Updated. Restarting the starter with the new version ..."}
			}
			return Result{OK: true, Msg: "Updated. Close this window's terminal and start the starter again to use it."}
		})
		if restart {
			go stopServing(server)
		}
		return err
	}

	g.POST("/update/apply", func(e *core.RequestEvent) error {
		if s.upd.u == nil {
			return e.BadRequestError("This build cannot update itself.", nil)
		}
		return apply(e, "tsum-stats", &s.upd.stats, s.upd.u.RestartCode, s.upd.u.Apply)
	})

	g.POST("/update/starter", func(e *core.RequestEvent) error {
		if !s.bundleUpdatable() {
			return e.BadRequestError("This copy of the starter has no update address.", nil)
		}
		return apply(e, "starter", &s.upd.starter, reloadCode(), s.applyBundle)
	})
}

// stopServing ends the HTTP server once the reply has gone out, so main can
// exit with the restart code.
func stopServing(server *http.Server) {
	time.Sleep(300 * time.Millisecond)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	// The stats page's realtime stream never goes idle; cut it.
	if server.Shutdown(ctx) != nil {
		server.Close()
	}
}
