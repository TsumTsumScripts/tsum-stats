<!-- With root() instead of from(), copies every section under it as one tall card.
     Copies a stat container to the clipboard as a compact image (lib/card.js).
     from() is the element whose figures the card shows; the page's card
     context adds the Tsum, the filters and the rounds. -->
<script>
  import {cardInfo, copyCard} from '../lib/card.js';
  import {shared} from '../lib/ui.svelte.js';
  import {tsumName} from '../lib/util.js';

  let {title, sub = '', from, root, label = '', cls = ''} = $props();
  const info = cardInfo();
  let busy = $state(false);

  async function copy() {
    if (!info || busy) return;
    busy = true;
    const i = info();
    const nameOf = id => tsumName(shared.catalog, id, i.build || 'global');
    await copyCard({title, sub, from: from?.(), root: root?.(), info: i, nameOf, file: title.toLowerCase().replace(/\W+/g, '-')});
    busy = false;
  }
</script>

{#if info}
  <button type="button" class="btn copy-btn {cls}" title="Copy as an image" aria-label="Copy {title} as an image" disabled={busy} onclick={copy}>
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" fill="none" stroke="currentColor" stroke-width="2"/></svg>{#if label}<span class="copy-label">{label}</span>{/if}
  </button>
{/if}
