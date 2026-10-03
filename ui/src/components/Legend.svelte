<!-- A chart's legend: swatch, portrait and name, and an optional value. -->
<script>
  import Avatar from './Avatar.svelte';

  let {items, column = false} = $props();
</script>

{#if items.length}
  <div class="legend" class:column>
    {#each items as item, i (i)}
      <span class="lg-item">
        <i class="sw" style:background={item.color}></i>
        {#if item.id}<Avatar id={item.id} name={item.label} />{/if}
        <span>{item.label}</span>
        {#if item.value}<b>{item.value}</b>{/if}
      </span>
    {/each}
  </div>
{/if}
