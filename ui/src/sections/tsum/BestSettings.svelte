<!-- One Tsum's best setups: every setting a player picks taken together (the
     skill level, the item set, chains per scan and max chain length, the
     bubble strategy and the skill type; tsum.go: ComboStat), ranked by
     expected net coins an hour (lib/expected.js), so an item set is charged
     its cost, or in medals by medals an hour.

     One skill level at a time: across levels the highest always wins, and the
     level is what the Tsum is at, not a setting. Without one picked in the
     page's header, it opens at the highest level with a ranked combination,
     with the others a click away. Only combinations with MIN_ROUNDS rounds
     rank, known within ± 5 % (in medals, the rounds alone: there is no error
     to go by), since a handful of alike rounds can look precise by chance.
     The first is marked best only when it beats the next by more than luck
     explains, and each is against the most played combination at its level,
     coloured only beyond luck. With none ranked yet, the most played are
     shown, flagged. -->
<script>
  import Seg from '../../components/Seg.svelte';
  import {differs, errText, expHour, trusted} from '../../lib/expected.js';
  import {MIN_ROUNDS, chainsLabel, fmt, itemsLabel, pct, playValueName, skillTypeName} from '../../lib/util.js';

  // combos: the Tsum page's combos. unit: 'medals' ranks by medals an hour (the rate columns are then medals).
  // skill: the header's skill level ('' for every one); with one, every combination is at it already.
  let {combos, unit, skill = ''} = $props();

  const TOP = 10;
  const ALL = 'all';
  const medals = $derived(unit === 'medals');
  const value = r => (medals ? (r.coinsPerSec == null ? null : r.coinsPerSec * 3600) : expHour(r));
  const sure = r => r.rounds >= MIN_ROUNDS && (medals || trusted(r));
  // Medals have no error to judge by: a change past half a percent is shown as one, the best is always clear.
  const beats = (a, b) => (medals ? Math.abs(value(a) / value(b) - 1) > 0.005 : differs(a, b));
  const levelName = s => (s === '' ? 'Not recorded' : `Skill ${s}`);

  const valued = $derived(combos.filter(r => value(r) !== null));
  /** The levels with a ranked combination, highest first (not recorded last). */
  const levels = $derived([...new Set(valued.filter(sure).map(r => r.skill))]
    .sort((a, b) => (a === '' ? 1 : b === '' ? -1 : Number(b) - Number(a))));
  let picked = $state(null);
  /** The level shown: null with the header's; the one picked here while it has ranked combinations, else the highest that does. */
  const level = $derived(skill ? null : picked === ALL || levels.includes(picked) ? picked : levels[0] ?? ALL);

  const view = $derived.by(() => {
    const at = level === null || level === ALL ? valued : valued.filter(r => r.skill === level);
    // The most played at each level: what each row is against.
    const mostAt = new Map();
    for (const r of at) if (!mostAt.has(r.skill) || r.rounds > mostAt.get(r.skill).rounds) mostAt.set(r.skill, r);
    const known = at.filter(sure).sort((a, b) => value(b) - value(a));
    // None ranked: the most played, best first, each flagged.
    const shown = known.length ? known.slice(0, TOP)
      : [...at].sort((a, b) => b.rounds - a.rounds).slice(0, 5).sort((a, b) => value(b) - value(a));
    const best = known.length > 1 && beats(known[0], known[1]) ? known[0] : known.length === 1 ? known[0] : null;
    const top = Math.max(0, ...shown.map(value));
    const rows = shown.map(r => {
      const most = mostAt.get(r.skill);
      const change = most && r !== most && value(most) ? value(r) / value(most) - 1 : null;
      return {...r, v: value(r), bar: top > 0 ? Math.max(0, (value(r) / top) * 100) : 0, sure: sure(r), best: r === best, most: r === most,
        against: most, change, real: change !== null && beats(r, most)};
    });
    return {rows, known: known.length, total: at.length};
  });
  // A setting is a column unless no row shown has it recorded; the skill level only across levels.
  const has = $derived({
    skill: level === ALL,
    chains: view.rows.some(r => r.scan !== '' || r.chain !== ''),
    bubble: view.rows.some(r => r.bubble !== ''),
    skillType: view.rows.some(r => r.skillType !== ''),
  });
  const setup = r => [levelName(r.skill), itemsLabel(r.items), chainsLabel(r.scan, r.chain), playValueName('bubble', r.bubble), skillTypeName(r.skillType)].join(' · ');
  const options = $derived([...levels.map(s => [s, levelName(s)]), ...(levels.length ? [[ALL, 'All levels']] : [])]);
</script>

{#if level !== null && options.length > 2}
  <div class="combo-levels">
    <Seg sm label="Skill level" value={level} onpick={v => (picked = v)} {options} />
  </div>
{/if}
{#if view.rows.length}
  <div class="table-wrap">
    <table class="breakdown combo-best">
      <thead>
        <tr>
          <th>#</th>
          {#if has.skill}<th>Skill</th>{/if}
          <th>Items</th>
          {#if has.chains}<th>Chains</th>{/if}
          {#if has.bubble}<th>Bubbles</th>{/if}
          {#if has.skillType}<th>Skill type</th>{/if}
          <th class="num">Rounds</th>
          {#if medals}
            <th class="num" title="Medals an hour of play">Medals/h</th>
          {:else}
            <th class="num" title="Expected net coins an hour of play: base coins with +Coin's bonus at its average, less what the items cost">Expected/h</th>
            <th class="num" title="How far the figure could be off by the luck of which rounds were played (one standard error). It does not cover changes over time: events, the game's own updates">±</th>
          {/if}
          <th class="num" title="Against the most played combination at the same skill level; coloured only when the difference is more than luck explains">Against most played</th>
        </tr>
      </thead>
      <tbody>
        {#each view.rows as r, i (r.key)}
          <tr class:few={!r.sure} title={setup(r)}>
            <td class="dim">{i + 1}</td>
            {#if has.skill}<td>{r.skill || '—'}</td>{/if}
            <td>
              <span class="bd-label">{itemsLabel(r.items)}</span>
              {#if r.best}<span class="tag">best</span>{/if}
              {#if r.most}<span class="tag">most played</span>{/if}
              {#if !r.sure}<span class="sub" title={medals ? `Under ${MIN_ROUNDS} rounds: too few to trust yet` : `Under ${MIN_ROUNDS} rounds or not yet known within ± 5 %: more rounds will settle it`}>{medals ? 'few rounds' : 'uncertain'}</span>{/if}
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
              title={r.change === null ? '' : `most played at ${levelName(r.skill).toLowerCase()}: ${setup(r.against)}, ${fmt(r.against.rounds)} rounds`}>
              {r.change === null ? '' : `${r.change > 0 ? '+' : ''}${pct(r.change)}`}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if !view.known}
    <p class="sub combo-note">No combination{level && level !== ALL ? ` at ${levelName(level).toLowerCase()}` : ''} has {fmt(MIN_ROUNDS)} rounds{medals ? '' : ' known within ± 5 %'} yet: these are the most played, best first.</p>
  {:else if view.total > view.rows.length}
    <p class="sub combo-note">{fmt(view.total - view.known)} of {fmt(view.total)} combinations have too few rounds to rank{view.known > TOP ? ` · the best ${TOP} of the ${fmt(view.known)} that do are shown` : ''}.</p>
  {/if}
{:else}
  <p class="dim">No rounds with {medals ? 'medals' : 'expected coins (known items and a time)'} in the filter.</p>
{/if}
