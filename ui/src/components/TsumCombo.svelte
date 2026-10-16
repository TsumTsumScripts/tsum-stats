<!-- A text box with a list of suggestions right under it, in place of the browser's
     <datalist>, whose popup the browser places itself and can leave away from its box.
     options: [{value, sub}]. onpick(text) is called when a suggestion is chosen, on
     Enter, and shortly after typing; it returns true when it took the text, which
     then clears the box. -->
<script>
  import {debounce} from '../lib/util.js';

  let {options, onpick, id = undefined, placeholder = '', label = undefined, wrapClass = ''} = $props();
  let input = $state();
  let text = $state('');
  let open = $state(false);
  let active = $state(-1);

  const shown = $derived.by(() => {
    const q = text.trim().toLowerCase();
    return q ? options.filter(o => o.value.toLowerCase().includes(q)) : options;
  });

  function take(t) {
    if (!onpick(t)) return false;
    text = '';
    open = false;
    active = -1;
    input.blur();
    return true;
  }
  const takeSoon = debounce(() => take(text.trim()), 250);

  function key(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      open = true;
      active = shown.length ? (active + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length : -1;
      document.getElementById(`${listId}-${active}`)?.scrollIntoView({block: 'nearest'});
    } else if (e.key === 'Enter') {
      if (!take(open && active >= 0 ? shown[active].value : text.trim())) open = false;
    } else if (e.key === 'Escape') {
      open = false;
    }
  }

  const listId = `combo-${Math.random().toString(36).slice(2, 8)}`;
</script>

<div class="combo {wrapClass}">
  <input {id} class="search" role="combobox" aria-expanded={String(open && shown.length > 0)} aria-controls={listId}
    aria-label={label} {placeholder} autocomplete="off" bind:this={input} bind:value={text}
    onfocus={() => (open = true)} onblur={() => (open = false)}
    oninput={() => { open = true; active = -1; takeSoon(); }} onkeydown={key}>
  {#if open && shown.length}
    <!-- mousedown, not click: the box would lose focus first and close the list. -->
    <ul class="combo-list" id={listId} role="listbox">
      {#each shown as o, i (o.value)}
        <li id="{listId}-{i}" role="option" aria-selected={String(i === active)} class:active={i === active}
          onmousedown={e => { e.preventDefault(); take(o.value); }}>
          <span>{o.value}</span>{#if o.sub}<span class="sub">{o.sub}</span>{/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>
