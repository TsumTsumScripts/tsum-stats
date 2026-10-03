<!-- A panel with a title row. tools go on the right of the title; with
     expandable, a button there blows the panel up to fill the window. -->
<script>
  import {expand} from '../lib/ui.svelte.js';

  let {id, title, sub = '', class: cls = '', expandable = true, hidden = false, tools, children} = $props();
  const me = Symbol();
  const open = $derived(expand.open === me);
  let node;
  let keep = $state(0);

  function toggle() {
    if (open) {
      expand.open = null;
      return;
    }
    // A spacer keeps the panel's place so the page below does not jump.
    keep = node.offsetHeight;
    expand.open = me;
  }
</script>

<div class="panel {cls}" class:expanded={open} {id} {hidden} bind:this={node}>
  <div class="panel-head">
    <div><h2>{title}</h2>{#if sub}<span class="sub">{sub}</span>{/if}</div>
    {#if tools || expandable}
      <div class="toggles">
        {@render tools?.()}
        {#if expandable}
          <button type="button" class="btn expand-btn" aria-pressed={String(open)} title={open ? 'Close the big view (Esc)' : 'Expand'}
            onclick={toggle}>{open ? '✕' : '⤢'}</button>
        {/if}
      </div>
    {/if}
  </div>
  {@render children()}
</div>
{#if open}<div style:height="{keep}px"></div>{/if}
