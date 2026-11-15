<!-- The overview tiles: the primary stat's figures, then medals beside coins.
     A number too long for its tile shows its short form (lib/fit.js).
     The first tile carries, in its bottom corner (clear of the themes' badges),
     the button that copies them as an image; copyFrom gives a wider element to
     copy (the Tsum page's tiles and insights). -->
<script>
  import CopyButton from '../../components/CopyButton.svelte';
  import {fit} from '../../lib/fit.js';
  import {BREAK_SECONDS, EXPECTED_BONUS, avgBetween, errText, expHour, runHour} from '../../lib/expected.js';
  import {cap, fmt, fmtDuration, fmtRate, fmtShort, pct} from '../../lib/util.js';

  // t: the summary's totals; m: the same over medal Tsums' rounds, 0s included.
  // noMedals drops the medal tiles when no round earned any (a Tsum that never does).
  // approx marks the median, quartile and P90 as estimates (the global site's);
  // missing says why they are not there, when they are not.
  // totalFirst leads with the total earned in place of the rate, and drops the rates
  // (the global Stats page: a rate over everyone's play together says nothing).
  // steady: show the consistency tile (the Tsum page has its own, with a target).
  // incomplete: the rounds left out for an unread figure (the summary's incompleteRounds).
  let {t, m, coins, basis, noMedals = false, approx = false, missing = '', totalFirst = false, steady = true, incomplete = 0, copyFrom = null} = $props();
  let node;

  const u = $derived(coins === 'medals' ? 'medals' : 'coins');
  const medals = $derived(coins === 'medals');
  const unitCls = $derived(medals ? 'medal' : 'coin');
  const perHour = r => (r === null ? null : r * 3600);
  const bonus = $derived(t.avgBaseCoins && t.avgFinalCoins ? t.avgFinalCoins / t.avgBaseCoins - 1 : null);
  const about = $derived(approx ? '≈ ' : '');
  // Half the middle half's width over the median (Insights' consistency): a misread round cannot stretch it as it does the standard deviation.
  const steadiness = $derived(t.q1Coins !== null && t.q3Coins !== null && t.medianCoins ? (t.q3Coins - t.q1Coins) / 2 / Math.abs(t.medianCoins) : null);
  /** A spread figure's note: its words and value, marked when it is an estimate. */
  const spread = (words, v) => (v === null ? '' : `${words} ${approx ? '≈ ' : ''}${fmt(v)}`);

  // [label, value, class, note, short: the value's form for a tile it does not fit]
  // Expected net coins lead in coin modes: what an hour of play pays, without the coin bonus's luck.
  const expected = $derived(medals || expHour(t) === null ? null
    : ['Expected coins an hour of play', fmt(expHour(t)), 'hero coin', [errText(t), `+Coin's bonus at its ${pct(EXPECTED_BONUS)} average, less item costs`].filter(Boolean).join(' · '), fmtShort(expHour(t))]);
  // The same with the time between rounds counted: an hour of the script running, not only of play.
  const running = $derived(medals || runHour(t) === null ? null
    : ['Expected/h, between rounds included', fmt(runHour(t)), 'coin',
      `play time plus ${approx ? '≈ ' : ''}${fmt(avgBetween(t))} s between rounds on average (gaps up to ${BREAK_SECONDS / 60} min; longer is a break)`, fmtShort(runHour(t))]);
  const rate = $derived([`${cap(basis)} per second`, fmtRate(t.coinsPerSec), `${expected ? '' : 'hero '}${unitCls}`, t.coinsPerSec === null ? '' : `≈ ${fmt(perHour(t.coinsPerSec))} ${u} an hour of play`]);
  const total = $derived([totalFirst ? `Total ${basis}` : `Total ${u}`, fmt(t.totalCoins), `${totalFirst ? 'hero ' : ''}${unitCls}`,
    medals || bonus === null ? '' : `coin bonus added ${pct(bonus)}`, fmtShort(t.totalCoins)]);
  const medalTotal = $derived(['Total medals', fmt(m.totalCoins), 'medal',
    m.rounds ? `earned in ${fmt(m.earnedRounds)} of ${fmt(m.rounds)} rounds (${pct(m.earnedRounds / m.rounds)})` : '', fmtShort(m.totalCoins)]);
  const tiles = $derived([
    ...(expected && !totalFirst ? [expected] : []),
    ...(running && !totalFirst ? [running] : []),
    totalFirst ? total : rate,
    [`Average ${u}`, fmt(t.avgCoins), unitCls, t.medianCoins === null && t.rounds ? missing : spread('median', t.medianCoins), fmtShort(t.avgCoins)],
    // The middle half of rounds, not the extremes: a misread round or a jackpot does not move it.
    ['Typical round', t.q1Coins === null ? '—' : `${about}${fmtShort(t.q1Coins)}–${fmtShort(t.q3Coins)}`, unitCls,
      [t.q1Coins === null && t.rounds ? missing : `the middle half of rounds`, t.maxCoins === null ? '' : `best ${fmt(t.maxCoins)}`].filter(Boolean).join(' · ')],
    ...(steady ? [['Consistency', steadiness === null ? '—' : `± ${pct(steadiness)}`, '', `half the rounds land within this of the median`]] : []),
    ...(totalFirst ? [] : [total]),
    ['Rounds', fmt(t.rounds), '', [t.totalSeconds ? `${fmtRate(t.totalSeconds / 3600)} h played` : '', medals && t.rounds ? `${pct(t.earnedRounds / t.rounds)} earned medals` : '',
      incomplete ? `${fmt(incomplete)} left out as incomplete (${pct(incomplete / (t.rounds + incomplete))})` : ''].filter(Boolean).join(' · '), fmtShort(t.rounds)],
    ['Average round', fmtDuration(t.avgSeconds), '', ''],
    ['Average score', fmt(t.avgScore), 'score', t.maxScore === null ? '' : `best ${fmt(t.maxScore)}`, fmtShort(t.avgScore)],
    // Medals beside coins, over medal Tsums' rounds (0s included); with medals primary the tiles above are these.
    ...(medals || (noMedals && !m.rounds) ? [] : [
      ...(totalFirst ? [medalTotal] : [['Medals per hour', fmt(perHour(m.coinsPerSec)), 'medal', m.coinsPerSec === null ? '' : `${fmtRate(m.coinsPerSec)} a second`, fmtShort(perHour(m.coinsPerSec))]]),
      ['Average medals', fmt(m.avgCoins), 'medal', m.medianCoins === null && m.rounds ? missing : spread('median', m.medianCoins), fmtShort(m.avgCoins)],
      ['Highest medals', fmt(m.maxCoins), 'medal', spread('one in ten over', m.p90Coins), fmtShort(m.maxCoins)],
      ...(totalFirst ? [] : [medalTotal]),
    ]),
  ]);
</script>

<div class="kpis" bind:this={node}>
  {#each tiles as [label, value, cls, note, short], i (label)}
    <div class="panel kpi {cls}">
      {#if i === 0}<CopyButton title="Overview" from={() => copyFrom?.() ?? node} cls="kpi-copy" />{/if}
      <div class="label">{label}</div>
      {#if short && short !== value}
        <div class="value fit" use:fit><span class="fit-full">{value}</span><span class="fit-short" title={value}>{short}</span></div>
      {:else}
        <div class="value">{value}</div>
      {/if}
      {#if note}<div class="note">{note}</div>{/if}
    </div>
  {/each}
</div>
