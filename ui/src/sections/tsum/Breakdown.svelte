<!-- One Tsum's figures split by something that changes between rounds (skill
     level, a script setting, the script version, the device): a row per value,
     its rate drawn as a bar, and how it compares with a reference row. -->
<script>
  import {fmt, fmtRate, parseUTC, pct} from '../../lib/util.js';

  // rows: [{label, rounds, avgCoins, maxCoins, coinsPerSec, avgScore, first, last, mark?}].
  // against: 'prev' compares each row with the one above it, 'most' with the most played row.
  // few: rows with fewer rounds than this are marked as too few to trust.
  let {rows, unit, head, against = 'most', few = 20} = $props();

  const day = new Intl.DateTimeFormat(undefined, {month: 'short', day: 'numeric'});
  const span = r => {
    const a = day.format(parseUTC(r.first)), b = day.format(parseUTC(r.last));
    return a === b ? a : `${a} – ${b}`;
  };

  const view = $derived.by(() => {
    const top = Math.max(0, ...rows.map(r => r.coinsPerSec ?? 0));
    // The best is only marked among rows with enough rounds to trust.
    const trusted = rows.filter(r => r.rounds >= few);
    const bestRate = Math.max(0, ...trusted.map(r => r.coinsPerSec ?? 0));
    const most = rows.reduce((m, r) => (m === null || r.rounds > m.rounds ? r : m), null);
    return rows.map((r, i) => {
      const ref = against === 'prev' ? rows[i - 1] : most === r ? null : most;
      const change = ref?.coinsPerSec && r.coinsPerSec !== null ? r.coinsPerSec / ref.coinsPerSec - 1 : null;
      return {...r, bar: top > 0 && r.coinsPerSec !== null ? (r.coinsPerSec / top) * 100 : 0, change, best: trusted.length > 1 && r.rounds >= few && r.coinsPerSec === bestRate};
    });
  });
  const U = $derived(unit === 'medals' ? 'Medals' : 'Coins');
  const changeTitle = $derived(against === 'prev' ? 'Rate against the row above' : 'Rate against the most played row');
</script>

<div class="table-wrap">
  <table class="breakdown">
    <colgroup><col class="bd-c-label"><col class="bd-c-n"><col class="bd-c-rate"><col class="bd-c-n"><col class="bd-c-n"><col class="bd-c-n"><col class="bd-c-n"><col class="bd-c-when"></colgroup>
    <thead>
      <tr>
        <th>{head}</th>
        <th class="num">Rounds</th>
        <th class="num">{U}/s</th>
        <th class="num" title={changeTitle}>Change</th>
        <th class="num">Average</th>
        <th class="num">Highest</th>
        <th class="num">Avg score</th>
        <th>Played</th>
      </tr>
    </thead>
    <tbody>
      {#each view as r (r.label)}
        <tr class:few={r.rounds < few} class:mark={r.mark}>
          <td>
            <span class="bd-label">{r.label}</span>
            {#if r.mark}<span class="tag">{r.mark}</span>{/if}
            {#if r.rounds < few}<span class="sub" title="Too few rounds to trust the figures yet">few rounds</span>{/if}
          </td>
          <td class="num">{fmt(r.rounds)}</td>
          <td class="num {unit === 'medals' ? 'medal' : 'coin'}">
            <span class="bd-rate"><span class="bd-bar"><span style:width="{r.bar}%" class:best={r.best}></span></span>{fmtRate(r.coinsPerSec)}</span>
          </td>
          <td class="num" class:up={r.change > 0.005} class:down={r.change < -0.005}>{r.change === null ? '' : `${r.change > 0 ? '+' : ''}${pct(r.change)}`}</td>
          <td class="num">{fmt(r.avgCoins)}</td>
          <td class="num">{fmt(r.maxCoins)}</td>
          <td class="num score">{fmt(r.avgScore)}</td>
          <td class="dim">{span(r)}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>
