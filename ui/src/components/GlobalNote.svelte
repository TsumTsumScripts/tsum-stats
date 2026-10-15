<!-- The top bar's note on the global site, in place of the live devices: when
     its figures were last worked out, how many players they come from, and
     how to add yours. -->
<script>
  import {onMount} from 'svelte';
  import {api, fmt} from '../lib/util.js';

  // The website's page about tsum-stats, which says how to contribute.
  const CONTRIBUTE = 'https://tsumtsum.gapscripts.app/stats-site';

  let status = $state.raw(null);
  onMount(async () => { status = await api('status').catch(() => null); });

  const when = new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC'});
</script>

<div class="live global-note">
  <span class="pill" title="Rounds from every player who sends them in through tsum-stats, worked out again every hour; contributors are those who sent rounds in the last 30 days. A round counts on the UTC day it began.">
    {#if status}Global · updated {when.format(new Date(status.generatedAt))} UTC · {fmt(status.contributors)} {status.contributors === 1 ? 'contributor' : 'contributors'} · {fmt(status.rounds)} {status.rounds === 1 ? 'round' : 'rounds'}{:else}Global stats{/if}
  </span>
  <a class="pill" href={CONTRIBUTE} title="How to add your rounds from tsum-stats">Contribute your rounds →</a>
</div>
