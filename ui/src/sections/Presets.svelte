<!-- Presets: the gallery of presets contributors shared (global site: data/global/presets.json,
     CONTRACT §4.3), and Convert, which reads pasted share codes, or presets GAP Companion sent
     (#/presets?p=…, lib/presets/links.js), entirely in the browser. Each preset can be copied as
     a code for the script's settings page, or opened in GAP Companion. On a contributor's own
     computer it also shares a preset to the gallery and lists theirs (CONTRACT §7.3). -->
<script>
  import {onMount} from 'svelte';
  import TsumChip from '../components/TsumChip.svelte';
  import {isGlobal} from '../lib/global/client.js';
  import {companionLink, unpackPresets} from '../lib/presets/links.js';
  import {TABLE, clean, describe, encode, exportText, read} from '../lib/presets/shareCode.js';
  import {cleanName} from '../lib/presets/text.js';
  import {shared, toast} from '../lib/ui.svelte.js';
  import {api, tsumColor, tsumName} from '../lib/util.js';

  let {hidden, initial} = $props();

  const globalSite = isGlobal();
  const local = __LOCAL_ONLY__ && !globalSite;
  const GALLERY = 'https://tsum-stats.gapscripts.app/#/presets';
  const skillSlot = TABLE.slots.find(s => s?.key === 'skillType');
  const skillName = id => skillSlot?.options?.[id] ?? id;

  // ---- Gallery (global site) ----
  let gallery = $state.raw(null);
  let galleryError = $state('');
  let search = $state('');
  let skill = $state('');
  const skills = $derived([...new Set((gallery?.presets ?? []).map(p => p.skill))].sort((a, b) => skillName(a).localeCompare(skillName(b))));
  const visible = $derived.by(() => {
    const q = search.trim().toLowerCase();
    return (gallery?.presets ?? []).filter(p => (!skill || p.skill === skill) && (!q ||
      p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q) ||
      (p.tsum && tsumName(shared.catalog, p.tsum).toLowerCase().includes(q)) || skillName(p.skill).toLowerCase().includes(q)));
  });

  async function loadGallery() {
    try {
      const res = await fetch(new URL('data/global/presets.json', document.baseURI), {cache: 'no-cache'});
      if (res.status === 404) gallery = {presets: []};
      else if (!res.ok) throw new Error(String(res.status));
      else gallery = await res.json();
    } catch {
      galleryError = 'The gallery could not be loaded. Try again later.';
    }
  }

  // ---- Convert ----
  let text = $state('');
  // Presets GAP Companion sent in the link, shown as codes, and how many of their settings
  // were left out (a value the script would not apply as is: a link made by hand, or a newer app).
  let fromCompanion = $state.raw(null);
  let companionDropped = $state(0);
  const pasted = $derived(text.trim() ? read(text) : null);
  const pastedNote = $derived.by(() => {
    if (!pasted) return '';
    if (!pasted.presets.length) return pasted.otherFormat
      ? 'That code is from an older version of the script. Ask for a fresh copy.'
      : 'No share codes found. Copy them again and paste the whole text.';
    const parts = [];
    if (pasted.bad) parts.push(`${pasted.bad} damaged code${pasted.bad === 1 ? ' was' : 's were'} left out`);
    const newer = pasted.presets.filter(p => p.skipped).length;
    if (newer) parts.push(`${newer} came from a newer script and may miss a setting until this site updates`);
    return parts.join('; ');
  });
  // Names cleaned as the gallery's are; a preset without one gets one, so it can go to GAP Companion.
  const named = list => list.map((p, i) => ({...p, name: cleanName(p.name ?? '') || `Shared preset${list.length > 1 ? ' ' + (i + 1) : ''}`}));

  // App calls this when the section is shown again with new params.
  export function shown(params) {
    const p = params?.p ? unpackPresets(params.p) : null;
    let dropped = 0;
    const kept = (p ?? []).map(x => {
      const c = clean(x.values);
      dropped += c.dropped;
      return {name: x.name, values: c.values};
    });
    fromCompanion = kept.length ? named(kept) : null;
    companionDropped = dropped;
  }

  async function copy(t, what) {
    try {
      await navigator.clipboard.writeText(t);
      toast(`Copied ${what}`);
    } catch {
      toast('Could not copy: select the text and copy it instead');
    }
  }

  // ---- Sharing (a contributor's own computer) ----
  let me = $state.raw(null); // {joined}
  let mine = $state.raw([]);
  let sharing = $state(null); // the preset whose Share form is open: {name, code, values}
  let form = $state({name: '', description: '', tsum: ''});
  let busy = $state(false);
  const ERRORS = {
    'bad-code': 'That is not one whole share code.', 'old-code': 'That code is from an older version of the script.',
    'newer-code': 'That code has a skill or setting this site does not know: from a newer script (try again after the site updates), or one the script removed.',
    'bad-name': 'Give it a name.', 'bad-description': 'The description is too long (280 characters at most).',
    'bad-tsum': 'Pick a Tsum from the list, or none.', 'preset-limit': 'You have shared as many presets as you can for now.',
    'not-joined': 'Join the global stats first (Contribute): only contributors can share presets.',
    unauthorized: 'The global site no longer knows this computer. Join again under Contribute.',
    budget: 'The global site is busy today. Try again tomorrow.', unreachable: 'The global site could not be reached.',
  };
  const tsumIds = $derived(new Map((shared.catalog?.tsums ?? []).map(t => [tsumName(shared.catalog, t.id).toLowerCase(), t.id])));

  async function post(path, body) {
    const res = await fetch(`/api/stats/${path}`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(ERRORS[data.code] ?? data.message ?? `The global site said ${data.code ?? res.status}`);
    return data;
  }

  async function loadMine() {
    try {
      me = await api('global');
      if (!me.joined) return;
      const res = await fetch('/api/stats/global/presets');
      const data = await res.json();
      mine = res.ok ? data.presets ?? [] : [];
    } catch {
      me = null;
    }
  }

  function openShare(p) {
    sharing = p;
    form = {name: p.name, description: '', tsum: ''};
  }

  async function share() {
    const tsum = form.tsum.trim() ? tsumIds.get(form.tsum.trim().toLowerCase()) : '';
    if (tsum === undefined) return toast(ERRORS['bad-tsum']);
    busy = true;
    try {
      await post('global/presets', {code: sharing.code ?? encode(sharing.values), name: form.name, description: form.description, tsum});
      toast(`Shared "${form.name}". It shows in the gallery within the hour.`, 6000);
      sharing = null;
      await loadMine();
    } catch (e) {
      toast(e.message, 6000);
    } finally {
      busy = false;
    }
  }

  async function unshare(p) {
    busy = true;
    try {
      await post('global/presets/delete', {id: p.id});
      toast(`Removed "${p.name}" from the gallery`);
      await loadMine();
    } catch (e) {
      toast(e.message, 6000);
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    shown(initial);
    if (globalSite) loadGallery();
    if (local) loadMine();
  });
</script>

<!-- One preset: what it changes, and what to do with it. -->
{#snippet card(p, actions)}
  {@const changes = describe(p.values)}
  <article class="panel preset">
    <div class="preset-head">
      <h3>{p.name}</h3>
      {#if p.tsum}<TsumChip id={p.tsum} name={tsumName(shared.catalog, p.tsum)} color={tsumColor(shared.catalog, p.tsum)} />{/if}
    </div>
    {#if p.description}<p class="preset-desc">{p.description}</p>{/if}
    <dl class="preset-settings">
      {#each changes as [label, value], i (i)}<div><dt>{label}</dt><dd>{value}</dd></div>{/each}
      {#if !changes.length}<div><dt>Every setting</dt><dd>Default</dd></div>{/if}
    </dl>
    <div class="preset-actions">{@render actions(p)}</div>
  </article>
{/snippet}

{#snippet use(p)}
  <button type="button" class="btn" title="For the script's settings page: paste it into the share box"
    onclick={() => copy(`${p.name}: ${p.code ?? encode(p.values)}`, 'the share code')}>Copy code</button>
  <a class="btn" href={companionLink([p])} target="_blank" rel="noopener" title="Adds it to your presets in GAP Companion">Add to GAP Companion</a>
  {#if local && me?.joined}<button type="button" class="btn" onclick={() => openShare(p)}>Share to the gallery</button>{/if}
{/snippet}

<section id="presets" class="stack" {hidden}>
  {#if fromCompanion}
    <div class="panel">
      <div class="panel-head"><div><h2>From GAP Companion</h2><span class="sub">{fromCompanion.length} preset{fromCompanion.length === 1 ? '' : 's'} as share codes</span></div></div>
      <textarea class="codes" readonly rows={Math.min(8, fromCompanion.length + 1)} aria-label="Share codes">{exportText(fromCompanion)}</textarea>
      {#if companionDropped}<p class="sub">{companionDropped} setting{companionDropped === 1 ? ' was' : 's were'} left out: the script would not take {companionDropped === 1 ? 'its value' : 'their values'}.</p>{/if}
      <div class="preset-actions">
        <button type="button" class="btn" onclick={() => copy(exportText(fromCompanion), 'the share codes')}>Copy codes</button>
      </div>
      <p class="sub">Paste them into the share box on the script's settings page, or send them to someone.
        {#if local && me?.joined}Share one to the gallery below.{:else if local}To share them in the gallery, join the global stats first (Contribute).{/if}</p>
    </div>
    <div class="preset-grid">
      {#each fromCompanion as p, i (i)}{@render card(p, use)}{/each}
    </div>
  {/if}

  <div class="panel">
    <div class="panel-head"><div><h2>Convert share codes</h2><span class="sub">Read codes from the script's Export presets or a message</span></div></div>
    <textarea class="codes" rows="4" placeholder="Coins: TSUM4-…~" aria-label="Share codes to read" bind:value={text}></textarea>
    {#if pastedNote}<p class="sub" aria-live="polite">{pastedNote}</p>{/if}
    {#if pasted?.presets.length > 1}
      <div class="preset-actions">
        <a class="btn" href={companionLink(named(pasted.presets))} target="_blank" rel="noopener">Add all {pasted.presets.length} to GAP Companion</a>
      </div>
    {/if}
  </div>
  {#if pasted?.presets.length}
    <div class="preset-grid">
      {#each named(pasted.presets) as p, i (i)}{@render card(p, use)}{/each}
    </div>
  {/if}

  {#if sharing}
    <form class="panel" onsubmit={e => { e.preventDefault(); share(); }}>
      <div class="panel-head"><div><h2>Share "{sharing.name}" to the gallery</h2><span class="sub">Everyone can see and copy it</span></div></div>
      <label class="field">Name<input maxlength="40" required bind:value={form.name} /></label>
      <label class="field">Description (optional)<input maxlength="280" bind:value={form.description} /></label>
      <label class="field">Tsum it is for (optional)<input list="preset-tsums" bind:value={form.tsum} /></label>
      <datalist id="preset-tsums">{#each shared.catalog?.tsums ?? [] as t (t.id)}<option value={tsumName(shared.catalog, t.id)}></option>{/each}</datalist>
      <div class="preset-actions">
        <button type="submit" class="btn" disabled={busy}>Share</button>
        <button type="button" class="btn" onclick={() => (sharing = null)}>Cancel</button>
      </div>
    </form>
  {/if}

  {#if local}
    <div class="panel">
      <div class="panel-head"><div><h2>Your shared presets</h2><span class="sub">In the <a href={GALLERY} target="_blank" rel="noopener">global gallery</a></span></div></div>
      {#if !me?.joined}
        <p class="sub">Only contributors to the global stats can share presets. Join under Contribute, then paste a code above and choose Share to the gallery.</p>
      {:else if !mine.length}
        <p class="sub">None yet. Paste a code above and choose Share to the gallery.</p>
      {:else}
        <ul class="mine">
          {#each mine as p (p.id)}
            <li><b>{p.name}</b> <span class="sub">{skillName(p.skill)}{p.hidden ? ' · taken down' : ''}</span>
              <button type="button" class="btn" disabled={busy} onclick={() => unshare(p)}>Remove</button></li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}

  {#if globalSite}
    <div class="panel">
      <div class="panel-head">
        <div><h2>Gallery</h2><span class="sub">Presets players shared. Copy a code for the script, or add it to GAP Companion.</span></div>
        <div class="gallery-filters">
          <input class="search" type="search" placeholder="Search" aria-label="Search presets" bind:value={search} />
          <select class="search" aria-label="Skill" bind:value={skill}>
            <option value="">Every skill</option>
            {#each skills as s (s)}<option value={s}>{skillName(s)}</option>{/each}
          </select>
        </div>
      </div>
      {#if galleryError}<p class="sub">{galleryError}</p>
      {:else if !gallery}<p class="sub">Loading…</p>
      {:else if !visible.length}<p class="sub">{gallery.presets.length ? 'No presets match.' : 'No presets shared yet.'}</p>{/if}
    </div>
    {#if visible.length}
      <div class="preset-grid">
        {#each visible as g (g.id)}
          {@const d = read(g.code).presets[0]}
          {#if d}{@render card({...g, values: d.values}, use)}{/if}
        {/each}
      </div>
    {/if}
  {/if}
</section>

<style>
  .preset-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: 12px; }
  .preset { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .preset-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
  .preset-head h3 { margin: 0; font-size: 16px; overflow-wrap: anywhere; }
  .preset-desc { margin: 0; color: var(--muted); font-size: 13px; }
  .preset-settings { display: grid; gap: 2px; margin: 0; font-size: 13px; }
  .preset-settings div { display: flex; justify-content: space-between; gap: 2px 12px; flex-wrap: wrap; }
  .preset-settings dt { color: var(--muted); }
  .preset-settings dd { margin: 0; font-weight: 700; text-align: right; }
  .preset-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: auto; padding-top: 4px; }
  .codes { width: 100%; box-sizing: border-box; font: 12px/1.45 ui-monospace, monospace; padding: 8px 10px; border-radius: 10px;
    border: 1px solid var(--panel-edge); background: var(--panel); color: inherit; resize: vertical; }
  .gallery-filters { display: flex; gap: 8px; flex-wrap: wrap; flex: 1 1 260px; max-width: 480px; min-width: 0; }
  .gallery-filters > * { flex: 1 1 140px; min-width: 0; width: auto; }
  .mine { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  .mine li { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .mine li .btn { margin-left: auto; }
  form.panel { display: grid; gap: 10px; }
</style>
