<!-- A top-bar button that opens a panel under it. Escape or a click elsewhere closes it. -->
<script>
  /** label: the button's content; children: the panel's. */
  let {label, children, id = undefined, title = undefined, btnClass = 'btn', align = 'right'} = $props();
  let open = $state(false);
  let root;

  export const close = () => (open = false);
  const outside = e => { if (open && !root.contains(e.target)) open = false; };
</script>

<svelte:window onclick={outside} onhashchange={close} onkeydown={e => { if (e.key === 'Escape') open = false; }} />

<div class="dropdown" bind:this={root}>
  <button type="button" class={btnClass} {id} {title} aria-haspopup="true" aria-expanded={String(open)} onclick={() => (open = !open)}>
    {@render label()}
  </button>
  <!-- A link inside closes it, as it leads elsewhere. -->
  {#if open}<div class="dropdown-panel" class:left={align === 'left'} role="presentation"
    onclick={e => { if (e.target.closest('a')) open = false; }}>{@render children()}</div>{/if}
</div>
