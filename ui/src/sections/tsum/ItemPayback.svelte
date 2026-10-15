<!-- Whether each boost item earns back its cost on this Tsum. An item is judged
     only between item sets that differ by that item alone (+Coin with and
     without 5>4, say), so the other items do not count for or against it. -->
<script>
  import {ITEMS, fmt, fmtRate} from '../../lib/util.js';

  // mix: the summary's build × items rows for this Tsum. net: coins are already
  // less item costs. final: coins are final coins. few: rounds a side needs.
  let {mix, net, final, few = 20} = $props();

  const rows = $derived.by(() => {
    // Item sets across builds; -1 is rounds recorded before items were.
    const sets = new Map();
    for (const m of mix) {
      if (m.items < 0) continue;
      const s = sets.get(m.items) ?? {coins: 0, coinRounds: 0, rateCoins: 0, rateSeconds: 0};
      s.coins += m.coins ?? 0;
      s.coinRounds += m.coinRounds;
      s.rateCoins += m.rateCoins ?? 0;
      s.rateSeconds += m.rateSeconds ?? 0;
      sets.set(m.items, s);
    }
    const out = [];
    for (const item of ITEMS) {
      // Each pair of sets that differ by this item alone, weighted by its smaller side.
      let weight = 0, avgDiff = 0, rateDiff = 0, rateWeight = 0, with_ = 0, without = 0, thin = true;
      for (const [mask, off] of sets) {
        if (mask & item.bit) continue;
        const on = sets.get(mask | item.bit);
        if (!on || !on.coinRounds || !off.coinRounds) continue;
        const w = Math.min(on.coinRounds, off.coinRounds);
        if (w >= few) thin = false;
        weight += w;
        avgDiff += w * (on.coins / on.coinRounds - off.coins / off.coinRounds);
        if (on.rateSeconds && off.rateSeconds) {
          rateWeight += w;
          rateDiff += w * (on.rateCoins / on.rateSeconds - off.rateCoins / off.rateSeconds);
        }
        with_ += on.coinRounds;
        without += off.coinRounds;
      }
      if (!weight) continue;
      const more = avgDiff / weight;
      // Net coins already have the item's cost taken off.
      const gain = net ? more : more - item.cost;
      out.push({...item, more, gain, rate: rateWeight ? rateDiff / rateWeight : null, with: with_, without, thin});
    }
    return out.sort((a, b) => b.gain - a.gain);
  });

  const signed = v => (v === null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${fmt(Math.abs(v))}`);
</script>

{#if rows.length}
  <div class="table-wrap">
    <table class="breakdown payback">
      <thead>
        <tr>
          <th>Item</th>
          <th class="num">Cost</th>
          <th class="num" title="Average coins a round with the item made, against the same items without it">{net ? 'Net coins' : 'Coins'} more a round</th>
          <th class="num" title="What the item adds a round, less its cost">Gain a round</th>
          <th class="num" title="Coins per second with the item, against without">Rate change</th>
          <th class="num">Rounds with · without</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {#each rows as r (r.bit)}
          <tr class:few={r.thin}>
            <td><span class="bd-label">{r.label}</span>{#if r.thin}<span class="sub" title="No pair of item sets has 20 rounds on both sides">few rounds</span>{/if}</td>
            <td class="num dim">{fmt(r.cost)}</td>
            <td class="num">{signed(r.more)}</td>
            <td class="num" class:up={r.gain > 0} class:down={r.gain < 0}><b>{signed(r.gain)}</b></td>
            <td class="num" class:up={r.rate > 0} class:down={r.rate < 0}>{r.rate === null ? '—' : `${r.rate > 0 ? '+' : ''}${fmtRate(r.rate)}/s`}</td>
            <td class="num dim">{fmt(r.with)} · {fmt(r.without)}</td>
            <td>{#if !r.thin}<span class="tag">{r.gain > 0 ? 'Pays' : 'Costs'}</span>{/if}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if !final}<p class="sub payback-note">These are base coins. The coin bonus adds to what a round pays, so switch to Final to judge an item by what you are paid.</p>{/if}
{:else}
  <p class="sub">No item has been played both with and without it, alongside the same other items.</p>
{/if}
