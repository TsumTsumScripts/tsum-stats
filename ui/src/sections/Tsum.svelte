<!--
  The Tsum page: everything about one Tsum. Its figures, how they changed with
  its skill level and the script's settings, where it ranks among your Tsums,
  what owning it says (level, skill, boxes to max), and its best rounds.
  On the global site it is every contributor's rounds of it: by skill level
  and items, ranked among every Tsum, by UTC day; no rounds, settings or
  Tsum lists, so no best rounds, recent form or boxes to max. Without a Tsum
  picked it is the list of Tsums over its time range and game, every Tsum
  together with few filters (the Stats page has them all): the best coin and
  medal earners an hour, the most played, the rounds of each Tsum a month and
  where the coins come from, and on the global site the Tsums new in the last
  30 days above them; with one, All Tsums goes back to it. The global site
  opens on it.
-->
<script>
  import {onMount} from 'svelte';
  import {isGlobal} from '../lib/global/client.js';
  import Avatar from '../components/Avatar.svelte';
  import Chart from '../components/Chart.svelte';
  import DaysBox from '../components/DaysBox.svelte';
  import TsumCombo from '../components/TsumCombo.svelte';
  import NewTsums from '../components/NewTsums.svelte';
  import Panel from '../components/Panel.svelte';
  import Seg from '../components/Seg.svelte';
  import {drawHistogram, drawItems, drawShare, drawSkillSpread, drawUsage} from '../lib/charts.js';
  import {BOX_PRICE, toMax} from '../lib/boxes.js';
  import {JACKPOT_TIMES} from '../lib/snapshot/engine.js';
  import {cardContext} from '../lib/card.js';
  import CopyButton from '../components/CopyButton.svelte';
  import {names} from '../lib/names.svelte.js';
  import {shared} from '../lib/ui.svelte.js';
  import {
    MIN_ROUNDS, api, buildLabel, cleanDays, daysLabel, playersIn, cap, chainsLabel, debounce, fmt, fmtDuration, fmtRate, fmtWhen, itemsLabel, loadPref, pct, savePref,
    PLAY, englishName, playValueName, skillTypeName, skillTypeValue, tsumColor, tsumName,
  } from '../lib/util.js';
  import Kpis from './stats/Kpis.svelte';
  import {EXP_WHAT, expHour, expRate, sumExp} from '../lib/expected.js';
  import Legend from '../components/Legend.svelte';
  import BestSettings from './tsum/BestSettings.svelte';
  import Breakdown from './tsum/Breakdown.svelte';
  import Earners from './tsum/Earners.svelte';
  import Insights from './tsum/Insights.svelte';
  import ItemPayback from './tsum/ItemPayback.svelte';

  // initial: the link's params; onStateChange(state, {push}) writes the link.
  let {hidden, initial, onStateChange} = $props();
  const globalSite = isGlobal();
  // The global site's status: the contributors a Tsum needs before its figures are trusted.
  let status = $state.raw(null);

  // id is the Tsum. days, coins, net, device and build mean what they do on the Stats page;
  // skillType is one of the script's skill types ('-' for none), or '' for every one.
  // skill is one skill level ('5'), or '' for every one: the breakdowns then compare like with like.
  const blank = () => ({id: '', days: 'all', coins: '', net: '', device: '', skillType: '', skill: '', build: ''});
  const filter = $state(blank());

  const VIEW_KEY = 'tsum-stats.tsum-views';
  const views = $state({items: 'exp', best: 'coins', usage: 'rounds', share: 'donut', shareMetric: 'coins', ...loadPref(VIEW_KEY, {})});
  function setView(key, v) {
    views[key] = v;
    savePref(VIEW_KEY, {...views});
    if (key === 'best') loadBest();
  }
  // A chart's measure as drawn and the rate measures offered: as on Stats (Stats.svelte: mv), medals an hour in Medals mode.
  const mv = key => {
    const v = views[key];
    if (filter.coins === 'medals') return v === 'exp' || v === 'rate' ? 'hour' : v;
    return v === 'hour' ? 'exp' : v;
  };
  const rateOpts = () => (filter.coins === 'medals' ? [['hour', `${U}/h`]] : [['exp', 'Expected/h'], ['rate', `${U}/s`]]);

  const catalog = shared.catalog;
  const nameOf = id => (id ? tsumName(catalog, id) : '');
  const colorOf = id => tsumColor(catalog, id);
  const ctx = {nameOf, colorOf, onPick: () => {}};

  let detail = $state.raw(null);
  /** The Tsum's skill types in the filter, without one picked: the select's choices. */
  let typeChoices = $state.raw([]);
  /** The Tsum's skill levels (1–10) in the filter, without one picked: the select's choices. */
  let skillChoices = $state.raw([]);
  let skillLegend = $state([]);
  let best = $state.raw([]);
  let played = $state.raw([]);
  let devices = $state.raw([]);
  /** The list of Tsums' summary (no Tsum picked): every Tsum over the time range, game and device, in base coins. */
  let list = $state.raw(null);
  /** The Tsum's row in the newest Tsum list for its build, with where it came from; null when not owned. */
  let owned = $state.raw(undefined);
  let loading = $state(false);
  let error = $state('');
  const seq = {detail: 0, best: 0, owned: 0, list: 0};

  const unit = $derived(filter.coins === 'medals' ? 'medals' : 'coins');
  const U = $derived(cap(unit));
  const net = $derived(filter.coins !== 'medals' && filter.net === '1');
  const basis = $derived(filter.coins === 'medals' ? 'medals' : `${net ? 'net ' : ''}${filter.coins === 'final' ? 'final' : 'base'} coins`);
  const entry = $derived(catalog.byId.get(filter.id));
  const name = $derived(nameOf(filter.id));
  const altName = $derived.by(() => {
    const other = entry && (names.lang === 'jp' ? englishName(entry) : entry.jp);
    return other && other !== name ? other : '';
  });

  // Each Tsum's rounds-under target, per primary stat, is a per-browser preference.
  const TARGET_KEY = 'tsum-stats.targets';
  const targetKey = $derived(`${filter.id}:${filter.coins || 'base'}${net ? ':net' : ''}`);
  const target = $derived((targetTick, loadPref(TARGET_KEY, {})[targetKey] ?? null));
  let targetTick = $state(0);
  function setTarget(v) {
    const all = loadPref(TARGET_KEY, {});
    if (v === null) delete all[targetKey];
    else all[targetKey] = v;
    savePref(TARGET_KEY, all);
    targetTick++;
    loadDetail();
  }

  // ---- Loading ----

  const isoDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  /** The UTC day a rolling range begins on ('' for all time): the global site's days are UTC ones, the day each round began. */
  function utcFrom(days) {
    const n = Number(days);
    if (!n) return '';
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n + 1);
    return d.toISOString().slice(0, 10);
  }
  function filterParams() {
    let from = '';
    const n = Number(filter.days);
    if (n && globalSite) {
      from = `${utcFrom(filter.days)}T00:00:00.000Z`;
    } else if (n) {
      const d = new Date();
      d.setDate(d.getDate() - n + 1);
      from = new Date(`${isoDay(d)}T00:00:00`).toISOString();
    }
    return {device: filter.device, skillType: filter.skillType, skill: filter.skill, build: filter.build, coins: filter.coins, net: net ? '1' : '', from};
  }

  function set(patch) {
    const push = 'id' in patch && patch.id !== filter.id;
    Object.assign(filter, patch);
    onStateChange({...filter}, {push});
    load();
    if (push) window.scrollTo({top: 0});
  }

  function load() {
    if (!filter.id) {
      detail = null;
      best = [];
      loadList();
      return;
    }
    loadDetail();
    loadBest();
    loadOwned();
  }

  async function loadDetail() {
    const mine = ++seq.detail;
    loading = true;
    try {
      const d = await api('tsum', {...filterParams(), id: filter.id, target: target ?? '', tz: -new Date().getTimezoneOffset()});
      if (mine === seq.detail) {
        detail = d;
        error = '';
        // The skill types to pick from are this Tsum's, kept while one is picked.
        if (!filter.skillType) typeChoices = d.skillTypes.map(r => r.key);
        if (!filter.skill) {
          skillChoices = d.settings.filter(r => r.setting === 'skillLevel' && /^([1-9]|10)$/.test(r.key)).map(r => r.key).sort((a, b) => a - b);
        }
      }
    } catch (e) {
      if (mine === seq.detail) error = `Could not load: ${e.message}`;
    } finally {
      if (mine === seq.detail) loading = false;
    }
  }

  /**
   * The list of Tsums: one summary over the time range, game and device, in
   * base coins, so every Tsum has its expected coins and the medal Tsums their
   * medals (summary.medals). The skill level and type are one Tsum's, so not sent.
   */
  async function loadList() {
    const mine = ++seq.list;
    loading = true;
    const {from, build, device} = filterParams();
    try {
      const d = await api('summary', {from, build, device, tz: -new Date().getTimezoneOffset()});
      if (mine === seq.list) { list = d; error = ''; }
    } catch (e) {
      if (mine === seq.list) error = `Could not load: ${e.message}`;
    } finally {
      if (mine === seq.list) loading = false;
    }
  }

  /** The best rounds: by the primary stat, its rate or score. The global site keeps no rounds. */
  async function loadBest() {
    if (globalSite) return;
    const mine = ++seq.best;
    const top = filter.coins === 'medals' ? '-medals' : filter.coins === 'final' ? '-finalCoins' : '-baseCoins';
    const sort = {coins: top, rate: '-coinsPerSec', score: '-score'}[views.best] || top;
    // Ranked by what the rounds made, as shown: before item costs.
    const res = await api('rounds', {...filterParams(), net: '', tsum: filter.id, sort, perPage: 10}).catch(() => null);
    if (mine === seq.best && res) best = res.items;
  }

  /** The Tsum in the newest Tsum list for the build (any device). The global site has no Tsum lists. */
  async function loadOwned() {
    if (globalSite) return;
    const mine = ++seq.owned;
    const build = filter.build || 'global';
    const sources = await api('owned-sources').catch(() => []);
    const src = sources.filter(s => s.build === build).sort((a, b) => b.stamp.localeCompare(a.stamp))[0];
    if (!src) { if (mine === seq.owned) owned = null; return; }
    const list = (await api('owned', {build, device: src.device}).catch(() => ({list: null}))).list;
    if (mine !== seq.owned) return;
    const own = list?.items.find(t => t.tsum === filter.id);
    owned = list ? {own: own ?? null, device: src.device, stamp: src.stamp} : null;
  }

  async function loadOptions() {
    if (globalSite) status = await api('status').catch(() => null);
    [played, devices] = await Promise.all([api('tsums').catch(() => []), api('round-devices').catch(() => [])]);
    played = played.filter(t => t.tsum);
  }

  // ---- The picker ----

  const pickOptions = $derived(played.map(t => ({value: tsumName(catalog, t.tsum), sub: `${fmt(t.rounds)} rounds`})));
  const playedRounds = $derived(new Map(played.map(t => [t.tsum, t.rounds])));

  function pick(typed) {
    const text = typed.trim().toLowerCase();
    const hit = text && played.find(t => [tsumName(catalog, t.tsum, 'en'), tsumName(catalog, t.tsum, 'jp'), t.tsum]
      .some(n => n.toLowerCase() === text));
    if (!hit) return false;
    set({id: hit.tsum});
    return true;
  }

  // ---- What the page shows ----

  const s = $derived(detail?.summary);

  /**
   * Where it ranks among the Tsums in the same filter, and how it compares with
   * all of them together: by expected net coins an hour (lib/expected.js), or
   * in medals by medals an hour.
   */
  const standing = $derived.by(() => {
    if (!detail) return null;
    const medals = filter.coins === 'medals';
    const rateOf = t => (medals ? t.coinsPerSec : expRate(t));
    // Ranked among the Tsums with MIN_ROUNDS rounds or more (this one whatever its rounds), as the Stats page ranks them.
    const rated = detail.field.filter(t => t.tsum && rateOf(t) !== null && (t.rounds >= MIN_ROUNDS || t.tsum === filter.id))
      .sort((a, b) => rateOf(b) - rateOf(a));
    const i = rated.findIndex(t => t.tsum === filter.id);
    const rounds = detail.field.reduce((n, t) => n + t.rounds, 0);
    const mine = detail.field.find(t => t.tsum === filter.id);
    const coins = detail.field.reduce((n, t) => n + (t.rateCoins ?? 0), 0);
    const secs = detail.field.reduce((n, t) => n + (t.rateSeconds ?? 0), 0);
    const all = medals ? (secs ? coins / secs : null) : expRate(sumExp(detail.field));
    const own = mine ? rateOf(mine) : null;
    return {
      rank: i < 0 ? null : i + 1, of: rated.length, all, medals,
      vsAll: all && own != null ? own / all - 1 : null,
      share: rounds && mine ? mine.rounds / rounds : null,
    };
  });

  const settingRows = (setting, label) => (detail?.settings ?? []).filter(r => r.setting === setting).map(r => ({...r, label: label(r.key)}));

  /** Skill levels, lowest first, with the one the Tsum list says it is at marked. */
  const skills = $derived(settingRows('skillLevel', k => `Skill ${k}`)
    .sort((a, b) => Number(a.key) - Number(b.key))
    .map((r, i, all) => ({...r, mark: owned?.own?.skill != null && Number(r.key) === owned.own.skill ? 'now' : '',
      // The boxes from the level below to this one (boxes[i] takes skill i to i+1), in coins; a medal Tsum's take medals.
      stepCost: i && Number(all[i - 1].key) === Number(r.key) - 1 && entry?.boxes?.[Number(r.key) - 1] && !entry.medal
        ? entry.boxes[Number(r.key) - 1] * BOX_PRICE.coins : null})));

  // Settings the page shows elsewhere: the skill level, and the boost items (each bonus*).
  const shownElsewhere = k => k === 'skillLevel' || k.startsWith('bonus');
  const words = k => cap(k.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/_/g, ' ').toLowerCase());
  const valueLabel = v => ({true: 'On', false: 'Off', null: 'Not set'}[v] ?? v.replace(/_/g, ' '));
  const byValue = (a, b) => (Number.isFinite(Number(a.key)) && Number.isFinite(Number(b.key)) ? Number(a.key) - Number(b.key) : a.key.localeCompare(b.key));

  // The play settings (chains per scan, chain length, bubble strategy) by the script's names, and first.
  const playOf = k => PLAY.find(p => p.key === k);
  const playLabel = p => v => (['true', 'false', 'null'].includes(v) ? valueLabel(v) : playValueName(p.param, v));
  /** Script settings that took more than one value for this Tsum. */
  const settings = $derived.by(() => {
    const keys = [...new Set((detail?.settings ?? []).map(r => r.setting))].filter(k => !shownElsewhere(k));
    const first = k => (playOf(k) ? PLAY.indexOf(playOf(k)) : PLAY.length);
    return keys.sort((a, b) => first(a) - first(b))
      .map(k => ({key: k, label: playOf(k)?.name ?? words(k), rows: settingRows(k, playOf(k) ? playLabel(playOf(k)) : valueLabel).sort(byValue)}))
      .filter(g => g.rows.length > 1);
  });
  // Chains per scan and max chain length as one pair, by scan then chain, not recorded last.
  const num = v => (v === '' ? Infinity : Number(v));
  const chainRows = $derived((detail?.chains ?? []).map(r => ({...r, label: chainsLabel(r.scan, r.chain)}))
    .sort((a, b) => num(a.scan) - num(b.scan) || num(a.chain) - num(b.chain)));
  const versions = $derived((detail?.versions ?? []).map(r => ({...r, label: r.key || 'Unknown'})));
  const deviceRows = $derived((detail?.devices ?? []).map(r => ({...r, label: r.key || 'No device'})));
  const typeRows = $derived((detail?.skillTypes ?? []).map(r => ({...r, label: skillTypeName(r.key)})));
  // A picked skill type the choices lack (a link's) is still offered, so it can be put back.
  // A picked skill level the choices lack (a link's) is still offered, so it can be put back.
  const skillOptions = $derived(filter.skill && !skillChoices.includes(filter.skill) ? [...skillChoices, filter.skill] : skillChoices);
  // With several skill levels mixed, a breakdown's difference may be the level's: said under each.
  const mixedNote = $derived(!filter.skill && skillOptions.length > 1 ? ' · skill levels mixed: pick one in the header to compare like with like' : '');
  const typeOptions = $derived(filter.skillType && !typeChoices.map(skillTypeValue).includes(filter.skillType)
    ? [...typeChoices, filter.skillType === '-' ? '' : filter.skillType] : typeChoices);

  const ownLine = $derived.by(() => {
    const o = owned?.own;
    if (!o) return null;
    const left = toMax(entry, o);
    return {
      level: o.level == null ? null : `Level ${o.level}${o.levelCap ? ` / ${o.levelCap}` : ''}`,
      skill: o.skill == null ? null : `Skill ${o.skill}${o.skillMax ? ` / ${o.skillMax}` : ''}`,
      progress: o.skillProgress && (!o.skillMax || o.skill < o.skillMax) ? `${o.skillProgress}% to the next` : '',
      left,
    };
  });

  // The global site: how many players sent rounds of it lately, and whether that is too few to stand for everyone.
  const players = $derived(globalSite ? playersIn(played.find(t => t.tsum === filter.id), {days: filter.days, from: utcFrom(filter.days)}) : null);
  const fewPlayers = $derived(players !== null && status !== null && players.n < status.minContributors);
  const whose = globalSite ? 'all' : 'your';

  // ---- The list of Tsums ----

  /** How many Tsums each ranking shows. */
  const EARNERS = 10;
  /** The global site's flag for a Tsum too few players sent rounds of over the range; '' when it has enough, and always on the local site. */
  function fewFlag(id) {
    if (!globalSite || !status) return '';
    const n = playersIn(played.find(t => t.tsum === id), {days: filter.days, from: utcFrom(filter.days)})?.n;
    return n != null && n < status.minContributors ? 'few players' : '';
  }
  /**
   * The rankings, of Tsums with MIN_ROUNDS rounds or more in the range (as
   * Stats ranks them): by expected net coins an hour, and the medal Tsums by
   * medals an hour; and the most played, every Tsum by its rounds.
   */
  const earners = $derived.by(() => {
    if (!list) return null;
    const rank = (rows, value) => rows.filter(t => t.tsum && t.rounds >= MIN_ROUNDS && value(t) !== null)
      .map(t => ({tsum: t.tsum, rounds: t.rounds, v: value(t), flag: fewFlag(t.tsum)}))
      .sort((a, b) => b.v - a.v).slice(0, EARNERS);
    return {
      coins: rank(list.tsums, expHour),
      medals: rank(list.medals.tsums, t => (t.coinsPerSec == null ? null : t.coinsPerSec * 3600)),
      most: list.tsums.filter(t => t.tsum).sort((a, b) => b.rounds - a.rounds).slice(0, 24),
    };
  });
  const listBuilds = $derived(new Set((list?.mix ?? []).map(m => m.build)).size > 1 || Boolean(filter.build));
  const rangeNote = $derived(`${daysLabel(filter.days).toLowerCase()}${globalSite && filter.days !== 'all' ? ' UTC' : ''}`);

  // The list's charts: a click on a Tsum opens its page.
  const listCtx = {nameOf, colorOf, onPick: id => set({id})};
  let usageLegend = $state([]), shareLegend = $state([]);
  /** Medals are the medal Tsums' (the summary's medal set), which has no items mix: a donut only. */
  const shareMedals = $derived(views.shareMetric === 'medals' && Boolean(list?.medals.tsums.length));
  const shareView = $derived(shareMedals ? 'donut' : views.share);
  const shareMetric = $derived(views.shareMetric === 'medals' ? 'coins' : views.shareMetric);
  const listArgs = $derived(list && {
    // The month still running, by the day a round began (a UTC one on the global site).
    usage: [list.dailyTsums, listCtx, views.usage, (globalSite ? new Date().toISOString() : isoDay(new Date())).slice(0, 7)],
    share: [shareView, shareMedals ? list.medals.tsums : shareView === 'sunburst' ? list.mix : list.tsums, listCtx, shareMetric],
  });
  const clickNote = ' · click one to see its page';
  const usageSub = $derived(`${views.usage === 'share' ? 'each Tsum\'s share of the month\'s rounds' : 'rounds a month'}, top 8 Tsums and the rest as Other${clickNote}`
    + `${globalSite ? ' · by the UTC day each round began' : ''}${filter.days === 'all' ? '' : ' · only the months in the time range: All time shows every one'}`);
  const shareTitle = $derived({coins: 'Where the coins come from', medals: 'Where the medals come from', rounds: 'Where the rounds go', time: 'Where the play time goes'}[shareMedals ? 'medals' : shareMetric]);
  const shareSub = $derived(`${shareView === 'sunburst' ? (listBuilds ? 'inner: game · middle: Tsum · outer: items used' : 'inner: Tsum · outer: items used') : 'top 8 Tsums, the rest as Other'}`
    + `${shareMedals ? ' · the medal Tsums\' medals' : shareMetric === 'coins' ? ' · base coins' : ''} · ${rangeNote}${clickNote}`);

  const args = $derived(s && {
    skills: [detail.skillBins, s.histogram],
    hist: [s.histogram, s.totals, ctx],
    items: [s.mix, mv('items')],
  });
  const builds = $derived(new Set((s?.mix ?? []).map(m => m.build)).size > 1 || Boolean(filter.build));

  // Best rounds show what the round made, before item costs.
  const roundCoins = r => (filter.coins === 'medals' ? r.medals : filter.coins === 'final' ? r.finalCoins : r.baseCoins);
  const roundRate = r => (roundCoins(r) !== null && r.durationSeconds ? roundCoins(r) / r.durationSeconds : null);

  // A copied card shows this Tsum, the time range, the primary stat and the game and device when picked.
  cardContext(() => ({
    tsum: filter.id,
    build: filter.build,
    unit,
    filters: [`${daysLabel(filter.days)}${globalSite && filter.days !== 'all' ? ' UTC' : ''}`, filter.id ? cap(basis) : '',
      filter.build ? buildLabel(filter.build) : '', filter.device, filter.id && filter.skillType ? skillTypeName(filter.skillType) : ''],
    rounds: (filter.id ? s?.totals.rounds : list?.totals.rounds) ?? 0,
  }));
  let overview = $state();
  let page = $state();

  const statsLink = $derived(`#/stats?${new URLSearchParams(Object.entries({tsum: filter.id, days: filter.days, coins: filter.coins, net: filter.net,
    device: filter.device, skillType: filter.skillType, build: filter.build, skill: filter.skill}).filter(([, v]) => v))}`);

  onMount(() => {
    Object.assign(filter, blank(), initial);
    filter.days = cleanDays(filter.days, 'all') || 'all';
    onStateChange({...filter}, {});
    loadOptions();
    load();
  });

  /** The link changed (Back or Forward): show what it says. */
  export function shown(params) {
    const next = {...blank(), ...params};
    next.days = cleanDays(next.days, 'all') || 'all';
    if (Object.keys(blank()).every(k => next[k] === filter[k])) return;
    Object.assign(filter, next);
    load();
  }

  export const refresh = debounce(() => { loadOptions(); load(); }, 800);
</script>

<section id="tsum" class="stack" class:loading {hidden} bind:this={page}>
  <div class="panel tsum-head" style:--tsum={filter.id ? colorOf(filter.id) : null}>
    {#if filter.id}
      <Avatar id={filter.id} {name} large />
      <div class="tsum-title">
        <h2>{name}</h2>
        {#if altName}<div class="sub">{altName}</div>{/if}
        <div class="tsum-facts">
          {#if standing?.rank}
            <span class="fact" title="Among the Tsums with rounds in this filter, by {standing.medals ? 'medals an hour of play' : `expected net coins an hour: ${EXP_WHAT}`}">
              <b>#{standing.rank}</b> of {fmt(standing.of)} Tsums with {fmt(MIN_ROUNDS)}+ rounds by {standing.medals ? 'medals/h' : 'expected coins/h'}
            </span>
          {/if}
          {#if standing?.vsAll !== null && standing?.vsAll !== undefined}
            <span class="fact" class:up={standing.vsAll > 0} class:down={standing.vsAll < 0}
              title="Against all {whose === 'your' ? 'your ' : ''}Tsums together, {standing.medals ? `${fmt(standing.all * 3600)} medals/h` : `${fmt(standing.all * 3600)} expected coins/h`}">
              <b>{standing.vsAll > 0 ? '+' : ''}{pct(standing.vsAll)}</b> vs all Tsums
            </span>
          {/if}
          {#if standing?.share}<span class="fact"><b>{pct(standing.share)}</b> of {whose} rounds</span>{/if}
          {#if players !== null}
            <span class="fact" class:dim={fewPlayers} title="Contributors who sent rounds of it over {players.over}{fewPlayers ? '. Too few players\' rounds to stand for everyone\'s yet' : ''}">
              <b>{fmt(players.n)}</b> {players.n === 1 ? 'player' : 'players'}{fewPlayers ? ' · few' : ''}
            </span>
          {/if}
          {#if ownLine}
            {#if ownLine.skill}<span class="fact"><b>{ownLine.skill}</b>{#if ownLine.progress} · {ownLine.progress}{/if}</span>{/if}
            {#if ownLine.level}<span class="fact">{ownLine.level}</span>{/if}
            {#if ownLine.left}
              <span class="fact to-max {ownLine.left.unit}">
                {#if ownLine.left.boxes}<b>{fmt(ownLine.left.boxes)}</b> boxes to max · {fmt(ownLine.left.cost)} {ownLine.left.unit}{:else}Maxed{/if}
              </span>
            {/if}
          {:else if owned === null || owned?.own === null}
            <span class="fact dim">{owned === null ? 'No Tsum list imported' : 'Not in your Tsum list'}</span>
          {/if}
        </div>
      </div>
    {:else}
      <div class="tsum-title"><h2>Tsums</h2><div class="sub">Every Tsum over the time range. Pick one for everything about it: how it plays at each skill level and with each setting{globalSite ? '' : ', and its best rounds'}.</div></div>
    {/if}
    <div class="tsum-pick">
      {#if filter.id}<button type="button" class="btn" title="Back to the list of Tsums" onclick={() => set({id: ''})}>← All Tsums</button>{/if}
      <TsumCombo options={pickOptions} onpick={pick} placeholder="Find a Tsum…" label="Show another Tsum" />
      {#if filter.id}<a class="btn" href={statsLink} title="This Tsum on the Stats page, with its rounds table">Open in Stats</a>{/if}
      {#if filter.id && s?.totals.rounds}<CopyButton title="Everything" label="Copy all" root={() => page} />{/if}
    </div>
    <!-- The filters are the header's last row rather than a panel of their own. -->
    {#if filter.id}
      <div class="tsum-bar">
        <Seg sm label="Time range" value={filter.days} onpick={v => set({days: v})}
          options={[['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['all', 'All time']]} />
        <DaysBox sm days={filter.days} onpick={v => { if (v !== filter.days) set({days: v}); }} />
        <Seg sm label="Primary stat" value={filter.coins} onpick={v => set({coins: v})}
          options={[['', 'Base', 'coin'], ['final', 'Final', 'coin'], ['medals', '', 'medal', 'Medals']]} />
        {#if filter.coins !== 'medals'}
          <label class="check" title="Subtract what each round's boost items cost. Rounds recorded before items were have no net coins."><input type="checkbox" checked={filter.net === '1'} onchange={e => set({net: e.target.checked ? '1' : ''})}> Less item costs</label>
        {/if}
        {#if builds}
          <Seg sm label="Game" value={filter.build} onpick={v => set({build: v})} options={[['', 'Both'], ['global', 'INTL'], ['jp', 'JP']]} />
        {/if}
        {#if skillOptions.length > 1 || filter.skill}
          <select class="search" aria-label="Skill level" title="Compare the breakdowns below at one skill level, so a level-up is not taken for a better setting" value={filter.skill} onchange={e => set({skill: e.target.value})}>
            <option value="">All skill levels</option>
            {#each skillOptions as k (k)}<option value={k}>Skill {k}</option>{/each}
          </select>
        {/if}
        {#if typeOptions.length > 1}
          <select class="search" aria-label="Skill type" title="The script's skill type" value={filter.skillType} onchange={e => set({skillType: e.target.value})}>
            <option value="">All skill types</option>
            {#each typeOptions as t (t)}<option value={skillTypeValue(t)}>{skillTypeName(t)}</option>{/each}
          </select>
        {/if}
        {#if devices.length > 1}
          <select class="search" aria-label="Device" value={filter.device} onchange={e => set({device: e.target.value})}>
            <option value="">All devices</option>
            {#each devices as d (d.device)}<option value={d.device}>{d.device}</option>{/each}
          </select>
        {/if}
        {#if error}<span class="sub">{error}</span>{/if}
      </div>
    {:else}
      <div class="tsum-bar">
        <Seg sm label="Time range" value={filter.days} onpick={v => set({days: v})}
          options={[['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['all', 'All time']]} />
        <DaysBox sm days={filter.days} onpick={v => { if (v !== filter.days) set({days: v}); }} />
        {#if listBuilds}
          <Seg sm label="Game" value={filter.build} onpick={v => set({build: v})} options={[['', 'Both'], ['global', 'INTL'], ['jp', 'JP']]} />
        {/if}
        {#if devices.length > 1}
          <select class="search" aria-label="Device" value={filter.device} onchange={e => set({device: e.target.value})}>
            <option value="">All devices</option>
            {#each devices as d (d.device)}<option value={d.device}>{d.device}</option>{/each}
          </select>
        {/if}
        {#if error}<span class="sub">{error}</span>{/if}
      </div>
    {/if}
  </div>

  <!-- The global site: one click to each new Tsum, on the list of Tsums (a Tsum's own page has All Tsums to go back to it). -->
  {#if globalSite && !filter.id}<NewTsums current={filter.id} played={playedRounds} onpick={id => set({id})} />{/if}

  {#if !filter.id}
    {#if earners && (earners.coins.length || earners.medals.length)}
      <div class="charts">
        <Panel title="Best coin earners" expandable={false}
          sub="expected net coins an hour of play: {EXP_WHAT} · {rangeNote} · Tsums with {fmt(MIN_ROUNDS)}+ rounds, at the skill levels {whose === 'your' ? 'you' : 'players'} played them at">
          <Earners rows={earners.coins} unit="coins" {nameOf} onpick={id => set({id})} />
        </Panel>
        <Panel title="Best medal earners" expandable={false}
          sub="medals an hour of play, a round that earned none counting as 0 · {rangeNote} · medal Tsums with {fmt(MIN_ROUNDS)}+ rounds"
>
          <Earners rows={earners.medals} unit="medals" {nameOf} onpick={id => set({id})}
            empty="No medal Tsum has {fmt(MIN_ROUNDS)} rounds {filter.days === 'all' ? 'yet' : 'in this range'}." />
        </Panel>
      </div>
    {/if}
    <div class="panel">
      <div class="panel-head"><div><h2>{globalSite ? 'Most played' : 'Your most played'}</h2><span class="sub">{rangeNote} · click one to see its page</span></div></div>
      {#if (earners?.most ?? played).length}
        <div class="tsum-grid">
          {#each (earners?.most ?? played).slice(0, 24) as t (t.tsum)}
            <button type="button" class="btn tsum-tile" onclick={() => set({id: t.tsum})}>
              <Avatar id={t.tsum} name={nameOf(t.tsum)} />
              <span class="tile-name">{nameOf(t.tsum)}</span>
              <span class="sub">{fmt(t.rounds)}</span>
            </button>
          {/each}
        </div>
      {:else}
        <div class="empty-state">
          <p>{filter.days === 'all' ? 'No rounds yet.' : 'No rounds in this time range.'}</p>
          {#if filter.days !== 'all'}<button type="button" class="btn" onclick={() => set({days: 'all'})}>Show all time</button>{/if}
        </div>
      {/if}
    </div>
    {#if list?.totals.rounds}
      <Panel title="Tsum usage per month" sub={usageSub}>
        {#snippet tools()}
          <Seg sm label="Measure" value={views.usage} onpick={v => setView('usage', v)} options={[['rounds', 'Rounds'], ['share', 'Share']]} />
        {/snippet}
        <Chart draw={drawUsage} args={listArgs?.usage} unit="coins" bind:legend={usageLegend} />
        <Legend items={usageLegend} />
      </Panel>
      <Panel title={shareTitle} sub={shareSub}>
        {#snippet tools()}
          {#if !shareMedals}<Seg sm label="Chart" value={views.share} onpick={v => setView('share', v)} options={[['donut', 'Donut'], ['sunburst', 'Sunburst']]} />{/if}
          <Seg sm label="Measure" value={shareMedals ? 'medals' : shareMetric} onpick={v => setView('shareMetric', v)}
            options={[['coins', 'Coins'], ...(list.medals.tsums.length ? [['medals', 'Medals']] : []), ['rounds', 'Rounds'], ['time', 'Time']]} />
        {/snippet}
        <div class="share-body">
          <Chart draw={drawShare} args={listArgs?.share} unit={shareMedals ? 'medals' : 'coins'} size="square" bind:legend={shareLegend} />
          <Legend items={shareLegend} column />
        </div>
      </Panel>
    {/if}
  {:else}

    {#if s && !s.totals.rounds}
      <div class="panel empty-state">
        <h2>No rounds in this filter</h2>
        {#if filter.days !== 'all'}<button type="button" class="btn" onclick={() => set({days: 'all'})}>Show all time</button>{/if}
      </div>
    {:else if s}
      <div class="tsum-overview" bind:this={overview}>
        <Kpis t={s.totals} m={s.medals.totals} coins={filter.coins} {basis} noMedals approx={globalSite} steady={false} incomplete={s.incompleteRounds ?? 0} copyFrom={() => overview} />
        <Insights {detail} own={owned?.own} {entry} {unit} {basis} {target} {setTarget} {whose} approx={globalSite} />
        {#if detail.jackpots?.rounds}
          <p class="jackpot-note sub" title="The +Coin item's rare 11×, 21× and 51× coin bonuses are luck, not the Tsum, and one of them can move a few hundred rounds' figures by a tenth">
            {fmt(detail.jackpots.rounds)} coin-bonus {detail.jackpots.rounds === 1 ? 'jackpot' : 'jackpots'} (final coins over {JACKPOT_TIMES}× base){detail.jackpots.coins !== null ? `, ${fmt(detail.jackpots.coins)} coins,` : ''}
            left out of these figures. The highest round, the items charts and the best rounds still count them.
          </p>
        {/if}
      </div>

      {#if detail.combos?.length}
        <Panel title="Best settings" expandable={false}
          sub="every setting picked together at one skill level: items, chains per scan and max chain, bubbles and skill type · ranked by {filter.coins === 'medals' ? 'medals an hour' : 'expected net coins an hour, each item set charged its cost'}, of the combinations with {fmt(MIN_ROUNDS)}+ rounds{filter.coins === 'medals' ? '' : ' known within ± 5 %'} · best marked when it beats the next by more than luck · each against the most played at its level">
          <BestSettings combos={detail.combos} {unit} skill={filter.skill} />
        </Panel>
      {/if}

      {#if skills.length}
        <Panel title="By skill level" sub="the skill level set in the script for each round · change is against the level below · pays back in: hours of play for the gain to earn back that level's boxes" expandable={false}>
          <Breakdown rows={skills} {unit} head="Skill" against="prev" />
        </Panel>
        {#if skills.filter(r => r.rounds >= 20).length > 1}
          <Panel title="{U} per round by skill level" sub="each level's share of its rounds at each amount of {basis}, so levels with fewer rounds still compare">
            <Chart draw={drawSkillSpread} args={args?.skills} {unit} bind:legend={skillLegend} />
            <Legend items={skillLegend} />
          </Panel>
        {/if}
      {/if}

      <Panel title="{U} per round" sub="how many rounds ended with each amount of {basis}{globalSite ? ' · ≈ from 2 % wide bins' : ''}">
        <Chart draw={drawHistogram} args={args?.hist} {unit} />
      </Panel>

      <div class="charts">
        <Panel class="wide" title="By items used" sub="every item set, best first">
          {#snippet tools()}
            <Seg sm label="Measure" value={mv('items')} onpick={v => setView('items', v)} options={[...rateOpts(), ['avg', 'Average'], ['rounds', 'Rounds']]} />
          {/snippet}
          <Chart draw={drawItems} args={args?.items} {unit} size="square" />
        </Panel>
      </div>

      {#if filter.coins !== 'medals'}
        <Panel title="Do the items pay?" sub="each item against the same other items without it, at the same skill level · in expected net coins an hour, its cost taken off" expandable={false}>
          <ItemPayback mix={s.mix} />
        </Panel>
      {/if}

      {#if chainRows.length > 1}
        <Panel title="By chain settings" sub="chains per scan and max chain length taken together, a row per pair · change is against the most played pair · the best pair is marked when it clearly beats the next{mixedNote}" expandable={false}>
          <Breakdown rows={chainRows} {unit} head="Pair" />
        </Panel>
      {/if}

      {#if settings.length}
        <Panel title="By script setting" sub="settings that changed while this Tsum played · change is against the most played value · settings often changed together, and with the skill level, so read these with care{globalSite ? ' · the global site breaks down by the chain and bubble settings only' : ''}{mixedNote}" expandable={false}>
          <div class="stack settings-list">
            {#each settings as g (g.key)}
              <Breakdown rows={g.rows} {unit} head={g.label} />
            {/each}
          </div>
        </Panel>
      {/if}

      {#if typeRows.length > 1}
        <Panel title="By skill type" sub="how the script played the skill · change is against the most played type{globalSite ? ' · rounds sent before the site kept skill types are not recorded' : ''}{mixedNote}" expandable={false}>
          <Breakdown rows={typeRows} {unit} head="Skill type" />
        </Panel>
      {/if}

      {#if versions.length > 1}
        <Panel title="By script version" sub="newest first · change is against the most played version{mixedNote}" expandable={false}>
          <Breakdown rows={versions} {unit} head="Version" />
        </Panel>
      {/if}

      {#if deviceRows.length > 1}
        <Panel title="By device" sub="change is against the most played device{mixedNote}" expandable={false}>
          <Breakdown rows={deviceRows} {unit} head="Device" />
        </Panel>
      {/if}

      {#if !globalSite}
      <Panel title="Best rounds" sub="the top 10 in the filter">
        {#snippet tools()}
          <Seg sm label="Best by" value={views.best} onpick={v => setView('best', v)} options={[['coins', U], ['rate', `${U}/s`], ['score', 'Score']]} />
          <a class="btn" href={statsLink}>All rounds</a>
        {/snippet}
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>#</th><th>When</th><th class="num">{unit === 'medals' ? 'Medals' : filter.coins === 'final' ? 'Final coins' : 'Base coins'}</th><th class="num">{U}/s</th><th class="num">Score</th>
                <th class="num">Time</th><th>Items</th><th>Game</th><th>Device</th></tr>
            </thead>
            <tbody>
              {#each best as r, i (r.id)}
                <tr>
                  <td class="dim">{i + 1}</td>
                  <td>{fmtWhen(r.playedAt)}</td>
                  <td class="num {unit === 'medals' ? 'medal' : 'coin'}">{fmt(roundCoins(r))}</td>
                  <td class="num {unit === 'medals' ? 'medal' : 'coin'}">{fmtRate(roundRate(r))}</td>
                  <td class="num score">{fmt(r.score)}</td>
                  <td class="num">{fmtDuration(r.durationSeconds)}</td>
                  <td class="dim">{itemsLabel(r.items)}</td>
                  <td><span class="tag">{buildLabel(r.build)}</span></td>
                  <td class="dim">{r.device || '—'}</td>
                </tr>
              {:else}
                <tr><td class="empty-row" colspan="9">No rounds.</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
      </Panel>
      {/if}
    {/if}
  {/if}
</section>
