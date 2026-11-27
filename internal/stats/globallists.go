package stats

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"hash/fnv"
	"net/http"
	"slices"

	"github.com/pocketbase/dbx"
)

// The forwarder's Tsum Lists (CONTRACT §2.8, §7.2). This computer has the
// Tsum Lists, and knows which account some devices' rounds were played on
// (accounts.go); the global site has everyone's rounds, most of which this
// computer never saw. So the evidence goes up and the site works the levels
// out there: every list once (ts_global_lists), and for each device tag the
// account its rounds are linked to here by the player's answer or by its
// device name, as one of that account's lists, or "not known"
// (ts_global_links), again when that changes. Never the device names.

// ListsSchema names ListBatch's format.
const ListsSchema = "gap.tsum-lists/1"

// What one request holds at most (the Worker's MAX_LISTS and MAX_LINKS), and
// about how many bytes of lists, under the 1 MiB body limit.
const (
	GlobalListRows  = 20
	GlobalLinkRows  = 200
	globalListBytes = 700 << 10
)

// GlobalList is one Tsum List as sent: an id that names it without its
// device, when it was read (UTC, played_at's form), its game, and its rows,
// each a list CSV row keyed by column, every cell a string and an unread one "".
type GlobalList struct {
	ID    string              `json:"id"`
	Stamp string              `json:"stamp"`
	Build string              `json:"build"`
	Tsums []map[string]string `json:"tsums"`
}

// GlobalLink says which account a device's rounds of one game were played on:
// List is one of the account's lists (GlobalList.ID), "" for "not known", nil
// to take an answer back. Tag is the device tag its round ids end with.
type GlobalLink struct {
	Build string  `json:"build"`
	Tag   string  `json:"tag"`
	List  *string `json:"list"`
}

// ListBatch is one gap.tsum-lists/1 request.
type ListBatch struct {
	Schema string       `json:"schema"`
	Lists  []GlobalList `json:"lists"`
	Links  []GlobalLink `json:"links"`
}

// Lists sends Tsum Lists and links.
func (g *GlobalSite) Lists(ctx context.Context, b ListBatch) error {
	b.Schema = ListsSchema
	if b.Lists == nil {
		b.Lists = []GlobalList{}
	}
	if b.Links == nil {
		b.Links = []GlobalLink{}
	}
	return g.do(ctx, http.MethodPost, "/api/v1/lists", b, nil)
}

// globalListID is a list's id on the global site: 16 hex of a hash of its
// game, device name and file, so the same list is the same id and the name
// does not go with it.
func globalListID(build, device, file string) string {
	sum := sha256.Sum256([]byte(build + "\x00" + device + "\x00" + file))
	return hex.EncodeToString(sum[:8])
}

// pendingList is a list to send, with its file and fingerprint to record.
type pendingList struct {
	file string
	hash int64
	size int
	list GlobalList
}

// pendingLists is every Tsum List whose contents the site has not taken, oldest first.
func pendingLists(db dbx.Builder) ([]pendingList, error) {
	var lists []struct {
		ID     int64  `db:"id"`
		File   string `db:"file"`
		Build  string `db:"build"`
		Device string `db:"device"`
		Stamp  string `db:"stamp"`
		Sent   *int64 `db:"sent"`
	}
	if err := db.NewQuery(`SELECT l.id, l.file, l.build, l.device, l.stamp, (SELECT hash FROM ts_global_lists s WHERE s.file = l.file) AS sent
		FROM ts_tsum_lists l WHERE l.build IN ('global', 'jp') ORDER BY l.stamp, l.id`).All(&lists); err != nil {
		return nil, err
	}
	var out []pendingList
	for _, l := range lists {
		var rows []OwnedTsum
		if err := db.NewQuery(`SELECT ord, tsum, name, level, level_cap, skill, skill_max, skill_progress, acquired, favorite FROM ts_owned
			WHERE list_id = {:id} ORDER BY ord, tsum`).Bind(dbx.Params{"id": l.ID}).All(&rows); err != nil {
			return nil, err
		}
		g := GlobalList{ID: globalListID(l.Build, l.Device, l.File), Stamp: stampTime(l.Stamp), Build: l.Build, Tsums: []map[string]string{}}
		for _, r := range rows {
			if r.Tsum == "" {
				continue
			}
			fav := ""
			if r.Favorite != nil {
				fav = "0"
				if *r.Favorite {
					fav = "1"
				}
			}
			g.Tsums = append(g.Tsums, map[string]string{
				"order": intText(r.Order), "tsum": r.Tsum, "name": r.Name, "level": intText(r.Level), "level_cap": intText(r.LevelCap),
				"skill": intText(r.Skill), "skill_max": intText(r.SkillMax), "skill_progress": intText(r.SkillProgress),
				"acquired": r.Acquired, "favorite": fav,
			})
		}
		if len(g.Tsums) == 0 {
			continue
		}
		var buf bytes.Buffer
		enc := json.NewEncoder(&buf)
		enc.SetEscapeHTML(false)
		_ = enc.Encode(g)
		h := fnv.New64a()
		h.Write(buf.Bytes())
		if hash := int64(h.Sum64()); l.Sent == nil || *l.Sent != hash {
			out = append(out, pendingList{l.File, hash, buf.Len(), g})
		}
	}
	return out, nil
}

// wantedLinks is what the site should know of each device tag's account, by
// game: build + "\x00" + tag → one of the account's lists (its oldest, so
// the answer stays the same as lists are added), or "" for "not known". Only
// what this computer knows that the site cannot work out: a stretch the
// player answered for, or one linked by its device name; a stretch linked
// because its game has one account is the site's to link the same way. A tag
// whose stretches say two accounts is left out.
func wantedLinks(db dbx.Builder) (map[string]string, error) {
	acc, err := DescribeAccounts(db)
	if err != nil {
		return nil, err
	}
	anchor := map[int]string{}
	for _, a := range acc.Accounts {
		var oldest *AccountList
		for i := range a.Lists {
			if oldest == nil || a.Lists[i].Stamp < oldest.Stamp {
				oldest = &a.Lists[i]
			}
		}
		if oldest != nil && (a.Build == "global" || a.Build == "jp") {
			anchor[a.ID] = globalListID(a.Build, oldest.Device, oldest.File)
		}
	}
	type said struct {
		lists   []string
		unknown bool
	}
	by := map[string]*said{}
	for _, s := range acc.Stretches {
		if (s.Build != "global" && s.Build != "jp") || len(s.Tag) != 12 {
			continue
		}
		k := s.Build + "\x00" + s.Tag
		if by[k] == nil {
			by[k] = &said{}
		}
		switch s.How {
		case LinkUnknown:
			by[k].unknown = true
		case LinkPicked, LinkDevice:
			if id := anchor[s.Account]; id != "" && !slices.Contains(by[k].lists, id) {
				by[k].lists = append(by[k].lists, id)
			}
		}
	}
	out := map[string]string{}
	for k, s := range by {
		switch {
		case len(s.lists) == 1:
			out[k] = s.lists[0]
		case len(s.lists) == 0 && s.unknown:
			out[k] = ""
		}
	}
	return out, nil
}

// pendingLinks is the links the site has not been told: each wanted one that
// differs from what ts_global_links says it knows, and a nil for one it knows
// that is wanted no more. In key order.
func pendingLinks(db dbx.Builder) ([]GlobalLink, error) {
	want, err := wantedLinks(db)
	if err != nil {
		return nil, err
	}
	var told []struct {
		Build string `db:"build"`
		Tag   string `db:"tag"`
		List  string `db:"list"`
	}
	if err := db.NewQuery(`SELECT build, tag, list FROM ts_global_links`).All(&told); err != nil {
		return nil, err
	}
	var out []GlobalLink
	known := map[string]bool{}
	for _, t := range told {
		k := t.Build + "\x00" + t.Tag
		known[k] = true
		if list, ok := want[k]; !ok {
			out = append(out, GlobalLink{t.Build, t.Tag, nil})
		} else if list != t.List {
			out = append(out, GlobalLink{t.Build, t.Tag, &list})
		}
	}
	for k, list := range want {
		if !known[k] {
			out = append(out, GlobalLink{k[:len(k)-13], k[len(k)-12:], &list})
		}
	}
	slices.SortFunc(out, func(a, b GlobalLink) int {
		if a.Build != b.Build {
			return compareStrings(a.Build, b.Build)
		}
		return compareStrings(a.Tag, b.Tag)
	})
	return out, nil
}

func compareStrings(a, b string) int {
	if a < b {
		return -1
	}
	if a > b {
		return 1
	}
	return 0
}

// sendLists sends the Tsum Lists the site has not taken, a request's worth at
// a time, then the links that changed (after the lists they name), and
// records each once the site says ok. Nothing until the site says it takes lists.
func (c *Contributor) sendLists(ctx context.Context, site *GlobalSite, gen int) error {
	c.mu.Lock()
	on := c.saved.Lists >= 1
	c.mu.Unlock()
	if !on {
		return nil
	}
	lists, err := pendingLists(c.db())
	if err != nil {
		return err
	}
	for len(lists) > 0 && !c.left(gen) {
		n, size := 0, 0
		for n < len(lists) && n < GlobalListRows && (n == 0 || size+lists[n].size <= globalListBytes) {
			size += lists[n].size
			n++
		}
		batch := ListBatch{}
		for _, l := range lists[:n] {
			batch.Lists = append(batch.Lists, l.list)
		}
		if err := site.Lists(ctx, batch); err != nil {
			return err
		}
		at := c.now().UTC().Format(sqlTime)
		for _, l := range lists[:n] {
			if _, err := c.db().NewQuery(`INSERT INTO ts_global_lists (file, hash, sent_at) VALUES ({:f}, {:h}, {:at})
				ON CONFLICT (file) DO UPDATE SET hash = excluded.hash, sent_at = excluded.sent_at`).Bind(dbx.Params{"f": l.file, "h": l.hash, "at": at}).Execute(); err != nil {
				return err
			}
		}
		lists = lists[n:]
	}
	links, err := pendingLinks(c.db())
	if err != nil {
		return err
	}
	for len(links) > 0 && !c.left(gen) {
		n := min(len(links), GlobalLinkRows)
		if err := site.Lists(ctx, ListBatch{Links: links[:n]}); err != nil {
			return err
		}
		at := c.now().UTC().Format(sqlTime)
		for _, l := range links[:n] {
			p := dbx.Params{"b": l.Build, "t": l.Tag, "at": at}
			q := `DELETE FROM ts_global_links WHERE build = {:b} AND tag = {:t}`
			if l.List != nil {
				p["l"] = *l.List
				q = `INSERT INTO ts_global_links (build, tag, list, sent_at) VALUES ({:b}, {:t}, {:l}, {:at})
					ON CONFLICT (build, tag) DO UPDATE SET list = excluded.list, sent_at = excluded.sent_at`
			}
			if _, err := c.db().NewQuery(q).Bind(p).Execute(); err != nil {
				return err
			}
		}
		links = links[n:]
	}
	return nil
}

// GlobalEvidence is what a pass would send of Tsum Lists and links now,
// without recording anything: the forwarder's own encoding, for tests that
// feed it to the global site, and for sizing a first upload.
func GlobalEvidence(db dbx.Builder) (ListBatch, error) {
	b := ListBatch{Schema: ListsSchema, Lists: []GlobalList{}, Links: []GlobalLink{}}
	lists, err := pendingLists(db)
	if err != nil {
		return b, err
	}
	for _, l := range lists {
		b.Lists = append(b.Lists, l.list)
	}
	links, err := pendingLinks(db)
	if err != nil {
		return b, err
	}
	b.Links = append(b.Links, links...)
	return b, nil
}
