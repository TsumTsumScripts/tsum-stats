<!-- The Data dialog: what is stored, where it is read from, and importing CSV files. -->
<script>
  import {api, fmt} from '../lib/util.js';
  import {toast} from '../lib/ui.svelte.js';

  let {upload, overrideText} = $props();

  let dialog, picker;
  let status = $state.raw(null);

  export async function open() {
    dialog.showModal();
    status = await api('status');
  }
  const close = () => dialog.close();

  async function rescan() {
    const res = await fetch('/api/stats/rescan', {method: 'POST'}).then(r => r.json());
    if (!res.files) toast('Nothing new in the import folders');
  }
</script>

<dialog bind:this={dialog}>
  <div class="panel">
    <h2>Data</h2>
    <div class="sub">
      {#if status}
        <p style="margin:0 0 8px">{fmt(status.rounds)} rounds stored.
          {status.eventsAddr ? `Listening for script events on ${status.eventsAddr}${status.token ? ' (token required)' : ''}.` : 'Not listening for script events.'}</p>
        {#if status.override && !status.override.unused}<p style="margin:0 0 8px">{overrideText(status)}</p>{/if}
        {#if status.importDirs.length}
          <div>Scanning for CSV files in:<ul>{#each status.importDirs as d (d)}<li><code>{d}</code></li>{/each}</ul></div>
        {:else}
          <p style="margin:0">No import folders. Start the server with --import-dir to watch one.</p>
        {/if}
      {/if}
    </div>
    <div class="filter-actions">
      <button type="button" class="btn primary" onclick={() => picker.click()}>Import CSV files…</button>
      <button type="button" class="btn" onclick={rescan}>Rescan folders</button>
      <button type="button" class="btn" onclick={close}>Close</button>
    </div>
    <input type="file" accept=".csv" multiple hidden bind:this={picker} onchange={e => upload(e.target.files)}>
    <p class="sub" style="margin:0">Drop <code>stats_*.csv</code> or <code>tsum_list_*.csv</code> files anywhere on the page to import them.
      <a href="#/help" onclick={close}>How to get data in</a></p>
  </div>
</dialog>
