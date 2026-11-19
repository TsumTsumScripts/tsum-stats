<!-- Head to head: a row per figure, a column per picked Tsum, the best in each
     row marked and a bar under each figure scaled to the row's largest. -->
<script>
  import Avatar from '../../components/Avatar.svelte';
  import {cap, fmt, fmtDuration, fmtRate, pct} from '../../lib/util.js';
  import {differs, expErr, expHour} from '../../lib/expected.js';

  // rows: the Tsum table's rows (each with .m, its medal figures). approx marks
  // the median and 90th percentile as estimates (the global site's).
  let {rows, picked, coins, nameOf, colorOf, focusOn, dropTsum, approx = false} = $props();

  const perHour = r => (r?.coinsPerSec == null ? null : r.coinsPerSec * 3600);

  /** Half the middle half's width over the median: how far half the rounds land from it (Insights' consistency). */
  const steadiness = r => (r?.q1Coins != null && r.q3Coins != null && r.medianCoins ? (r.q3Coins - r.q1Coins) / 2 / Math.abs(r.medianCoins) : null);

  const card = $derived.by(() => {
    const byId = new Map(rows.map(r => [r.tsum, r]));
    const u = coins === 'medals' ? 'medals' : 'coins', U = cap(u);
    // The primary stat's own rows: medals take their colour, coins stay plain.
    const own = coins === 'medals' ? 'medal' : '';
    // One row per idea. [label, value(row), format, which end wins: 'high', 'low' or none, class, sure(winner, runner-up)].
    // Only the rows with a winner count towards "best in"; expected coins only when the gap is more than luck explains.
    const figures = [
      ['Rounds', r => r.rounds, fmt],
      ['Expected coins per hour', expHour, v => fmt(v), 'high', 'coin', differs],
      ['± (luck of the rounds played)', r => expErr(r), v => (v === null ? '' : `± ${pct(v)}`)],
      [`${U} per second`, r => r.coinsPerSec, fmtRate, '', own],
      [`Average ${u}`, r => r.avgCoins, fmt, '', own],
      [`${approx ? '≈ ' : ''}Median ${u}`, r => r.medianCoins, fmt, '', own],
      ['Consistency (lower is steadier)', steadiness, v => `± ${pct(v)}`, 'low'],
      ['Average round', r => r.avgSeconds, fmtDuration],
      ['Average score', r => r.avgScore, fmt],
      ...(coins !== 'medals' ? [
        ['Medals per hour', r => perHour(r.m), fmt, 'high', 'medal'],
        ['Rounds that earn medals', r => (r.m?.rounds ? r.m.earnedRounds / r.m.rounds : null), pct, '', 'medal'],
      ] : []),
    ];
    const wins = new Map(picked.map(id => [id, 0]));
    let contests = 0;
    const body = [];
    for (const [label, get, format, better, cls, sure] of figures) {
      const vals = picked.map(id => (byId.has(id) ? get(byId.get(id)) ?? null : null));
      const nums = vals.filter(v => v !== null);
      if (!nums.length) continue;
      const max = Math.max(0, ...nums);
      let best = null;
      if (better && nums.length > 1) {
        const order = picked.map((id, i) => ({row: byId.get(id), v: vals[i]})).filter(x => x.v !== null)
          .sort((a, b) => (better === 'high' ? b.v - a.v : a.v - b.v));
        if (!sure || sure(order[0].row, order[1].row)) best = order[0].v;
        contests++;
      }
      body.push({label, cells: vals.map((v, i) => {
        const top = best !== null && v === best;
        if (top) wins.set(picked[i], wins.get(picked[i]) + 1);
        return {text: format(v), cls: ['num', cls || '', top ? 'best' : ''].join(' ').trim(),
          bar: v !== null && max > 0 && better ? (v / max) * 100 : null};
      })});
    }
    const most = Math.max(...wins.values());
    const heads = picked.map(id => ({id, leader: wins.get(id) === most && most > 0,
      note: byId.has(id) ? `best in ${wins.get(id)} of ${contests}` : 'no rounds in the filter'}));
    return {heads, body};
  });
</script>

<div class="table-wrap">
  <table class="versus">
    <thead>
      <tr>
        <th></th>
        {#each card.heads as h (h.id)}
          <th class={h.leader ? 'leader' : null}>
            <span class="versus-tsum">
              <button type="button" class="linkish" title="{nameOf(h.id)} · focus on it" onclick={e => focusOn(h.id, e)}>
                <span class="tsum-cell">
                  <i class="sw" style:background={colorOf(h.id)}></i><Avatar id={h.id} name={nameOf(h.id)} />
                  <span class="versus-name">{nameOf(h.id) || 'Not identified'}</span>
                </span>
              </button>
              <button type="button" class="linkish dim" title="Take it out of the comparison" onclick={() => dropTsum(h.id)}>×</button>
            </span>
            <span class="sub">{h.note}</span>
          </th>
        {/each}
      </tr>
    </thead>
    <tbody>
      {#each card.body as row (row.label)}
        <tr>
          <th scope="row">{row.label}</th>
          {#each row.cells as c, i (i)}
            <td class={c.cls}><span>{c.text}</span>{#if c.bar !== null}<i class="bar" style:width="{c.bar}%"></i>{/if}</td>
          {/each}
        </tr>
      {/each}
    </tbody>
  </table>
</div>
