<!-- Whether each boost item earns back its cost on this Tsum, in expected net
     coins an hour (lib/expected.js): what an hour of play pays with the item
     against without it, its cost already taken off and the coin bonus at its
     average. An item is judged only between item sets that differ by that item
     alone, at the same skill level (+Coin with and without 5>4 at skill 5, say),
     so neither the other items nor a level-up count for or against it. An item
     that makes rounds longer is charged for the time, which a per-round figure
     missed. The verdict needs the gain to be more than luck explains. -->
<script>
  import {EXPECTED_BONUS, expErr, expRate} from '../../lib/expected.js';
  import {ITEMS, fmt, pct} from '../../lib/util.js';

  // mix: the summary's build × skill level × items rows for this Tsum.
  let {mix} = $props();

  // Items that pay in something other than coins: their coin figure is only their cost.
  const NOT_COINS = {8: 'exp', 16: 'score'};

  const rows = $derived.by(() => {
    // Item sets per skill level, every build together; -1 is rounds recorded before items were.
    const sets = new Map();
    for (const m of mix) {
      if (m.items < 0 || !m.expRounds) continue;
      const k = `${m.skill}|${m.items}`;
      const s = sets.get(k) ?? {skill: m.skill, items: m.items, expCoins: 0, expSeconds: 0, expRounds: 0, expSq: 0};
      s.expCoins += m.expCoins;
      s.expSeconds += m.expSeconds;
      s.expRounds += m.expRounds;
      s.expSq = s.expSq === null || m.expSq === null ? null : s.expSq + m.expSq;
      sets.set(k, s);
    }
    const out = [];
    for (const item of ITEMS) {
      // Each pair of sets that differ by this item alone at one skill level, weighted by its smaller side.
      let weight = 0, diff = 0, offRate = 0, variance = 0, known = true, with_ = 0, without = 0, levels = new Set();
      for (const off of sets.values()) {
        if (off.items & item.bit) continue;
        const on = sets.get(`${off.skill}|${off.items | item.bit}`);
        if (!on) continue;
        const w = Math.min(on.expRounds, off.expRounds);
        const ron = expRate(on), roff = expRate(off), eon = expErr(on), eoff = expErr(off);
        weight += w;
        diff += w * (ron - roff);
        offRate += w * roff;
        if (eon === null || eoff === null) known = false;
        else variance += w * w * ((ron * eon) ** 2 + (roff * eoff) ** 2);
        with_ += on.expRounds;
        without += off.expRounds;
        levels.add(off.skill);
      }
      if (!weight) continue;
      const change = (diff / weight) * 3600;
      const err = known ? (Math.sqrt(variance) / weight) * 3600 : null;
      const verdict = NOT_COINS[item.bit] ? `For ${NOT_COINS[item.bit]}` : err === null || Math.abs(change) <= 2 * err ? 'Unclear' : change > 0 ? 'Pays' : 'Costs';
      out.push({...item, change, err, rel: offRate ? diff / offRate : null, with: with_, without, levels: levels.size, verdict});
    }
    return out.sort((a, b) => b.change - a.change);
  });

  const signed = v => (v === null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt(Math.abs(v))}`);
  // +Coin pays for itself in a round whose base coins pass its cost over the average bonus.
  const coinBreakEven = 500 / EXPECTED_BONUS;
</script>

{#if rows.length}
  <div class="table-wrap">
    <table class="breakdown payback">
      <thead>
        <tr>
          <th>Item</th>
          <th class="num">Cost</th>
          <th class="num" title="Expected net coins an hour with the item against without it, the item's cost taken off, at the same skill level and other items">Change an hour</th>
          <th class="num" title="How far the change could be off by the luck of which rounds were played (one standard error)">±</th>
          <th class="num" title="The change against the rate without the item">Change</th>
          <th class="num">Rounds with · without</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each rows as r (r.bit)}
          <tr class:few={r.verdict === 'Unclear'}>
            <td>
              <span class="bd-label">{r.label}</span>
              {#if r.levels > 1}<span class="sub" title="Compared within each skill level, then combined">{r.levels} skill levels</span>{/if}
            </td>
            <td class="num dim">{fmt(r.cost)}</td>
            <td class="num" class:up={r.verdict === 'Pays'} class:down={r.verdict === 'Costs'}><b>{signed(r.change)}</b></td>
            <td class="num dim">{r.err === null ? '' : `± ${fmt(r.err)}`}</td>
            <td class="num">{r.rel === null ? '' : `${r.rel > 0 ? '+' : ''}${pct(r.rel)}`}</td>
            <td class="num dim">{fmt(r.with)} · {fmt(r.without)}</td>
            <td><span class="tag" title={r.verdict === 'Unclear' ? 'The change is within what luck explains: more rounds on both sides will settle it'
              : r.verdict.startsWith('For') ? `It pays in ${NOT_COINS[r.bit]}, not coins: the change is its cost` : ''}>{r.verdict}</span></td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  <p class="sub payback-note">In expected net coins an hour: the coin bonus at its {pct(EXPECTED_BONUS)} average and each item's cost taken off, so an item that makes rounds longer is charged for the time.
    +Coin pays for itself in any round over {fmt(coinBreakEven)} base coins.</p>
{:else}
  <p class="sub">No item has been played both with and without it, alongside the same other items at the same skill level.</p>
{/if}
