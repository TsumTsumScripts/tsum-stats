<!-- Above the whole page, an open dialog included (lib/popup.js). -->
<script>
  import {popup} from '../lib/popup.js';
  import {toasts} from '../lib/ui.svelte.js';
</script>

{#each toasts as t (t.id)}
  <div class="toast" role="status" use:popup><div class="panel">{t.text}</div></div>
{/each}
