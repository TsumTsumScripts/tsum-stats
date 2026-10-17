<!-- Each Tsum's best chains-per-scan × max-chain pair: the two settings taken
     together, as the items chart takes an item set, from the summary's chains
     (summary.go: ChainStat). Only pairs with enough rounds can be the best,
     and the rounds without either setting never are. -->
<script>
  import TsumCell from '../../components/TsumCell.svelte';
  import {chainsLabel, fmt, fmtRate, pct} from '../../lib/util.js';

  // chains: the summary's chains. tsums: the Tsum ids to list, most played first.
  // few: a pair with fewer rounds than this is not trusted to be the best.
  let {chains, tsums, unit, nameOf, colorOf, focusOn, few = 20} = $props();

  const rate = p => (p.secs ? p.rateCoins / p.secs : null);

  const rows = $derived.by(() => {
    // Rounds per Tsum and pair, every build together.
    const byTsum = new Map();
    for (const c of chains) {
      if (c.scan === '' && c.chain === '') continue;
      if (!byTsum.has(c.tsum)) byTsum.set(c.tsum, new Map());
      const pairs = byTsum.get(c.tsum), key = `${c.scan},${c.chain}`;
      if (!pairs.has(key)) pairs.set(key, {scan: c.scan, chain: c.chain, rounds: 0, rateCoins: 0, secs: 0});
      const p = pairs.get(key);
      p.rounds += c.rounds;
      p.rateCoins += c.rateCoins ?? 0;
      p.secs += c.rateSeconds ?? 0;
    }
    const out = [];
    for (const tsum of tsums) {
      const pairs = [...(byTsum.get(tsum)?.values() ?? [])];
      const trusted = pairs.filter(p => p.rounds >= few && rate(p) !== null);
      if (!trusted.length) continue;
      const best = trusted.reduce((m, p) => (rate(p) > rate(m) ? p : m));
      const most = pairs.reduce((m, p) => (p.rounds > m.rounds ? p : m));
      out.push({tsum, best, most, tried: pairs.length,
        change: most !== best && rate(most) ? rate(best) / rate(most) - 1 : null});
    }
    return out;
  });
  const U = $derived(unit === 'medals' ? 'Medals' : 'Coins');
</script>

{#if rows.length}
  <div class="table-wrap">
    <table class="breakdown chain-best">
      <thead>
        <tr>
          <th>Tsum</th>
          <th>Best pair</th>
          <th class="num">{U}/s</th>
          <th class="num">Rounds</th>
          <th class="num" title="The best pair's rate against the Tsum's most played pair">Against most played</th>
          <th class="num" title="Pairs played with this Tsum">Pairs</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as r (r.tsum)}
          <tr>
            <td><TsumCell id={r.tsum} name={nameOf(r.tsum) || 'Not identified'} color={colorOf(r.tsum)} onpick={r.tsum ? e => focusOn(r.tsum, e) : null} /></td>
            <td>
              <span class="bd-label">{chainsLabel(r.best.scan, r.best.chain)}</span>
              {#if r.best === r.most}<span class="tag">most played</span>{/if}
            </td>
            <td class="num {unit === 'medals' ? 'medal' : 'coin'}">{fmtRate(rate(r.best))}</td>
            <td class="num">{fmt(r.best.rounds)}</td>
            <td class="num" class:up={r.change > 0.005} class:down={r.change < -0.005}
              title={r.change === null ? '' : `most played: ${chainsLabel(r.most.scan, r.most.chain)}, ${fmt(r.most.rounds)} rounds`}>
              {r.change === null ? '' : `${r.change > 0 ? '+' : ''}${pct(r.change)}`}
            </td>
            <td class="num">{fmt(r.tried)}</td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{:else}
  <p class="dim">No Tsum has a chains-per-scan and max-chain pair with {fmt(few)} rounds or more in the filter.</p>
{/if}
