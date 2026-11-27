<!-- One Tsum's best setups: every setting a player picks taken together (the
     skill level, the item set, chains per scan and max chain length, the
     bubble strategy and the skill type; tsum.go: ComboStat), ranked by
     expected net coins an hour (lib/expected.js), so an item set is charged
     its cost, or in medals by medals an hour. As ChainBest and Breakdown do:
     only combinations known within ± 5 % rank (in medals, those with FEW
     rounds), the first is marked best only when it beats the next by more
     than luck explains, and each is against the most played combination,
     coloured only beyond luck. With none known well enough yet, the most
     played are shown, flagged. -->
<script>
  import {differs, errText, expHour, trusted} from '../../lib/expected.js';
  import {chainsLabel, fmt, itemsLabel, pct, playValueName, skillTypeName} from '../../lib/util.js';

  // combos: the Tsum page's combos. unit: 'medals' ranks by medals an hour (the rate columns are then medals).
  let {combos, unit} = $props();

  const TOP = 10;
  const FEW = 20;
  const medals = $derived(unit === 'medals');
  const value = r => (medals ? (r.coinsPerSec == null ? null : r.coinsPerSec * 3600) : expHour(r));
  const sure = r => (medals ? r.rounds >= FEW : trusted(r));
  // Medals have no error to judge by: a change past half a percent is shown as one, the best is always clear.
  const beats = (a, b) => (medals ? Math.abs(value(a) / value(b) - 1) > 0.005 : differs(a, b));

  const view = $derived.by(() => {
    const valued = combos.filter(r => value(r) !== null);
    const known = valued.filter(sure).sort((a, b) => value(b) - value(a));
    // Too few rounds everywhere: the most played, best first, each flagged.
    const shown = known.length ? known.slice(0, TOP)
      : [...valued].sort((a, b) => b.rounds - a.rounds).slice(0, 5).sort((a, b) => value(b) - value(a));
    const most = valued.reduce((m, r) => (m === null || r.rounds > m.rounds ? r : m), null);
    const best = known.length > 1 && beats(known[0], known[1]) ? known[0] : known.length === 1 ? known[0] : null;
    const top = Math.max(0, ...shown.map(value));
    const rows = shown.map(r => {
      const change = most && r !== most && value(most) ? value(r) / value(most) - 1 : null;
      return {...r, v: value(r), bar: top > 0 ? Math.max(0, (value(r) / top) * 100) : 0, sure: sure(r), best: r === best, most: r === most,
        change, real: change !== null && beats(r, most)};
    });
    return {rows, known: known.length, valued: valued.length, most};
  });
  // A setting is a column unless no row shown has it recorded.
  const has = $derived({
    chains: view.rows.some(r => r.scan !== '' || r.chain !== ''),
    bubble: view.rows.some(r => r.bubble !== ''),
    skillType: view.rows.some(r => r.skillType !== ''),
  });
  const setup = r => [r.skill ? `Skill ${r.skill}` : 'Skill not recorded', itemsLabel(r.items),
    has.chains ? chainsLabel(r.scan, r.chain) : '', has.bubble ? playValueName('bubble', r.bubble) : '',
    has.skillType ? skillTypeName(r.skillType) : ''].filter(Boolean).join(' · ');
</script>

{#if view.rows.length}
  <div class="table-wrap">
    <table class="breakdown combo-best">
      <thead>
        <tr>
          <th>#</th>
          <th>Skill</th>
          <th>Items</th>
          {#if has.chains}<th>Chains</th>{/if}
          {#if has.bubble}<th>Bubbles</th>{/if}
          {#if has.skillType}<th>Skill type</th>{/if}
          <th class="num">Rounds</th>
          {#if medals}
            <th class="num" title="Medals an hour of play">Medals/h</th>
          {:else}
            <th class="num" title="Expected net coins an hour of play: base coins with +Coin's bonus at its average, less what the items cost">Expected/h</th>
            <th class="num" title="How far the figure could be off by the luck of which rounds were played (one standard error)">±</th>
          {/if}
          <th class="num" title="Against the most played combination; coloured only when the difference is more than luck explains">Against most played</th>
        </tr>
      </thead>
      <tbody>
        {#each view.rows as r, i (r.key)}
          <tr class:few={!r.sure} title={setup(r)}>
            <td class="dim">{i + 1}</td>
            <td>{r.skill || '—'}</td>
            <td>
              <span class="bd-label">{itemsLabel(r.items)}</span>
              {#if r.best}<span class="tag">best</span>{/if}
              {#if r.most}<span class="tag">most played</span>{/if}
              {#if !r.sure}<span class="sub" title={medals ? 'Too few rounds to trust the figures yet' : 'Not yet known within ± 5 %: more rounds will settle it'}>{medals ? 'few rounds' : 'uncertain'}</span>{/if}
            </td>
            {#if has.chains}<td>{chainsLabel(r.scan, r.chain)}</td>{/if}
            {#if has.bubble}<td>{playValueName('bubble', r.bubble)}</td>{/if}
            {#if has.skillType}<td>{skillTypeName(r.skillType)}</td>{/if}
            <td class="num">{fmt(r.rounds)}</td>
            <td class="num {medals ? 'medal' : 'coin'}">
              <span class="bd-rate"><span class="bd-bar"><span style:width="{r.bar}%" class:best={r.best}></span></span>{fmt(r.v)}</span>
            </td>
            {#if !medals}<td class="num dim">{errText(r)}</td>{/if}
            <td class="num" class:up={r.real && r.change > 0} class:down={r.real && r.change < 0}
              title={r.change === null || !view.most ? '' : `most played: ${setup(view.most)}, ${fmt(view.most.rounds)} rounds`}>
              {r.change === null ? '' : `${r.change > 0 ? '+' : ''}${pct(r.change)}`}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if !view.known}
    <p class="sub combo-note">No combination is {medals ? `at ${FEW} rounds` : 'known within ± 5 %'} yet: these are the most played, best first.</p>
  {:else if view.valued > view.rows.length}
    <p class="sub combo-note">{fmt(view.valued - view.known)} of {fmt(view.valued)} combinations have too few rounds to rank{view.known > TOP ? ` · the best ${TOP} of the ${fmt(view.known)} that do are shown` : ''}.</p>
  {/if}
{:else}
  <p class="dim">No rounds with {medals ? 'medals' : 'expected coins (known items and a time)'} in the filter.</p>
{/if}
