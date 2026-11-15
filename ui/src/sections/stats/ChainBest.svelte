<!-- Each Tsum's best chains-per-scan × max-chain pair: the two settings taken
     together, as the items chart takes an item set, from the summary's chains
     (summary.go: ChainStat). Pairs are compared at one skill level, the Tsum's
     highest with MIN_ROUNDS rounds (else its most played), so a level-up is not
     taken for a better pair, and in expected net coins an hour
     (lib/expected.js). Only pairs known within ± 5 % can be the best, a best
     is called clear only when it beats the next by more than luck explains, and
     the rounds without either setting never are one. -->
<script>
  import TsumCell from '../../components/TsumCell.svelte';
  import {differs, errText, expHour, trusted} from '../../lib/expected.js';
  import {MIN_ROUNDS, chainsLabel, fmt, pct} from '../../lib/util.js';

  // chains: the summary's chains. tsums: the Tsum ids to list, most played first.
  let {chains, tsums, nameOf, colorOf, focusOn} = $props();

  const add = (to, c) => {
    to.rounds += c.rounds;
    to.expCoins += c.expCoins ?? 0;
    to.expSeconds += c.expSeconds ?? 0;
    to.expRounds += c.expRounds;
    to.expSq = to.expSq === null || c.expSq === null ? null : to.expSq + (c.expSq ?? 0);
  };
  const blank = extra => ({rounds: 0, expCoins: 0, expSeconds: 0, expRounds: 0, expSq: 0, ...extra});

  const rows = $derived.by(() => {
    // Pairs per Tsum and skill level, every build together.
    const byTsum = new Map();
    for (const c of chains) {
      if (c.scan === '' && c.chain === '') continue;
      if (!byTsum.has(c.tsum)) byTsum.set(c.tsum, new Map());
      const levels = byTsum.get(c.tsum);
      if (!levels.has(c.skill)) levels.set(c.skill, {skill: c.skill, rounds: 0, pairs: new Map()});
      const level = levels.get(c.skill), key = `${c.scan},${c.chain}`;
      level.rounds += c.rounds;
      if (!level.pairs.has(key)) level.pairs.set(key, blank({scan: c.scan, chain: c.chain}));
      add(level.pairs.get(key), c);
    }
    const out = [];
    for (const tsum of tsums) {
      const levels = [...(byTsum.get(tsum)?.values() ?? [])];
      if (!levels.length) continue;
      const enough = levels.filter(l => l.skill !== '' && l.rounds >= MIN_ROUNDS).sort((a, b) => Number(b.skill) - Number(a.skill));
      const level = enough[0] ?? levels.reduce((m, l) => (l.rounds > m.rounds ? l : m));
      const pairs = [...level.pairs.values()];
      const ranked = pairs.filter(p => trusted(p)).sort((a, b) => expHour(b) - expHour(a));
      if (!ranked.length) continue;
      const best = ranked[0];
      const most = pairs.reduce((m, p) => (p.rounds > m.rounds ? p : m));
      out.push({tsum, skill: level.skill, best, most, tried: pairs.length, clear: ranked.length === 1 || differs(best, ranked[1]), next: ranked[1] ?? null,
        change: most !== best && expHour(most) ? expHour(best) / expHour(most) - 1 : null, real: most !== best && differs(best, most)});
    }
    return out;
  });
</script>

{#if rows.length}
  <div class="table-wrap">
    <table class="breakdown chain-best">
      <thead>
        <tr>
          <th>Tsum</th>
          <th title="The pairs are compared at this skill level: the Tsum's highest with {MIN_ROUNDS} rounds or more">Skill</th>
          <th>Best pair</th>
          <th class="num" title="Expected net coins an hour of play">Expected/h</th>
          <th class="num" title="How far it could be off by the luck of which rounds were played (one standard error)">±</th>
          <th class="num">Rounds</th>
          <th class="num" title="The best pair against the Tsum's most played pair at that level; coloured only when the difference is more than luck explains">Against most played</th>
          <th class="num" title="Pairs played with this Tsum at that level">Pairs</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as r (r.tsum)}
          <tr class:few={!r.clear}>
            <td><TsumCell id={r.tsum} name={nameOf(r.tsum) || 'Not identified'} color={colorOf(r.tsum)} onpick={r.tsum ? e => focusOn(r.tsum, e) : null} /></td>
            <td class="dim">{r.skill || '—'}</td>
            <td>
              <span class="bd-label">{chainsLabel(r.best.scan, r.best.chain)}</span>
              {#if r.best === r.most}<span class="tag">most played</span>{/if}
              {#if !r.clear}<span class="sub" title="Within luck of {chainsLabel(r.next.scan, r.next.chain)}: more rounds will settle which is better">not clear yet</span>{/if}
            </td>
            <td class="num coin">{fmt(expHour(r.best))}</td>
            <td class="num dim">{errText(r.best)}</td>
            <td class="num">{fmt(r.best.rounds)}</td>
            <td class="num" class:up={r.real && r.change > 0} class:down={r.real && r.change < 0}
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
  <p class="dim">No Tsum has a chains-per-scan and max-chain pair known within ± 5 % in the filter.</p>
{/if}
