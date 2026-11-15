<!-- The Tsum page's read-outs above the breakdowns: recent form, how long its
     next skill level and full skill take at your pace, and how steady it is,
     with the share of rounds under a target the player sets. -->
<script>
  import {toMax, toNext} from '../../lib/boxes.js';
  import {differs, errText, expHour, expRate, sumExp} from '../../lib/expected.js';
  import {debounce, fmt, fmtRate, pct} from '../../lib/util.js';

  // detail: the /tsum answer; own: the Tsum's Tsum list row (null when not owned,
  // undefined while loading); entry: its catalog entry; target / setTarget: the
  // rounds-under figure's threshold in the primary stat (null for none).
  // whose: 'your' rounds, or on the global site 'all' of them; approx: the
  // median and the rounds under the target are estimates from 2 % bins.
  let {detail, own, entry, unit, basis, target, setTarget, whose = 'your', approx = false} = $props();
  const about = $derived(approx ? '≈ ' : '');

  const t = $derived(detail.summary.totals);

  // Recent form in expected coins an hour (lib/expected.js), or the medal rate in medals.
  // A change is coloured only when it is more than luck explains (medals: past half a percent).
  const medals = $derived(unit === 'medals');
  const form = $derived.by(() => {
    const value = r => (r ? (medals ? r.coinsPerSec : expHour(r)) : null);
    const [recent, before] = ['recent', 'before'].map(k => detail.form.find(r => r.key === k) ?? null);
    if (value(recent) === null) return null;
    const vs = (r, base) => {
      const v = value(r), b = value(base);
      return v === null || !b ? null : {v: v / b - 1, real: medals ? Math.abs(v / b - 1) > 0.005 : differs(r, base)};
    };
    return {recent, before, value: value(recent), err: medals ? '' : errText(recent), vsAll: vs(recent, t), vsBefore: before && vs(recent, before)};
  });
  const signed = c => (c === null ? '' : `${c.v > 0 ? '+' : ''}${pct(c.v)}`);
  const trend = c => (!c?.real ? '' : c.v > 0 ? 'up' : 'down');

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
    // Coins at what all the Tsums in the filter earn in expected net coins: the bonus's luck and the items' cost out.
    const rate = u === 'medals' ? detail.earn.medalsPerSec : expRate(sumExp(detail.field)) ?? detail.earn.coinsPerSec;
    // The time between rounds stretches play time into time running the script, where it is known (this Tsum's share).
    const stretch = t.expBetweenSeconds != null && t.expSeconds ? (t.expSeconds + t.expBetweenSeconds) / t.expSeconds : null;
    const time = cost => (rate > 0 ? playTime((cost / rate) * (stretch ?? 1)) : null);
    // What the next level earns over this one, when the filter has rounds of both (the global site's usually does):
    // the hours of play its gain takes to earn back the boxes.
    const level = k => detail.settings.find(r => r.setting === 'skillLevel' && r.key === String(k));
    const now = level(own.skill), then = next && level(next.skill);
    const gain = u === 'coins' && now && then && differs(then, now) ? expHour(then) - expHour(now) : null;
    return {next, max, u, rate, stretch, nextTime: next && time(next.cost), maxTime: time(max.cost),
      gain, payback: gain > 0 ? playTime((next.cost / gain) * 3600) : null};
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
    <div class="panel kpi" title="The newest {fmt(form.recent.rounds)} rounds in the filter. A change is coloured only when it is more than the luck of which rounds were played explains">
      <div class="label">Recent form · last {fmt(form.recent.rounds)} rounds</div>
      {#if medals}
        <div class="value">{fmtRate(form.value)} <span class="unit">medals/s</span></div>
      {:else}
        <div class="value">{fmt(form.value)} <span class="unit">expected coins/h</span></div>
      {/if}
      <div class="note">
        {#if form.err}{form.err} · {/if}<span class={trend(form.vsAll)}>{signed(form.vsAll)}</span> against all {fmt(t.rounds)}
        {#if form.vsBefore} · <span class={trend(form.vsBefore)}>{signed(form.vsBefore)}</span> against the {fmt(form.before.rounds)} before{/if}
      </div>
    </div>
  {/if}

  {#if boxes}
    <div class="panel kpi" title="At what all {whose} Tsums earned a second of play in this filter: {fmtRate(boxes.rate)} {boxes.u === 'medals' ? 'medals' : 'expected net coins'}/s">
      {#if boxes.next}
        <div class="label">To skill {boxes.next.skill}</div>
        <div class="value">{fmt(boxes.next.boxes)} <span class="unit">{boxes.next.boxes === 1 ? 'box' : 'boxes'}</span></div>
        <div class="note">
          {fmt(boxes.next.cost)} {boxes.u}{#if boxes.nextTime}{' '}≈ <b>{boxes.nextTime}</b> {boxes.stretch ? 'of the script running, time between rounds included' : 'of play'}{/if}
          {#if boxes.max.boxes > boxes.next.boxes} · full skill: {fmt(boxes.max.boxes)} boxes{#if boxes.maxTime}{' '}≈ {boxes.maxTime}{/if}{/if}
        </div>
        {#if boxes.gain !== null}
          <div class="note">skill {boxes.next.skill} earns <span class={boxes.gain > 0 ? 'up' : 'down'}>{boxes.gain > 0 ? '+' : '−'}{fmt(Math.abs(boxes.gain))}</span> expected coins/h{#if boxes.payback}: pays back in {boxes.payback} of play{/if}</div>
        {/if}
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
