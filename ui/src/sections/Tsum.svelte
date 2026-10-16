<!--
  The Tsum page: everything about one Tsum. Its figures, how they changed with
  its skill level and the script's settings, where it ranks among your Tsums,
  what owning it says (level, skill, boxes to max), and its best rounds.
  On the global site it is every contributor's rounds of it: by skill level
  and items, ranked among every Tsum, by UTC day; no rounds, settings or
  Tsum lists, so no best rounds, recent form or boxes to max.
-->
<script>
  import {onMount} from 'svelte';
  import {isGlobal} from '../lib/global/client.js';
  import Avatar from '../components/Avatar.svelte';
  import Chart from '../components/Chart.svelte';
  import Panel from '../components/Panel.svelte';
  import Seg from '../components/Seg.svelte';
  import {drawDaily, drawHistogram, drawItems, drawSkillSpread} from '../lib/charts.js';
  import {toMax} from '../lib/boxes.js';
  import {cardContext} from '../lib/card.js';
  import {shared} from '../lib/ui.svelte.js';
  import {
    api, buildLabel, cap, debounce, fmt, fmtDuration, fmtRate, fmtWhen, itemsLabel, loadPref, pct, savePref,
    PLAY, playValueName, skillTypeName, skillTypeValue, tsumColor, tsumName,
  } from '../lib/util.js';
  import Kpis from './stats/Kpis.svelte';
  import Legend from '../components/Legend.svelte';
  import Breakdown from './tsum/Breakdown.svelte';
  import Insights from './tsum/Insights.svelte';
  import ItemPayback from './tsum/ItemPayback.svelte';

  // initial: the link's params; onStateChange(state, {push}) writes the link.
  let {hidden, initial, onStateChange} = $props();
  const globalSite = isGlobal();
  // The global site's status: the contributors a Tsum needs before its figures are trusted.
  let status = $state.raw(null);

  // id is the Tsum. days, coins, net, device and build mean what they do on the Stats page;
  // skillType is one of the script's skill types ('-' for none), or '' for every one.
  const blank = () => ({id: '', days: 'all', coins: '', net: '', device: '', skillType: '', build: ''});
  const filter = $state(blank());

  const VIEW_KEY = 'tsum-stats.tsum-views';
  const views = $state({daily: 'rate', items: 'rate', best: 'coins', ...loadPref(VIEW_KEY, {})});
  function setView(key, v) {
    views[key] = v;
    savePref(VIEW_KEY, {...views});
    if (key === 'best') loadBest();
  }

  const catalog = shared.catalog;
  const nameOf = id => (id ? tsumName(catalog, id, filter.build || 'global') : '');
  const colorOf = id => tsumColor(catalog, id);
  const ctx = {nameOf, colorOf, onPick: () => {}};

  let detail = $state.raw(null);
  /** The Tsum's skill types in the filter, without one picked: the select's choices. */
  let typeChoices = $state.raw([]);
  let skillLegend = $state([]);
  let best = $state.raw([]);
  let played = $state.raw([]);
  let devices = $state.raw([]);
  /** The Tsum's row in the newest Tsum list for its build, with where it came from; null when not owned. */
  let owned = $state.raw(undefined);
  let loading = $state(false);
  let error = $state('');
  const seq = {detail: 0, best: 0, owned: 0};

  const unit = $derived(filter.coins === 'medals' ? 'medals' : 'coins');
  const U = $derived(cap(unit));
  const net = $derived(filter.coins !== 'medals' && filter.net === '1');
  const basis = $derived(filter.coins === 'medals' ? 'medals' : `${net ? 'net ' : ''}${filter.coins === 'final' ? 'final' : 'base'} coins`);
  const entry = $derived(catalog.byId.get(filter.id));
  const name = $derived(nameOf(filter.id));
  const altName = $derived.by(() => {
    const other = entry && (filter.build === 'jp' ? entry.global : entry.jp);
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
  function filterParams() {
    let from = '';
    const n = Number(filter.days);
    // The global site's days are UTC ones, the day each round began.
    if (n && globalSite) {
      const d = new Date();
      d.setUTCDate(d.getUTCDate() - n + 1);
      from = `${d.toISOString().slice(0, 10)}T00:00:00.000Z`;
    } else if (n) {
      const d = new Date();
      d.setDate(d.getDate() - n + 1);
      from = new Date(`${isoDay(d)}T00:00:00`).toISOString();
    }
    return {device: filter.device, skillType: filter.skillType, build: filter.build, coins: filter.coins, net: net ? '1' : '', from};
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
      }
    } catch (e) {
      if (mine === seq.detail) error = `Could not load: ${e.message}`;
    } finally {
      if (mine === seq.detail) loading = false;
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

  let box = $state();
  function pick() {
    const text = box.value.trim().toLowerCase();
    const hit = text && played.find(t => [tsumName(catalog, t.tsum), tsumName(catalog, t.tsum, 'jp'), t.tsum]
      .some(n => n.toLowerCase() === text));
    if (!hit) return;
    box.value = '';
    box.blur();
    set({id: hit.tsum});
  }
  const pickSoon = debounce(pick, 250);

  // ---- What the page shows ----

  const s = $derived(detail?.summary);

  /** Where it ranks by rate among the Tsums in the same filter, and how it compares with all of them together. */
  const standing = $derived.by(() => {
    if (!detail) return null;
    const rated = detail.field.filter(t => t.tsum && t.coinsPerSec !== null).sort((a, b) => b.coinsPerSec - a.coinsPerSec);
    const i = rated.findIndex(t => t.tsum === filter.id);
    const coins = detail.field.reduce((n, t) => n + (t.rateCoins ?? 0), 0);
    const secs = detail.field.reduce((n, t) => n + (t.rateSeconds ?? 0), 0);
    const rounds = detail.field.reduce((n, t) => n + t.rounds, 0);
    const mine = detail.field.find(t => t.tsum === filter.id);
    const all = secs ? coins / secs : null;
    return {
      rank: i < 0 ? null : i + 1, of: rated.length, all,
      vsAll: all && mine?.coinsPerSec != null ? mine.coinsPerSec / all - 1 : null,
      share: rounds && mine ? mine.rounds / rounds : null,
    };
  });

  const settingRows = (setting, label) => (detail?.settings ?? []).filter(r => r.setting === setting).map(r => ({...r, label: label(r.key)}));

  /** Skill levels, lowest first, with the one the Tsum list says it is at marked. */
  const skills = $derived(settingRows('skillLevel', k => `Skill ${k}`)
    .sort((a, b) => Number(a.key) - Number(b.key))
    .map(r => ({...r, mark: owned?.own?.skill != null && Number(r.key) === owned.own.skill ? 'now' : ''})));

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
  const versions = $derived((detail?.versions ?? []).map(r => ({...r, label: r.key || 'Unknown'})));
  const deviceRows = $derived((detail?.devices ?? []).map(r => ({...r, label: r.key || 'No device'})));
  const typeRows = $derived((detail?.skillTypes ?? []).map(r => ({...r, label: skillTypeName(r.key)})));
  // A picked skill type the choices lack (a link's) is still offered, so it can be put back.
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
  const players = $derived(globalSite ? (played.find(t => t.tsum === filter.id)?.contributors ?? null) : null);
  const fewPlayers = $derived(players !== null && status !== null && players < status.minContributors);
  const whose = globalSite ? 'all' : 'your';

  const args = $derived(s && {
    skills: [detail.skillBins, s.histogram],
    daily: [s.daily, s.dailyTsums, ctx, views.daily],
    hist: [s.histogram, s.totals, ctx],
    items: [s.mix, views.items],
  });
  const dailySub = $derived({rate: `${basis} per second of play`, avg: `average ${basis} per round, with the day's lowest–highest band`, stack: `total ${basis} each day`}[views.daily]
    + (globalSite ? ' · by the UTC day each round began' : ''));
  const builds = $derived(new Set((s?.mix ?? []).map(m => m.build)).size > 1 || Boolean(filter.build));

  // Best rounds show what the round made, before item costs.
  const roundCoins = r => (filter.coins === 'medals' ? r.medals : filter.coins === 'final' ? r.finalCoins : r.baseCoins);
  const roundRate = r => (roundCoins(r) !== null && r.durationSeconds ? roundCoins(r) / r.durationSeconds : null);

  // A copied card shows this Tsum, the time range, the primary stat and the game and device when picked.
  const daysLabel = {7: 'Last 7 days', 30: 'Last 30 days', 90: 'Last 90 days', all: 'All time'};
  cardContext(() => ({
    tsum: filter.id,
    build: filter.build,
    filters: [`${daysLabel[filter.days] ?? 'All time'}${globalSite && filter.days !== 'all' ? ' UTC' : ''}`, cap(basis),
      filter.build ? buildLabel(filter.build) : '', filter.device, filter.skillType ? skillTypeName(filter.skillType) : ''],
    rounds: s?.totals.rounds ?? 0,
  }));
  let overview = $state();

  const statsLink = $derived(`#/stats?${new URLSearchParams(Object.entries({tsum: filter.id, days: filter.days, coins: filter.coins, net: filter.net,
    device: filter.device, skillType: filter.skillType, build: filter.build}).filter(([, v]) => v))}`);

  onMount(() => {
    Object.assign(filter, blank(), initial);
    onStateChange({...filter}, {});
    loadOptions();
    load();
  });

  /** The link changed (Back or Forward): show what it says. */
  export function shown(params) {
    const next = {...blank(), ...params};
    if (Object.keys(blank()).every(k => next[k] === filter[k])) return;
    Object.assign(filter, next);
    load();
  }

  export const refresh = debounce(() => { loadOptions(); load(); }, 800);
</script>

<section id="tsum" class="stack" class:loading {hidden}>
  <div class="panel tsum-head" style:--tsum={filter.id ? colorOf(filter.id) : null}>
    {#if filter.id}
      <Avatar id={filter.id} {name} large />
      <div class="tsum-title">
        <h2>{name}</h2>
        {#if altName}<div class="sub">{altName}</div>{/if}
        <div class="tsum-facts">
          {#if standing?.rank}
            <span class="fact" title="Among the Tsums with rounds in this filter, by {basis} per second">
              <b>#{standing.rank}</b> of {fmt(standing.of)} Tsums by {U.toLowerCase()}/s
            </span>
          {/if}
          {#if standing?.vsAll !== null && standing?.vsAll !== undefined}
            <span class="fact" class:up={standing.vsAll > 0} class:down={standing.vsAll < 0}
              title="Against all {whose === 'your' ? 'your ' : ''}Tsums together, {fmtRate(standing.all)} {unit}/s">
              <b>{standing.vsAll > 0 ? '+' : ''}{pct(standing.vsAll)}</b> vs all Tsums
            </span>
          {/if}
          {#if standing?.share}<span class="fact"><b>{pct(standing.share)}</b> of {whose} rounds</span>{/if}
          {#if players !== null}
            <span class="fact" class:dim={fewPlayers} title="Contributors who sent rounds of it in the last 30 days{fewPlayers ? '. Too few players\' rounds to stand for everyone\'s yet' : ''}">
              <b>{fmt(players)}</b> {players === 1 ? 'player' : 'players'}{fewPlayers ? ' · few' : ''}
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
      <div class="tsum-title"><h2>Pick a Tsum</h2><div class="sub">Everything about one Tsum: how it plays at each skill level, with each setting, and its best rounds.</div></div>
    {/if}
    <div class="tsum-pick">
      <input class="search" list="tsum-page-options" placeholder="Find a Tsum…" autocomplete="off" aria-label="Show another Tsum"
        bind:this={box} onchange={pick} oninput={pickSoon}>
      {#if filter.id}<a class="btn" href={statsLink} title="This Tsum on the Stats page, with its rounds table">Open in Stats</a>{/if}
    </div>
    <!-- The filters are the header's last row rather than a panel of their own. -->
    {#if filter.id}
      <div class="tsum-bar">
        <Seg sm label="Time range" value={filter.days} onpick={v => set({days: v})}
          options={[['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['all', 'All time']]} />
        <Seg sm label="Primary stat" value={filter.coins} onpick={v => set({coins: v})}
          options={[['', 'Base', 'coin'], ['final', 'Final', 'coin'], ['medals', '', 'medal', 'Medals']]} />
        {#if filter.coins !== 'medals'}
          <label class="check" title="Subtract what each round's boost items cost. Rounds recorded before items were have no net coins."><input type="checkbox" checked={filter.net === '1'} onchange={e => set({net: e.target.checked ? '1' : ''})}> Less item costs</label>
        {/if}
        {#if builds}
          <Seg sm label="Game" value={filter.build} onpick={v => set({build: v})} options={[['', 'Both'], ['global', 'INTL'], ['jp', 'JP']]} />
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
    {/if}
    <datalist id="tsum-page-options">
      {#each played as t (t.tsum)}<option value={tsumName(catalog, t.tsum)}>{fmt(t.rounds)} rounds</option>{/each}
    </datalist>
  </div>

  {#if !filter.id}
    <div class="panel">
      <div class="panel-head"><div><h2>{globalSite ? 'Most played' : 'Your most played'}</h2><span class="sub">click one to see its page</span></div></div>
      {#if played.length}
        <div class="tsum-grid">
          {#each played.slice(0, 24) as t (t.tsum)}
            <button type="button" class="btn tsum-tile" onclick={() => set({id: t.tsum})}>
              <Avatar id={t.tsum} name={nameOf(t.tsum)} />
              <span class="tile-name">{nameOf(t.tsum)}</span>
              <span class="sub">{fmt(t.rounds)}</span>
            </button>
          {/each}
        </div>
      {:else}
        <div class="empty-state">No rounds yet.</div>
      {/if}
    </div>
  {:else}

    {#if s && !s.totals.rounds}
      <div class="panel empty-state">
        <h2>No rounds in this filter</h2>
        {#if filter.days !== 'all'}<button type="button" class="btn" onclick={() => set({days: 'all'})}>Show all time</button>{/if}
      </div>
    {:else if s}
      <div class="tsum-overview" bind:this={overview}>
        <Kpis t={s.totals} m={s.medals.totals} coins={filter.coins} {basis} noMedals approx={globalSite} copyFrom={() => overview} />
        <Insights {detail} own={owned?.own} {entry} {unit} {basis} {target} {setTarget} {whose} approx={globalSite} />
      </div>

      {#if skills.length}
        <Panel title="By skill level" sub="the skill level set in the script for each round · change is against the level below" expandable={false}>
          <Breakdown rows={skills} {unit} head="Skill" against="prev" />
        </Panel>
        {#if skills.filter(r => r.rounds >= 20).length > 1}
          <Panel title="{U} per round by skill level" sub="each level's share of its rounds at each amount of {basis}, so levels with fewer rounds still compare">
            <Chart draw={drawSkillSpread} args={args?.skills} {unit} bind:legend={skillLegend} />
            <Legend items={skillLegend} />
          </Panel>
        {/if}
      {/if}

      <Panel title="{U} per day" sub={dailySub}>
        {#snippet tools()}
          <Seg sm label="Chart" value={views.daily} onpick={v => setView('daily', v)} options={[['rate', `${U}/s`], ['avg', 'Average'], ['stack', 'Total']]} />
        {/snippet}
        <Chart draw={drawDaily} args={args?.daily} {unit} />
      </Panel>

      <Panel title="{U} per round" sub="how many rounds ended with each amount of {basis}{globalSite ? ' · ≈ from 2 % wide bins' : ''}">
        <Chart draw={drawHistogram} args={args?.hist} {unit} />
      </Panel>

      <div class="charts">
        <Panel class="wide" title="By items used" sub="every item set, best first">
          {#snippet tools()}
            <Seg sm label="Measure" value={views.items} onpick={v => setView('items', v)} options={[['rate', `${U}/s`], ['avg', 'Average'], ['rounds', 'Rounds']]} />
          {/snippet}
          <Chart draw={drawItems} args={args?.items} {unit} size="square" />
        </Panel>
      </div>

      {#if filter.coins !== 'medals'}
        <Panel title="Do the items pay?" sub="each item against the same other items without it · gain is what it adds a round, less its cost" expandable={false}>
          <ItemPayback mix={s.mix} {net} final={filter.coins === 'final'} />
        </Panel>
      {/if}

      {#if settings.length}
        <Panel title="By script setting" sub="settings that changed while this Tsum played · change is against the most played value · settings often changed together, and with the skill level, so read these with care{globalSite ? ' · the global site breaks down by the chain and bubble settings only' : ''}" expandable={false}>
          <div class="stack settings-list">
            {#each settings as g (g.key)}
              <Breakdown rows={g.rows} {unit} head={g.label} />
            {/each}
          </div>
        </Panel>
      {/if}

      {#if typeRows.length > 1}
        <Panel title="By skill type" sub="how the script played the skill · change is against the most played type{globalSite ? ' · rounds sent before the site kept skill types are not recorded' : ''}" expandable={false}>
          <Breakdown rows={typeRows} {unit} head="Skill type" />
        </Panel>
      {/if}

      {#if versions.length > 1}
        <Panel title="By script version" sub="newest first · change is against the most played version" expandable={false}>
          <Breakdown rows={versions} {unit} head="Version" />
        </Panel>
      {/if}

      {#if deviceRows.length > 1}
        <Panel title="By device" sub="change is against the most played device" expandable={false}>
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
                  <td class="num">{fmtRate(roundRate(r))}</td>
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
