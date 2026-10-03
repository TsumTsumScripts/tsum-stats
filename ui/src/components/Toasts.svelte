<script>
  import {toasts} from '../lib/ui.svelte.js';
</script>

{#each toasts as t (t.id)}
  <div class="toast" role="status"><div class="panel">{t.text}</div></div>
{/each}
