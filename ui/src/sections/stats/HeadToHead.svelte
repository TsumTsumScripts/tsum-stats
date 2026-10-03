<!-- Head to head: a row per figure, a column per picked Tsum, the best in each
     row marked and a bar under each figure scaled to the row's largest. -->
<script>
  import Avatar from '../../components/Avatar.svelte';
  import {cap, fmt, fmtDuration, fmtRate, pct} from '../../lib/util.js';

  // rows: the Tsum table's rows (each with .m, its medal figures).
  let {rows, picked, coins, nameOf, colorOf, focusOn, dropTsum} = $props();

  const perHour = r => (r?.coinsPerSec == null ? null : r.coinsPerSec * 3600);

  const card = $derived.by(() => {
    const byId = new Map(rows.map(r => [r.tsum, r]));
    const u = coins === 'medals' ? 'medals' : 'coins', U = cap(u);
    // [label, value(row), format, which end wins: 'high', 'low' or none, class]
    const figures = [
      ['Rounds', r => r.rounds, fmt],
      [`${U} per second`, r => r.coinsPerSec, fmtRate, 'high'],
      [`${U} per hour`, perHour, fmt, 'high'],
      [`Average ${u}`, r => r.avgCoins, fmt, 'high'],
      [`Median ${u}`, r => r.medianCoins, fmt, 'high'],
      [`Lowest ${u}`, r => r.minCoins, fmt, 'high'],
      [`Highest ${u}`, r => r.maxCoins, fmt, 'high'],
      ['One in ten over', r => r.p90Coins, fmt, 'high'],
      ['Spread (lower is steadier)', r => r.stdCoins, fmt, 'low'],
      [`Total ${u}`, r => r.coins, fmt],
      ['Average round', r => r.avgSeconds, fmtDuration, 'low'],
      ['Average score', r => r.avgScore, fmt, 'high'],
      ...(coins !== 'medals' ? [
        ['Medals per hour', r => perHour(r.m), fmt, 'high', 'medal'],
        ['Average medals', r => r.m?.avgCoins, fmt, 'high', 'medal'],
        ['Rounds with medals', r => (r.m && r.rounds ? r.m.rounds / r.rounds : null), pct, 'high', 'medal'],
      ] : []),
    ];
    const wins = new Map(picked.map(id => [id, 0]));
    const body = [];
    for (const [label, get, format, better, cls] of figures) {
      const vals = picked.map(id => (byId.has(id) ? get(byId.get(id)) ?? null : null));
      const nums = vals.filter(v => v !== null);
      if (!nums.length) continue;
      const max = Math.max(0, ...nums);
      const best = better && nums.length > 1 ? (better === 'high' ? Math.max(...nums) : Math.min(...nums)) : null;
      body.push({label, cells: vals.map((v, i) => {
        const top = best !== null && v === best;
        if (top) wins.set(picked[i], wins.get(picked[i]) + 1);
        return {text: format(v), cls: ['num', cls || '', top ? 'best' : ''].join(' ').trim(),
          bar: v !== null && max > 0 ? (v / max) * 100 : null};
      })});
    }
    const most = Math.max(...wins.values());
    const heads = picked.map(id => ({id, leader: wins.get(id) === most && most > 0,
      note: byId.has(id) ? `best in ${wins.get(id)}` : 'no rounds in the filter'}));
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
