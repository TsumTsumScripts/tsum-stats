<!-- One Tsum's figures split by something that changes between rounds (skill
     level, a script setting, the script version, the device): a row per value,
     its expected coins an hour drawn as a bar (lib/expected.js), and how it
     compares with a reference row. A change is coloured, and a row marked best,
     only when the difference is more than the luck of which rounds were played
     explains; a row whose figure is not yet known within ± 5 % says so.
     In medals there is no such error to go by: the medal rate, rows under
     `few` rounds flagged, as before. -->
<script>
  import {differs, errText, expHour, trusted} from '../../lib/expected.js';
  import {fmt, fmtRate, parseUTC, pct} from '../../lib/util.js';

  // rows: [{label, rounds, avgCoins, maxCoins, coinsPerSec, avgScore, first, last, exp*, mark?}].
  // against: 'prev' compares each row with the one above it, 'most' with the most played row.
  // few: in medals, rows with fewer rounds than this are marked as too few to trust.
  let {rows, unit, head, against = 'most', few = 20} = $props();

  const medals = $derived(unit === 'medals');
  const day = new Intl.DateTimeFormat(undefined, {month: 'short', day: 'numeric'});
  const span = r => {
    const a = day.format(parseUTC(r.first)), b = day.format(parseUTC(r.last));
    return a === b ? a : `${a} – ${b}`;
  };

  const view = $derived.by(() => {
    const value = r => (medals ? r.coinsPerSec : expHour(r));
    const sure = r => (medals ? r.rounds >= few : trusted(r));
    const top = Math.max(0, ...rows.map(r => value(r) ?? 0));
    // The best is the highest of the rows known well enough, marked only when it clearly beats the next.
    const ranked = rows.filter(r => sure(r) && value(r) !== null).sort((a, b) => value(b) - value(a));
    const best = ranked.length > 1 && (medals || differs(ranked[0], ranked[1])) ? ranked[0] : null;
    const most = rows.reduce((m, r) => (m === null || r.rounds > m.rounds ? r : m), null);
    return rows.map((r, i) => {
      const ref = against === 'prev' ? rows[i - 1] : most === r ? null : most;
      const change = ref && value(ref) && value(r) !== null ? value(r) / value(ref) - 1 : null;
      // Medals have no error to judge by: a change past half a percent is shown as one.
      const real = change !== null && (medals ? Math.abs(change) > 0.005 : differs(r, ref));
      return {...r, v: value(r), bar: top > 0 && value(r) !== null ? (value(r) / top) * 100 : 0, change, real, best: r === best, sure: sure(r)};
    });
  });
  const changeTitle = $derived(`${against === 'prev' ? 'Against the row above' : 'Against the most played row'}; coloured only when the difference is more than luck explains`);
</script>

<div class="table-wrap">
  <table class="breakdown">
    <colgroup><col class="bd-c-label"><col class="bd-c-n"><col class="bd-c-rate">{#if !medals}<col class="bd-c-n">{/if}<col class="bd-c-n"><col class="bd-c-n"><col class="bd-c-n"><col class="bd-c-n"><col class="bd-c-when"></colgroup>
    <thead>
      <tr>
        <th>{head}</th>
        <th class="num">Rounds</th>
        {#if medals}
          <th class="num">Medals/s</th>
        {:else}
          <th class="num" title="Expected net coins an hour of play: base coins with +Coin's bonus at its average, less what the items cost">Expected/h</th>
          <th class="num" title="How far the figure could be off by the luck of which rounds were played (one standard error)">±</th>
        {/if}
        <th class="num" title={changeTitle}>Change</th>
        <th class="num">{medals ? 'Average' : 'Coins/s'}</th>
        <th class="num">{medals ? 'Highest' : 'Average'}</th>
        <th class="num">Avg score</th>
        <th>Played</th>
      </tr>
    </thead>
    <tbody>
      {#each view as r (r.label)}
        <tr class:few={!r.sure} class:mark={r.mark}>
          <td>
            <span class="bd-label">{r.label}</span>
            {#if r.mark}<span class="tag">{r.mark}</span>{/if}
            {#if !r.sure}<span class="sub" title={medals ? 'Too few rounds to trust the figures yet' : 'Not yet known within ± 5 %: more rounds will settle it'}>{medals ? 'few rounds' : 'uncertain'}</span>{/if}
          </td>
          <td class="num">{fmt(r.rounds)}</td>
          <td class="num {medals ? 'medal' : 'coin'}">
            <span class="bd-rate"><span class="bd-bar"><span style:width="{r.bar}%" class:best={r.best}></span></span>{medals ? fmtRate(r.v) : fmt(r.v)}</span>
          </td>
          {#if !medals}<td class="num dim">{errText(r)}</td>{/if}
          <td class="num" class:up={r.real && r.change > 0} class:down={r.real && r.change < 0}>{r.change === null ? '' : `${r.change > 0 ? '+' : ''}${pct(r.change)}`}</td>
          <td class="num">{medals ? fmt(r.avgCoins) : fmtRate(r.coinsPerSec)}</td>
          <td class="num">{medals ? fmt(r.maxCoins) : fmt(r.avgCoins)}</td>
          <td class="num score">{fmt(r.avgScore)}</td>
          <td class="dim">{span(r)}</td>
        </tr>
      {/each}
    </tbody>
  </table>
</div>
