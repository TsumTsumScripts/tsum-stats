<!-- The Tsum page's list of Tsums, ranked by what they earn an hour of play:
     the best coin earners (expected net coins an hour, lib/expected.js) or the
     best medal earners (medals an hour, a round that earned none counting as
     0). Each row is a button to the Tsum's page, with a bar against the first
     and, where the figure is not to be trusted yet (too few players on the
     global site), a flag in words. -->
<script>
  import Avatar from '../../components/Avatar.svelte';
  import {fmt} from '../../lib/util.js';

  // rows: [{tsum, v (an hour), rounds, flag ('' or a few words)}], best first. unit: 'coins' or 'medals'.
  let {rows, unit, nameOf, onpick, empty = 'No Tsum has enough rounds yet.'} = $props();

  const top = $derived(rows[0]?.v || 0);
  const what = $derived(unit === 'medals' ? 'medals an hour' : 'expected coins an hour');
</script>

{#if rows.length}
  <ol class="earners" class:medal={unit === 'medals'}>
    {#each rows as r, i (r.tsum)}
      <li>
        <button type="button" class="btn quiet earner" onclick={() => onpick(r.tsum)}
          title="{nameOf(r.tsum)}: {fmt(r.v)} {what} over {fmt(r.rounds)} rounds{r.flag ? ` · ${r.flag}` : ''}">
          <span class="earner-rank">{i + 1}</span>
          <Avatar id={r.tsum} name={nameOf(r.tsum)} />
          <span class="earner-name">
            <span class="tile-name">{nameOf(r.tsum)}</span>
            <span class="sub">{fmt(r.rounds)} rounds{#if r.flag} · {r.flag}{/if}</span>
          </span>
          <span class="earner-rate">
            <span class="bd-bar"><span style:width="{top > 0 ? Math.max(0, (r.v / top) * 100) : 0}%" class:best={i === 0}></span></span>
            <b>{fmt(r.v)}</b><span class="sub">/h</span>
          </span>
        </button>
      </li>
    {/each}
  </ol>
{:else}
  <div class="empty-state">{empty}</div>
{/if}
