<!-- The Tsums out in the last 30 days on either build, newest first, each a
     link to its Tsum page. The days are the catalog's `released`, the day the
     game's files first had the Tsum (general-automation-app's stats-catalog.js).
     Nothing shows when there are none. -->
<script>
  import Avatar from './Avatar.svelte';
  import {shared} from '../lib/ui.svelte.js';
  import {buildLabel, fmt, tsumName} from '../lib/util.js';

  // build: whose names to show; current: the Tsum on show, marked;
  // played: id → rounds; onpick(id): instead of following the link.
  let {build = 'global', current = '', played = new Map(), onpick = null} = $props();

  const DAYS = 30;
  const isoDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const since = (d => (d.setDate(d.getDate() - DAYS), isoDay(d)))(new Date());
  const dayFmt = new Intl.DateTimeFormat(undefined, {month: 'short', day: 'numeric'});
  const dayLabel = day => dayFmt.format(new Date(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)));

  // Each Tsum with its builds' days in the window, latest first.
  const recent = shared.catalog.tsums.flatMap(t => {
    const out = Object.entries(t.released ?? {}).filter(([, day]) => day >= since).sort(([, a], [, b]) => b.localeCompare(a));
    return out.length ? [{id: t.id, out, last: out[0][1]}] : [];
  }).sort((a, b) => b.last.localeCompare(a.last) || a.id.localeCompare(b.id));

  const tsumPage = id => `#/tsum?id=${encodeURIComponent(id)}`;
  const outText = out => out.map(([b, day]) => `${buildLabel(b)} ${dayLabel(day)}`).join(' · ');
  function click(e, id) {
    if (!onpick || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
    e.preventDefault();
    onpick(id);
  }
</script>

{#if recent.length}
  <div class="panel new-tsums">
    <div class="panel-head"><div><h2>New Tsums</h2><span class="sub">added to the game in the last {DAYS} days, INTL and JP · click one to see its page</span></div></div>
    <div class="tsum-grid">
      {#each recent as t (t.id)}
        {@const name = tsumName(shared.catalog, t.id, build)}
        {@const rounds = played.get(t.id)}
        <a class="btn tsum-tile" href={tsumPage(t.id)} aria-current={t.id === current ? 'page' : undefined}
          title="{name} · out on {outText(t.out)} · {rounds ? `${fmt(rounds)} rounds` : 'no rounds yet'}" onclick={e => click(e, t.id)}>
          <Avatar id={t.id} {name} />
          <span class="tile-text">
            <span class="tile-name">{name}</span>
            <span class="sub">{#each t.out as [b, day] (b)}<span class="tag">{buildLabel(b)} {dayLabel(day)}</span>{/each} {rounds ? `${fmt(rounds)} rounds` : 'No rounds yet'}</span>
          </span>
        </a>
      {/each}
    </div>
  </div>
{/if}
