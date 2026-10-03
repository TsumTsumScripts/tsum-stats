<!-- What maxing every shown Tsum still costs, and when the player's pace gets
     there. The pace is the coins (after the coin bonus) and medals this build's
     rounds earned a day over the chosen window. -->
<script>
  import Chart from '../../components/Chart.svelte';
  import Legend from '../../components/Legend.svelte';
  import Panel from '../../components/Panel.svelte';
  import Seg from '../../components/Seg.svelte';
  import {drawMaxOut} from '../../lib/charts.js';
  import {isSnapshot} from '../../lib/snapshot/client.js';
  import {theme} from '../../lib/ui.svelte.js';
  import {api, css, fmt, loadPref, parseUTC, savePref} from '../../lib/util.js';

  // totals: maxOutTotals() over the shown Tsums; shown: how many that is.
  let {build, totals, shown} = $props();

  const DAY_MS = 864e5;
  const WINDOWS = {7: '7 days', 30: '30 days', all: 'All'};
  const PREF_KEY = 'tsum-stats.maxout';
  const saved = loadPref(PREF_KEY, {});
  const prefs = $state({days: saved.days in WINDOWS ? saved.days : '30', have: {coins: +saved.have?.coins || 0, medals: +saved.have?.medals || 0}});
  const setPrefs = patch => { Object.assign(prefs, patch); savePref(PREF_KEY, $state.snapshot(prefs)); };

  // Earned per day: {coins, medals}, null while loading or with no rounds.
  let pace = $state(null);
  let legend = $state([]);

  async function loadPace(b, days) {
    // A snapshot's "now" is when it was made, so its pace is not diluted by the days since.
    const end = isSnapshot() ? new Date((await api('status')).generatedAt) : new Date();
    const from = days === 'all' ? null : new Date(end - days * DAY_MS);
    const s = await api('summary', {build: b, coins: 'final', from: from?.toISOString()});
    if (!s.totals.rounds || !s.totals.first) return null;
    const start = Math.max(from ?? 0, parseUTC(s.totals.first));
    const span = Math.max(1, (end - start) / DAY_MS);
    return {coins: (s.totals.totalCoins ?? 0) / span, medals: (s.medals.totals.totalCoins ?? 0) / span, rounds: s.totals.rounds};
  }
  $effect(() => {
    const b = build, d = prefs.days;
    pace = undefined;
    loadPace(b, d).then(p => { if (b === build && d === prefs.days) pace = p; }, () => { pace = null; });
  });

  const units = [['coins', 'Coins', 'coin'], ['medals', 'Medals', 'medal']];
  const left = u => Math.max(0, totals[u].cost - prefs.have[u]);
  const days = u => (pace?.[u] > 0 ? left(u) / pace[u] : null);
  const finish = d => new Date(Date.now() + d * DAY_MS).toLocaleDateString(undefined, {dateStyle: 'medium'});
  const daysText = d => (d === null ? '—' : d < 1 ? 'Under a day' : `${fmt(Math.ceil(d))} days`);

  const args = $derived.by(() => {
    theme.version;
    if (!pace) return null;
    return [units.map(([u, label, cls]) => ({label, color: css(`--${cls}`), need: totals[u].cost, left: left(u), rate: pace[u]}))];
  });
</script>

<Panel title="Cost to max" sub="every skill box left for the {fmt(shown)} Tsums shown · {fmt(30000)} coins or {fmt(10000)} medals a box">
  {#snippet tools()}
    <Seg sm label="Pace from" value={prefs.days} onpick={v => setPrefs({days: v})} options={Object.entries(WINDOWS)} />
  {/snippet}
  <div class="kpis maxout">
    {#each units as [u, label, cls] (u)}
      <div class="panel kpi {cls}">
        <div class="label">{label} to max</div>
        <div class="value">{fmt(totals[u].cost)}</div>
        <div class="note">{fmt(totals[u].boxes)} boxes for {fmt(totals[u].tsums)} Tsums</div>
      </div>
      <div class="panel kpi">
        <div class="label">{label} done in</div>
        <div class="value">{pace === undefined ? '…' : !totals[u].cost ? 'Done' : daysText(days(u))}</div>
        <div class="note">
          {#if pace === null}No {build === 'jp' ? 'JP' : 'INTL'} rounds in this window
          {:else if pace}{fmt(pace[u])} {u} a day{#if days(u) !== null && left(u)}{` · ${finish(days(u))}`}{/if}{/if}
        </div>
        <label class="field have">On hand <input type="number" min="0" step="1000" value={prefs.have[u] || ''} placeholder="0"
          oninput={e => setPrefs({have: {...prefs.have, [u]: Math.max(0, +e.target.value || 0)}})}></label>
      </div>
    {/each}
  </div>
  {#if totals.unknown}<p class="sub maxout-note">{fmt(totals.unknown)} shown Tsums have no box counts and are left out.</p>{/if}
  <Chart draw={drawMaxOut} {args} size="short" bind:legend />
  <Legend items={legend} />
</Panel>
