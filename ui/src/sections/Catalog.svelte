<!-- The Catalog: every Tsum the chosen build has, marked with what the
     player's latest Tsum List export says they own, from any device or one. -->
<script>
  import {onMount} from 'svelte';
  import {isSnapshot} from '../lib/snapshot/client.js';
  import Avatar from '../components/Avatar.svelte';
  import Seg from '../components/Seg.svelte';
  import MaxOut from './catalog/MaxOut.svelte';
  import {maxOutTotals, toMax} from '../lib/boxes.js';
  import {shared} from '../lib/ui.svelte.js';
  import {api, debounce, fmt, loadPref, savePref, tsumColor} from '../lib/util.js';

  let {hidden, initial, onStateChange} = $props();

  // Levels show out of the game's top level, not the Tsum's current cap.
  const MAX_LEVEL = 50;
  const blank = () => ({build: 'global', device: '', owned: 'all', q: ''});

  // Sort keys, their labels and the direction a first click gives.
  const SORTS = {
    name: {label: 'Name', dir: 'asc'},
    order: {label: 'Date acquired', dir: 'asc'},
    level: {label: 'Level', dir: 'desc'},
    skill: {label: 'Skill level', dir: 'desc'},
    left: {label: 'Boxes to max', dir: 'desc'},
  };
  const NAME_MODES = ['en', 'jp', 'all'];
  const VIEWS = ['card', 'list'];

  // Sort, view and name language are per-browser preferences, not part of the link.
  const PREF_KEY = 'tsum-stats.catalog';
  function loadPrefs() {
    const d = {sorts: [{key: 'name', dir: 'asc'}], view: 'card', names: 'all'};
    const p = loadPref(PREF_KEY, {});
    const sorts = (Array.isArray(p.sorts) ? p.sorts : []).filter((s, i, all) =>
      s && s.key in SORTS && (s.dir === 'asc' || s.dir === 'desc') && all.findIndex(o => o.key === s.key) === i);
    return {
      sorts: sorts.length ? sorts : d.sorts,
      view: VIEWS.includes(p.view) ? p.view : d.view,
      names: NAME_MODES.includes(p.names) ? p.names : d.names,
    };
  }

  // "20260920-140211" → a Date in the viewer's zone. The script names the file in
  // device local time, so this is approximate across zones.
  function stampDate(stamp) {
    const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(stamp || '');
    return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null;
  }
  const dateFmt = new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short'});
  const monthFmt = new Intl.DateTimeFormat(undefined, {year: 'numeric', month: 'short'});
  const acquiredLabel = a => {
    const m = /^(\d{4})-(\d{2})$/.exec(a || '');
    return m ? monthFmt.format(new Date(+m[1], m[2] - 1, 1)) : '';
  };
  const buildName = b => (b === 'jp' ? 'JP' : 'INTL');

  const filter = $state(blank());
  const prefs = $state(loadPrefs());
  // Each build|device's latest Tsum list; absent until fetched, null when there is none.
  const lists = $state({});
  // Every device's lists, one per build: what the Device menu offers. Undefined until fetched.
  let sources = $state();
  const catalog = shared.catalog;

  function set(patch) {
    Object.assign(filter, patch);
    onStateChange({...filter});
  }
  function setPrefs(patch) {
    Object.assign(prefs, patch);
    savePref(PREF_KEY, $state.snapshot(prefs));
  }
  const setQuery = debounce(q => set({q}), 150);

  // Click a sort: flip it if it is the only one, else make it the only one.
  // Shift/add: append it, or flip it when already there.
  function toggleSort(key, add) {
    const cur = prefs.sorts.find(s => s.key === key);
    const flip = s => ({key: s.key, dir: s.dir === 'asc' ? 'desc' : 'asc'});
    if (add) {
      setPrefs({sorts: cur ? prefs.sorts.map(s => (s.key === key ? flip(s) : s)) : [...prefs.sorts, {key, dir: SORTS[key].dir}]});
    } else {
      setPrefs({sorts: [cur && prefs.sorts.length === 1 ? flip(cur) : {key, dir: cur ? cur.dir : SORTS[key].dir}]});
    }
  }

  const listKey = $derived(`${filter.build}|${filter.device}`);
  async function loadList(build, device, key) {
    lists[key] = (await api('owned', {build, device})).list;
  }
  async function loadSources() {
    sources = await api('owned-sources');
  }
  $effect(() => {
    if (sources && !(listKey in lists)) loadList(filter.build, filter.device, listKey);
  });

  const list = $derived(lists[listKey]);
  const loaded = $derived(sources !== undefined && listKey in lists);

  // The menu: a device is named once, with its build added only when it has a list for both.
  const deviceName = d => d || 'Unknown device';
  const options = $derived.by(() => {
    const builds = new Map();
    for (const s of sources ?? []) builds.set(s.device, (builds.get(s.device) ?? 0) + 1);
    return (sources ?? []).map(s => ({
      value: `${s.build}|${s.device}`, build: s.build, device: s.device,
      label: builds.get(s.device) > 1 ? `${deviceName(s.device)} · ${buildName(s.build)}` : deviceName(s.device),
    }));
  });
  const pick = value => {
    const o = options.find(x => x.value === value);
    if (o) set({build: o.build, device: o.device});
  };
  // A link, or a device that has gone, may name no list: take the newest one of the build, else the first.
  $effect(() => {
    if (!sources?.length || options.some(o => o.value === listKey)) return;
    const mine = sources.filter(s => s.build === filter.build);
    const best = [...(mine.length ? mine : sources)].sort((a, b) => b.stamp.localeCompare(a.stamp))[0];
    set({build: best.build, device: best.device});
  });

  // This build's roster, plus anything owned that the roster has no name for.
  // Names: en/jp show one language (falling back to the other); all shows this build's name with the other under it.
  const view = $derived.by(() => {
    const build = filter.build;
    const owned = new Map((list?.items ?? []).filter(t => t.tsum).map(t => [t.tsum, t]));
    const first = prefs.names === 'all' ? build : prefs.names === 'jp' ? 'jp' : 'global';
    const second = first === 'jp' ? 'global' : 'jp';
    const named = (id, names, own) => {
      const name = names[first] || names[second] || id;
      const alt = prefs.names === 'all' && names[second] && names[second] !== names[first] ? names[second] : '';
      return {id, name, alt, search: `${names.global} ${names.jp}`.toLowerCase(), own, color: tsumColor(catalog, id),
        left: toMax(catalog.byId.get(id), own)};
    };
    const entries = catalog.tsums.filter(t => t[build] || owned.has(t.id)).map(t => named(t.id, t, owned.get(t.id) ?? null));
    for (const [id, o] of owned) {
      if (!catalog.byId.has(id)) entries.push(named(id, {global: o.name || '', jp: o.name || ''}, o));
    }

    const ownedCount = entries.filter(e => e.own).length;
    const q = filter.q.trim().toLowerCase();
    const shown = entries.filter(e =>
      (filter.owned === 'all' || (filter.owned === 'owned') === Boolean(e.own)) &&
      (!q || e.search.includes(q) || e.id.includes(q)));
    const collator = new Intl.Collator(first === 'jp' ? 'ja' : undefined);
    const value = (e, key) => (key === 'name' ? e.name : key === 'left' ? e.left?.boxes ?? null : e.own?.[key] ?? null);
    // A Tsum with no figure for a key goes last whichever way it sorts.
    const compare = ({key, dir}) => (a, b) => {
      const x = value(a, key), y = value(b, key);
      if (x === null || y === null) return (x === null) - (y === null);
      const r = key === 'name' ? collator.compare(x, y) : x - y;
      return dir === 'desc' ? -r : r;
    };
    const chain = prefs.sorts.map(compare);
    shown.sort((a, b) => { for (const c of chain) { const r = c(a, b); if (r) return r; } return collator.compare(a.name, b.name); });

    const when = stampDate(list?.stamp);
    return {
      shown,
      totals: maxOutTotals(shown),
      count: list ? `Owned ${fmt(ownedCount)} / ${fmt(entries.length)}` : `${fmt(entries.length)} Tsums`,
      progress: entries.length ? (ownedCount / entries.length) * 100 : 0,
      source: list ? `From ${list.file}${when ? ` · exported ${dateFmt.format(when)}` : ''}` : 'No Tsum list imported yet',
    };
  });

  const sortArrow = key => {
    const i = prefs.sorts.findIndex(s => s.key === key);
    return i < 0 ? '' : `${prefs.sorts[i].dir === 'asc' ? '↑' : '↓'}${prefs.sorts.length > 1 ? i + 1 : ''}`;
  };
  const ariaSort = key => {
    const s = prefs.sorts.find(o => o.key === key);
    return s ? (s.dir === 'asc' ? 'ascending' : 'descending') : 'none';
  };
  // Max level and max skill: themes style these through `.maxed` (see docs/STATS-SITE.md).
  const isMaxed = o => Boolean(o) && o.level >= MAX_LEVEL && o.skillMax > 0 && o.skill >= o.skillMax;
  const compact = new Intl.NumberFormat(undefined, {notation: 'compact', maximumFractionDigits: 1});
  const leftTitle = l => `${fmt(l.boxes)} boxes · ${fmt(l.cost)} ${l.unit} to max the skill`;
  const skillText = o => (o.skill === null ? '?' : o.skillMax ? `${o.skill}/${o.skillMax}` : String(o.skill));

  onMount(() => {
    // Only the filters travel in the link; the rest is a saved preference.
    const p = Object.fromEntries(Object.keys(blank()).filter(k => k in initial).map(k => [k, initial[k]]));
    Object.assign(filter, p);
    if (filter.build !== 'jp') filter.build = 'global';
    onStateChange({...filter});
    loadSources();
  });

  /** A Tsum list was imported: fetch the lists again. */
  export function listsChanged() {
    for (const k of Object.keys(lists)) delete lists[k];
    loadSources();
  }
</script>

{#snippet meter(label, value, max, cls)}
  <div class="meter {cls}">
    <span>{label}</span>
    <div class="bar"><div style:width="{value !== null && max ? Math.min(100, (value / max) * 100) : 0}%"></div></div>
    <b>{value === null ? '?' : max ? `${value}/${max}` : String(value)}</b>
  </div>
{/snippet}

<!-- A list cell: a bar (hidden when the list is narrow) beside the figure. -->
{#snippet figure(o, value, max, text, cls)}
  {#if o}
    <span class="fig meter {cls}">
      <span class="bar"><span style:width="{value !== null && value !== undefined && max ? Math.min(100, (value / max) * 100) : 0}%"></span></span>
      <b>{text}</b>
    </span>
  {:else}—{/if}
{/snippet}

<!-- Skill boxes left and what they cost; a coin or medal icon says which. -->
{#snippet toMaxText(l)}
  {#if !l}<span class="sub">—</span>
  {:else if !l.boxes}<span class="sub">Skill maxed</span>
  {:else}<span class="to-max {l.unit}" title={leftTitle(l)}>{fmt(l.boxes)} {l.boxes === 1 ? 'box' : 'boxes'} · <b>{compact.format(l.cost)}</b></span>{/if}
{/snippet}

{#snippet emptyState()}
  <div class="panel empty-state" style="grid-column:1/-1">
    <h2>No Tsum list yet</h2>
    {#if isSnapshot()}<p>This snapshot has no Tsum list.</p>{:else}
    <p>In the Tsum script, run Chores › Tsum List › Now. The export lands in tsum_record/ and is picked
      up from the import folders, or drop the tsum_list_*.csv file here. <a href="#/help?topic=tsums">Step by step</a></p>{/if}
  </div>
{/snippet}

<section id="catalog" class="stack" {hidden}>
  <div class="panel">
    <div class="cat-controls">
      <!-- A labelled box, not a pill: a device may be named INTL or JP, like the game's builds. -->
      <label class="cat-device" title="Whose Tsum list to show: each device's newest export">
        <span>Device</span>
        <select value={listKey} onchange={e => pick(e.target.value)} disabled={!options.length}>
          {#each options as o (o.value)}<option value={o.value}>{o.label}</option>{:else}<option value={listKey}>No Tsum lists yet</option>{/each}
        </select>
      </label>
      <Seg label="Owned" value={filter.owned} onpick={v => set({owned: v})} options={[['all', 'All'], ['owned', 'Owned'], ['missing', 'Missing']]} />
      <input class="search" type="search" placeholder="Search Tsums" autocomplete="off" value={filter.q} oninput={e => setQuery(e.target.value)}>
      <Seg label="Tsum names" value={prefs.names} onpick={v => setPrefs({names: v})} options={[['en', 'Eng'], ['jp', 'JP'], ['all', 'All']]} />
      <Seg label="Layout" value={prefs.view} onpick={v => setPrefs({view: v})} options={[['card', 'Cards'], ['list', 'List']]} />
    </div>
    <!-- Every sort is always shown: grey when off, green ascending, gold descending. Shift-click adds one to the chain. -->
    <div class="cat-sort" style="margin-top:10px">
      <span class="sub">Sort</span>
      {#each Object.keys(SORTS) as k (k)}
        {@const i = prefs.sorts.findIndex(s => s.key === k)}
        {@const dir = i < 0 ? '' : prefs.sorts[i].dir}
        <button type="button" class="sort-btn {dir}" aria-pressed={i >= 0}
          title="Click to sort, click again to flip, Shift-click to add a sort"
          onclick={e => toggleSort(k, e.shiftKey)}>
          {prefs.sorts.length > 1 && i >= 0 ? `${i + 1}. ` : ''}{SORTS[k].label}{dir ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}
        </button>
      {/each}
    </div>
    <div class="cat-summary" style="margin-top:14px">
      <h2>{view.count}</h2>
      <div class="progress"><div style:width="{view.progress}%"></div></div>
      <span class="sub">{view.source}</span>
    </div>
  </div>

  {#if loaded}
    <MaxOut build={filter.build} totals={view.totals} shown={view.shown.length} />
    <div class="grid" class:list={prefs.view === 'list'}>
      {#if !list}{@render emptyState()}{/if}
      {#if !list && filter.owned !== 'all'}
        <!-- Nothing owned to show without a list. -->
      {:else if !view.shown.length}
        <div class="panel empty-state" style="grid-column:1/-1">No Tsums match.</div>
      {:else if prefs.view === 'list'}
        <div class="panel list-wrap">
          <table class="tsum-list">
            <thead>
              <tr>
                {#each [['Tsum', 'name'], ['Lv', 'level'], ['Skill', 'skill'], ['To max', 'left'], ['Acquired', 'order']] as [label, key] (key)}
                  <th class:num={key === 'level' || key === 'skill' || key === 'left'} aria-sort={ariaSort(key)} title="Click to sort, Shift-click to add a sort">
                    <button type="button" onclick={e => toggleSort(key, e.shiftKey)}>{label}{#if sortArrow(key)}<span class="arrow">{sortArrow(key)}</span>{/if}</button>
                  </th>
                {/each}
              </tr>
            </thead>
            <tbody>
              {#each view.shown as e (e.id)}
                {@const o = e.own}
                <tr class:missing={!o} class:maxed={isMaxed(o)} style:--tsum={e.color}>
                  <td class="who"><Avatar id={e.id} name={e.name} /><span class="names"><b>{e.name}{#if o?.favorite}<span class="fav-star" title="Favorite" role="img" aria-label="Favorite"></span>{/if}</b>{#if e.alt}<span class="alt">{e.alt}</span>{/if}</span>{#if isMaxed(o)}<span class="maxed-badge" title="Max level and skill" role="img" aria-label="Max level and skill"></span>{/if}</td>
                  <td class="num">{@render figure(o, o?.level, MAX_LEVEL, o ? `${o.level ?? '?'}/${MAX_LEVEL}` : '', 'level')}</td>
                  <td class="num">{@render figure(o, o?.skill, o?.skillMax, o ? skillText(o) : '', 'skill')}</td>
                  <td class="num">{@render toMaxText(e.left)}</td>
                  <td>{o ? `${acquiredLabel(o.acquired) || '—'}${o.order ? ` · #${o.order}` : ''}` : 'Not owned'}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {:else}
        {#each view.shown as e (e.id)}
          {@const o = e.own}
          <div class="panel card" class:missing={!o} class:maxed={isMaxed(o)} style:--tsum={e.color}>
            {#if isMaxed(o)}<span class="maxed-shine" aria-hidden="true"></span><span class="maxed-badge" title="Max level and skill" role="img" aria-label="Max level and skill"></span>{/if}
            <span class="portrait"><Avatar id={e.id} name={e.name} large />{#if o?.favorite}<span class="fav-star" title="Favorite" role="img" aria-label="Favorite"></span>{/if}</span>
            <div class="name">{e.name}</div>
            {#if e.alt}<div class="alt">{e.alt}</div>{/if}
            {#if o}
              <div class="stats">
                {@render meter('Lv', o.level, MAX_LEVEL, 'level')}
                {@render meter('Skill', o.skill, o.skillMax, 'skill')}
                <div class="meta-left">{@render toMaxText(e.left)}</div>
                <div class="meta"><span>{acquiredLabel(o.acquired) || '—'}</span><span title="Order acquired">{o.order ? `#${o.order}` : ''}</span></div>
              </div>
            {:else}
              <div class="sub">Not owned</div>
              <div class="stats"><div class="meta-left">{@render toMaxText(e.left)}</div></div>
            {/if}
          </div>
        {/each}
      {/if}
    </div>
  {/if}
</section>
