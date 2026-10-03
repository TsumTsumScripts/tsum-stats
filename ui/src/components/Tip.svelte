<!-- The chart tooltip, beside the pointer and kept inside the window. -->
<script>
  import {tip} from '../lib/ui.svelte.js';

  const PAD = 14;
  let w = $state(0), h = $state(0);
  let innerWidth = $state(0), innerHeight = $state(0);
  const left = $derived(Math.max(8, tip.x + PAD + w > innerWidth - 8 ? tip.x - w - PAD : tip.x + PAD));
  const top = $derived(Math.max(8, tip.y + PAD + h > innerHeight - 8 ? tip.y - h - PAD : tip.y + PAD));
</script>

<svelte:window bind:innerWidth bind:innerHeight />

{#if tip.lines}
  <div class="tip" style:left="{left}px" style:top="{top}px" bind:offsetWidth={w} bind:offsetHeight={h}>
    {#each tip.lines as line, i (i)}
      {#if i}<br>{/if}
      {#each line as part, j (j)}
        {#if typeof part === 'string'}{part}
        {:else if part.sw}<i class="sw" style:background={part.sw}></i>
        {:else if part.dim !== undefined}<span class="dim">{part.dim}</span>
        {:else}<b>{part.b}</b>{/if}
      {/each}
    {/each}
  </div>
{/if}
