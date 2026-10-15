<!-- The Contribute dialog: add your rounds to the global stats, see what has been sent, stop or unlink. -->
<script module>
  /**
   * Calls set with the time now, and again once `until` (ms; NaN for none)
   * has passed, so a state that ends at a time ends on screen too. A long
   * wait is re-armed hourly. Returns the cancel, for an $effect.
   */
  export function tickUntil(until, set, timers = globalThis) {
    let id;
    const tick = () => {
      const now = Date.now();
      set(now);
      if (until > now) id = timers.setTimeout(tick, Math.min(until - now + 250, 3_600_000));
    };
    tick();
    return () => timers.clearTimeout(id);
  }
</script>

<script>
  import {toast} from '../lib/ui.svelte.js';
  import {api, fmt} from '../lib/util.js';

  let dialog;
  let st = $state.raw(null);
  let agreed = $state(false), busy = $state(false), confirming = $state(false);
  const when = new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short'});
  // The global site's days are UTC days: a round counts on the day it began.
  const utcDay = new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeZone: 'UTC'});
  const at = s => (s ? when.format(new Date(s)) : '—');
  const day = s => (s ? utcDay.format(new Date(`${s}T00:00:00Z`)) : '—');
  function hostOf(u) {
    try {
      return new URL(u).host;
    } catch {
      return u || '';
    }
  }

  /** Takes a new state from the server; App.svelte passes on the ts/global topic. */
  export function update(s) {
    st = s;
  }

  /** Opens on the current state; the server counts the waiting rounds afresh. */
  export async function open() {
    confirming = false;
    dialog.showModal();
    try {
      update(await api('global'));
    } catch (e) {
      toast(e.message, 6000);
    }
  }
  const close = () => dialog.close();

  async function post(path, body) {
    busy = true;
    try {
      const res = await fetch(`/api/stats/global/${path}`, {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || `${res.status}`);
      st = data;
      return true;
    } catch (e) {
      toast(e.message, 6000);
      return false;
    } finally {
      busy = false;
    }
  }

  async function join() {
    const again = st.joined;
    if (!(await post('join'))) return;
    agreed = false;
    toast(again ? 'Contributing again.' : 'Joined. The first upload starts in about two minutes.');
  }
  const uploadNow = () => post('run');
  const stop = () => post('leave', {unlink: false});
  async function unlink() {
    if (!(await post('leave', {unlink: true}))) return;
    confirming = false;
    toast('The global site is unlinking your rounds, and this computer has stopped contributing.', 6000);
  }

  const host = $derived(hostOf(st?.url));
  // The daily limit's note and the disabled Upload now end when retryAt passes, even with no new state.
  let now = $state(Date.now());
  $effect(() => tickUntil(Date.parse(st?.retryAt ?? ''), t => (now = t)));
  const waiting = $derived(Boolean(st?.retryAt) && Date.parse(st.retryAt) > now);
</script>

<dialog bind:this={dialog}>
  <div class="panel share">
    <h2>Contribute to the global stats</h2>
    {#if !st}
      <p class="sub">Loading…</p>

    {:else if confirming}
      <p style="margin:0"><b>Stop and unlink your rounds?</b></p>
      <ul>
        <li>Uploads stop, and this computer forgets its contributor key.</li>
        <li>Over the following hours (a day or more if you have sent many rounds) the global site takes your contributor
          number off every round you sent. The rounds stay in the global figures, still with their hashed device code,
          and cannot be taken out of them.</li>
        <li>This cannot be undone. If you join again later you are a new contributor, and rounds already sent are not sent again.</li>
      </ul>
      {#if busy}<p class="sub" style="margin:0" aria-live="polite">{st.running ? 'Finishing the upload in progress, then unlinking…' : 'Unlinking…'}</p>{/if}
      {#if st.lastError}<p class="error">{st.lastError}</p>{/if}
      <div class="filter-actions">
        <button type="button" class="btn primary" onclick={unlink} disabled={busy}>Unlink my rounds</button>
        <button type="button" class="btn" onclick={() => (confirming = false)} disabled={busy}>Cancel</button>
      </div>

    {:else if !st.enabled}
      <p>Add your rounds to the community figures at <a href={st.url} target="_blank" rel="noopener">{host}</a>:
        what each Tsum earns by skill level, boost items and game, pooled from many players' rounds.
        Tsum Tsum Stats sends new rounds about once an hour, in the background, while it is running.</p>
      {#if st.joined}<p class="sub" style="margin:0">Stopped. You are still contributor <b>#{st.id}</b>, and joining again carries on under that number.</p>{/if}

      <p style="margin:0"><b>What is sent</b>, for each round from the last 60 days</p>
      <ul>
        <li>The round's id, which carries when the round began and a code for the device that played it.</li>
        <li>The round's figures: when it ended, how long it ran, score, coins and medals.</li>
        <li>The Tsum, the game (international or JP), its skill level and the boost items used.</li>
        <li>The script's version and the settings it played the round with, and this app's version.</li>
      </ul>
      <p style="margin:0"><b>Never sent</b></p>
      <ul>
        <li>Device names, whether a round came live or from a CSV file, your Tsum lists (which Tsums you own), and the
          names of files and folders on your computer or devices.</li>
      </ul>
      <p style="margin:0"><b>What the global site keeps</b></p>
      <ul>
        <li>Your rounds, for good, under a contributor number with no name or account. Numbers are given out in order
          as players join. This dialog shows your own totals; your number is not published.</li>
        <li>The public page shows figures added up over rounds of the same day, Tsum, game, skill level and boost items
          (counts, totals, best and lowest, first and last end time), and how many contributors (in all and per Tsum) and
          devices sent rounds in the last 30 days. Where only you, or a few players, send a Tsum, those figures can be close
          to your own rounds: a group of one round shows that round's score, coins and end time. The page marks such Tsums
          "few players".</li>
        <li>Only a hashed (scrambled) form of each round's device code, to tell devices apart and to count a round sent
          twice only once.</li>
        <li>When you join, a hashed form of your internet address, for about a day, to limit how many joins one address makes.</li>
        <li>You can stop at any time. You can also unlink your rounds: they lose your contributor number, but stay in the
          global figures with their hashed device code. They cannot be taken out of the figures.</li>
      </ul>
      {#if st.url}
        <p class="sub" style="margin:0">{fmt(st.pending)} {st.pending === 1 ? 'round is' : 'rounds are'} ready to send. Rounds are sent 20 minutes after they end.</p>
      {:else}
        <p class="sub" style="margin:0">Contributing is turned off on this computer: Tsum Tsum Stats was started with an empty <code>--global-url</code>.</p>
      {/if}

      <label class="check share-consent"><input type="checkbox" bind:checked={agreed}>
        I agree to send my rounds to the global stats as described here.</label>
      {#if st.lastError}<p class="error">{st.lastError}</p>{/if}

      <div class="filter-actions">
        <button type="button" class="btn primary" onclick={join} disabled={busy || !agreed || !st.url}>{st.joined ? 'Join again' : 'Join'}</button>
        <button type="button" class="btn" onclick={close}>Close</button>
        {#if st.joined}<button type="button" class="btn" onclick={() => (confirming = true)} disabled={busy}>Unlink my rounds</button>{/if}
      </div>

    {:else}
      <p class="sub" style="margin:0">Contributing to <a href={st.url} target="_blank" rel="noopener">{host}</a> as contributor <b>#{st.id}</b>.</p>
      <div class="addr-box pull-box">
        <ul>
          <li>Rounds sent: <b>{fmt(st.sent)}</b></li>
          <li>Waiting to send: <b>{fmt(st.pending)}</b></li>
          <li>Last upload: <b>{st.lastUpload ? at(st.lastUpload) : 'none yet'}</b></li>
          {#if waiting}<li>The global site's daily limit is reached. Uploads carry on after <b>{at(st.retryAt)}</b>.</li>{/if}
        </ul>
        {#if st.me}
          <p class="sub" style="margin:0">The global site has <b>{fmt(st.me.rounds)}</b> of your rounds, from {fmt(st.me.devices)}
            {st.me.devices === 1 ? 'device' : 'devices'}{#if st.me.first}, played {day(st.me.first)} to {day(st.me.last)}{/if}.
            Today it has taken {fmt(st.me.today?.rounds)} of {fmt(st.me.today?.quota)}.
            {#if st.me.duplicates}{fmt(st.me.duplicates)} had already been sent by someone else.{/if}</p>
        {/if}
      </div>
      {#if !st.lastUpload && !st.running && !waiting}<p class="sub" style="margin:0">The first upload starts about two minutes after joining. Upload now sends at once.</p>{/if}
      {#if st.running}<p class="sub" style="margin:0" aria-live="polite">Uploading…</p>{/if}
      {#if st.lastError}<p class="error">{st.lastError}</p>{/if}

      <div class="filter-actions">
        <button type="button" class="btn primary" onclick={uploadNow} disabled={busy || st.running || waiting}>
          {st.running ? 'Uploading…' : 'Upload now'}</button>
        <button type="button" class="btn" onclick={close}>Close</button>
        <button type="button" class="btn" onclick={stop} disabled={busy}>Stop contributing</button>
        <button type="button" class="btn" onclick={() => (confirming = true)} disabled={busy}>Stop and unlink my rounds</button>
      </div>
      <p class="sub" style="margin:0">Stopping keeps your contributor number, so you can carry on later. Your rounds stay in the global figures either way.</p>
    {/if}
  </div>
</dialog>
