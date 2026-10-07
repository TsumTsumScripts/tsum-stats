<!-- The Share dialog: sign in to GitHub, choose what goes on the public page, publish it. -->
<script>
  import {onMount} from 'svelte';
  import {toast} from '../lib/ui.svelte.js';
  import {api, fmt} from '../lib/util.js';

  let dialog;
  let st = $state.raw(null);
  let repo = $state(''), devices = $state('anonymous'), collection = $state(true), agreed = $state(false);
  let busy = $state(false), checking = $state(false), token = $state('');
  const day = new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short'});

  /** Takes a new state from the server; the choices are only copied while the player is not editing them. */
  export function update(s) {
    const first = !st;
    st = s;
    if (first || s.phase === 'done') { repo = s.repo; devices = s.devices; collection = s.collection; }
  }

  /** Opens on what is saved, then asks GitHub whether the saved sign-in still works. */
  export async function open() {
    dialog.showModal();
    update(await api('publish'));
    if (st.signedIn && !working) {
      checking = true;
      try {
        const res = await fetch('/api/stats/publish/check', {method: 'POST'});
        if (res.ok) update(await res.json());
      } catch {
        // GitHub or the app could not be reached: the form stays, and a publish says what is wrong.
      } finally {
        checking = false;
      }
    }
  }
  const close = () => dialog.close();

  async function post(path, body) {
    busy = true;
    try {
      const res = await fetch(`/api/stats/publish/${path}`, {
        method: 'POST', headers: {'Content-Type': 'application/json'}, body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message || `${res.status}`);
      st = data;
    } catch (e) {
      toast(e.message, 6000);
    } finally {
      busy = false;
    }
  }

  async function useToken() {
    await post('token', {token});
    if (st?.signedIn) token = '';
  }
  const signOut = () => post('logout');
  const publish = () => post('run', {repo, devices, collection, public: agreed});

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
      toast('Copied');
    } catch {
      toast('Could not copy. Select it and copy by hand.');
    }
  }

  const working = $derived(st && (st.phase === 'exporting' || st.phase === 'uploading'));
  const pageUrl = $derived(st?.url || (st?.login ? `https://${st.login.toLowerCase()}.github.io/${repo}/` : ''));

  onMount(() => { api('publish').then(update).catch(() => {}); });
</script>

<dialog bind:this={dialog}>
  <div class="panel share">
    <h2>Share your stats</h2>
    {#if !st}
      <p class="sub">Loading…</p>

    {:else if !st.signedIn}
      <p>Publish your stats as a web page on GitHub Pages, at your own address, so you can share it or look at it anywhere. It is a copy: it does not update until you press Publish again.</p>
      {#if st.phase === 'error'}<p class="error">{st.error}</p>{/if}
      <p style="margin:0"><b>Connect your GitHub account</b></p>
      <ol class="steps">
        <li>Have a free GitHub account. <a href="https://github.com/signup" target="_blank" rel="noopener">Create one</a> if you do not.</li>
        <li><a href="https://github.com/settings/tokens/new?scopes=public_repo&description=Tsum%20Tsum%20Stats" target="_blank" rel="noopener">Open GitHub's token page</a>
          and sign in there if it asks. “public_repo” is already ticked. Set <b>Expiration</b> to what you like (a short one means making a new token later), then press <b>Generate token</b>.</li>
        <li>Copy the token (it starts with <code>ghp_</code>) and paste it here. GitHub shows it once.</li>
      </ol>
      <label class="field"><span>Token</span>
        <input type="password" bind:value={token} autocomplete="off" spellcheck="false" placeholder="ghp_…"></label>
      <p class="sub" style="margin:6px 0">It lets Tsum Tsum Stats create and update public repositories in your account, nothing else. It is kept in this computer's Tsum Tsum Stats folder, never sent anywhere but GitHub. Sign out forgets it, and you can revoke it on GitHub any time.</p>
      <div class="filter-actions">
        <button type="button" class="btn primary" onclick={useToken} disabled={busy || !token.trim()}>Connect</button>
        <button type="button" class="btn" onclick={close}>Close</button>
      </div>

    {:else}
      <p class="sub" style="margin:0">Signed in to GitHub as <b>{st.login || 'your account'}</b>.
        <button type="button" class="linkish" onclick={signOut} disabled={busy || working}>Sign out</button></p>

      {#if st.phase === 'done'}
        <p><b>Published.</b> {fmt(st.rounds)} rounds are on your page.</p>
        <div class="addr-box">
          <div class="addr"><a href={st.url} target="_blank" rel="noopener"><code>{st.url}</code></a>
            <button type="button" class="btn" onclick={() => copy(st.url)}>Copy link</button></div>
        </div>
        <p class="callout" role="note">If the link shows “404”, GitHub is still switching your page on. Wait a minute or two, then refresh.</p>
      {/if}

      <fieldset class="share-choices" disabled={working}>
        <label class="field"><span>Device names on the page</span>
          <select bind:value={devices}>
            <option value="anonymous">Hidden: “Device 1”, “Device 2”</option>
            <option value="hide">Not shown at all</option>
            <option value="keep">Shown as they are</option>
          </select></label>
        <label class="check"><input type="checkbox" bind:checked={collection}> Include which Tsums I own (the Catalog)</label>
        <details class="more">
          <summary>Advanced</summary>
          <label class="field"><span>Repository name</span><input type="text" bind:value={repo} spellcheck="false"></label>
          <p class="sub" style="margin:6px 0 0">Created in your account the first time. Its page is <code>{pageUrl}</code></p>
        </details>
      </fieldset>

      <label class="check share-consent"><input type="checkbox" bind:checked={agreed} disabled={working}>
        I understand that anyone with the link can see this page.</label>

      {#if st.phase === 'error'}<p class="error">{st.error}</p>{/if}
      {#if working}<p class="sub" style="margin:0" aria-live="polite">{st.message}…</p>{/if}
      {#if st.url && !working && st.phase !== 'done'}<p class="sub" style="margin:0">Last published {st.publishedAt ? day.format(new Date(st.publishedAt)) : ''}:
        <a href={st.url} target="_blank" rel="noopener">{st.url}</a></p>{/if}

      <div class="filter-actions">
        <button type="button" class="btn primary" onclick={publish} disabled={busy || working || checking || !agreed || !repo}>
          {working ? 'Publishing…' : st.url ? 'Update my page' : 'Publish'}</button>
        <button type="button" class="btn" onclick={close}>Close</button>
      </div>
    {/if}
  </div>
</dialog>
