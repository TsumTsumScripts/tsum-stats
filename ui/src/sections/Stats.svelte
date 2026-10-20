<!--
  The Stats section: the filter rail, KPI tiles, charts, the per-Tsum table and
  the rounds table. The server filters, sorts, pages and aggregates, so the
  page never holds more than one page of rounds however many there are.
  On the global site there are no rounds, only their sums per UTC day (the
  day each round began) and their 2 % bins: no rounds table, filters
  by skill level and items instead of devices, and coin and medal ranges only.
-->
<script>
  import {onMount, tick} from 'svelte';
  import {isGlobal} from '../lib/global/client.js';
  import {isSnapshot} from '../lib/snapshot/client.js';
  import {SvelteSet} from 'svelte/reactivity';
  import Chart from '../components/Chart.svelte';
  import DataTable from '../components/DataTable.svelte';
  import Legend from '../components/Legend.svelte';
  import Panel from '../components/Panel.svelte';
  import Seg from '../components/Seg.svelte';
  import TsumCell from '../components/TsumCell.svelte';
  import {drawCompare, drawDaily, drawEfficiency, drawChains, drawHistogram, drawItems, drawShare} from '../lib/charts.js';
  import {cardContext} from '../lib/card.js';
  import {expand, shared, toast} from '../lib/ui.svelte.js';
  import {
    api, buildLabel, cap, debounce, fmt, fmtDuration, fmtRate, fmtWhen, itemsCost, itemsLabel, loadPref, pct, savePref,
    PLAY, playValueName, skillTypeName, tsumColor, tsumName,
  } from '../lib/util.js';
  import ChainBest from './stats/ChainBest.svelte';
  import FilterRail from './stats/FilterRail.svelte';
  import FocusBar from './stats/FocusBar.svelte';
  import HeadToHead from './stats/HeadToHead.svelte';
  import Kpis from './stats/Kpis.svelte';

  // initial: the link's params; onStateChange(filter, {push}) writes the link.
  let {hidden, initial, onStateChange} = $props();
  const globalSite = isGlobal();

  // coins is the primary stat: '' base coins (before the coin bonus), 'final' final
  // coins, 'medals' medals (the server then keeps medal Tsums' rounds, one that earned none as 0).
  // net '1' subtracts what the round's boost items cost from its coins (not from medals).
  // tsum is a comma list: one Tsum focuses on it, several compare them head to head.
  // device is a comma list of device names; empty is every device.
  // skillType is a comma list of the script's skill types, '-' the rounds sent without one; empty is every one.
  // scan, chain and bubble (PLAY) are comma lists of those script settings' values, '-' where not recorded.
  // days is the time range: '7' or '30' (rolling, up to today), 'all', or '' for the from/to dates.
  // min/max Score, Coins and Medals are the outlier ranges (OUTLIERS); incomplete '1' keeps rounds with an unread figure.
  // On the global site, skill and items are comma lists of skill levels and item masks (-1: not recorded).
  // minRounds leaves Tsums with fewer rounds in the filter out of the rankings (the Tsum table and efficiency chart);
  // it is the page's alone, never sent, so every total still counts their rounds.
  const blank = () => ({tsum: '', device: '', skillType: '', ...Object.fromEntries(PLAY.map(p => [p.param, ''])), days: '7', from: '', to: '', ...Object.fromEntries(OUTLIER_KEYS.map(k => [k, ''])),
    incomplete: '', build: '', coins: '', net: '', minRounds: '', sort: '-playedAt', page: 1, perPage: 50, ...(globalSite ? {skill: '', items: ''} : {})});
  /** The outlier ranges: a stat, its link keys and the input step. */
  const OUTLIERS = [['score', 'Score', 'minScore', 'maxScore', 1000], ['coins', 'Coins', 'minCoins', 'maxCoins', 100], ['medals', 'Medals', 'minMedals', 'maxMedals', 10]];
  const OUTLIER_KEYS = OUTLIERS.flatMap(([, , lo, hi]) => [lo, hi]);
  // The global site keeps bins of coins and medals, not of scores: no score range there.
  const RANGES = globalSite ? OUTLIERS.filter(([stat]) => stat !== 'score') : OUTLIERS;
  const listOf = s => (s ? s.split(',').filter(Boolean) : []);
  /** A filter from the link's params; a link with dates but no days keeps its dates. */
  function fromParams(p) {
    const s = {...blank(), ...p};
    // Every global round is complete and has no device, and there are no score bins, so those filters do not apply.
    if (globalSite) Object.assign(s, {device: '', incomplete: '', minScore: '', maxScore: ''});
    if ((p.from || p.to) && !p.days) s.days = '';
    s.page = Number(s.page) || 1;
    s.perPage = Number(s.perPage) || 50;
    return s;
  }
  // Ctrl, ⌘ or Shift with a click adds a Tsum to the comparison instead of focusing on it.
  const adds = e => Boolean(e && (e.ctrlKey || e.metaKey || e.shiftKey));
  const basisName = (coins, net) => (coins === 'medals' ? 'medals' : `${net ? 'net ' : ''}${coins === 'final' ? 'final' : 'base'} coins`);

  // Local calendar days → UTC instants, so "From Sep 3" means the viewer's Sep 3.
  // The global site's figures are per UTC day (the day a round began), so there a day is a UTC one.
  const dayStart = day => new Date(`${day}T00:00:00${globalSite ? 'Z' : ''}`);
  const addDays = (d, n) => (globalSite ? d.setUTCDate(d.getUTCDate() + n) : d.setDate(d.getDate() + n));
  const localDayStart = day => (day ? dayStart(day).toISOString() : '');
  function localDayEnd(day) {
    if (!day) return '';
    const d = dayStart(day);
    addDays(d, 1);
    return d.toISOString();
  }
  const isoDay = d => (globalSite ? d.toISOString().slice(0, 10)
    : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  const utc = globalSite ? ' UTC' : '';

  // "-score" ↔ [{id: 'score', desc: true}]
  const toSorting = sort => [{id: sort.replace(/^-/, ''), desc: sort.startsWith('-')}];
  const fromSorting = s => (s[0] ? `${s[0].desc ? '-' : ''}${s[0].id}` : '-playedAt');

  // Chart views are a per-browser preference, not part of the link.
  const VIEW_KEY = 'tsum-stats.views';
  const defaultViews = {compare: 'rate', eff: 'rate', effMetric: 'rate', daily: 'stack', share: 'donut', shareMetric: 'coins', items: 'rate', chains: 'rate', chainsView: 'all'};
  const views = $state({...defaultViews, ...loadPref(VIEW_KEY, {})});
  function setView(key, v) {
    views[key] = v;
    savePref(VIEW_KEY, {...views});
  }

  const filter = $state(blank());
  /** Devices that have played a round: {device, rounds}. */
  let playedDevices = $state([]);
  /** The script's skill types with rounds, [{skillType, rounds}], "" for none. */
  let skillTypes = $state([]);
  /** Each play setting's values with rounds, {scan: [{value, rounds}], ...}, "" for not recorded. */
  let playChoices = $state.raw({});
  // The global site's status: its skill levels and the contributors a Tsum needs before its figures are trusted.
  let status = $state.raw(null);
  // The global site's item sets, for the items filter: [{items, rounds}] from the last summary without one.
  let itemSets = $state.raw([]);
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
  const pickedTypes = $derived(listOf(filter.skillType));
  const pickedPlay = $derived(Object.fromEntries(PLAY.map(p => [p.param, listOf(filter[p.param])])));
  const pickedSkills = $derived(globalSite ? listOf(filter.skill) : []);
  const pickedItems = $derived(globalSite ? listOf(filter.items) : []);
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
    addDays(from, -n + 1);
    return {from: isoDay(from), to: ''};
  });

  const filterParams = () => ({
    tsum: filter.tsum, device: filter.device, skillType: filter.skillType, ...Object.fromEntries(PLAY.map(p => [p.param, filter[p.param]])), build: filter.build, coins: filter.coins, net: net ? '1' : '', incomplete: filter.incomplete,
    ...Object.fromEntries(OUTLIER_KEYS.map(k => [k, filter[k]])),
    from: localDayStart(range.from), to: localDayEnd(range.to),
    ...(globalSite ? {skill: filter.skill, items: filter.items} : {}),
  });

  /**
   * Changes the filter; only: 'rounds' when just the table's page moved. A new
   * Tsum selection is a new history entry, so the browser's Back undoes it.
   */
  function set(patch, {resetPage = true, only} = {}) {
    const push = 'tsum' in patch && patch.tsum !== filter.tsum;
    const sortOnly = 'sort' in patch && Object.keys(patch).length === 1;
    // The minimum rounds is applied here, to what is loaded already.
    const pageOnly = Object.keys(patch).every(k => k === 'minRounds');
    Object.assign(filter, patch, resetPage && !('page' in patch) && !pageOnly ? {page: 1} : {});
    onStateChange({...filter}, {push});
    navTick++;
    if (pageOnly) return;
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
    if (pickedTypes.length) {
      out.push({label: pickedTypes.length > 2 ? `${pickedTypes.length} skill types` : pickedTypes.map(skillTypeName).join(', '), clear: () => set({skillType: ''})});
    }
    for (const p of PLAY) {
      const on = pickedPlay[p.param];
      if (on.length) out.push({label: `${p.short}: ${on.length > 2 ? `${on.length} values` : on.map(v => playValueName(p.param, v)).join(', ')}`, clear: () => set({[p.param]: ''})});
    }
    if (filter.build) out.push({label: buildLabel(filter.build), clear: () => set({build: ''})});
    if (pickedSkills.length) out.push({label: `Skill ${pickedSkills.map(skillName).join(', ')}`, clear: () => set({skill: ''})});
    if (pickedItems.length) {
      out.push({label: pickedItems.length > 2 ? `${pickedItems.length} item sets` : pickedItems.map(m => itemsLabel(Number(m))).join(', '), clear: () => set({items: ''})});
    }
    if (Number(filter.days)) out.push({label: `Last ${filter.days} days${utc}`, kind: 'time', clear: () => set({days: 'all'})});
    else if (filter.days !== 'all' && (filter.from || filter.to)) {
      out.push({label: `${filter.from || '…'} → ${filter.to || 'today'}${utc}`, kind: 'time', clear: () => set({days: 'all', from: '', to: ''})});
    }
    if (filter.coins) out.push({label: cap(basisName(filter.coins)), kind: 'basis', clear: () => set({coins: ''})});
    if (net) out.push({label: 'Less item costs', kind: 'basis', clear: () => set({net: ''})});
    // The coin range is base or final coins, even in Medals mode.
    const rangeName = {coins: basisName(filter.coins === 'final' ? 'final' : '', net), score: 'score', medals: 'medals'};
    for (const [stat, , lo, hi] of OUTLIERS) {
      const a = filter[lo], b = filter[hi];
      if (a === '' && b === '') continue;
      const label = a !== '' && b !== '' ? `${fmt(Number(a))}–${fmt(Number(b))}` : a !== '' ? `≥ ${fmt(Number(a))}` : `≤ ${fmt(Number(b))}`;
      out.push({label: `${label} ${rangeName[stat]}`, clear: () => set({[lo]: '', [hi]: ''})});
    }
    if (filter.incomplete) out.push({label: 'Incomplete rounds', clear: () => set({incomplete: ''})});
    if (minRounds) out.push({label: `Tsums with ${fmt(minRounds)}+ rounds`, clear: () => set({minRounds: ''})});
    return out;
  });

  // A copied card names the focused Tsum, or the compared ones in its filter line, and always the time range and primary stat.
  cardContext(() => ({
    tsum: picked.length === 1 ? picked[0] : '',
    build: filter.build,
    unit,
    filters: [
      picked.length > 1 ? picked.map(nameOf).join(' vs ') : '',
      chips.find(c => c.kind === 'time')?.label ?? 'All time',
      cap(basis),
      ...chips.filter(c => !c.kind).map(c => c.label),
    ],
    rounds: summary?.totals.rounds ?? 0,
  }));

  /** The Tsum page for the one focused Tsum, with the filters it understands. */
  const pageLink = $derived.by(() => {
    if (picked.length !== 1) return null;
    // The page's ranges are rolling or all time; dates fall back to all time.
    const days = Number(filter.days) ? filter.days : 'all';
    const q = Object.entries({id: picked[0], days, coins: filter.coins, net: filter.net, device: pickedDevices.length === 1 ? filter.device : '', build: filter.build});
    return `#/tsum?${new URLSearchParams(q.filter(([, v]) => v))}`;
  });

  // ---- Loading ----

  function loadSummary() {
    summaryLoad = fetchSummary();
    return summaryLoad;
  }

  async function fetchSummary() {
    const mine = ++seq.summary;
    loading = true;
    const params = filterParams();
    try {
      const s = await api('summary', {...params, tz: -new Date().getTimezoneOffset()});
      if (mine !== seq.summary) return;
      summary = s;
      // The items filter offers the item sets the rest of the filter has.
      if (globalSite && !params.items) itemSets = itemSetsOf(s.mix);
    } catch (e) {
      if (mine === seq.summary) roundsNote = `Could not load: ${e.message}`;
      // The global site has no rounds table to say so under.
      if (mine === seq.summary && globalSite) toast(roundsNote, 6000);
    } finally {
      if (mine === seq.summary) loading = false;
    }
  }

  async function loadRounds() {
    // The global site keeps no rounds.
    if (globalSite) return;
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
    if (globalSite) status = await api('status');
    playedDevices = await api('round-devices');
    // An older snapshot has no skill types to offer.
    skillTypes = await api('skill-types').catch(() => []);
    // Nor play settings.
    playChoices = await api('play-settings').catch(() => ({}));
    played = (await api('tsums')).filter(t => t.tsum);
  }

  // ---- The global site's filters and flags ----

  const skillName = s => (Number(s) < 0 ? 'not recorded' : String(s));
  /** Rounds per item set in a summary's mix, most played first. */
  function itemSetsOf(mix) {
    const by = new Map();
    for (const m of mix) by.set(m.items, (by.get(m.items) ?? 0) + m.rounds);
    return [...by].map(([items, rounds]) => ({items, rounds})).sort((a, b) => b.rounds - a.rounds);
  }
  // A picked item set the last summary did not have is still offered, so it can be unticked.
  const itemChoices = $derived([...itemSets,
    ...pickedItems.filter(m => !itemSets.some(s => String(s.items) === m)).map(m => ({items: Number(m), rounds: null}))]);
  // Contributors per Tsum; one with fewer than status.minContributors is flagged "few players".
  const playersOf = $derived(new Map(played.map(t => [t.tsum, t.contributors ?? null])));
  const fewPlayers = r => globalSite && status && r.players !== null && r.players < status.minContributors;
  /**
   * Why the global site's spreads are missing, when they are: a range cuts the
   * bins of its own figure only, so the others' (coins under a medal range,
   * medals under a coin range) have none to give.
   */
  const noSpreads = $derived(summary?.global && !summary.global.spreads
    ? (summary.global.range === 'medals' ? 'with a medal range' : summary.global.range ? 'with a coin range' : 'yet for some days') : '');
  const noSpreadsWhy = 'a range keeps whole bins of its own figure, and the other figures\' bins cannot be cut by it';
  // The charts mark the global site's spreads as estimates, or say why they are missing.
  const spreadCtx = $derived(summary?.global ? {...ctx, approx: true, noSpreads: noSpreads && `No spreads ${noSpreads}: ${noSpreadsWhy}`} : ctx);

  /** The played Tsum whose English or JP name (or id) is text, or ''. */
  function matchTsum(text) {
    text = text.trim().toLowerCase();
    return (text && played.find(t => [tsumName(catalog, t.tsum), tsumName(catalog, t.tsum, 'jp'), t.tsum]
      .some(n => n.toLowerCase() === text))?.tsum) || '';
  }

  // ---- What the summary shows ----

  /** The fewest rounds a Tsum needs in the filter to be ranked; 0 for any. */
  const minRounds = $derived(Math.max(0, Math.floor(Number(filter.minRounds)) || 0));
  const ranked = t => t.rounds >= minRounds;
  /** The Tsum table's rows: each with its name, share of the primary stat, and medal figures (m). */
  const tsumRows = $derived.by(() => {
    if (!summary) return [];
    const s = summary;
    const total = s.tsums.reduce((n, t) => n + (t.coins ?? 0), 0);
    const medalTotal = s.medals.tsums.reduce((n, t) => n + (t.coins ?? 0), 0);
    const medalsOf = new Map(s.medals.tsums.map(t => [t.tsum, {...t, share: medalTotal ? (t.coins ?? 0) / medalTotal : null}]));
    return s.tsums.map(t => ({...t, name: nameOf(t.tsum) || 'Not identified', share: total ? (t.coins ?? 0) / total : null,
      m: medalsOf.get(t.tsum), players: playersOf.get(t.tsum) ?? null}));
  });

  const effSub = $derived(summary && {
    rate: `${fmt(byRounds.length)} Tsums · click one to focus, Ctrl/⌘-click to compare`,
    box: 'the 12 most played · box: middle half · bar: median · dot: average · whiskers: lowest to 90th percentile · ring: highest',
    bubble: 'every Tsum · across: average coins · up: coins per second · size: rounds',
  }[views.eff] + (minRounds ? ` · Tsums with ${fmt(minRounds)} rounds or more` : ''));
  const shareSub = $derived(summary && (views.share === 'sunburst'
    ? (new Set(summary.mix.map(m => m.build)).size > 1 ? 'inner: game · middle: Tsum · outer: items used' : 'inner: Tsum · outer: items used')
    : 'top 8 Tsums, the rest as Other'));
  const dailySub = $derived(summary && {
    stack: `total ${basis}, top 7 Tsums`, rate: `${basis} per second of play`, avg: `average ${basis} per round, with the day's lowest–highest band`,
  }[views.daily] + (globalSite ? ' · by the UTC day each round began' : ''));
  const histSub = $derived(summary && (noSpreads ? `not available ${noSpreads}: ${noSpreadsWhy}`
    : `how many rounds ended with each amount of ${basis}, by Tsum${summary.global ? ' · ≈ from 2 % wide bins' : ''}`));

  // Each chart's draw arguments; null until there is a summary.
  const byRounds = $derived(summary ? summary.tsums.filter(ranked).sort((a, c) => c.rounds - a.rounds) : []);
  // Shares are of every Tsum in the filter, ranked or not; the table lists the ranked ones.
  const tableRows = $derived(tsumRows.filter(ranked));
  // A card's efficiency chart keeps the 10 best by its measure.
  const effKey = {rate: 'coinsPerSec', avg: 'avgCoins', median: 'medianCoins', max: 'maxCoins'};
  const effTop = $derived(views.eff === 'rate'
    ? byRounds.filter(t => t[effKey[views.effMetric]] != null).sort((a, c) => c[effKey[views.effMetric]] - a[effKey[views.effMetric]]).slice(0, 10)
    : byRounds.slice(0, 10));
  const args = $derived(summary && {
    compare: picked.length > 1 ? [summary.dailyTsums, picked, ctx, views.compare] : null,
    eff: [views.eff, byRounds, spreadCtx, views.effMetric],
    daily: [summary.daily, summary.dailyTsums, ctx, views.daily],
    share: [views.share, views.share === 'sunburst' ? summary.mix : summary.tsums, ctx, views.shareMetric],
    items: [summary.mix, views.items],
    chains: [summary.chains, views.chains],
    hist: [summary.histogram, summary.totals, spreadCtx],
  });

  // ---- Tables ----

  /** The class of a column of the primary stat: its figures take the coin or medal colour. */
  const unitCls = () => (filter.coins === 'medals' ? 'medal' : 'coin');
  /** Whether a rounds column is the primary stat itself (coins: '', 'final' or 'medals'), which a copied card keeps first. */
  const primaryIs = coins => filter.coins === coins && !net;
  const num = (id, header, get, format = fmt, extra = {}) => ({
    id, header, accessorFn: r => get(r) ?? undefined, cell: r => format(get(r)), sortUndefined: 'last', sortDescFirst: true,
    ...extra, meta: {num: true, ...extra.meta},
  });

  // The same figures for medals, over medal Tsums' rounds, 0s included (row.m). With
  // medals as the primary stat the columns above already are these, so they drop out.
  const medal = (id, header, get, format = fmt, meta = {}) =>
    num(id, header, r => (r.m ? get(r.m) : null), format, {meta: {show: coinMode, ...meta}});

  // The global site's quartiles and P90 are estimates from its bins.
  const approxName = label => (globalSite ? `≈ ${label}` : label);
  const approxTitle = title => (globalSite ? `${title ? `${title}. ` : ''}Approximate: within 2 % of the exact figure` : title || undefined);

  const tsumColumns = [
    {id: 'pick', header: '', enableSorting: false, enableHiding: false, meta: {cls: 'pick'}, snippet: pickCell},
    {id: 'tsum', header: 'Tsum', accessorFn: r => r.name, snippet: tsumCell, sortDescFirst: false, enableHiding: false, meta: {search: true}},
    num('rounds', 'Rounds', r => r.rounds),
    num('players', 'Players', r => r.players, fmt, {meta: {show: () => globalSite, title: 'Contributors who sent rounds of this Tsum in the last 30 days'}}),
    num('share', () => `${U.slice(0, -1)} share`, r => r.share, pct, {meta: {title: "This Tsum's part of the primary stat in the filter"}}),
    num('coins', () => `Total ${unit}`, r => r.coins, fmt, {meta: {cls: unitCls}}),
    num('coinsPerSec', () => `${U}/s`, r => r.coinsPerSec, fmtRate, {meta: {cls: unitCls, title: 'Per second of play'}}),
    num('coinsPerHour', () => `${U}/h`, r => (r.coinsPerSec === null ? null : r.coinsPerSec * 3600)),
    num('avgCoins', 'Average', r => r.avgCoins),
    num('medianCoins', approxName('Median'), r => r.medianCoins, fmt, {meta: {title: approxTitle('')}}),
    num('minCoins', 'Lowest', r => r.minCoins),
    num('maxCoins', 'Highest', r => r.maxCoins),
    num('stdCoins', 'Std dev', r => r.stdCoins, fmt, {meta: {title: 'How far rounds usually land from the average'}}),
    num('q1Coins', approxName('Q1'), r => r.q1Coins, fmt, {meta: {hidden: true, title: approxTitle('A quarter of rounds made fewer coins')}}),
    num('q3Coins', approxName('Q3'), r => r.q3Coins, fmt, {meta: {hidden: true, title: approxTitle('A quarter of rounds made more coins')}}),
    num('p90Coins', approxName('P90'), r => r.p90Coins, fmt, {meta: {hidden: true, title: approxTitle('One round in ten made more coins')}}),
    num('avgBaseCoins', 'Avg base coins', r => r.avgBaseCoins, fmt, {meta: {hidden: true, title: 'Before the coin bonus'}}),
    num('avgFinalCoins', 'Avg final coins', r => r.avgFinalCoins, fmt, {meta: {hidden: true, title: 'After the coin bonus'}}),
    num('avgSeconds', 'Avg time', r => r.avgSeconds, fmtDuration),
    num('avgScore', 'Avg score', r => r.avgScore, fmt, {meta: {cls: 'score'}}),
    num('maxScore', 'Best score', r => r.maxScore, fmt, {meta: {hidden: true}}),
    medal('medalRounds', 'Medal rounds', m => m.earnedRounds, fmt, {hidden: true, title: 'Rounds that earned medals'}),
    medal('medalShare', 'Medal share', m => m.share, pct, {hidden: true, title: "This Tsum's part of all medals in the filter"}),
    medal('medals', 'Total medals', m => m.coins, fmt, {cls: 'medal'}),
    medal('medalsPerSec', 'Medals/s', m => m.coinsPerSec, fmtRate, {cls: 'medal', hidden: true, title: 'Medals per second of play, a round that earned none counting as 0'}),
    medal('medalsPerHour', 'Medals/h', m => (m.coinsPerSec === null ? null : m.coinsPerSec * 3600), fmt, {cls: 'medal'}),
    medal('avgMedals', 'Avg medals', m => m.avgCoins, fmt, {cls: 'medal', title: 'Average medals a round, a round that earned none counting as 0'}),
    medal('medianMedals', approxName('Median medals'), m => m.medianCoins, fmt, {hidden: true, title: approxTitle('')}),
    medal('minMedals', 'Lowest medals', m => m.minCoins, fmt, {hidden: true}),
    medal('maxMedals', 'Highest medals', m => m.maxCoins, fmt, {hidden: true}),
    medal('stdMedals', 'Medals std dev', m => m.stdCoins, fmt, {hidden: true}),
    medal('q1Medals', approxName('Medals Q1'), m => m.q1Coins, fmt, {hidden: true, title: approxTitle('')}),
    medal('q3Medals', approxName('Medals Q3'), m => m.q3Coins, fmt, {hidden: true, title: approxTitle('')}),
    medal('p90Medals', approxName('Medals P90'), m => m.p90Coins, fmt, {hidden: true, title: approxTitle('')}),
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
    num('baseCoins', 'Base coins', r => r.baseCoins, fmt, {meta: {cls: () => (primaryIs('') ? 'coin primary' : 'coin')}}),
    num('finalCoins', 'Final coins', r => r.finalCoins, fmt, {meta: {cls: () => (primaryIs('final') ? 'coin primary' : 'coin')}}),
    num('netCoins', () => cap(basis), r => netCoins(r), fmt, {enableSorting: false, meta: {cls: 'coin primary', show: () => net}}),
    num('coinsPerSec', () => `${U}/s`, r => {
      const c = filter.coins === 'medals' ? r.medals : netCoins(r);
      return c !== null && r.durationSeconds ? c / r.durationSeconds : null;
    }, fmtRate, {meta: {cls: () => `${unitCls()} primary`, title: 'Per second, of the Primary stat'}}),
    {id: 'items', header: 'Items', accessorKey: 'items', cell: r => itemsLabel(r.items), enableSorting: false, meta: {cls: 'dim'}},
    num('score', 'Score', r => r.score, fmt, {meta: {cls: 'score'}}),
    num('medals', 'Medals', r => r.medals, fmt, {meta: {cls: () => (primaryIs('medals') ? 'medal primary' : 'medal')}}),
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
  {#if fewPlayers(r)}<span class="sub few-flag" title="Too few players' rounds to stand for everyone's yet">few players</span>{/if}
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
  <FilterRail {filter} {range} {chips} outliers={RANGES} {picked} {played} {playedDevices} {pickedDevices} {skillTypes} {pickedTypes} {playChoices} {pickedPlay} comparing={picked.length > 1}
    skills={status?.skills ?? []} {pickedSkills} {itemChoices} {pickedItems}
    {set} reset={() => set({...blank(), coins: filter.coins, net: filter.net})} {addTsum} {dropTsum} {matchTsum} {nameOf} {colorOf} bind:open={railOpen} />

  <div class="stack stats-main">
    {#if picked.length}
      <FocusBar {picked} {canBack} {nameOf} {colorOf} {addTsum} {dropTsum} {matchTsum} clear={() => set({tsum: ''})} {pageLink} />
    {/if}

    <div id="s-overview" class="anchor">
      {#if summary}<Kpis t={summary.totals} m={summary.medals.totals} coins={filter.coins} {basis} approx={Boolean(summary.global)}
        missing={noSpreads && `no median ${noSpreads}`} />{/if}
    </div>

    <Panel id="s-compare" class="anchor" title="Head to head" sub="the Tsums in the filter side by side · the best in each row is marked"
      hidden={picked.length < 2}>
      {#if summary && picked.length > 1}
        <HeadToHead rows={tsumRows} {picked} coins={filter.coins} {nameOf} {colorOf} {focusOn} {dropTsum} approx={Boolean(summary.global)} />
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
      <Chart draw={drawEfficiency} args={args?.eff} cardArgs={args && [views.eff, effTop, spreadCtx, views.effMetric]} {unit} size="tall" />
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
      <Panel class="wide" title="By items used" sub="every item set, best first">
        {#snippet tools()}
          <Seg sm label="Measure" value={views.items} onpick={v => setView('items', v)} options={[['rate', `${U}/s`], ['avg', 'Average'], ['rounds', 'Rounds']]} />
        {/snippet}
        <Chart draw={drawItems} args={args?.items} {unit} size="square" />
      </Panel>
    </div>

    <Panel id="s-chains" class="anchor" title="By chain settings"
      sub={views.chainsView === 'best' ? `each Tsum's best chains-per-scan and max-chain pair of those with 20 rounds or more` : 'chains per scan and max chain length together, every pair, best first'}>
      {#snippet tools()}
        <Seg sm label="View" value={views.chainsView} onpick={v => setView('chainsView', v)} options={[['all', 'Every pair'], ['best', 'Best per Tsum']]} />
        {#if views.chainsView !== 'best'}
          <Seg sm label="Measure" value={views.chains} onpick={v => setView('chains', v)} options={[['rate', `${U}/s`], ['avg', 'Average'], ['rounds', 'Rounds']]} />
        {/if}
      {/snippet}
      {#if views.chainsView === 'best'}
        <ChainBest chains={summary?.chains ?? []} tsums={[...tableRows].sort((a, c) => c.rounds - a.rounds).map(t => t.tsum)} {unit} {nameOf} {colorOf} {focusOn} />
      {:else}
        <Chart draw={drawChains} args={args?.chains} {unit} size="square" />
      {/if}
    </Panel>

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
      <DataTable columns={tsumColumns} rows={tableRows} key="tsums" search="Search Tsums" pageSize={25} pageSizes={[10, 25, 50, 100]}
        sorting={[{id: 'coinsPerSec', desc: true}]} countLabel={n => `${fmt(n)} Tsums`} rowClass={r => (fewPlayers(r) ? 'few' : null)}>
        {#snippet empty()}No Tsums match these filters.{/snippet}
      </DataTable>
    </Panel>

    {#if !globalSite}
      <Panel id="s-rounds" class="anchor" title="Rounds" sub={roundsNote}>
        <DataTable columns={roundColumns} rows={rounds.rows} total={rounds.total} page={rounds.page} key="rounds" pageSizes={[25, 50, 100, 200]}
          manual={roundsManual} rowClass={r => (rounds.fresh.has(r.id) ? 'fresh' : null)} countLabel={n => `${fmt(n)} rounds`} empty={roundsEmpty} />
      </Panel>
    {/if}
  </div>
</section>
