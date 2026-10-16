<!-- A published snapshot's footnote: when it was taken. -->
<script>
  import {onMount} from 'svelte';
  import {api, fmt} from '../lib/util.js';

  let status = $state.raw(null);
  onMount(async () => { status = await api('status'); });

  const day = new Intl.DateTimeFormat(undefined, {dateStyle: 'medium'});
</script>

<p class="global-note" title="A copy of the player's stats taken at that time; it does not update by itself.">
  {#if status}Snapshot · {day.format(new Date(status.generatedAt))} · {fmt(status.rounds)} rounds{:else}Snapshot{/if}
</p>
