<!-- A Tsum's swatch, portrait and name; a button when onpick is given. -->
<script>
  import Avatar from './Avatar.svelte';

  let {id, name, color, onpick = null} = $props();
</script>

{#snippet cell()}
  <span class="tsum-cell"><i class="sw" style:background={color}></i><Avatar id={id || '?'} {name} />{name}</span>
{/snippet}

{#if onpick}
  <button type="button" class="linkish" title="Focus on this Tsum · Ctrl/⌘/Shift-click adds it to the comparison" onclick={onpick}>
    {@render cell()}
  </button>
{:else}
  {@render cell()}
{/if}
