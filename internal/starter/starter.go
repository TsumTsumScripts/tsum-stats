// Package starter is the service starter's website: the page at /starter/ and
// the /api/starter routes behind it. It drives devices over adb the way the
// starter bundle's terminal menu does, using the bundle's device script, and
// hands round stats to the stats site's own importer.
package starter

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/TsumTsumScripts/tsum-stats/internal/stats"
	"github.com/pocketbase/pocketbase/core"
)

//go:embed all:site
var siteFS embed.FS

// Starter serves one bundle folder: its device script, apk/, collected/,
// adb/, channel.txt and last-device.txt.
type Starter struct {
	bundle  string
	storage string
	version string

	mu        sync.Mutex
	adbPath   string
	adbState  adbInfo
	locks     map[string]*sync.Mutex
	rows      map[string]Device
	setADB    func(string) // tells the stats importer which adb to use
	importer  func(ctx context.Context, serial string) importOutcome
	downloads sync.Mutex
	upd       updates
}

type importOutcome struct {
	Copied, Rounds, Lists int
	Errors                []string
	Err                   string
}

// New checks that dir is a starter bundle.
func New(dir, version string) (*Starter, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return nil, err
	}
	if _, err := os.Stat(filepath.Join(abs, "device", "gap-service.sh")); err != nil {
		return nil, errors.New(abs + " is not a starter bundle: it has no device/gap-service.sh")
	}
	storage := strings.TrimRight(os.Getenv("GAP_STORAGE_ROOT"), "/")
	if storage == "" {
		storage = defaultStorage
	}
	return &Starter{bundle: abs, storage: storage, version: version,
		locks: map[string]*sync.Mutex{}, rows: map[string]Device{}}, nil
}

// Collected is where copies off a device land, which the stats importer also scans.
func (s *Starter) Collected() string { return filepath.Join(s.bundle, "collected") }

// Storage is the app's folder on the device.
func (s *Starter) Storage() string { return s.storage }

// useADB resolves adb and, once there is one, starts its server and shares it.
func (s *Starter) useADB() adbInfo {
	info := s.resolveADB()
	if !info.Missing {
		info.Warning = s.startServer(info.Path)
	}
	s.mu.Lock()
	s.adbPath, s.adbState = info.Path, info
	set := s.setADB
	s.mu.Unlock()
	if set != nil && info.Path != "" {
		set(info.Path)
	}
	return info
}

// Mount is stats.StarterHook: it adds the page and the routes, and shares the
// stats site's device import.
func (s *Starter) Mount(se *core.ServeEvent, puller *stats.Puller) {
	s.setADB = puller.SetADB
	s.importer = func(ctx context.Context, serial string) importOutcome {
		res, err := puller.Pull(ctx, []string{serial})
		if err != nil {
			return importOutcome{Err: err.Error()}
		}
		r := res[0]
		out := importOutcome{Copied: r.Copied, Rounds: r.Result.Rounds, Lists: r.Result.Lists, Errors: r.Result.Errors, Err: r.Error}
		if r.Found == 0 && r.Error != "" {
			out.Err = "No round stats or Tsum lists on this device.\nNothing matched stats_*.csv or tsum_list_*.csv under " + s.storage + "."
		}
		return out
	}
	_ = os.MkdirAll(s.Collected(), 0o755)
	s.useADB()

	site, _ := fs.Sub(siteFS, "site")
	files := http.StripPrefix("/starter/", http.FileServerFS(site))
	se.Router.GET("/starter", func(e *core.RequestEvent) error { return e.Redirect(http.StatusFound, "/starter/") })
	se.Router.GET("/starter/{path...}", func(e *core.RequestEvent) error {
		e.Response.Header().Set("Cache-Control", "no-cache")
		files.ServeHTTP(e.Response, e.Request)
		return nil
	})

	g := se.Router.Group("/api/starter")
	g.BindFunc(localOnly)
	s.mountUpdates(se, g)

	g.GET("/status", func(e *core.RequestEvent) error {
		s.mu.Lock()
		info := s.adbState
		s.mu.Unlock()
		base := s.releaseBase()
		channel := ""
		if base != defaultReleaseBase {
			channel = base
		}
		last, _ := os.ReadFile(filepath.Join(s.bundle, "last-device.txt"))
		starterVersion, _ := s.bundleVersion()
		return e.JSON(http.StatusOK, map[string]any{
			"version": s.version, "starterVersion": starterVersion, "bundle": s.bundle, "storage": s.storage, "adb": info,
			"channel": channel, "hasApks": len(s.bundledAPKs("")) > 0,
			"lastDevice": strings.TrimSpace(string(last)), "collected": s.Collected(),
		})
	})

	g.POST("/adb/download", func(e *core.RequestEvent) error {
		if !s.downloads.TryLock() {
			return e.JSON(http.StatusConflict, map[string]any{"message": "adb is already downloading."})
		}
		defer s.downloads.Unlock()
		return stream(e, func(logf func(string)) Result {
			if err := s.downloadADB(logf); err != nil {
				return Result{Msg: err.Error()}
			}
			info := s.useADB()
			return Result{OK: true, Msg: "adb is ready (" + info.Source + ")."}
		})
	})

	// Restarts the adb server, for devices that should be listed but are not.
	g.POST("/adb/restart", func(e *core.RequestEvent) error {
		if s.adb() == "" {
			return e.BadRequestError("adb is not ready yet.", nil)
		}
		return stream(e, func(logf func(string)) Result {
			return s.restartServer(e.Request.Context(), logf)
		})
	})

	g.GET("/devices", func(e *core.RequestEvent) error {
		if s.adb() == "" {
			return e.JSON(http.StatusOK, map[string]any{"devices": []Device{}, "noAdb": true})
		}
		return e.JSON(http.StatusOK, map[string]any{"devices": s.Devices(e.Request.Context()), "ports": emuPorts})
	})

	g.GET("/device", func(e *core.RequestEvent) error {
		row, ok := s.DeviceRow(e.Request.Context(), e.Request.URL.Query().Get("serial"))
		if !ok {
			return e.JSON(http.StatusOK, map[string]any{"gone": true})
		}
		return e.JSON(http.StatusOK, map[string]any{"device": row})
	})

	g.POST("/remember", func(e *core.RequestEvent) error {
		var body struct{ Serial string }
		if err := e.BindBody(&body); err != nil {
			return e.BadRequestError("Expected a serial.", err)
		}
		// Best effort: a bundle on read-only media just forgets between runs.
		_ = os.WriteFile(filepath.Join(s.bundle, "last-device.txt"), []byte(body.Serial+"\n"), 0o644)
		return e.NoContent(http.StatusNoContent)
	})

	g.GET("/apks", func(e *core.RequestEvent) error {
		abi := e.Request.URL.Query().Get("abi")
		return e.JSON(http.StatusOK, map[string]any{"apks": s.bundledAPKs(abi)})
	})

	// The files a delete would remove, for the page to show before it asks.
	g.GET("/files", func(e *core.RequestEvent) error {
		q := e.Request.URL.Query()
		k, ok := fileKinds[q.Get("kind")]
		if !ok {
			return e.BadRequestError("Unknown kind.", nil)
		}
		files := s.deviceFiles(e.Request.Context(), q.Get("serial"), k.glob)
		rel := make([]string, 0, len(files))
		for _, f := range files {
			rel = append(rel, strings.TrimPrefix(f, s.storage+"/"))
		}
		return e.JSON(http.StatusOK, map[string]any{"files": rel, "glob": k.glob, "storage": s.storage})
	})

	g.POST("/action", func(e *core.RequestEvent) error {
		var body struct {
			Serial string  `json:"serial"`
			Action string  `json:"action"`
			Opts   Options `json:"options"`
		}
		if err := e.BindBody(&body); err != nil || body.Serial == "" || body.Action == "" {
			return e.BadRequestError("Expected a serial and an action.", err)
		}
		if s.adb() == "" {
			return e.BadRequestError("adb is not ready yet.", nil)
		}
		return stream(e, func(logf func(string)) Result {
			return s.Run(e.Request.Context(), body.Serial, body.Action, body.Opts, logf)
		})
	})

	g.POST("/channel", func(e *core.RequestEvent) error {
		var body struct{ URL string }
		if err := e.BindBody(&body); err != nil {
			return e.BadRequestError("Expected a URL.", err)
		}
		base, err := s.setChannel(body.URL)
		if err != nil {
			return e.BadRequestError(err.Error(), err)
		}
		channel := ""
		if base != defaultReleaseBase {
			channel = base
		}
		return e.JSON(http.StatusOK, map[string]any{"channel": channel})
	})

	// The zip, as a download (mode "download") or saved where the computer's
	// own dialog says (mode "dialog", for browsers with no save picker).
	g.POST("/export", func(e *core.RequestEvent) error {
		var body struct {
			ExportRequest
			Mode string `json:"mode"`
		}
		if err := e.BindBody(&body); err != nil || len(body.Serials) == 0 || len(body.Parts) == 0 {
			return e.BadRequestError("Choose a device and at least one thing to export.", err)
		}
		_ = http.NewResponseController(e.Response).SetWriteDeadline(time.Time{})
		name := exportName(body.Serials)
		ctx := e.Request.Context()
		if body.Mode == "dialog" {
			path, err := saveDialog(ctx, name)
			if errors.Is(err, errNoDialog) {
				return e.JSON(http.StatusOK, map[string]any{"unsupported": true})
			}
			if err != nil {
				return e.JSON(http.StatusOK, map[string]any{"cancelled": true})
			}
			f, err := os.Create(path)
			if err != nil {
				return e.BadRequestError("Could not write "+path+": "+err.Error(), err)
			}
			err = s.writeExport(ctx, f, body.ExportRequest)
			if cerr := f.Close(); err == nil {
				err = cerr
			}
			if err != nil {
				os.Remove(path)
				return e.InternalServerError("The export failed: "+err.Error(), err)
			}
			return e.JSON(http.StatusOK, map[string]any{"path": path})
		}
		e.Response.Header().Set("Content-Type", "application/zip")
		e.Response.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
		e.Response.Header().Set("X-Export-Name", name)
		return s.writeExport(ctx, e.Response, body.ExportRequest)
	})

	// Opens a folder of the bundle's, or shows a file the export wrote.
	g.POST("/reveal", func(e *core.RequestEvent) error {
		var body struct{ Path string }
		if err := e.BindBody(&body); err != nil || body.Path == "" {
			return e.BadRequestError("Expected a path.", err)
		}
		p := filepath.Clean(body.Path)
		if rel, err := filepath.Rel(s.bundle, p); err == nil && filepath.IsLocal(rel) || p == s.bundle {
			_ = os.MkdirAll(p, 0o755)
			return revealOK(e, openFolder(p))
		}
		if strings.HasSuffix(strings.ToLower(p), ".zip") && isExec(p) {
			return revealOK(e, revealFile(p))
		}
		return e.ForbiddenError("Only the bundle's folders and saved exports can be opened.", nil)
	})
}

func revealOK(e *core.RequestEvent, err error) error {
	if err != nil {
		return e.BadRequestError(err.Error(), err)
	}
	return e.NoContent(http.StatusNoContent)
}

// localOnly guards routes that run adb on this computer: the Host must be a
// loopback name (no DNS rebinding) and a write must come from this origin.
func localOnly(e *core.RequestEvent) error {
	host, _, err := net.SplitHostPort(e.Request.Host)
	if err != nil {
		host = e.Request.Host
	}
	host = strings.Trim(host, "[]")
	if ip := net.ParseIP(host); !(host == "localhost" || ip != nil && ip.IsLoopback()) {
		return e.ForbiddenError("The starter only answers on this computer.", nil)
	}
	if e.Request.Method != http.MethodGet {
		origin := e.Request.Header.Get("Origin")
		if origin != "" {
			u, err := url.Parse(origin)
			if err != nil || !strings.EqualFold(u.Host, e.Request.Host) {
				return e.ForbiddenError("Cross-origin request refused.", nil)
			}
		}
		if !strings.HasPrefix(e.Request.Header.Get("Content-Type"), "application/json") {
			return e.BadRequestError("Expected JSON.", nil)
		}
	}
	return e.Next()
}

// stream runs fn and sends its log as NDJSON while it runs:
// {"log": "..."} per line, then {"done": true, "ok": .., "msg": ..}.
func stream(e *core.RequestEvent, fn func(logf func(string)) Result) error {
	rc := http.NewResponseController(e.Response)
	_ = rc.SetWriteDeadline(time.Time{})
	e.Response.Header().Set("Content-Type", "application/x-ndjson")
	e.Response.Header().Set("Cache-Control", "no-cache")
	e.Response.WriteHeader(http.StatusOK)
	var mu sync.Mutex
	enc := json.NewEncoder(e.Response)
	send := func(v any) {
		mu.Lock()
		defer mu.Unlock()
		_ = enc.Encode(v)
		_ = rc.Flush()
	}
	res := fn(func(line string) { send(map[string]string{"log": line}) })
	send(map[string]any{"done": true, "ok": res.OK, "msg": res.Msg, "path": res.Path, "restart": res.Restart})
	return nil
}
