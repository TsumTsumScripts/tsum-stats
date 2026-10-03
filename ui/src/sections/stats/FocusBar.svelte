<!-- The bar over the charts while Tsums are picked: who is in view, and the ways back out. -->
<script>
  import TsumChip from '../../components/TsumChip.svelte';
  import {debounce} from '../../lib/util.js';

  let {picked, canBack, nameOf, colorOf, addTsum, dropTsum, matchTsum, clear} = $props();

  let box;
  function tryAdd() {
    const id = matchTsum(box.value);
    if (!id) return;
    box.value = '';
    addTsum(id);
  }
  const addSoon = debounce(tryAdd, 250);
</script>

<div class="panel focus-bar">
  {#if canBack}
    <button type="button" class="btn" title="The Tsums you had before (the browser's Back does the same)" onclick={() => history.back()}>← Back</button>
  {/if}
  <span class="sub focus-label">{picked.length > 1 ? `Comparing ${picked.length}` : 'Focused on'}</span>
  <span class="focus-tsums">
    {#each picked as id (id)}
      <TsumChip {id} name={nameOf(id)} color={colorOf(id)} onremove={picked.length > 1 ? () => dropTsum(id) : null} />
    {/each}
  </span>
  <input class="search focus-add" list="tsum-options" placeholder="+ Compare with…" autocomplete="off" aria-label="Add a Tsum to compare"
    bind:this={box} onchange={tryAdd} oninput={addSoon}>
  <span class="spacer"></span>
  <button type="button" class="btn primary" title="Show every Tsum again (Esc)" onclick={clear}>✕ All Tsums</button>
</div>
