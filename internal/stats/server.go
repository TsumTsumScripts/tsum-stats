package stats

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"log"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/subscriptions"
)

// Config is set from the command line.
type Config struct {
	EventsAddr    string   // listen for devices dialling in; "" disables
	EventsConnect []string // dial a device's listener through adb forward
	EventsToken   string
	ImportDirs    []string
	ScanInterval  time.Duration
	WebDir        string      // files here override the embedded site's
	ADB           string      // adb for importing from devices; "" looks for one
	DeviceStorage string      // the app's storage root on the device
	Version       string      // this build's, for WebDir's override.json
	Starter       StarterHook // the service starter's page and routes; nil without --starter
}

// StarterHook mounts the service starter (internal/starter) beside the stats
// site. It supplies the adb, so the stats site does not download its own.
type StarterHook interface {
	Mount(se *core.ServeEvent, puller *Puller)
}

// Realtime topics the page subscribes to through PocketBase's /api/realtime.
const (
	TopicDevices = "ts/devices"
	TopicRounds  = "ts/rounds"
	TopicImports = "ts/imports"
	// TopicPublish is in publish.go.
)

// Register wires the tables, the listener, the importer, the routes and the
// site (see SiteFS) into app.
func Register(app core.App, cfg *Config, embedded fs.FS) {
	var (
		events   *Events
		importer *Importer
		stop     = make(chan struct{})
	)

	app.OnBootstrap().BindFunc(func(e *core.BootstrapEvent) error {
		if err := e.Next(); err != nil {
			return err
		}
		return migrate(e.App)
	})

	app.OnServe().BindFunc(func(se *core.ServeEvent) error {
		// No superuser prompt on first run: the site needs no login, and the
		// admin UI stays reachable through `tsum-stats superuser upsert`.
		se.InstallerFunc = nil

		bc := newBroadcaster(se.App, stop)
		events = NewEvents(se.App, cfg.EventsToken,
			func(d []Device) { bc.send(TopicDevices, d) },
			func(r Round) { bc.send(TopicRounds, r) })
		if cfg.EventsAddr != "" {
			l, err := events.Listen(cfg.EventsAddr)
			if err != nil {
				return err
			}
			se.App.Logger().Info("Listening for script events", "addr", l.Addr().String())
			if !IsLoopback(cfg.EventsAddr) && cfg.EventsToken == "" {
				log.Printf("Script events are accepted from any device on the network at %s; --events-token asks them for a shared word", cfg.EventsAddr)
			}
			se.App.OnTerminate().BindFunc(func(e *core.TerminateEvent) error {
				l.Close()
				return e.Next()
			})
		}
		for _, addr := range cfg.EventsConnect {
			go events.Dial(addr, stop)
		}

		// Files pulled from devices go to the first --import-dir, else to one beside the database.
		dirs := append(append([]string{}, cfg.ImportDirs...), DefaultImportDirs()...)
		pullDest := filepath.Join(se.App.DataDir(), "collected")
		if len(cfg.ImportDirs) > 0 {
			pullDest = cfg.ImportDirs[0]
		} else {
			dirs = append(dirs, pullDest)
		}
		importer = NewImporter(se.App, dirs, func(r ImportResult) { bc.send(TopicImports, r) })
		puller := NewPuller(cfg.ADB, cfg.DeviceStorage, pullDest, importer)
		go importer.Run(cfg.ScanInterval, stop)
		if cfg.Starter != nil {
			cfg.Starter.Mount(se, puller)
		} else if puller.ADB() == "" {
			go puller.InstallADB(filepath.Join(se.App.DataDir(), "adb"))
		}
		se.App.OnTerminate().BindFunc(func(e *core.TerminateEvent) error {
			close(stop)
			return e.Next()
		})

		site, overlay, err := SiteFS(embedded, cfg.WebDir, cfg.Version)
		if err != nil {
			return fmt.Errorf("--web-dir: %w", err)
		}
		publisher := NewPublisher(se.App.DataDir(), site, se.App.DB, cfg.Version,
			func(st PublishState) { bc.send(TopicPublish, st) })
		registerRoutes(se, events, importer, puller, publisher, overlay, embedded, cfg)
		se.Router.GET("/{path...}", serveSite(site))
		return se.Next()
	})
}

func registerRoutes(se *core.ServeEvent, events *Events, importer *Importer, puller *Puller, publisher *Publisher, overlay *Overlay, embedded fs.FS, cfg *Config) {
	g := se.Router.Group("/api/stats")

	// The Theme menu: built-in themes, plus the player's in --web-dir/themes.
	g.GET("/themes", func(e *core.RequestEvent) error {
		if overlay != nil {
			return e.JSON(http.StatusOK, overlay.Themes())
		}
		return e.JSON(http.StatusOK, Themes(embedded))
	})

	g.GET("/rounds", func(e *core.RequestEvent) error {
		q := e.Request.URL.Query()
		page, _ := strconv.Atoi(q.Get("page"))
		perPage, _ := strconv.Atoi(q.Get("perPage"))
		rows, err := RoundsPage(e.App.DB(), ParseFilter(q), q.Get("sort"), page, perPage)
		if err != nil {
			return e.InternalServerError("", err)
		}
		return e.JSON(http.StatusOK, map[string]any{"items": rows, "page": max(page, 1)})
	})

	g.GET("/summary", func(e *core.RequestEvent) error {
		q := e.Request.URL.Query()
		tz, _ := strconv.Atoi(q.Get("tz"))
		s, err := Summarize(e.App.DB(), ParseFilter(q), tz)
		if err != nil {
			return e.InternalServerError("", err)
		}
		return e.JSON(http.StatusOK, s)
	})

	g.GET("/tsums", func(e *core.RequestEvent) error {
		t, err := PlayedTsums(e.App.DB())
		if err != nil {
			return e.InternalServerError("", err)
		}
		return e.JSON(http.StatusOK, t)
	})

	g.GET("/round-devices", func(e *core.RequestEvent) error {
		d, err := PlayedDevices(e.App.DB())
		if err != nil {
			return e.InternalServerError("", err)
		}
		return e.JSON(http.StatusOK, d)
	})

	g.GET("/owned", func(e *core.RequestEvent) error {
		build := e.Request.URL.Query().Get("build")
		if build != "jp" {
			build = "global"
		}
		l, err := LatestTsumList(e.App.DB(), build, e.Request.URL.Query().Get("device"))
		if err != nil {
			return e.InternalServerError("", err)
		}
		return e.JSON(http.StatusOK, map[string]any{"list": l})
	})

	// Which devices have a Tsum list, and for which build: the Catalog's picker.
	g.GET("/owned-sources", func(e *core.RequestEvent) error {
		s, err := TsumListSources(e.App.DB())
		if err != nil {
			return e.InternalServerError("", err)
		}
		return e.JSON(http.StatusOK, s)
	})

	g.GET("/devices", func(e *core.RequestEvent) error {
		return e.JSON(http.StatusOK, events.Devices())
	})

	g.GET("/status", func(e *core.RequestEvent) error {
		var rounds int64
		_ = e.App.DB().NewQuery("SELECT COUNT(*) FROM ts_rounds").Row(&rounds)
		status := map[string]any{
			"rounds": rounds, "importDirs": importer.Dirs(), "version": cfg.Version,
			"eventsAddr": cfg.EventsAddr, "eventsConnect": cfg.EventsConnect, "token": cfg.EventsToken != "",
			"eventsLoopback": IsLoopback(cfg.EventsAddr), "lanAddrs": LANAddrs(), "adb": puller.ADB() != "",
		}
		if overlay != nil {
			status["override"] = overlay.State()
		}
		return e.JSON(http.StatusOK, status)
	})

	g.POST("/rescan", func(e *core.RequestEvent) error {
		return e.JSON(http.StatusOK, importer.Scan())
	}).BindFunc(sameOrigin)

	// Devices adb can see, for Help's "Import from devices".
	g.GET("/adb/devices", func(e *core.RequestEvent) error {
		list, err := puller.Devices(e.Request.Context())
		if err != nil {
			return e.JSON(http.StatusOK, map[string]any{"adb": puller.ADB(), "devices": []ADBDevice{}, "error": err.Error()})
		}
		return e.JSON(http.StatusOK, map[string]any{"adb": puller.ADB(), "devices": list})
	})

	g.POST("/adb/import", func(e *core.RequestEvent) error {
		var body struct {
			Serials []string `json:"serials"`
		}
		if err := e.BindBody(&body); err != nil || len(body.Serials) == 0 {
			return e.BadRequestError("Choose at least one device.", err)
		}
		res, err := puller.Pull(e.Request.Context(), body.Serials)
		if errors.Is(err, ErrPullBusy) {
			return e.JSON(http.StatusConflict, map[string]any{"message": "An import is already running."})
		}
		if err != nil {
			return e.BadRequestError(err.Error(), err)
		}
		return e.JSON(http.StatusOK, map[string]any{"devices": res})
	}).BindFunc(sameOrigin)

	// Share: publish a snapshot to the player's GitHub Pages (publish.go).
	g.GET("/publish", func(e *core.RequestEvent) error {
		return e.JSON(http.StatusOK, publisher.State())
	})
	g.POST("/publish/check", func(e *core.RequestEvent) error {
		return e.JSON(http.StatusOK, publisher.Check())
	})
	g.POST("/publish/token", func(e *core.RequestEvent) error {
		var body struct {
			Token string `json:"token"`
		}
		if err := e.BindBody(&body); err != nil {
			return e.BadRequestError("Expected the token.", err)
		}
		if err := publisher.SaveToken(body.Token); err != nil {
			return e.BadRequestError(err.Error(), err)
		}
		return e.JSON(http.StatusOK, publisher.State())
	}).BindFunc(sameOrigin)
	g.POST("/publish/logout", func(e *core.RequestEvent) error {
		if err := publisher.Logout(); err != nil {
			return e.BadRequestError(err.Error(), err)
		}
		return e.JSON(http.StatusOK, publisher.State())
	}).BindFunc(sameOrigin)
	g.POST("/publish/run", func(e *core.RequestEvent) error {
		var body PublishOptions
		if err := e.BindBody(&body); err != nil {
			return e.BadRequestError("Expected the publish options.", err)
		}
		if err := publisher.Run(body); err != nil {
			return e.BadRequestError(err.Error(), err)
		}
		return e.JSON(http.StatusOK, publisher.State())
	}).BindFunc(sameOrigin)

	g.POST("/import", func(e *core.RequestEvent) error {
		if err := e.Request.ParseMultipartForm(32 << 20); err != nil {
			return e.BadRequestError("Expected a multipart upload.", err)
		}
		var total ImportResult
		for _, fh := range e.Request.MultipartForm.File["files"] {
			f, err := fh.Open()
			if err != nil {
				total.Errors = append(total.Errors, err.Error())
				continue
			}
			res, err := importer.Import(fh.Filename, f)
			f.Close()
			if err != nil {
				total.Errors = append(total.Errors, err.Error())
				continue
			}
			total.Files += res.Files
			total.Rounds += res.Rounds
			total.Lists += res.Lists
		}
		return e.JSON(http.StatusOK, total)
	}).BindFunc(sameOrigin)
}

// sameOrigin refuses a write sent by another site's page in this browser.
// PocketBase allows any CORS origin, and a form post needs no preflight.
func sameOrigin(e *core.RequestEvent) error {
	origin := e.Request.Header.Get("Origin")
	if origin == "" {
		return e.Next()
	}
	u, err := url.Parse(origin)
	if err != nil || !strings.EqualFold(u.Host, e.Request.Host) {
		return e.ForbiddenError("Cross-origin request refused.", nil)
	}
	return e.Next()
}

// broadcaster sends realtime messages from one goroutine, so a device's event
// reader never waits on a browser. PocketBase's Send blocks until the page's
// stream takes the message, and a stream to a sleeping PC can stall for minutes.
type broadcaster struct {
	app   core.App
	queue chan subscriptions.Message
}

const (
	broadcastQueue = 256
	// A page that has not taken a message in this long is dropped; its
	// EventSource reconnects if it is still there.
	broadcastTimeout = 2 * time.Second
)

func newBroadcaster(app core.App, stop <-chan struct{}) *broadcaster {
	b := &broadcaster{app: app, queue: make(chan subscriptions.Message, broadcastQueue)}
	go b.run(stop)
	return b
}

func (b *broadcaster) send(topic string, v any) {
	data, err := json.Marshal(v)
	if err != nil {
		return
	}
	select {
	case b.queue <- subscriptions.Message{Name: topic, Data: data}:
	default:
		b.app.Logger().Warn("Realtime queue full, dropped a message", slog.String("topic", topic))
	}
}

func (b *broadcaster) run(stop <-chan struct{}) {
	for {
		select {
		case <-stop:
			return
		case msg := <-b.queue:
			for _, c := range b.app.SubscriptionsBroker().Clients() {
				if c.IsDiscarded() || !c.HasSubscription(msg.Name) {
					continue
				}
				if !deliver(c, msg) {
					b.app.SubscriptionsBroker().Unregister(c.Id())
				}
			}
		}
	}
}

// deliver is Send with a time limit. False means the page is not reading.
func deliver(c subscriptions.Client, msg subscriptions.Message) (ok bool) {
	// The channel is closed when the page disconnects mid-send.
	defer func() {
		if recover() != nil {
			ok = true
		}
	}()
	t := time.NewTimer(broadcastTimeout)
	defer t.Stop()
	select {
	case c.Channel() <- msg:
		return true
	case <-t.C:
		return false
	}
}

// IsLoopback reports whether addr binds only this machine.
func IsLoopback(addr string) bool {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(host)
	return host == "localhost" || (ip != nil && ip.IsLoopback())
}

// LANAddrs is this computer's IPv4 addresses on the network, for the Help
// page: a phone or another PC dials one of these. Loopback and link-local
// (169.254.x) are left out, since no other device can reach them.
func LANAddrs() []string {
	addrs := []string{}
	ifaces, _ := net.Interfaces()
	for _, iface := range ifaces {
		if iface.Flags&net.FlagUp == 0 || iface.Flags&net.FlagLoopback != 0 {
			continue
		}
		list, _ := iface.Addrs()
		for _, a := range list {
			n, ok := a.(*net.IPNet)
			if ok && n.IP.To4() != nil && !n.IP.IsLoopback() && !n.IP.IsLinkLocalUnicast() {
				addrs = append(addrs, n.IP.String())
			}
		}
	}
	return addrs
}
