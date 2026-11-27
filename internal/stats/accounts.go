package stats

import (
	"cmp"
	"slices"
	"strings"

	"github.com/pocketbase/dbx"
)

// Game accounts, worked out from the Tsum Lists, and which account each
// stretch of rounds was played on: what lets a list's reading of a Tsum's
// skill level bound the rounds around it (skillfix.go: the list rule).
//
// A Tsum List names the device folder it came from, not the account, and one
// emulator can hold another account later. So lists are grouped by what they
// say (groupAccounts), and rounds are linked to an account only where that is
// safe (linker.account); the rest wait for the player to say
// (ts_account_links, the page's Data dialog). docs/INTERNALS.md § The skill
// level correction has the reasoning.

const (
	// accountMinCommon is how many Tsums a list must share with an account before it can join it.
	accountMinCommon = 5
	// accountSameShare is the share of those that must be at the very same
	// skill level: an account's lists days apart agree on nearly all of them
	// (95 % and up on the developer's), two accounts on few (8 %).
	accountSameShare = 0.5
	// accountMisreads is the share of them that may read lower than before (a misread digit) and still join.
	accountMisreads = 0.02
)

// AccountList is one Tsum List of an account.
type AccountList struct {
	File   string `json:"file"`
	Device string `json:"device"`
	Stamp  string `json:"stamp"`
	// At is the stamp as played_at is written (UTC, sqlTime).
	At    string `json:"at"`
	Tsums int    `json:"tsums"`

	skill, level map[string]int64
}

// Account is one game account: the Tsum Lists that are one account's, oldest first.
type Account struct {
	// ID is its place among the accounts, for the page; it can change when a list arrives.
	ID    int    `json:"id"`
	Build string `json:"build"`
	// Label is its lists' device names, each once, in the order first seen.
	Label   string        `json:"label"`
	Devices []string      `json:"devices"`
	Lists   []AccountList `json:"lists"`
	// Tsums is how many Tsums any of its lists holds.
	Tsums int `json:"tsums"`

	// The highest skill and level any list so far read for each Tsum.
	skill, level map[string]int64
}

// stampTime is a list's stamp (YYYYMMDD-HHMMSS, UTC: the script's
// statsFileStamp) in played_at's form.
func stampTime(stamp string) string {
	if len(stamp) != 15 {
		return stamp
	}
	return stamp[:4] + "-" + stamp[4:6] + "-" + stamp[6:8] + " " + stamp[9:11] + ":" + stamp[11:13] + ":" + stamp[13:15]
}

// joins reports whether list l can be the account's next list: enough Tsums in
// common, nearly none read lower than before (skill or level: neither ever
// goes down), and most at the very same skill.
func (a *Account) joins(l *AccountList) bool {
	common, down, same := 0, 0, 0
	for t, s := range l.skill {
		was, ok := a.skill[t]
		if !ok {
			continue
		}
		common++
		lv, hasLevel := l.level[t]
		if s < was || (hasLevel && lv < a.level[t]) {
			down++
		}
		if s == was {
			same++
		}
	}
	return common >= accountMinCommon && float64(down) <= accountMisreads*float64(common) && float64(same) >= accountSameShare*float64(common)
}

func (a *Account) add(l AccountList) {
	a.Lists = append(a.Lists, l)
	if !slices.Contains(a.Devices, l.Device) {
		a.Devices = append(a.Devices, l.Device)
	}
	for t, s := range l.skill {
		a.skill[t] = max(a.skill[t], s)
	}
	for t, s := range l.level {
		a.level[t] = max(a.level[t], s)
	}
	a.Tsums = len(a.skill)
	a.Label = strings.Join(a.Devices, ", ")
}

// groupAccounts puts lists (oldest first) into accounts: each joins the
// account with the newest list that it can be the next list of (joins), else
// starts one. Only within a build.
func groupAccounts(lists []AccountList, builds []string) []*Account {
	var out []*Account
	for i, l := range lists {
		var into *Account
		for k := len(out) - 1; k >= 0 && into == nil; k-- {
			// Newest list first: out is kept in the order of each account's last list below.
			if out[k].Build == builds[i] && out[k].joins(&l) {
				into = out[k]
				out = append(append(out[:k:k], out[k+1:]...), into)
			}
		}
		if into == nil {
			into = &Account{Build: builds[i], skill: map[string]int64{}, level: map[string]int64{}}
			out = append(out, into)
		}
		into.add(l)
	}
	slices.SortStableFunc(out, func(a, b *Account) int {
		return cmp.Or(strings.Compare(a.Build, b.Build), strings.Compare(a.Lists[0].Stamp, b.Lists[0].Stamp), strings.Compare(a.Lists[0].File, b.Lists[0].File))
	})
	for i, a := range out {
		a.ID = i + 1
	}
	return out
}

// loadAccounts reads every Tsum List and groups them (groupAccounts).
func loadAccounts(db dbx.Builder) ([]*Account, error) {
	var rows []struct {
		ID     int64  `db:"id"`
		File   string `db:"file"`
		Build  string `db:"build"`
		Device string `db:"device"`
		Stamp  string `db:"stamp"`
		Tsums  int    `db:"tsums"`
	}
	if err := db.NewQuery(`SELECT id, file, build, device, stamp, tsums FROM ts_tsum_lists ORDER BY stamp, id`).All(&rows); err != nil {
		return nil, err
	}
	var owned []struct {
		ListID int64  `db:"list_id"`
		Tsum   string `db:"tsum"`
		Skill  *int64 `db:"skill"`
		Level  *int64 `db:"level"`
	}
	if err := db.NewQuery(`SELECT list_id, tsum, skill, level FROM ts_owned WHERE tsum <> ''`).All(&owned); err != nil {
		return nil, err
	}
	at := map[int64]int{}
	lists := make([]AccountList, len(rows))
	builds := make([]string, len(rows))
	for i, r := range rows {
		at[r.ID] = i
		lists[i] = AccountList{File: r.File, Device: r.Device, Stamp: r.Stamp, At: stampTime(r.Stamp), Tsums: r.Tsums, skill: map[string]int64{}, level: map[string]int64{}}
		builds[i] = r.Build
	}
	for _, o := range owned {
		i, ok := at[o.ListID]
		// A skill level outside 1-10 is a misread, and says nothing.
		if !ok || o.Skill == nil || *o.Skill < 1 || *o.Skill > 10 {
			continue
		}
		lists[i].skill[o.Tsum] = *o.Skill
		if o.Level != nil {
			lists[i].level[o.Tsum] = *o.Level
		}
	}
	// A list with no skill level read says nothing of an account.
	var read []AccountList
	var readBuilds []string
	for i, l := range lists {
		if len(l.skill) > 0 {
			read, readBuilds = append(read, l), append(readBuilds, builds[i])
		}
	}
	return groupAccounts(read, readBuilds), nil
}

// listBound is what an account's lists say of one Tsum's skill level at one
// time: at least Floor (the newest list before it), at most Cap (the oldest
// after it); 0 for no such list. FloorList and CapList are those lists.
type listBound struct {
	Floor, Cap         int
	FloorList, CapList *AccountList
}

// bound is the account's listBound for tsum at time at (played_at's form). A
// Tsum its lists read lower after than before (a misread) has none.
func (a *Account) bound(tsum, at string) listBound {
	var b listBound
	for i := range a.Lists {
		l := &a.Lists[i]
		s, ok := l.skill[tsum]
		if !ok {
			continue
		}
		if l.At <= at {
			if int(s) >= b.Floor {
				b.Floor, b.FloorList = int(s), l
			}
		} else if b.Cap == 0 || int(s) < b.Cap {
			b.Cap, b.CapList = int(s), l
		}
	}
	if b.Cap > 0 && b.Floor > b.Cap {
		return listBound{}
	}
	return b
}

// clamp is level held within the bound, and the list that moved it (nil when it stands).
func (b listBound) clamp(level int) (int, *AccountList, string) {
	switch {
	case level <= 0:
		return level, nil, ""
	case b.Cap > 0 && level > b.Cap:
		return b.Cap, b.CapList, "cap"
	case level < b.Floor:
		return b.Floor, b.FloorList, "floor"
	}
	return level, nil, ""
}

// stretchTagSQL is the device tag a stretch of rounds goes by: deviceTagSQL's,
// but "" for an id of another shape, so those rounds are one stretch.
const stretchTagSQL = "(CASE WHEN length(round_id) = 36 THEN substr(round_id, 25) ELSE '' END)"

// How a stretch came by its account.
const (
	LinkPicked  = "picked"  // the player named it
	LinkUnknown = "unknown" // the player said it is not known
	LinkDevice  = "device"  // every list of its device name is one account's
	LinkBuild   = "build"   // its game has lists of one account only
)

// linker links rounds to accounts.
type linker struct {
	accounts []*Account
	byFile   map[string]*Account
	// picks is the player's answers: stretch key → a list's file, "" for not known.
	picks map[string]string
	// byDevice is the one account of a build's lists under a device name (nil: more than one); byBuild the build's one account.
	byDevice map[string]*Account
	byBuild  map[string]*Account
}

func stretchKey(build, device, tag string) string { return build + "\x00" + device + "\x00" + tag }

func newLinker(db dbx.Builder) (*linker, error) {
	accounts, err := loadAccounts(db)
	if err != nil {
		return nil, err
	}
	lk := &linker{accounts: accounts, byFile: map[string]*Account{}, picks: map[string]string{}, byDevice: map[string]*Account{}, byBuild: map[string]*Account{}}
	one := func(m map[string]*Account, k string, a *Account) {
		if was, ok := m[k]; ok && was != a {
			m[k] = nil
		} else {
			m[k] = a
		}
	}
	for _, a := range accounts {
		one(lk.byBuild, a.Build, a)
		for _, l := range a.Lists {
			lk.byFile[l.File] = a
			if l.Device != "" {
				one(lk.byDevice, a.Build+"\x00"+l.Device, a)
				// Rounds from before the script recorded the game have none: any game's list of the device.
				one(lk.byDevice, "\x00"+l.Device, a)
			}
		}
	}
	var picks []struct {
		Build  string `db:"build"`
		Device string `db:"device"`
		Tag    string `db:"tag"`
		File   string `db:"list_file"`
	}
	if err := db.NewQuery(`SELECT build, device, tag, list_file FROM ts_account_links`).All(&picks); err != nil {
		return nil, err
	}
	for _, p := range picks {
		lk.picks[stretchKey(p.Build, p.Device, p.Tag)] = p.File
	}
	return lk, nil
}

// account is the account a stretch's rounds were played on, and how that is
// known; nil when it is not. The player's answer first; then the device
// name, when every list under it is one account's; then the game, when only
// one account has lists of it. Anything else is left for the player.
func (lk *linker) account(build, device, tag string) (*Account, string) {
	if file, ok := lk.picks[stretchKey(build, device, tag)]; ok {
		if file == "" {
			return nil, LinkUnknown
		}
		if a := lk.byFile[file]; a != nil {
			return a, LinkPicked
		}
		// The list it named is gone: as if never asked.
	}
	if device != "" {
		if a := lk.byDevice[build+"\x00"+device]; a != nil {
			return a, LinkDevice
		}
	}
	if build != "" {
		if a := lk.byBuild[build]; a != nil {
			return a, LinkBuild
		}
	}
	return nil, ""
}

// Stretch is the rounds of one game, device name and device tag: what the
// player links to an account.
type Stretch struct {
	Build  string `db:"build" json:"build"`
	Device string `db:"device" json:"device"`
	Tag    string `db:"tag" json:"tag"`
	Rounds int64  `db:"rounds" json:"rounds"`
	First  string `db:"first" json:"first"`
	Last   string `db:"last" json:"last"`
	// Tsums are its most played Tsums, and TsumCount how many it played.
	Tsums     []TsumStat `db:"-" json:"tsums"`
	TsumCount int        `db:"-" json:"tsumCount"`
	// Account is the account it is linked to (Account.ID), 0 for none; How is
	// one of the Link* words, "" when nothing says. Picked is the list the
	// player named, when they did.
	Account int    `db:"-" json:"account"`
	How     string `db:"-" json:"how"`
	Picked  string `db:"-" json:"picked"`
}

// Accounts is the page's account picker: the accounts, and every stretch of
// rounds with the account it is linked to.
type Accounts struct {
	Accounts  []*Account `json:"accounts"`
	Stretches []Stretch  `json:"stretches"`
}

// stretchTsums is how many of a stretch's Tsums the picker names.
const stretchTsums = 5

// DescribeAccounts is Accounts: stretches oldest first.
func DescribeAccounts(db dbx.Builder) (Accounts, error) {
	out := Accounts{Accounts: []*Account{}, Stretches: []Stretch{}}
	lk, err := newLinker(db)
	if err != nil {
		return out, err
	}
	if lk.accounts != nil {
		out.Accounts = lk.accounts
	}
	if err := db.NewQuery(`SELECT build, device, ` + stretchTagSQL + ` AS tag, COUNT(*) AS rounds, MIN(played_at) AS first, MAX(played_at) AS last
		FROM ts_rounds GROUP BY build, device, tag ORDER BY first, build, device, tag`).All(&out.Stretches); err != nil {
		return out, err
	}
	var tsums []struct {
		Build  string `db:"build"`
		Device string `db:"device"`
		Tag    string `db:"tag"`
		Tsum   string `db:"tsum"`
		Rounds int64  `db:"rounds"`
	}
	if err := db.NewQuery(`SELECT build, device, ` + stretchTagSQL + ` AS tag, tsum, COUNT(*) AS rounds FROM ts_rounds WHERE tsum <> ''
		GROUP BY build, device, tag, tsum ORDER BY rounds DESC, tsum`).All(&tsums); err != nil {
		return out, err
	}
	at := map[string]int{}
	for i := range out.Stretches {
		s := &out.Stretches[i]
		s.Tsums = []TsumStat{}
		at[stretchKey(s.Build, s.Device, s.Tag)] = i
		a, how := lk.account(s.Build, s.Device, s.Tag)
		if a != nil {
			s.Account = a.ID
		}
		s.How, s.Picked = how, lk.picks[stretchKey(s.Build, s.Device, s.Tag)]
	}
	for _, t := range tsums {
		s := &out.Stretches[at[stretchKey(t.Build, t.Device, t.Tag)]]
		s.TsumCount++
		if len(s.Tsums) < stretchTsums {
			s.Tsums = append(s.Tsums, TsumStat{Tsum: t.Tsum, Rounds: t.Rounds})
		}
	}
	return out, nil
}

// LinkAccount stores the player's answer for one stretch: list, the file of
// a Tsum List of the account it was played on; "" for not known; nil to
// forget the answer, so the stretch is linked as if never asked. Every Tsum's
// effective levels are then worked out again.
func LinkAccount(db dbx.Builder, build, device, tag string, list *string) error {
	p := dbx.Params{"b": build, "d": device, "t": tag}
	if _, err := db.NewQuery(`DELETE FROM ts_account_links WHERE build = {:b} AND device = {:d} AND tag = {:t}`).Bind(p).Execute(); err != nil {
		return err
	}
	if list != nil {
		p["f"] = *list
		if _, err := db.NewQuery(`INSERT INTO ts_account_links (build, device, tag, list_file) VALUES ({:b}, {:d}, {:t}, {:f})`).Bind(p).Execute(); err != nil {
			return err
		}
	}
	return Refile(db)
}
