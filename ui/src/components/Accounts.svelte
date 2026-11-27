<!-- Game accounts, in the Data dialog: the accounts the Tsum Lists show
     (accounts.go groups lists by what they say, not by device name), and for
     each stretch of rounds (a game, device name and device) the account it was
     played on. A stretch the site cannot link by itself is the player's to
     name; a Tsum List then bounds the skill level of its rounds (the skill
     level correction). Local site only. -->
<script>
  import {shared, toast} from '../lib/ui.svelte.js';
  import {api, buildLabel, fmt, parseUTC, tsumName} from '../lib/util.js';

  // onchange: called after an answer was stored, when every figure by skill level may have moved.
  let {onchange = () => {}} = $props();

  let data = $state.raw(null);
  let busy = $state(false);

  export async function load() {
    data = await api('accounts').catch(() => null);
  }

  const day = new Intl.DateTimeFormat(undefined, {month: 'short', day: 'numeric', timeZone: 'UTC'});
  const span = (a, b) => {
    const x = day.format(parseUTC(a)), y = day.format(parseUTC(b));
    return x === y ? x : `${x} – ${y}`;
  };
  const accountOf = id => data.accounts.find(a => a.id === id);
  const accountName = a => `${buildLabel(a.build)} · ${a.label}`;
  const listsSpan = a => span(a.lists[0].at, a.lists.at(-1).at);
  /** The list an account is named by when picked: its newest. */
  const anchor = a => a.lists.at(-1).file;
  const tsumsOf = s => s.tsums.map(t => tsumName(shared.catalog, t.tsum)).join(', ') + (s.tsumCount > s.tsums.length ? ` +${s.tsumCount - s.tsums.length}` : '');
  const AUTO = '\u0000auto';
  /** A stretch's select value: the picked account's anchor, '' for not known, AUTO when never asked. */
  const valueOf = s => (s.how === 'picked' ? anchor(accountOf(s.account)) : s.how === 'unknown' ? '' : AUTO);
  const HOW = {device: 'by its device name', build: 'the only account of its game', picked: 'you said so', unknown: 'you said it is not known'};
  // The ones waiting for an answer first, then the rest, each oldest first.
  const stretches = $derived(data ? [...data.stretches].sort((a, b) => Number(Boolean(a.how)) - Number(Boolean(b.how))) : []);
  const waiting = $derived(stretches.filter(s => !s.how));

  async function pick(s, value) {
    busy = true;
    try {
      const res = await fetch('/api/stats/accounts/link', {method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({build: s.build, device: s.device, tag: s.tag, list: value === AUTO ? null : value})});
      if (!res.ok) throw new Error(String(res.status));
      data = await res.json();
      onchange();
    } catch (e) {
      toast(`Could not save: ${e.message}`, 6000);
    } finally {
      busy = false;
    }
  }
</script>

{#if data?.accounts.length}
  <div class="accounts">
    <h3>Game accounts</h3>
    <p class="sub">A Tsum List says what skill level each Tsum was at, and a level never goes down, so a list corrects the level of rounds played
      on its account before and after it. The lists show {data.accounts.length === 1 ? 'one account' : `${data.accounts.length} accounts`}:</p>
    <ul>
      {#each data.accounts as a (a.id)}
        <li><b>{accountName(a)}</b> · {fmt(a.lists.length)} {a.lists.length === 1 ? 'list' : 'lists'}, {listsSpan(a)} · {fmt(a.tsums)} Tsums</li>
      {/each}
    </ul>
    {#if waiting.length}
      <p class="sub"><b>{fmt(waiting.length)}</b> {waiting.length === 1 ? 'stretch of rounds has' : 'stretches of rounds have'} no account yet: nothing says which one
        {waiting.length === 1 ? 'it was' : 'they were'} played on. Name it and its lists apply; left as it is, only the coins judge those rounds.</p>
    {/if}
    <div class="stretches" class:busy>
      {#each stretches as s (`${s.build}|${s.device}|${s.tag}`)}
        <div class="stretch" class:waiting={!s.how}>
          <div>
            <b>{span(s.first, s.last)}</b> · {s.build ? buildLabel(s.build) : 'game not recorded'} · {s.device || 'unnamed device'}{s.tag ? ` …${s.tag.slice(-4)}` : ''}
            · {fmt(s.rounds)} {s.rounds === 1 ? 'round' : 'rounds'}
            <div class="sub">{tsumsOf(s)}{#if s.how} · {HOW[s.how]}{/if}</div>
          </div>
          <select class="search" aria-label="The account these rounds were played on" disabled={busy} value={valueOf(s)} onchange={e => pick(s, e.target.value)}>
            <option value={AUTO}>{s.how === 'device' || s.how === 'build' ? accountName(accountOf(s.account)) : 'No account yet'}</option>
            {#each data.accounts as a (a.id)}
              {#if !((s.how === 'device' || s.how === 'build') && a.id === s.account)}<option value={anchor(a)}>{accountName(a)}</option>{/if}
            {/each}
            <option value="">Not known</option>
          </select>
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  .accounts { display: grid; gap: 8px; }
  h3 { margin: 4px 0 0; font-size: 15px; }
  p { margin: 0; }
  .stretches { display: grid; gap: 6px; max-height: 44vh; overflow-y: auto; }
  .stretches.busy { opacity: .6; }
  .stretch { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 220px); gap: 6px 12px; align-items: center;
    padding: 6px 10px; border-radius: 10px; background: var(--well); font-size: 13px; }
  .stretch.waiting { box-shadow: inset 3px 0 0 var(--accent-a); }
  .stretch select { width: 100%; min-width: 0; }
  @media (max-width: 559px) { .stretch { grid-template-columns: minmax(0, 1fr); } }
</style>
