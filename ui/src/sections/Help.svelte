<!-- The Help section: how to get data in. The text is static; the script fills
     in what only the server knows -- the address to paste, the devices
     connected, what is stored so far. -->
<script>
  import {onMount} from 'svelte';
  import {shared, toast} from '../lib/ui.svelte.js';
  import {api, fmt, isOnline} from '../lib/util.js';

  let {hidden, initial} = $props();

  // "127.0.0.1:21025" → "21025"
  const portOf = addr => addr.slice(addr.lastIndexOf(':') + 1);

  let status = $state.raw(null);
  let listsText = $state('…');
  const online = $derived(shared.devices.filter(isOnline));
  const port = $derived(status?.eventsAddr ? portOf(status.eventsAddr) : '');

  // Import from devices: ticked serials survive a Refresh; null until the first list, which ticks every ready device.
  let pull = $state.raw({adb: true, devices: [], error: '', loading: true});
  let picked = $state(null);
  let pulling = $state(false);
  let pullMsg = $state([]);
  let refreshing = $state(false);

  function scrollTo(topic) {
    const target = topic && document.getElementById(`help-${topic}`);
    if (target) target.scrollIntoView({behavior: 'smooth', block: 'start'});
  }

  async function loadPullDevices() {
    refreshing = true;
    try {
      pull = {...(await api('adb/devices')), loading: false};
      picked ??= pull.devices.filter(d => d.state === 'device').map(d => d.serial);
    } catch {
      pull = {adb: true, devices: [], error: '', loading: false, failed: true};
    } finally {
      refreshing = false;
    }
  }
  const pullNote = $derived(!pull.adb ? 'Tsum Tsum Stats could not find adb. Install Android platform-tools, or start it with --adb PATH.'
    : pull.error ? `adb: ${pull.error}`
    : !pull.devices.length && !pull.loading ? 'No devices found. Start the emulator, then press Refresh.' : '');

  function toggle(serial, on) {
    picked = on ? [...(picked ?? []), serial] : (picked ?? []).filter(s => s !== serial);
  }
  const ready = $derived(pull.devices.filter(d => d.state === 'device' && picked?.includes(d.serial)).map(d => d.serial));

  // "emulator-5554: 3 files, 120 rounds, 1 Tsum list, 2 unchanged"
  function describePull(d) {
    if (d.error) return `${d.serial}: ${d.error}`;
    const r = d.result;
    const bits = [`${fmt(r.rounds)} rounds`];
    if (r.lists) bits.push(`${r.lists} Tsum list${r.lists > 1 ? 's' : ''}`);
    if (r.unchanged) bits.push(`${r.unchanged} unchanged`);
    if (r.errors?.length) bits.push(`${r.errors.length} failed`);
    return `${d.serial}: ${d.copied} file${d.copied === 1 ? '' : 's'}, ${bits.join(', ')}`;
  }

  async function importFromDevices() {
    const serials = ready;
    pulling = true;
    pullMsg = ['Copying and importing…'];
    try {
      const res = await fetch('/api/stats/adb/import', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({serials})});
      const body = await res.json();
      if (!res.ok) throw new Error(body.message || res.status);
      pullMsg = body.devices.map(describePull);
      const rounds = body.devices.reduce((n, d) => n + (d.result?.rounds || 0), 0);
      toast(`Imported ${fmt(rounds)} rounds from ${serials.length} device${serials.length > 1 ? 's' : ''}.`);
      refresh();
    } catch (err) {
      pullMsg = [`Import failed: ${err.message}`];
    } finally {
      pulling = false;
    }
  }

  async function copyAddr(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied. Paste it into the GAP app: Settings › Script events.');
    } catch {
      toast('Could not copy. Select the address and copy it by hand.');
    }
  }

  export async function refresh() {
    try {
      const [s, intl, jp] = await Promise.all([api('status'), api('owned', {build: 'global'}), api('owned', {build: 'jp'})]);
      status = s;
      const lists = [['INTL', intl.list], ['JP', jp.list]].filter(([, l]) => l).map(([b, l]) => `${b} · ${fmt(l.tsums)} Tsums`);
      listsText = lists.length ? lists.join(' · ') : 'None yet';
    } catch { /* the page keeps what it had */ }
  }

  export function shown(params) {
    refresh();
    scrollTo(params.topic);
  }

  onMount(() => {
    refresh();
    loadPullDevices();
    scrollTo(initial.topic);
  });
</script>

<section id="help" class="stack help" {hidden}>
  <div class="panel">
    <h2>Getting your data into Tsum Tsum Stats</h2>
    <p class="lead">Tsum Tsum Stats fills itself from the Tsum script. There are three ways in, and you can use all of them:</p>
    <div class="help-status">
      <a class="status-tile" href="#/help?topic=live">
        <span class="label">Live stats</span><b>{online.length ? `${online.length} connected` : 'Not connected'}</b>
        <span class="sub">Rounds appear the moment they end</span>
      </a>
      <a class="status-tile" href="#/help?topic=rounds">
        <span class="label">Round stats files</span><b>{status ? (status.rounds ? `${fmt(status.rounds)} rounds` : 'No rounds yet') : '…'}</b>
        <span class="sub">Every round the script played, from its CSVs</span>
      </a>
      <a class="status-tile" href="#/help?topic=tsums">
        <span class="label">Tsum list</span><b>{listsText}</b><span class="sub">Which Tsums you own, for the Catalog</span>
      </a>
    </div>
  </div>

  <div class="panel" id="help-live">
    <div class="panel-head"><h2>1 · Live stats: connect the GAP app</h2><span class="sub">Settings › Script events</span></div>
    <div class="help-cols">
      <div>
        <p>The GAP app can send each round to Tsum Tsum Stats as it finishes, so the Stats page updates by itself. Paste this address into the app:</p>
        <div class="addr-box">
          <span class="sub">Emulator on this computer (BlueStacks, MuMu, LDPlayer, Nox…)</span>
          <div class="addr">
            <code>{!status ? '10.0.2.2:21025' : port ? `10.0.2.2:${port}` : 'Not listening'}</code>
            <button type="button" class="btn primary" disabled={status && !port} onclick={() => copyAddr(`10.0.2.2:${port || '21025'}`)}>Copy</button>
          </div>
        </div>
        <ol class="steps">
          <li>In the emulator, open the <b>GAP</b> app and tap <b>Settings</b> in the bottom bar.</li>
          <li>Scroll down to <b>Script events</b>. Paste the address into the second box, the one that shows <code>192.168.1.50:21025, another:21025</code> when empty.</li>
          <li>Optional: type a name in the first box, such as <code>tsum-left</code>. Leave it empty to use the name shown in grey. That name is what the device is called here.</li>
          <li>Tap <b>Apply</b>. The line under it should say <b>Dialling 1 of 1</b>. It shows <b>Not reaching</b> for a few seconds while it connects.</li>
        </ol>
        <p>The device then appears at the top right of every page:
          <span class="live-inline">
            {#if online.length}
              <span class="pill online"><span class="dot"></span>{online.map(d => d.device).join(', ')}: connected now</span>
            {:else}
              <span class="pill"><span class="dot"></span>No devices yet</span>
            {/if}
          </span>
        </p>
        <p class="sub">The app remembers the address, and reconnects by itself when Tsum Tsum Stats or the emulator restarts.
          Live stats only carry rounds that end while connected; older rounds come from the <a href="#/help?topic=rounds">round stats files</a>.
          Keep <b>Record round stats</b> on too: without it the script does not read the score page, and live rounds arrive with no score or coins.</p>
      </div>
      <figure class="shot"><img src="img/help/app-script-events.png" alt="The GAP app's Settings, Script events section, with 10.0.2.2:21025 in the address box and 'Dialling 1 of 1' under Apply" width="540" height="455" loading="lazy"><figcaption>GAP app › Settings › Script events, connected</figcaption></figure>
    </div>
    <details class="more">
      <summary>A phone, or an emulator on another computer</summary>
      <!-- The listener is open to the network by default; say what this server is doing now. -->
      {#if status && !status.eventsAddr}
        <p>Tsum Tsum Stats was started with its script-event listener off (--events-addr "").</p>
      {:else if status}
        <p>Another device reaches this computer by its network address instead of 10.0.2.2. This computer's addresses are:</p>
        {#if status.lanAddrs.length}
          <ul>{#each status.lanAddrs as a (a)}<li><code>{a}:{port}</code></li>{/each}</ul>
        {:else}
          <p class="sub">None found. Is this computer on a network?</p>
        {/if}
        {#if status.eventsLoopback}
          <p>Right now Tsum Tsum Stats only accepts devices on this computer (<code>{status.eventsAddr}</code>), because it was started with that --events-addr. Start it without one to accept devices on the network too.</p>
        {:else}
          <p>Tsum Tsum Stats accepts devices from the network on {status.eventsAddr}.
            {status.token ? "It asks for a shared word: put it in the app's Shared word box." : 'It does not ask for a shared word, so any device on the network can send to it.'}</p>
          {#if !status.token}
            <p class="sub">The events are sent as plain text. On a network you do not trust, start it from a terminal with a shared word, and put the same word in the app's Shared word box:</p>
            <pre>tsum-stats serve --events-token WORD</pre>
          {/if}
        {/if}
      {/if}
    </details>
    <details class="more">
      <summary>It still says “Not reaching”</summary>
      <ul>
        <li>Tsum Tsum Stats has to be running on the same computer as the emulator. </li>
        <li><code>10.0.2.2</code> is how an emulator reaches the computer it runs on. It does not work from a phone. See the section above.</li>
        <li>From a phone or another computer: this computer's firewall has to let Tsum Tsum Stats in. Windows and macOS ask the first time it starts; allow it on private networks.</li>
        <li>The app's engine service has to be running. The Library shows <b>Online</b> when it is.</li>
        <li>A device that has not been heard from for 45 seconds shows as <b>Offline</b> here. It comes back once the app reconnects.</li>
      </ul>
    </details>
  </div>

  <div class="panel" id="help-rounds">
    <div class="panel-head"><h2>2 · Round stats files</h2><span class="sub">stats_*.csv</span></div>
    <div class="help-cols">
      <div>
        <p>With <b>Record round stats</b> on, the Tsum script writes one row for every round it plays: Tsum, score, coins, medals, time, and the settings the round was played with. It is on by default. To check it:</p>
        <ol class="steps">
          <li>Start the Tsum script from the GAP Library. The floating bar appears over the game.</li>
          <li>Tap the gear on the bar to open the script's settings.
            <img class="inline-shot" src="img/help/overlay-bar.png" alt="The floating bar; the gear is the second button from the right" width="310" height="50" loading="lazy"></li>
          <li>Open the <b>General</b> tab and check that <b>Record round stats</b> is on.</li>
        </ol>
        <p>The files are on the device in <code>Download/GeneralAutomationPlatform/tsum_record/</code>, one per day: <code>stats_20260929.csv</code>. Days and times in the file names are UTC.</p>
        <h3>Get them into Tsum Tsum Stats</h3>
        <div class="addr-box pull-box">
          <div class="addr"><b>Import from devices</b><button type="button" class="btn" disabled={refreshing} onclick={loadPullDevices}>Refresh</button></div>
          <span class="sub">Copies every <code>stats_*.csv</code> and <code>tsum_list_*.csv</code> off the ticked devices into this program's own <code>collected</code> folder, then imports them.</span>
          <div class="pull-list">
            {#if pull.loading}
              <span class="sub">Looking for devices…</span>
            {:else if pull.failed}
              <span class="sub">Could not ask Tsum Tsum Stats for devices.</span>
            {:else}
              {#each pull.devices as d (d.serial)}
                {@const ok = d.state === 'device'}
                <label class={ok ? '' : 'off'}>
                  <input type="checkbox" value={d.serial} disabled={!ok} checked={ok && picked?.includes(d.serial)} onchange={e => toggle(d.serial, e.target.checked)}>
                  <b>{d.model || d.serial}</b> <code>{d.serial}</code>{#if !ok}<span class="sub"> {d.state}</span>{/if}
                </label>
              {/each}
              {#if pullNote}<span class="sub">{pullNote}</span>{/if}
            {/if}
          </div>
          <div class="filter-actions">
            <button type="button" class="btn primary" disabled={pulling || !ready.length} onclick={importFromDevices}>Import</button>
            <span class="sub">{#each pullMsg as line, i (i)}{#if i}<br>{/if}{line}{/each}</span>
          </div>
        </div>
        <ul class="ways">
          <li><b>With the Import button above:</b> tick the emulators and press <b>Import</b>. Press it again whenever you like; rounds already stored are updated, not doubled.</li>
          <li><b>MuMu Player:</b> nothing to do. Tsum Tsum Stats reads <code>Documents/MuMuSharedFolder</code> directly, when that folder exists.</li>
          <li><b>By hand:</b> drop <code>stats_*.csv</code> files anywhere on this page, or use <b>Data › Import CSV files…</b>.</li>
        </ul>
        {#if status}
          <p class="sub">
            {#if status.importDirs.length}
              Folders Tsum Tsum Stats is watching now: {#each status.importDirs as d, i (d)}{#if i}, {/if}<code>{d}</code>{/each}
            {:else}
              Tsum Tsum Stats is not watching any folder now, so use the Import button above or drop the files here.
            {/if}
          </p>
        {/if}
      </div>
      <figure class="shot"><img src="img/help/record-round-stats.png" alt="The Tsum script's settings, General tab, with Record round stats switched on (other rows hidden)" width="540" height="205" loading="lazy"><figcaption>Tsum script settings › General</figcaption></figure>
    </div>
  </div>

  <div class="panel" id="help-tsums">
    <div class="panel-head"><h2>3 · Tsum list: the collection export</h2><span class="sub">tsum_list_*.csv</span></div>
    <div class="help-cols">
      <div>
        <p>The <a href="#/catalog">Catalog</a> shows which Tsums you own, with level, skill and when you got them. That comes from a chore that reads your in-game collection:</p>
        <ol class="steps">
          <li>Have Tsum Tsum open, INTL or JP. The script works out which one.</li>
          <li>Start the Tsum script, tap the gear, and open the <b>Chores</b> tab.</li>
          <li>Under <b>Tsum List</b>, tap <b>Now</b> beside <b>Export Tsum list</b>.</li>
          <li>Leave the device alone until the banner says <b>Tsum list: N saved</b>. The run then stops by itself.</li>
        </ol>
        <p>The script opens the collection itself. It sorts it by <b>Date acquired</b> with owned Tsums only, and taps each Tsum to read its level and skill. When it is done it puts your sort order back.
          It takes a few seconds per Tsum, so a big collection takes several minutes. If a round is already being played, the export waits for it to end, and the run carries on afterwards.</p>
        <p>The file is <code>tsum_record/tsum_list_20260929-101500.csv</code>, in the same folder as the round stats. It is saved after every page, so stopping part-way keeps what was read.
          Bring it in the same way: <a href="#/help?topic=rounds">Import from devices</a> and <code>9) Copy stats files</code> copy Tsum lists too, or drop the file on this page. The Catalog always shows the newest list for each game.</p>
      </div>
      <figure class="shot"><img src="img/help/export-tsum-list.png" alt="The Tsum script's settings, Chores tab, with the Export Tsum list row and its Now button highlighted (other rows hidden)" width="540" height="257" loading="lazy"><figcaption>Tsum script settings › Chores › Tsum List</figcaption></figure>
    </div>
  </div>

  <div class="panel" id="help-share">
    <div class="panel-head"><h2>4 · Share your stats on GitHub</h2><span class="sub">optional</span></div>
    <p>Tsum Tsum Stats can publish a copy of your stats as a web page at your own address, <code>https://&lt;your-name&gt;.github.io/tsum-stats/</code>, using your free GitHub account. Anyone with the link can see it, so you can show it to friends or open it on your phone. It does not update by itself: press <b>Update my page</b> to refresh it.</p>
    <ol class="steps">
      <li><a href="https://github.com/signup" target="_blank" rel="noopener">Create a GitHub account</a>, or sign in to the one you have. It is free, and your email must be verified.</li>
      <li>Come back here and press <b>Share your stats</b> below.</li>
      <li>Connect your account. GitHub's own page, over https, is where you sign in: Tsum Tsum Stats never sees your password. It opens GitHub's token page with everything ticked for you; press <b>Generate token</b>, copy the token and paste it into Tsum Tsum Stats.</li>
      <li>Choose how device names appear and whether your Tsum list goes on the page, tick that you understand it is public, and press <b>Publish</b>. Tsum Tsum Stats creates the <code>tsum-stats</code> repository and turns GitHub Pages on.</li>
    </ol>
    <p class="callout" role="note"><b>The first time, wait 1–2 minutes after publishing.</b> GitHub needs that long to switch the page on, and the link shows “404” until then.</p>
    <p class="sub">Sign out in the Share window forgets the token; the page stays up until you delete the repository on github.com.</p>
    <div class="filter-actions"><button type="button" class="btn primary" onclick={() => document.getElementById('share-btn')?.click()}>Share your stats</button></div>
  </div>
</section>
