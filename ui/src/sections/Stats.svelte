<!--
  The Stats section: the filter rail, KPI tiles, charts, the per-Tsum table and
  the rounds table. The server filters, sorts, pages and aggregates, so the
  page never holds more than one page of rounds however many there are.
-->
<script>
  import {onMount, tick} from 'svelte';
  import {isSnapshot} from '../lib/snapshot/client.js';
  import {SvelteSet} from 'svelte/reactivity';
  import Chart from '../components/Chart.svelte';
  import DataTable from '../components/DataTable.svelte';
  import Legend from '../components/Legend.svelte';
  import Panel from '../components/Panel.svelte';
  import Seg from '../components/Seg.svelte';
  import TsumCell from '../components/TsumCell.svelte';
  import {drawCompare, drawDaily, drawEfficiency, drawHistogram, drawHours, drawItems, drawShare} from '../lib/charts.js';
  import {expand, shared} from '../lib/ui.svelte.js';
  import {
    api, buildLabel, cap, debounce, fmt, fmtDuration, fmtRate, fmtWhen, itemsCost, itemsLabel, loadPref, pct, savePref, tsumColor, tsumName,
  } from '../lib/util.js';
  import FilterRail from './stats/FilterRail.svelte';
  import FocusBar from './stats/FocusBar.svelte';
  import HeadToHead from './stats/HeadToHead.svelte';
  import Kpis from './stats/Kpis.svelte';

  // initial: the link's params; onStateChange(filter, {push}) writes the link.
  let {hidden, initial, onStateChange} = $props();

  // coins is the primary stat: '' base coins (before the coin bonus), 'final' final
  // coins, 'medals' medals (the server then keeps only rounds that earned medals).
  // net '1' subtracts what the round's boost items cost from its coins (not from medals).
  // tsum is a comma list: one Tsum focuses on it, several compare them head to head.
  // device is a comma list of device names; empty is every device.
  // days is the time range: '7' or '30' (rolling, up to today), 'all', or '' for the from/to dates.
  // min/max Score, Coins and Medals are the outlier ranges (OUTLIERS); incomplete '1' keeps rounds with an unread figure.
  const blank = () => ({tsum: '', device: '', days: '7', from: '', to: '', ...Object.fromEntries(OUTLIER_KEYS.map(k => [k, ''])),
    incomplete: '', build: '', coins: '', net: '', sort: '-playedAt', page: 1, perPage: 50});
  /** The outlier ranges: a stat, its link keys and the input step. */
  const OUTLIERS = [['score', 'Score', 'minScore', 'maxScore', 1000], ['coins', 'Coins', 'minCoins', 'maxCoins', 100], ['medals', 'Medals', 'minMedals', 'maxMedals', 10]];
  const OUTLIER_KEYS = OUTLIERS.flatMap(([, , lo, hi]) => [lo, hi]);
  const listOf = s => (s ? s.split(',').filter(Boolean) : []);
  /** A filter from the link's params; a link with dates but no days keeps its dates. */
  function fromParams(p) {
    const s = {...blank(), ...p};
    if ((p.from || p.to) && !p.days) s.days = '';
    s.page = Number(s.page) || 1;
    s.perPage = Number(s.perPage) || 50;
    return s;
  }
  // Ctrl, ⌘ or Shift with a click adds a Tsum to the comparison instead of focusing on it.
  const adds = e => Boolean(e && (e.ctrlKey || e.metaKey || e.shiftKey));
  const basisName = (coins, net) => (coins === 'medals' ? 'medals' : `${net ? 'net ' : ''}${coins === 'final' ? 'final' : 'base'} coins`);

  // Local calendar days → UTC instants, so "From Sep 3" means the viewer's Sep 3.
  const localDayStart = day => (day ? new Date(`${day}T00:00:00`).toISOString() : '');
  function localDayEnd(day) {
    if (!day) return '';
    const d = new Date(`${day}T00:00:00`);
    d.setDate(d.getDate() + 1);
    return d.toISOString();
  }
  const isoDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  // "-score" ↔ [{id: 'score', desc: true}]
  const toSorting = sort => [{id: sort.replace(/^-/, ''), desc: sort.startsWith('-')}];
  const fromSorting = s => (s[0] ? `${s[0].desc ? '-' : ''}${s[0].id}` : '-playedAt');

  // Chart views are a per-browser preference, not part of the link.
  const VIEW_KEY = 'tsum-stats.views';
  const defaultViews = {compare: 'rate', eff: 'rate', effMetric: 'rate', daily: 'stack', share: 'donut', shareMetric: 'coins', hour: 'rate', items: 'rate'};
  const views = $state({...defaultViews, ...loadPref(VIEW_KEY, {})});
  function setView(key, v) {
    views[key] = v;
    savePref(VIEW_KEY, {...views});
  }

  const filter = $state(blank());
  /** Devices that have played a round: {device, rounds}. */
  let playedDevices = $state([]);
  let summary = $state.raw(null);
  let summaryLoad = Promise.resolve();
  const seq = {summary: 0, rounds: 0};
  let loading = $state(false);
  let roundsNote = $state('');
  // One page of rounds, with the page it is and the rows to flash as new.
  let rounds = $state.raw({rows: [], total: 0, page: null, fresh: new Set()});
  let fresh = new Set();
  let played = $state.raw([]);
  let railOpen = $state(false);
  // Bumped on every link change, for the focus bar's Back button.
  let navTick = $state(0);
  // Rows ticked in the Tsum table for the next comparison.
  const ticked = new SvelteSet();
  const legends = $state({compare: [], daily: [], share: [], hist: []});

  const catalog = shared.catalog;
  const nameOf = id => (id ? tsumName(catalog, id, filter.build || 'global') : '');
  const colorOf = id => tsumColor(catalog, id);
  const picked = $derived(listOf(filter.tsum));
  const pickedDevices = $derived(listOf(filter.device));
  const unit = $derived(filter.coins === 'medals' ? 'medals' : 'coins');
  const U = $derived(cap(unit));
  // Item costs come off coins only; in Medals mode the switch waits, unsent.
  const net = $derived(filter.coins !== 'medals' && filter.net === '1');
  const basis = $derived(basisName(filter.coins, net));
  const coinMode = () => filter.coins !== 'medals';
  const canBack = $derived.by(() => {
    navTick;
    return Boolean(picked.length && history.state?.gapDrill);
  });

  /** Focuses on one Tsum, or with adds(e) toggles it in the comparison. */
  function focusOn(id, e) {
    if (!adds(e)) return set({tsum: id});
    set({tsum: (picked.includes(id) ? picked.filter(t => t !== id) : [...picked, id]).join(',')});
  }
  const addTsum = id => !picked.includes(id) && set({tsum: [...picked, id].join(',')});
  const dropTsum = id => set({tsum: picked.filter(t => t !== id).join(',')});
  const ctx = {nameOf, colorOf, onPick: focusOn};

  /** The from/to days the range stands for; the rolling ones end today. */
  const range = $derived.by(() => {
    if (filter.days === 'all') return {from: '', to: ''};
    const n = Number(filter.days);
    if (!n) return {from: filter.from, to: filter.to};
    const from = new Date();
    from.setDate(from.getDate() - n + 1);
    return {from: isoDay(from), to: ''};
  });

  const filterParams = () => ({
    tsum: filter.tsum, device: filter.device, build: filter.build, coins: filter.coins, net: net ? '1' : '', incomplete: filter.incomplete,
    ...Object.fromEntries(OUTLIER_KEYS.map(k => [k, filter[k]])),
    from: localDayStart(range.from), to: localDayEnd(range.to),
  });

  /**
   * Changes the filter; only: 'rounds' when just the table's page moved. A new
   * Tsum selection is a new history entry, so the browser's Back undoes it.
   */
  function set(patch, {resetPage = true, only} = {}) {
    const push = 'tsum' in patch && patch.tsum !== filter.tsum;
    const sortOnly = 'sort' in patch && Object.keys(patch).length === 1;
    Object.assign(filter, patch, resetPage && !('page' in patch) ? {page: 1} : {});
    onStateChange({...filter}, {push});
    navTick++;
    if (only !== 'rounds' && !sortOnly) loadSummary();
    loadRounds();
  }

  /** The active filters as removable chips; on narrow screens they are all the rail shows. */
  const chips = $derived.by(() => {
    const out = [];
    // Picked Tsums are in the focus bar and under the rail's Tsums box.
    if (pickedDevices.length) {
      out.push({label: pickedDevices.length > 2 ? `${pickedDevices.length} devices` : pickedDevices.join(', '), clear: () => set({device: ''})});
    }
    if (filter.build) out.push({label: buildLabel(filter.build), clear: () => set({build: ''})});
    if (Number(filter.days)) out.push({label: `Last ${filter.days} days`, clear: () => set({days: 'all'})});
    else if (filter.days !== 'all' && (filter.from || filter.to)) {
      out.push({label: `${filter.from || '…'} → ${filter.to || 'today'}`, clear: () => set({days: 'all', from: '', to: ''})});
    }
    if (filter.coins) out.push({label: cap(basisName(filter.coins)), clear: () => set({coins: ''})});
    if (net) out.push({label: 'Less item costs', clear: () => set({net: ''})});
    // The coin range is base or final coins, even in Medals mode.
    const rangeName = {coins: basisName(filter.coins === 'final' ? 'final' : '', net), score: 'score', medals: 'medals'};
    for (const [stat, , lo, hi] of OUTLIERS) {
      const a = filter[lo], b = filter[hi];
      if (a === '' && b === '') continue;
      const label = a !== '' && b !== '' ? `${fmt(Number(a))}–${fmt(Number(b))}` : a !== '' ? `≥ ${fmt(Number(a))}` : `≤ ${fmt(Number(b))}`;
      out.push({label: `${label} ${rangeName[stat]}`, clear: () => set({[lo]: '', [hi]: ''})});
    }
    if (filter.incomplete) out.push({label: 'Incomplete rounds', clear: () => set({incomplete: ''})});
    return out;
  });

  // ---- Loading ----

  function loadSummary() {
    summaryLoad = fetchSummary();
    return summaryLoad;
  }

  async function fetchSummary() {
    const mine = ++seq.summary;
    loading = true;
    try {
      const s = await api('summary', {...filterParams(), tz: -new Date().getTimezoneOffset()});
      if (mine === seq.summary) summary = s;
    } catch (e) {
      if (mine === seq.summary) roundsNote = `Could not load: ${e.message}`;
    } finally {
      if (mine === seq.summary) loading = false;
    }
  }

  async function loadRounds() {
    const mine = ++seq.rounds;
    try {
      const res = await api('rounds', {...filterParams(), sort: filter.sort, page: filter.page, perPage: filter.perPage});
      // The total is the summary's count, so wait for the one in flight.
      await summaryLoad;
      if (mine !== seq.rounds) return;
      const total = summary?.totals.rounds ?? 0;
      rounds = {rows: res.items, total, fresh,
        page: {sorting: toSorting(filter.sort), pageIndex: filter.page - 1, pageSize: Number(filter.perPage)}};
      fresh = new Set();
      roundsNote = `${fmt(total)} rounds · click a column to sort`;
    } catch (e) {
      if (mine === seq.rounds) roundsNote = `Could not load: ${e.message}`;
    }
  }

  async function loadTsumOptions() {
    playedDevices = await api('round-devices');
    played = (await api('tsums')).filter(t => t.tsum);
  }

  /** The played Tsum whose English or JP name (or id) is text, or ''. */
  function matchTsum(text) {
    text = text.trim().toLowerCase();
    return (text && played.find(t => [tsumName(catalog, t.tsum), tsumName(catalog, t.tsum, 'jp'), t.tsum]
      .some(n => n.toLowerCase() === text))?.tsum) || '';
  }

  // ---- What the summary shows ----

  /** The Tsum table's rows: each with its name, share of the primary stat, and medal figures (m). */
  const tsumRows = $derived.by(() => {
    if (!summary) return [];
    const s = summary;
    const total = s.tsums.reduce((n, t) => n + (t.coins ?? 0), 0);
    const medalTotal = s.medals.tsums.reduce((n, t) => n + (t.coins ?? 0), 0);
    const medalsOf = new Map(s.medals.tsums.map(t => [t.tsum, {...t, share: medalTotal ? (t.coins ?? 0) / medalTotal : null}]));
    return s.tsums.map(t => ({...t, name: nameOf(t.tsum) || 'Not identified', share: total ? (t.coins ?? 0) / total : null,
      m: medalsOf.get(t.tsum)}));
  });

  const effSub = $derived(summary && {
    rate: `${fmt(summary.tsums.length)} Tsums · click one to focus, Ctrl/⌘-click to compare`,
    box: 'the 12 most played · box: middle half · bar: median · dot: average · whiskers: lowest to 90th percentile · ring: highest',
    bubble: 'every Tsum · across: average coins · up: coins per second · size: rounds',
  }[views.eff]);
  const shareSub = $derived(summary && (views.share === 'sunburst'
    ? (new Set(summary.mix.map(m => m.build)).size > 1 ? 'inner: game · middle: Tsum · outer: items used' : 'inner: Tsum · outer: items used')
    : 'top 8 Tsums, the rest as Other'));
  const dailySub = $derived(summary && {
    stack: `total ${basis}, top 7 Tsums`, rate: `${basis} per second of play`, avg: `average ${basis} per round, with the day's lowest–highest band`,
  }[views.daily]);
  const histSub = $derived(summary && `how many rounds ended with each amount of ${basis}, by Tsum`);

  // Each chart's draw arguments; null until there is a summary.
  const byRounds = $derived(summary ? [...summary.tsums].sort((a, c) => c.rounds - a.rounds) : []);
  const args = $derived(summary && {
    compare: picked.length > 1 ? [summary.dailyTsums, picked, ctx, views.compare] : null,
    eff: [views.eff, byRounds, ctx, views.effMetric],
    daily: [summary.daily, summary.dailyTsums, ctx, views.daily],
    share: [views.share, views.share === 'sunburst' ? summary.mix : summary.tsums, ctx, views.shareMetric],
    hours: [summary.hours, views.hour],
    items: [summary.mix, views.items],
    hist: [summary.histogram, summary.totals, ctx],
  });

  // ---- Tables ----

  const num = (id, header, get, format = fmt, extra = {}) => ({
    id, header, accessorFn: r => get(r) ?? undefined, cell: r => format(get(r)), sortUndefined: 'last', sortDescFirst: true,
    ...extra, meta: {num: true, ...extra.meta},
  });

  // The same figures for medals, over the rounds that earned any (row.m). With
  // medals as the primary stat the columns above already are these, so they drop out.
  const medal = (id, header, get, format = fmt, meta = {}) =>
    num(id, header, r => (r.m ? get(r.m) : null), format, {meta: {show: coinMode, ...meta}});

  const tsumColumns = [
    {id: 'pick', header: '', enableSorting: false, enableHiding: false, meta: {cls: 'pick'}, snippet: pickCell},
    {id: 'tsum', header: 'Tsum', accessorFn: r => r.name, snippet: tsumCell, sortDescFirst: false, enableHiding: false, meta: {search: true}},
    num('rounds', 'Rounds', r => r.rounds),
    num('share', () => `${U.slice(0, -1)} share`, r => r.share, pct, {meta: {title: "This Tsum's part of the primary stat in the filter"}}),
    num('coins', () => `Total ${unit}`, r => r.coins, fmt, {meta: {cls: 'coin'}}),
    num('coinsPerSec', () => `${U}/s`, r => r.coinsPerSec, fmtRate, {meta: {cls: 'coin', title: 'Per second of play'}}),
    num('coinsPerHour', () => `${U}/h`, r => (r.coinsPerSec === null ? null : r.coinsPerSec * 3600)),
    num('avgCoins', 'Average', r => r.avgCoins),
    num('medianCoins', 'Median', r => r.medianCoins),
    num('minCoins', 'Lowest', r => r.minCoins),
    num('maxCoins', 'Highest', r => r.maxCoins),
    num('stdCoins', 'Std dev', r => r.stdCoins, fmt, {meta: {title: 'How far rounds usually land from the average'}}),
    num('q1Coins', 'Q1', r => r.q1Coins, fmt, {meta: {hidden: true, title: 'A quarter of rounds made fewer coins'}}),
    num('q3Coins', 'Q3', r => r.q3Coins, fmt, {meta: {hidden: true, title: 'A quarter of rounds made more coins'}}),
    num('p90Coins', 'P90', r => r.p90Coins, fmt, {meta: {hidden: true, title: 'One round in ten made more coins'}}),
    num('avgBaseCoins', 'Avg base coins', r => r.avgBaseCoins, fmt, {meta: {hidden: true, title: 'Before the coin bonus'}}),
    num('avgFinalCoins', 'Avg final coins', r => r.avgFinalCoins, fmt, {meta: {hidden: true, title: 'After the coin bonus'}}),
    num('avgSeconds', 'Avg time', r => r.avgSeconds, fmtDuration),
    num('avgScore', 'Avg score', r => r.avgScore, fmt, {meta: {cls: 'score'}}),
    num('maxScore', 'Best score', r => r.maxScore, fmt, {meta: {hidden: true}}),
    medal('medalRounds', 'Medal rounds', m => m.rounds, fmt, {hidden: true, title: 'Rounds that earned medals'}),
    medal('medalShare', 'Medal share', m => m.share, pct, {hidden: true, title: "This Tsum's part of all medals in the filter"}),
    medal('medals', 'Total medals', m => m.coins, fmt, {cls: 'medal'}),
    medal('medalsPerSec', 'Medals/s', m => m.coinsPerSec, fmtRate, {cls: 'medal', hidden: true, title: 'Medals per second of play, in rounds that earned medals'}),
    medal('medalsPerHour', 'Medals/h', m => (m.coinsPerSec === null ? null : m.coinsPerSec * 3600), fmt, {cls: 'medal'}),
    medal('avgMedals', 'Avg medals', m => m.avgCoins, fmt, {cls: 'medal', title: 'Average of the rounds that earned medals'}),
    medal('medianMedals', 'Median medals', m => m.medianCoins, fmt, {hidden: true}),
    medal('minMedals', 'Lowest medals', m => m.minCoins, fmt, {hidden: true}),
    medal('maxMedals', 'Highest medals', m => m.maxCoins, fmt, {hidden: true}),
    medal('stdMedals', 'Medals std dev', m => m.stdCoins, fmt, {hidden: true}),
    medal('q1Medals', 'Medals Q1', m => m.q1Coins, fmt, {hidden: true}),
    medal('q3Medals', 'Medals Q3', m => m.q3Coins, fmt, {hidden: true}),
    medal('p90Medals', 'Medals P90', m => m.p90Coins, fmt, {hidden: true}),
  ];

  /** A round's coins in the Primary stat, less its items' cost when net; null when unknown. */
  function netCoins(r) {
    const c = filter.coins === 'final' ? r.finalCoins : r.baseCoins;
    const cost = net ? itemsCost(r.items) : 0;
    return c === null || cost === null ? null : c - cost;
  }

  const roundColumns = [
    {id: 'playedAt', header: 'When', accessorKey: 'playedAt', cell: r => fmtWhen(r.playedAt), enableHiding: false, sortDescFirst: true},
    {id: 'tsum', header: 'Tsum', accessorKey: 'tsum', snippet: roundTsumCell, sortDescFirst: false},
    {id: 'build', header: 'Game', accessorKey: 'build', snippet: buildCell, enableSorting: false},
    num('baseCoins', 'Base coins', r => r.baseCoins, fmt, {meta: {cls: 'coin'}}),
    num('finalCoins', 'Final coins', r => r.finalCoins, fmt, {meta: {cls: 'coin'}}),
    num('netCoins', () => cap(basis), r => netCoins(r), fmt, {enableSorting: false, meta: {cls: 'coin', show: () => net}}),
    num('coinsPerSec', () => `${U}/s`, r => {
      const c = filter.coins === 'medals' ? r.medals : netCoins(r);
      return c !== null && r.durationSeconds ? c / r.durationSeconds : null;
    }, fmtRate, {meta: {cls: 'coin', title: 'Per second, of the Primary stat'}}),
    {id: 'items', header: 'Items', accessorKey: 'items', cell: r => itemsLabel(r.items), enableSorting: false, meta: {cls: 'dim'}},
    num('score', 'Score', r => r.score, fmt, {meta: {cls: 'score'}}),
    num('medals', 'Medals', r => r.medals, fmt, {meta: {cls: 'medal'}}),
    num('medalsPerSec', 'Medals/s', r => (r.medals !== null && r.durationSeconds ? r.medals / r.durationSeconds : null), fmtRate,
      {meta: {cls: 'medal', hidden: true, show: coinMode}}),
    num('durationSeconds', 'Time', r => r.durationSeconds, fmtDuration),
    {id: 'skillType', header: 'Skill', accessorKey: 'skillType', cell: r => r.skillType || '—', enableSorting: false, meta: {cls: 'dim', hidden: true}},
    {id: 'device', header: 'Device', accessorKey: 'device', cell: r => r.device || '—', sortDescFirst: false, meta: {cls: 'dim'}},
  ];

  const roundsManual = {
    onSort: sorting => set({sort: fromSorting(sorting)}),
    onPage: p => set({page: p.pageIndex + 1, perPage: p.pageSize}, {resetPage: false, only: 'rounds'}),
  };

  async function compareTicked() {
    set({tsum: [...ticked].join(',')});
    ticked.clear();
    await tick();
    document.getElementById('s-compare')?.scrollIntoView({behavior: 'smooth', block: 'start'});
  }

  // Esc backs out of a focused Tsum when nothing else (a big view, the filter menu) is open.
  // Capture, so it sees them open before their own Esc handlers close them.
  function onKey(e) {
    if (e.key !== 'Escape' || !filter.tsum || hidden || expand.open || railOpen || e.target.closest?.('input, select, textarea')) return;
    set({tsum: ''});
  }

  onMount(() => {
    Object.assign(filter, fromParams(initial));
    onStateChange({...filter}, {});
    loadTsumOptions();
    loadSummary();
    loadRounds();
  });

  /** The link changed (Back or Forward): show what it says. */
  export function shown(params) {
    const next = fromParams(params);
    navTick++;
    if (Object.keys(blank()).every(k => String(next[k]) === String(filter[k]))) return;
    Object.assign(filter, next);
    loadSummary();
    loadRounds();
  }

  export const refresh = debounce(() => { loadTsumOptions(); loadSummary(); loadRounds(); }, 800);

  /** A round arrived live: refresh, and flash its row if it lands on this page. */
  export function roundArrived(round) {
    fresh.add(round.id);
    refresh();
  }
</script>

{#snippet tsumCell(r)}
  <TsumCell id={r.tsum} name={r.tsum ? nameOf(r.tsum) : 'Not identified'} color={colorOf(r.tsum)} onpick={r.tsum ? e => focusOn(r.tsum, e) : null} />
{/snippet}
{#snippet roundTsumCell(r)}
  <TsumCell id={r.tsum} name={r.tsum ? tsumName(catalog, r.tsum, r.build || filter.build || 'global') : 'Not identified'} color={colorOf(r.tsum)}
    onpick={r.tsum ? e => focusOn(r.tsum, e) : null} />
{/snippet}
{#snippet pickCell(r)}
  {#if r.tsum}
    <input type="checkbox" aria-label="Compare {r.name}" checked={ticked.has(r.tsum)}
      onchange={e => (e.target.checked ? ticked.add(r.tsum) : ticked.delete(r.tsum))}>
  {/if}
{/snippet}
{#snippet buildCell(r)}<span class="tag">{buildLabel(r.build)}</span>{/snippet}
{#snippet roundsEmpty()}
  {#if summary?.totals.rounds}No rounds on this page.
  {:else if filter.days !== 'all'}No rounds in this time range. <button type="button" class="linkish" onclick={() => set({days: 'all'})}>Show all time</button>
  {:else if isSnapshot()}No rounds in this snapshot.
  {:else}No rounds yet. They appear here as the script plays, or when stats CSVs are imported. <a href="#/help">How to get them in</a>{/if}
{/snippet}

<svelte:document onkeydowncapture={onKey} />

<section id="stats" class="stats-layout" class:loading {hidden}>
  <FilterRail {filter} {range} {chips} outliers={OUTLIERS} {picked} {played} {playedDevices} {pickedDevices} comparing={picked.length > 1}
    {set} reset={() => set({...blank(), coins: filter.coins, net: filter.net})} {addTsum} {dropTsum} {matchTsum} {nameOf} {colorOf} bind:open={railOpen} />

  <div class="stack stats-main">
    {#if picked.length}
      <FocusBar {picked} {canBack} {nameOf} {colorOf} {addTsum} {dropTsum} {matchTsum} clear={() => set({tsum: ''})} />
    {/if}

    <div id="s-overview" class="anchor">
      {#if summary}<Kpis t={summary.totals} m={summary.medals.totals} coins={filter.coins} {basis} />{/if}
    </div>

    <Panel id="s-compare" class="anchor" title="Head to head" sub="the Tsums in the filter side by side · the best in each row is marked"
      hidden={picked.length < 2}>
      {#if summary && picked.length > 1}
        <HeadToHead rows={tsumRows} {picked} coins={filter.coins} {nameOf} {colorOf} {focusOn} {dropTsum} />
      {/if}
      <div class="panel-head versus-head">
        <div><h3>Per day</h3></div>
        <Seg sm label="Measure" value={views.compare} onpick={v => setView('compare', v)}
          options={[['rate', `${U}/s`], ['avg', 'Average'], ['total', 'Total'], ['rounds', 'Rounds']]} />
      </div>
      <Chart draw={drawCompare} args={args?.compare} {unit} bind:legend={legends.compare} />
      <Legend items={legends.compare} />
    </Panel>

    <Panel id="s-efficiency" class="anchor" title="{U.slice(0, -1)} efficiency by Tsum" sub={effSub}>
      {#snippet tools()}
        <Seg sm label="Chart" value={views.eff} onpick={v => setView('eff', v)} options={[['rate', 'Ranked'], ['box', 'Spread'], ['bubble', 'Bubbles']]} />
        <Seg sm label="Measure" value={views.effMetric} onpick={v => setView('effMetric', v)} hidden={views.eff !== 'rate'}
          options={[['rate', `${U}/s`], ['avg', 'Average'], ['median', 'Median'], ['max', 'Best']]} />
      {/snippet}
      <Chart draw={drawEfficiency} args={args?.eff} {unit} size="tall" />
    </Panel>

    <div class="charts anchor" id="s-time">
      <Panel class="wide" title="{U} per day" sub={dailySub}>
        {#snippet tools()}
          <Seg sm label="Chart" value={views.daily} onpick={v => setView('daily', v)} options={[['stack', 'By Tsum'], ['rate', `${U}/s`], ['avg', 'Average']]} />
        {/snippet}
        <Chart draw={drawDaily} args={args?.daily} {unit} bind:legend={legends.daily} />
        <Legend items={legends.daily} />
      </Panel>
    </div>

    <Panel id="s-share" class="anchor" title="Where the {unit} come from" sub={shareSub}>
      {#snippet tools()}
        <Seg sm label="Chart" value={views.share} onpick={v => setView('share', v)} options={[['donut', 'Donut'], ['sunburst', 'Sunburst']]} />
        <Seg sm label="Measure" value={views.shareMetric} onpick={v => setView('shareMetric', v)}
          options={[['coins', U], ['rounds', 'Rounds'], ['time', 'Time']]} />
      {/snippet}
      <div class="share-body">
        <Chart draw={drawShare} args={args?.share} {unit} size="square" bind:legend={legends.share} />
        <Legend items={legends.share} column />
      </div>
    </Panel>

    <div class="charts anchor" id="s-when">
      <Panel title="By hour of day" sub="your time, across every day in the filter">
        {#snippet tools()}
          <Seg sm label="Measure" value={views.hour} onpick={v => setView('hour', v)} options={[['rate', `${U}/s`], ['avg', 'Average'], ['rounds', 'Rounds']]} />
        {/snippet}
        <Chart draw={drawHours} args={args?.hours} {unit} size="square" />
      </Panel>
      <Panel title="By items used" sub="every item set, best first">
        {#snippet tools()}
          <Seg sm label="Measure" value={views.items} onpick={v => setView('items', v)} options={[['rate', `${U}/s`], ['avg', 'Average'], ['rounds', 'Rounds']]} />
        {/snippet}
        <Chart draw={drawItems} args={args?.items} {unit} size="square" />
      </Panel>
    </div>

    <Panel id="s-spread" class="anchor" title="{U} per round" sub={histSub}>
      <Chart draw={drawHistogram} args={args?.hist} {unit} bind:legend={legends.hist} />
      <Legend items={legends.hist} />
    </Panel>

    <Panel id="s-tsums" class="anchor" title="Tsums" sub="click a name to focus on it · tick several to compare them">
      {#snippet tools()}
        <button type="button" class="btn" disabled={ticked.size < 2} onclick={compareTicked}>
          {ticked.size ? `Compare ${ticked.size} ticked` : 'Compare ticked'}
        </button>
      {/snippet}
      <DataTable columns={tsumColumns} rows={tsumRows} key="tsums" search="Search Tsums" pageSize={25} pageSizes={[10, 25, 50, 100]}
        sorting={[{id: 'coinsPerSec', desc: true}]} countLabel={n => `${fmt(n)} Tsums`}>
        {#snippet empty()}No Tsums match these filters.{/snippet}
      </DataTable>
    </Panel>

    <Panel id="s-rounds" class="anchor" title="Rounds" sub={roundsNote}>
      <DataTable columns={roundColumns} rows={rounds.rows} total={rounds.total} page={rounds.page} key="rounds" pageSizes={[25, 50, 100, 200]}
        manual={roundsManual} rowClass={r => (rounds.fresh.has(r.id) ? 'fresh' : null)} countLabel={n => `${fmt(n)} rounds`} empty={roundsEmpty} />
    </Panel>
  </div>
</section>
