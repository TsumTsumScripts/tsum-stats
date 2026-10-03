<!-- A picked Tsum as a chip; with onremove it is a button that drops it. -->
<script>
  import Avatar from './Avatar.svelte';

  let {id, name, color, onremove = null} = $props();
</script>

{#snippet body()}
  <span class="tsum-cell"><i class="sw" style:background={color}></i><Avatar {id} {name} /><span class="chip-name">{name || id}</span></span>
{/snippet}

{#if onremove}
  <button type="button" class="chip" title="Remove {name || id}" onclick={onremove}>{@render body()}<span aria-hidden="true">×</span></button>
{:else}
  <span class="chip" title={name || id}>{@render body()}</span>
{/if}
