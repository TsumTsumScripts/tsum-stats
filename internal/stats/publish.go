package stats

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/pocketbase/dbx"
)

// Publisher is the "Share" feature: it signs the player in to GitHub, and
// publishes a snapshot (snapshot.go) to their GitHub Pages site. The page
// drives it and shows its state; the work runs in the background.

// TopicPublish carries the publisher's state to the page as it changes.
const TopicPublish = "ts/publish"

// DefaultRepo is what the site is published as: <account>.github.io/tsum-stats.
const DefaultRepo = "tsum-stats"

var repoName = regexp.MustCompile(`^[A-Za-z0-9._-]{1,100}$`)

// Phases of PublishState.
const (
	PhaseIdle      = "idle"
	PhaseLogin     = "login" // waiting for the player to type the code on github.com
	PhaseExporting = "exporting"
	PhaseUploading = "uploading"
	PhaseDone      = "done"
	PhaseError     = "error"
)

// PublishState is what the page shows. It never holds the token.
type PublishState struct {
	// Available is always true: a pasted token works in every build.
	Available bool `json:"available"`
	// DeviceFlow is false when this build has no GitHub app for the code sign-in.
	DeviceFlow bool   `json:"deviceFlow"`
	SignedIn   bool   `json:"signedIn"`
	Login      string `json:"login"`

	Phase   string `json:"phase"`
	Message string `json:"message"`
	Error   string `json:"error,omitempty"`

	// While signing in.
	UserCode        string `json:"userCode,omitempty"`
	VerificationURI string `json:"verificationUri,omitempty"`

	// The choices, kept between publishes.
	Repo       string `json:"repo"`
	Devices    string `json:"devices"`
	Collection bool   `json:"collection"`

	// The last publish.
	URL         string         `json:"url,omitempty"`
	PublishedAt string         `json:"publishedAt,omitempty"`
	Rounds      int            `json:"rounds,omitempty"`
	Result      *PublishResult `json:"result,omitempty"`
}

// saved is github.json in the data folder: the token and the choices.
type saved struct {
	Token       string `json:"token,omitempty"`
	Login       string `json:"login,omitempty"`
	Repo        string `json:"repo,omitempty"`
	Devices     string `json:"devices,omitempty"`
	NoOwned     bool   `json:"noCollection,omitempty"`
	URL         string `json:"url,omitempty"`
	PublishedAt string `json:"publishedAt,omitempty"`
	Rounds      int    `json:"rounds,omitempty"`
}

// Publisher holds the sign-in and the publish that may be running.
type Publisher struct {
	file       string
	site       fs.FS
	db         func() dbx.Builder
	version    string
	notify     func(PublishState)
	newGH      func(token string) *GitHub
	deviceFlow bool   // the build has an OAuth app for StartLogin
	envToken   string // TSUM_GITHUB_TOKEN or --github-token: skips the sign-in
	now        func() time.Time

	mu     sync.Mutex
	saved  saved
	state  PublishState
	cancel context.CancelFunc // of the sign-in in progress
	gen    int                // counts sign-ins, so a cancelled one finishes without effect
	busy   bool               // a publish is running
}

// NewPublisher reads any saved sign-in from dataDir. clientID is the GitHub
// OAuth app the player signs in through; "" means this build cannot.
func NewPublisher(dataDir, clientID, token string, site fs.FS, db func() dbx.Builder, version string, notify func(PublishState)) *Publisher {
	p := &Publisher{
		file: filepath.Join(dataDir, "github.json"), site: site, db: db, version: version, notify: notify, envToken: token,
		newGH: func(token string) *GitHub { return NewGitHub(clientID, token) }, now: time.Now,
		deviceFlow: clientID != "",
	}
	if data, err := os.ReadFile(p.file); err == nil {
		_ = json.Unmarshal(data, &p.saved)
	}
	p.state = PublishState{Available: true, DeviceFlow: clientID != "", Phase: PhaseIdle}
	return p
}

func (p *Publisher) token() string {
	if p.envToken != "" {
		return p.envToken
	}
	return p.saved.Token
}

// view fills the state from what is saved. The caller holds the lock.
func (p *Publisher) view() PublishState {
	s := p.state
	s.Available = true
	s.DeviceFlow = p.deviceFlow
	s.SignedIn = p.token() != ""
	s.Login = p.saved.Login
	s.Repo = cmpOr(p.saved.Repo, DefaultRepo)
	s.Devices = cmpOr(p.saved.Devices, DevicesAnonymous)
	s.Collection = !p.saved.NoOwned
	if s.URL == "" {
		s.URL, s.PublishedAt, s.Rounds = p.saved.URL, p.saved.PublishedAt, p.saved.Rounds
	}
	return s
}

// State is what the page shows now.
func (p *Publisher) State() PublishState {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.view()
}

// set changes the state and tells the page. The caller holds the lock.
func (p *Publisher) set(f func(*PublishState)) {
	f(&p.state)
	if p.notify != nil {
		go p.notify(p.view())
	}
}

// persist writes github.json with only the owner able to read it: it holds the token.
func (p *Publisher) persist() error {
	data, _ := json.MarshalIndent(p.saved, "", "  ")
	tmp := p.file + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, p.file)
}

// StartLogin begins signing in: the state gets a code to type at GitHub, and
// the sign-in finishes in the background once it has been.
func (p *Publisher) StartLogin() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.busy {
		return errors.New("a publish is running")
	}
	if p.cancel != nil {
		p.cancel()
	}
	gh := p.newGH("")
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	dc, err := gh.StartLogin(ctx)
	if err != nil {
		cancel()
		return err
	}
	p.cancel = cancel
	p.gen++
	gen := p.gen
	p.set(func(s *PublishState) {
		*s = PublishState{Available: s.Available, Phase: PhaseLogin, UserCode: dc.UserCode, VerificationURI: dc.VerificationURI,
			Message: "Type the code on GitHub to let Tsum Tsum Stats publish for you"}
	})
	go func() {
		defer cancel()
		token, err := gh.WaitForLogin(ctx, dc)
		var login string
		if err == nil {
			gh.Token = token
			login, err = gh.Login(ctx)
		}
		p.mu.Lock()
		defer p.mu.Unlock()
		if gen != p.gen {
			return // replaced by a new sign-in, or cancelled by a sign-out
		}
		p.cancel = nil
		if err != nil {
			p.set(func(s *PublishState) {
				*s = PublishState{Available: s.Available, Phase: PhaseError, Error: err.Error()}
			})
			return
		}
		p.saved.Token, p.saved.Login = token, login
		if err := p.persist(); err != nil {
			p.set(func(s *PublishState) {
				*s = PublishState{Available: s.Available, Phase: PhaseError, Error: err.Error()}
			})
			return
		}
		p.set(func(s *PublishState) { *s = PublishState{Available: s.Available, Phase: PhaseIdle} })
	}()
	return nil
}

// SaveToken signs in with a token the player made on github.com. It is checked
// against GitHub before it is kept.
func (p *Publisher) SaveToken(token string) error {
	token = strings.TrimSpace(token)
	if token == "" {
		return errors.New("paste the token from GitHub")
	}
	p.mu.Lock()
	if p.busy {
		p.mu.Unlock()
		return errors.New("a publish is running")
	}
	p.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	login, err := p.newGH(token).Login(ctx)
	if err != nil {
		if errors.Is(err, ErrSignedOut) {
			return errors.New("GitHub does not accept that token. Check you copied all of it, and that it has not expired")
		}
		return err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.cancel != nil {
		p.cancel()
		p.cancel = nil
	}
	p.gen++
	p.saved.Token, p.saved.Login = token, login
	if err := p.persist(); err != nil {
		return err
	}
	p.set(func(s *PublishState) { *s = PublishState{Phase: PhaseIdle} })
	return nil
}

// Logout forgets the token. The published site stays up; it is the player's repo.
func (p *Publisher) Logout() error {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.busy {
		return errors.New("a publish is running")
	}
	if p.cancel != nil {
		p.cancel()
		p.cancel = nil
	}
	p.gen++
	p.saved.Token, p.saved.Login = "", ""
	err := p.persist()
	p.set(func(s *PublishState) { *s = PublishState{Available: s.Available, Phase: PhaseIdle} })
	return err
}

// PublishOptions are the player's choices for a publish.
type PublishOptions struct {
	Repo       string `json:"repo"`
	Devices    string `json:"devices"`
	Collection bool   `json:"collection"`
	// Public is the player's confirmation that anyone will be able to see the page.
	Public bool `json:"public"`
}

// Run publishes in the background; the state follows it.
func (p *Publisher) Run(o PublishOptions) error {
	if !o.Public {
		return errors.New("confirm that the page will be public")
	}
	if !repoName.MatchString(o.Repo) {
		return errors.New("the repository name may only hold letters, digits, dots, dashes and underscores")
	}
	if o.Devices != DevicesAnonymous && o.Devices != DevicesKeep && o.Devices != DevicesHide {
		return errors.New("unknown device setting")
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.busy {
		return errors.New("a publish is already running")
	}
	if p.token() == "" {
		return errors.New("sign in to GitHub first")
	}
	p.busy = true
	p.saved.Repo, p.saved.Devices, p.saved.NoOwned = o.Repo, o.Devices, !o.Collection
	_ = p.persist()
	token := p.token()
	p.set(func(s *PublishState) {
		*s = PublishState{Available: s.Available, Phase: PhaseExporting, Message: "Collecting your stats"}
	})
	go p.run(token, o)
	return nil
}

func (p *Publisher) run(token string, o PublishOptions) {
	fail := func(err error) {
		p.mu.Lock()
		defer p.mu.Unlock()
		p.busy = false
		msg := err.Error()
		if errors.Is(err, ErrSignedOut) {
			// The token is no good any more: the next step is to sign in again.
			p.saved.Token, p.saved.Login = "", ""
			_ = p.persist()
			msg = "GitHub no longer accepts the saved sign-in. Sign in again."
		}
		p.set(func(s *PublishState) { *s = PublishState{Available: s.Available, Phase: PhaseError, Error: msg} })
	}
	dir, err := os.MkdirTemp("", "tsum-stats-publish-")
	if err != nil {
		fail(err)
		return
	}
	defer os.RemoveAll(dir)
	exp, err := ExportSnapshot(p.db(), p.site, dir, SnapshotOptions{Devices: o.Devices, NoOwned: !o.Collection, Version: p.version, Now: p.now()})
	if err != nil {
		fail(err)
		return
	}

	gh := p.newGH(token)
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	p.mu.Lock()
	login := p.saved.Login
	p.mu.Unlock()
	if login == "" { // a token given on the command line
		if login, err = gh.Login(ctx); err != nil {
			fail(err)
			return
		}
		p.mu.Lock()
		p.saved.Login = login
		p.mu.Unlock()
	}
	p.mu.Lock()
	p.set(func(s *PublishState) { s.Phase, s.Message = PhaseUploading, "Connecting to GitHub" })
	p.mu.Unlock()
	res, err := gh.Publish(ctx, login, o.Repo, dir, func(msg string) {
		p.mu.Lock()
		p.set(func(s *PublishState) { s.Message = msg })
		p.mu.Unlock()
	})
	if err != nil {
		fail(err)
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.busy = false
	p.saved.URL, p.saved.PublishedAt, p.saved.Rounds = res.URL, p.now().UTC().Format(time.RFC3339), exp.Rounds
	_ = p.persist()
	p.set(func(s *PublishState) {
		*s = PublishState{Available: s.Available, Phase: PhaseDone, URL: res.URL, PublishedAt: p.saved.PublishedAt, Rounds: exp.Rounds, Result: &res,
			Message: "Published"}
	})
}
