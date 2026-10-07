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
	PhaseExporting = "exporting"
	PhaseUploading = "uploading"
	PhaseDone      = "done"
	PhaseError     = "error"
)

// PublishState is what the page shows. It never holds the token.
type PublishState struct {
	// Available is always true: a pasted token works in every build.
	Available bool   `json:"available"`
	SignedIn  bool   `json:"signedIn"`
	Login     string `json:"login"`

	Phase   string `json:"phase"`
	Message string `json:"message"`
	Error   string `json:"error,omitempty"`

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
	file    string
	site    fs.FS
	db      func() dbx.Builder
	version string
	notify  func(PublishState)
	newGH   func(token string) *GitHub
	now     func() time.Time

	mu    sync.Mutex
	saved saved
	state PublishState
	gen   int  // counts sign-ins and sign-outs, so a check that overlaps one has no effect
	busy  bool // a publish is running
}

// NewPublisher reads any saved sign-in from dataDir.
func NewPublisher(dataDir string, site fs.FS, db func() dbx.Builder, version string, notify func(PublishState)) *Publisher {
	p := &Publisher{
		file: filepath.Join(dataDir, "github.json"), site: site, db: db, version: version, notify: notify,
		newGH: NewGitHub, now: time.Now,
	}
	if data, err := os.ReadFile(p.file); err == nil {
		_ = json.Unmarshal(data, &p.saved)
	}
	p.state = PublishState{Available: true, Phase: PhaseIdle}
	return p
}

// view fills the state from what is saved. The caller holds the lock.
func (p *Publisher) view() PublishState {
	s := p.state
	s.Available = true
	s.SignedIn = p.saved.Token != ""
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
	p.gen++
	p.saved.Token, p.saved.Login = "", ""
	err := p.persist()
	p.set(func(s *PublishState) { *s = PublishState{Available: s.Available, Phase: PhaseIdle} })
	return err
}

// Check asks GitHub whether the saved token still works, so a dead one sends the
// player back to sign in before they press Publish. Only a refusal counts:
// when GitHub cannot be reached the state stays as it was.
func (p *Publisher) Check() PublishState {
	p.mu.Lock()
	token, gen := p.saved.Token, p.gen
	if token == "" || p.busy {
		defer p.mu.Unlock()
		return p.view()
	}
	p.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := p.newGH(token).Login(ctx)
	p.mu.Lock()
	defer p.mu.Unlock()
	if errors.Is(err, ErrSignedOut) && gen == p.gen && !p.busy && p.saved.Token == token {
		p.rejected()
	}
	return p.view()
}

// rejected is GitHub refusing the token, revoked or expired: the next step is
// to sign in again. The caller holds the lock.
func (p *Publisher) rejected() {
	p.saved.Token, p.saved.Login = "", ""
	_ = p.persist()
	p.set(func(s *PublishState) {
		*s = PublishState{Available: s.Available, Phase: PhaseError, Error: "GitHub no longer accepts the saved sign-in. Sign in again."}
	})
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
	if p.saved.Token == "" {
		return errors.New("sign in to GitHub first")
	}
	p.busy = true
	p.saved.Repo, p.saved.Devices, p.saved.NoOwned = o.Repo, o.Devices, !o.Collection
	_ = p.persist()
	token := p.saved.Token
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
		if errors.Is(err, ErrSignedOut) {
			p.rejected()
			return
		}
		p.set(func(s *PublishState) {
			*s = PublishState{Available: s.Available, Phase: PhaseError, Error: err.Error()}
		})
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
