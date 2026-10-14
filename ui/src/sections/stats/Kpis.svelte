<!-- The overview tiles: the primary stat's figures, then medals beside coins. -->
<script>
  import {cap, fmt, fmtDuration, fmtRate, pct} from '../../lib/util.js';

  // t: the summary's totals; m: the same over rounds that earned medals.
  // noMedals drops the medal tiles when no round earned any (a Tsum that never does).
  // approx marks the median, quartile and P90 as estimates (the global site's);
  // missing says why they are not there, when they are not.
  let {t, m, coins, basis, noMedals = false, approx = false, missing = ''} = $props();

  const u = $derived(coins === 'medals' ? 'medals' : 'coins');
  const medals = $derived(coins === 'medals');
  const unitCls = $derived(medals ? 'medal' : 'coin');
  const perHour = r => (r === null ? null : r * 3600);
  const bonus = $derived(t.avgBaseCoins && t.avgFinalCoins ? t.avgFinalCoins / t.avgBaseCoins - 1 : null);
  /** A spread figure's note: its words and value, marked when it is an estimate. */
  const spread = (words, v) => (v === null ? '' : `${words} ${approx ? '≈ ' : ''}${fmt(v)}`);

  // [label, value, class, note]
  const tiles = $derived([
    [`${cap(basis)} per second`, fmtRate(t.coinsPerSec), `hero ${unitCls}`, t.coinsPerSec === null ? '' : `≈ ${fmt(perHour(t.coinsPerSec))} ${u} an hour of play`],
    [`Average ${u}`, fmt(t.avgCoins), unitCls, t.medianCoins === null && t.rounds ? missing : spread('median', t.medianCoins)],
    [`Lowest ${u}`, fmt(t.minCoins), unitCls, spread('a quarter under', t.q1Coins)],
    [`Highest ${u}`, fmt(t.maxCoins), unitCls, spread('one in ten over', t.p90Coins)],
    ['Spread', t.stdCoins === null ? '—' : `± ${fmt(t.stdCoins)}`, '', `standard deviation of ${u}`],
    [`Total ${u}`, fmt(t.totalCoins), unitCls, medals || bonus === null ? '' : `coin bonus added ${pct(bonus)}`],
    [medals ? 'Rounds with medals' : 'Rounds', fmt(t.rounds), '', t.totalSeconds ? `${fmtRate(t.totalSeconds / 3600)} h played` : ''],
    ['Average round', fmtDuration(t.avgSeconds), '', ''],
    ['Average score', fmt(t.avgScore), 'score', t.maxScore === null ? '' : `best ${fmt(t.maxScore)}`],
    // Medals beside coins, over the rounds that earned any; with medals primary the tiles above are these.
    ...(medals || (noMedals && !m.rounds) ? [] : [
      ['Medals per hour', fmt(perHour(m.coinsPerSec)), 'medal', m.coinsPerSec === null ? '' : `${fmtRate(m.coinsPerSec)} a second`],
      ['Average medals', fmt(m.avgCoins), 'medal', m.medianCoins === null && m.rounds ? missing : spread('median', m.medianCoins)],
      ['Highest medals', fmt(m.maxCoins), 'medal', spread('one in ten over', m.p90Coins)],
      ['Total medals', fmt(m.totalCoins), 'medal', t.rounds ? `from ${fmt(m.rounds)} rounds (${pct(m.rounds / t.rounds)})` : ''],
    ]),
  ]);
</script>

<div class="kpis">
  {#each tiles as [label, value, cls, note] (label)}
    <div class="panel kpi {cls}">
      <div class="label">{label}</div>
      <div class="value">{value}</div>
      {#if note}<div class="note">{note}</div>{/if}
    </div>
  {/each}
</div>
