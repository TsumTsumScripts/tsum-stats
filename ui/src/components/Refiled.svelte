<!-- The note wherever a figure includes rounds counted at another skill level
     than recorded (the skill level correction, lib/skillFix.js): how many,
     which, why when the site knows (the local site's and a snapshot's
     skill-fixes), and the switch to the figures as recorded (lib/levels.svelte.js).
     Nothing shows when nothing was re-filed and the correction is on. -->
<script>
  import {levels, refiledTotals, setRecorded} from '../lib/levels.svelte.js';
  import {fmt, parseUTC} from '../lib/util.js';

  // refiled: a summary's [{tsum, from, to, rounds}]. fixes: skill-fixes rows, [] where the site has none.
  // nameOf: a Tsum's name; one: the page is one Tsum's, so the lines leave its name out.
  let {refiled = [], fixes = [], nameOf = id => id, one = false} = $props();

  const total = $derived(refiledTotals(refiled).rounds);
  const rows = $derived([...(refiled ?? [])].sort((a, b) => b.rounds - a.rounds));
  const MAX = 8;
  const day = new Intl.DateTimeFormat(undefined, {month: 'short', day: 'numeric'});
  const span = f => {
    const a = day.format(parseUTC(f.first)), b = day.format(parseUTC(f.last));
    return a === b ? a : `${a} – ${b}`;
  };
  /** Why one run moved, from its skill-fixes row. */
  function why(f) {
    const what = f.medals ? 'medals' : 'coins';
    const held = `${fmt(f.mid)} against ${fmt(f.againstMid)} a round`;
    const sure = f.confidence === 'high' ? 'a close match' : 'a fair match';
    if (f.rule === 'trusted') {
      return `a run of ${fmt(f.rounds)} rounds, ${span(f)}: the same ${what} as this device's later rounds at skill ${f.to}, whose level the script read from the Tsum List (${held}; ${sure})`;
    }
    return `a run of ${fmt(f.rounds)} rounds, ${span(f)}: this device's recorded level went ${f.from < f.to ? 'down and back up' : 'up and back down'}, which a Tsum's level never does, and their ${what} match its skill ${f.to} rounds (${held}; ${sure})`;
  }
  const reasons = r => fixes.filter(f => f.tsum === r.tsum && String(f.from) === r.from && String(f.to) === r.to);
</script>

{#if total || levels.recorded}
  <div class="refiled" class:off={levels.recorded}>
    <span class="refiled-text">
      <span class="refiled-mark" aria-hidden="true">⇄</span>
      {#if levels.recorded}
        Skill levels <b>as recorded</b>{#if total}: the correction would count <b>{fmt(total)}</b> {total === 1 ? 'round' : 'rounds'} at another level{/if}
      {:else}
        <b>{fmt(total)}</b> {total === 1 ? 'round' : 'rounds'} counted at another skill level than recorded
      {/if}
    </span>
    <button type="button" class="btn refiled-switch" aria-pressed={levels.recorded}
      title={levels.recorded ? 'Count each round at the level the skill level correction finds most likely' : 'Count each round at the skill level it was recorded with, to compare'}
      onclick={() => setRecorded(!levels.recorded)}>{levels.recorded ? 'Apply the correction' : 'Show as recorded'}</button>
    {#if total}
      <details>
        <summary>Which rounds</summary>
        <ul>
          {#each rows.slice(0, MAX) as r (`${r.tsum}|${r.from}|${r.to}`)}
            <li>
              {#if !one}<b>{nameOf(r.tsum)}</b>:{' '}{/if}{fmt(r.rounds)} {r.rounds === 1 ? 'round' : 'rounds'} recorded as skill {r.from} {levels.recorded ? 'would count' : 'counted'} as skill {r.to}
              {#each reasons(r) as f (`${f.player}|${f.first}`)}<div class="sub">{why(f)}</div>{/each}
            </li>
          {/each}
          {#if rows.length > MAX}<li class="sub">and {fmt(rows.length - MAX)} more</li>{/if}
        </ul>
        <div class="sub">A level typed into the script can be left wrong for a stretch; one read from the Tsum List (script 6.0a19 and later) is trusted. The recorded level is kept as it is.</div>
      </details>
    {/if}
  </div>
{/if}

<style>
  .refiled { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px 12px; padding: 8px 14px; border-radius: 12px;
    background: var(--well); color: var(--muted); font-size: 13px; }
  .refiled.off { box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--accent-a) 45%, transparent); }
  .refiled b { color: var(--ink); font-variant-numeric: tabular-nums; }
  .refiled-mark { font-weight: 800; color: var(--accent-a); margin-right: 4px; }
  .refiled-switch { padding: 2px 10px; font-size: 12px; }
  details { flex: 1 1 100%; }
  summary { cursor: pointer; width: fit-content; }
  ul { margin: 6px 0; padding-left: 20px; }
  li { margin: 3px 0; }
</style>
