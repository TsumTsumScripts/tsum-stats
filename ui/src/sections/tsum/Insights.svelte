<!-- The Tsum page's read-outs above the breakdowns: recent form, how long its
     next skill level and full skill take at your pace, and how steady it is,
     with the share of rounds under a target the player sets. -->
<script>
  import {toMax, toNext} from '../../lib/boxes.js';
  import {debounce, fmt, fmtRate, pct} from '../../lib/util.js';

  // detail: the /tsum answer; own: the Tsum's Tsum list row (null when not owned,
  // undefined while loading); entry: its catalog entry; target / setTarget: the
  // rounds-under figure's threshold in the primary stat (null for none).
  // whose: 'your' rounds, or on the global site 'all' of them; approx: the
  // median and the rounds under the target are estimates from 2 % bins.
  let {detail, own, entry, unit, basis, target, setTarget, whose = 'your', approx = false} = $props();
  const about = $derived(approx ? '≈ ' : '');

  const t = $derived(detail.summary.totals);

  const form = $derived.by(() => {
    const [recent, before] = ['recent', 'before'].map(k => detail.form.find(r => r.key === k) ?? null);
    if (!recent || recent.coinsPerSec === null) return null;
    const vs = (r, base) => (r?.coinsPerSec != null && base ? r.coinsPerSec / base - 1 : null);
    return {recent, before, vsAll: vs(recent, t.coinsPerSec), vsBefore: vs(recent, before?.coinsPerSec)};
  });
  const signed = v => (v === null ? '' : `${v > 0 ? '+' : ''}${pct(v)}`);
  const trend = v => (v === null || Math.abs(v) < 0.005 ? '' : v > 0 ? 'up' : 'down');

  /** Hours of play, as minutes, hours or days. */
  function playTime(sec) {
    if (sec === null || !Number.isFinite(sec)) return '—';
    if (sec < 3600) return `${fmt(Math.max(1, sec / 60))} min`;
    if (sec < 48 * 3600) return `${fmtRate(sec / 3600)} h`;
    return `${fmtRate(sec / 86400)} days`;
  }

  /** Boxes to the next skill level and to full skill, and how much play each takes at the filter's pace. */
  const boxes = $derived.by(() => {
    if (!own || !entry?.boxes?.length) return null;
    const next = toNext(entry, own), max = toMax(entry, own);
    const u = max.unit;
    const rate = u === 'medals' ? detail.earn.medalsPerSec : detail.earn.coinsPerSec;
    const time = cost => (rate > 0 ? playTime(cost / rate) : null);
    return {next, max, u, rate, nextTime: next && time(next.cost), maxTime: time(max.cost)};
  });

  // Half the middle half's width against the median: a misread round cannot stretch it as it does the standard deviation.
  const steadiness = $derived(t.q1Coins !== null && t.q3Coins !== null && t.medianCoins ? (t.q3Coins - t.q1Coins) / 2 / Math.abs(t.medianCoins) : null);
  const under = $derived(detail.target && detail.target.rounds ? detail.target.under / detail.target.rounds : null);
  const setSoon = debounce(v => setTarget(v), 500);
  function onTarget(e) {
    const v = e.target.value.trim();
    setSoon(v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));
  }
</script>

<div class="kpis insights">
  {#if form}
    <div class="panel kpi" title="The newest {fmt(form.recent.rounds)} rounds in the filter">
      <div class="label">Recent form · last {fmt(form.recent.rounds)} rounds</div>
      <div class="value">{fmtRate(form.recent.coinsPerSec)} <span class="unit">{unit}/s</span></div>
      <div class="note">
        <span class={trend(form.vsAll)}>{signed(form.vsAll)}</span> against all {fmt(t.rounds)}
        {#if form.before?.coinsPerSec != null} · <span class={trend(form.vsBefore)}>{signed(form.vsBefore)}</span> against the {fmt(form.before.rounds)} before{/if}
      </div>
    </div>
  {/if}

  {#if boxes}
    <div class="panel kpi" title="At what all your Tsums earned a second of play in this filter: {fmtRate(boxes.rate)} {boxes.u === 'medals' ? 'medals' : 'final coins'}/s">
      {#if boxes.next}
        <div class="label">To skill {boxes.next.skill}</div>
        <div class="value">{fmt(boxes.next.boxes)} <span class="unit">{boxes.next.boxes === 1 ? 'box' : 'boxes'}</span></div>
        <div class="note">
          {fmt(boxes.next.cost)} {boxes.u}{#if boxes.nextTime} ≈ <b>{boxes.nextTime}</b> of play{/if}
          {#if boxes.max.boxes > boxes.next.boxes} · full skill: {fmt(boxes.max.boxes)} boxes{#if boxes.maxTime} ≈ {boxes.maxTime}{/if}{/if}
        </div>
      {:else}
        <div class="label">Skill</div>
        <div class="value">Full</div>
        <div class="note">no boxes left to open</div>
      {/if}
    </div>
  {/if}

  <div class="panel kpi">
    <div class="label">Consistency</div>
    <div class="value">{steadiness === null ? '—' : `± ${pct(steadiness)}`}</div>
    <div class="note">half {whose === 'your' ? 'your' : 'the'} rounds land within this of the median, {about}{fmt(t.medianCoins)}</div>
    <label class="target">
      <span>Rounds under</span>
      <input type="number" inputmode="numeric" placeholder={t.medianCoins === null ? 'a target' : fmt(t.medianCoins).replace(/\D/g, '')}
        value={target ?? ''} oninput={onTarget} aria-label="Target {basis}">
      <span>{unit}:</span>
      <b>{under === null ? '—' : about + pct(under)}</b>
    </label>
    {#if detail.target?.rounds}<div class="note">{about}{fmt(detail.target.under)} of {fmt(detail.target.rounds)} rounds{approx ? ', to the nearest 2 % bin' : ''}</div>{/if}
  </div>
</div>
