<!-- Script versions (health.go: DescribeHealth): how well each version, or each
     device, reads a round, and whether a version earns more or less than the
     one before it. A version is held against the latest earlier version on the
     same Tsums at the same skill levels with the same items, in expected net
     coins an hour (lib/expected.js), so a level-up or another item set is not
     taken for the script getting better or worse. The verdict needs the change
     to be more than the luck of which rounds were played explains. -->
<script>
  import Seg from '../../components/Seg.svelte';
  import {expErr, expRate} from '../../lib/expected.js';
  import {fmt, parseUTC, pct} from '../../lib/util.js';

  // health: the /health answer.
  let {health} = $props();
  let view = $state('versions');

  const day = new Intl.DateTimeFormat(undefined, {month: 'short', day: 'numeric'});
  const span = r => {
    const a = day.format(parseUTC(r.first)), b = day.format(parseUTC(r.last));
    return a === b ? a : `${a} – ${b}`;
  };
  const FIGURES = [['noTsum', 'Tsum'], ['score', 'score'], ['base', 'base coins'], ['final', 'final coins'], ['secs', 'time'], ['medals', 'medals']];
  const unreadTitle = r => FIGURES.filter(([k]) => r[k]).map(([k, name]) => `${name}: ${fmt(r[k])}`).join(' · ') || 'every figure read';

  /** The fewest rounds a version must share with an earlier one (the smaller side of each Tsum × skill × items, added up) to be held against it. */
  const SHARED = 20;
  /** Each version against the latest earlier one it shares SHARED rounds with on a Tsum × skill level × items, its change in expected coins. */
  const versions = $derived.by(() => {
    const cellsOf = new Map();
    for (const c of health.cells) {
      if (!c.expRounds) continue;
      if (!cellsOf.has(c.version)) cellsOf.set(c.version, new Map());
      cellsOf.get(c.version).set(`${c.tsum}|${c.skill}|${c.items}`, c);
    }
    const order = health.versions.map(v => v.key);
    return health.versions.map((v, i) => {
      const mine = cellsOf.get(v.key);
      let against = null, weight = 0, change = 0, base = 0, variance = 0, rounds = 0, known = true;
      for (let j = i - 1; j >= 0 && mine && against === null; j--) {
        const theirs = cellsOf.get(order[j]);
        if (!theirs) continue;
        weight = 0; change = 0; base = 0; variance = 0; rounds = 0; known = true;
        for (const [k, c] of mine) {
          const p = theirs.get(k);
          if (!p) continue;
          const r1 = expRate(c), r0 = expRate(p), e1 = expErr(c), e0 = expErr(p);
          if (r0 === null || r1 === null) continue;
          // Differences in coins a second, weighted by the smaller side, over the earlier rates the same way:
          // a cell whose rate is near 0 cannot blow up a ratio.
          const w = Math.min(c.expRounds, p.expRounds);
          weight += w;
          change += w * (r1 - r0);
          base += w * r0;
          rounds += c.expRounds;
          if (e1 === null || e0 === null) known = false;
          else variance += w * w * ((r1 * e1) ** 2 + (r0 * e0) ** 2);
        }
        if (weight >= SHARED) against = order[j];
      }
      if (against === null) weight = 0;
      const c = weight && base > 0 ? change / base : null, err = c !== null && known ? Math.sqrt(variance) / base : null;
      const verdict = c === null ? '' : err === null || Math.abs(c) <= 2 * err ? 'Same' : c < 0 ? 'Slower' : 'Faster';
      return {...v, against, change: c, err, matched: rounds, verdict};
    }).reverse();
  });
  const devices = $derived(health.devices);
  const unreadCls = r => (r.rounds && r.unread / r.rounds > 0.02 ? 'down' : '');
</script>

<div class="panel-head versions-head">
  <Seg sm label="By" value={view} onpick={v => (view = v)} options={[['versions', 'Script version'], ['devices', 'Device']]} />
</div>
<div class="table-wrap">
  <table class="breakdown">
    <thead>
      <tr>
        <th>{view === 'versions' ? 'Version' : 'Device'}</th>
        <th class="num">Rounds</th>
        <th class="num" title="Rounds with a figure the script could not read, left out of every other figure; red over 2 %">Unread</th>
        {#if view === 'versions'}
          <th class="num" title="Expected net coins an hour against the version before it, on the same Tsums at the same skill levels with the same items">Against the one before</th>
          <th class="num" title="How far the change could be off by the luck of which rounds were played (one standard error)">±</th>
          <th class="num" title="This version's rounds on Tsums, skill levels and items the earlier version also played">Compared rounds</th>
          <th></th>
        {/if}
        <th>Played</th>
      </tr>
    </thead>
    <tbody>
      {#each view === 'versions' ? versions : devices as r (r.key)}
        <tr>
          <td><span class="bd-label">{r.key || (view === 'versions' ? 'Unknown' : 'No device')}</span></td>
          <td class="num">{fmt(r.rounds)}</td>
          <td class="num {unreadCls(r)}" title={unreadTitle(r)}>{r.rounds ? pct(r.unread / r.rounds) : ''}</td>
          {#if view === 'versions'}
            <td class="num" class:up={r.verdict === 'Faster'} class:down={r.verdict === 'Slower'} title={r.against !== null ? `against ${r.against || 'Unknown'}` : `no earlier version shares ${SHARED} rounds on the same Tsums, skill levels and items`}>
              {r.change === null ? '' : `${r.change > 0 ? '+' : ''}${pct(r.change)}`}{#if r.against !== null}<span class="sub"> vs {r.against || 'Unknown'}</span>{/if}
            </td>
            <td class="num dim">{r.err === null ? '' : `± ${pct(r.err)}`}</td>
            <td class="num dim">{r.matched ? fmt(r.matched) : ''}</td>
            <td>{#if r.verdict && r.verdict !== 'Same'}<span class="tag">{r.verdict}</span>{:else if r.verdict}<span class="sub">within luck</span>{/if}</td>
          {/if}
          <td class="dim">{span(r)}</td>
        </tr>
      {:else}
        <tr><td class="empty-row" colspan="8">No rounds.</td></tr>
      {/each}
    </tbody>
  </table>
</div>
