package starter

import (
	"context"
	"net/http"
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
	Newer  func(a, b string) bool                // a is newer than b
	// The exit status the launcher answers by starting the program again; 0
	// when nothing waits for it, and the player restarts it by hand.
	RestartCode int
	// Off: no check in the background, only when asked.
	NoAutoCheck bool
}

// How often the running program looks for a newer version by itself.
const updateEvery = 6 * time.Hour

// UpdateState is what the page shows about updates.
type UpdateState struct {
	Current    string `json:"current"`
	Latest     string `json:"latest,omitempty"`
	Available  bool   `json:"available"`
	Checked    string `json:"checked,omitempty"` // RFC 3339
	Error      string `json:"error,omitempty"`
	Disabled   bool   `json:"disabled"`   // this build has no update address
	CanRestart bool   `json:"canRestart"` // a launcher starts the new version
	Installed  bool   `json:"installed"`  // replaced; takes effect on a restart
}

type updates struct {
	mu       sync.Mutex
	u        *Updater
	state    UpdateState
	applying sync.Mutex
	restart  bool
}

// SetUpdater turns on the page's update routes. Call it before serving.
func (s *Starter) SetUpdater(u Updater) { s.upd.u = &u }

// RestartCode is the exit status to leave with: non-zero once an update asked
// for a restart.
func (s *Starter) RestartCode() int {
	s.upd.mu.Lock()
	defer s.upd.mu.Unlock()
	if s.upd.restart && s.upd.u != nil {
		return s.upd.u.RestartCode
	}
	return 0
}

func (s *Starter) updateState() UpdateState {
	s.upd.mu.Lock()
	defer s.upd.mu.Unlock()
	st := s.upd.state
	st.Current = s.version
	st.Disabled = s.upd.u == nil
	st.CanRestart = s.upd.u != nil && s.upd.u.RestartCode != 0
	return st
}

// checkUpdate asks the pin for the newest version and remembers the answer.
func (s *Starter) checkUpdate() UpdateState {
	if s.upd.u == nil {
		return s.updateState()
	}
	latest, err := s.upd.u.Latest()
	s.upd.mu.Lock()
	s.upd.state.Checked = time.Now().UTC().Format(time.RFC3339)
	if err != nil {
		s.upd.state.Error = err.Error()
	} else {
		s.upd.state.Error = ""
		s.upd.state.Latest = latest
		s.upd.state.Available = !s.upd.state.Installed && s.upd.u.Newer(latest, s.version)
	}
	s.upd.mu.Unlock()
	return s.updateState()
}

// mountUpdates adds /api/starter/update{,/check,/apply} and the background check.
func (s *Starter) mountUpdates(se *core.ServeEvent, g *router.RouterGroup[*core.RequestEvent]) {
	server := se.Server
	if s.upd.u != nil && !s.upd.u.NoAutoCheck {
		go func() {
			for {
				s.checkUpdate()
				time.Sleep(updateEvery)
			}
		}()
	}

	g.GET("/update", func(e *core.RequestEvent) error {
		return e.JSON(http.StatusOK, s.updateState())
	})

	g.POST("/update/check", func(e *core.RequestEvent) error {
		return e.JSON(http.StatusOK, s.checkUpdate())
	})

	// Downloads the new version, then, when a launcher waits for it, stops
	// serving so the launcher starts it. The page reloads once it answers.
	g.POST("/update/apply", func(e *core.RequestEvent) error {
		if s.upd.u == nil {
			return e.BadRequestError("This build cannot update itself.", nil)
		}
		if !s.upd.applying.TryLock() {
			return e.JSON(http.StatusConflict, map[string]any{"message": "An update is already running."})
		}
		defer s.upd.applying.Unlock()
		restart := false
		err := stream(e, func(logf func(string)) Result {
			done, err := s.upd.u.Apply(logf)
			if err != nil {
				return Result{Msg: "The update failed: " + err.Error() + ". Nothing was changed."}
			}
			if !done {
				return Result{OK: true, Msg: "tsum-stats " + s.version + " is already the newest version."}
			}
			s.upd.mu.Lock()
			s.upd.state.Installed, s.upd.state.Available = true, false
			restart = s.upd.u.RestartCode != 0
			s.upd.restart = restart
			s.upd.mu.Unlock()
			if restart {
				return Result{OK: true, Restart: true, Msg: "Updated. Restarting the starter with the new version ..."}
			}
			return Result{OK: true, Msg: "Updated. Close this window's terminal and start the starter again to use it."}
		})
		if restart {
			// After this reply has gone out; Shutdown waits for it to finish.
			go func() {
				time.Sleep(300 * time.Millisecond)
				ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
				defer cancel()
				// The stats page's realtime stream never goes idle; cut it.
				if server.Shutdown(ctx) != nil {
					server.Close()
				}
			}()
		}
		return err
	})
}
