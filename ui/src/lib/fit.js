// A figure too long for its box shows its short form (1.3B, 12M) instead, the
// full figure as its tooltip. The box (class "fit") holds both, .fit-full and
// .fit-short; the class "short" on it picks the short one. A fit box adds
// nothing to its tile's width (contain: inline-size, styles.css), so a long
// figure overflows it rather than widening the tile, and that overflow is what
// refit measures.

/** Measures box again: the full figure, unless it overflows and there is a short one. */
export function refit(box) {
  box.classList.remove('short');
  if (box.querySelector('.fit-short') && box.scrollWidth > box.clientWidth) box.classList.add('short');
}

/** The action: refits when the box resizes, its figure changes, and once the fonts are in. The copy card calls refit itself. */
export function fit(box) {
  const sized = new ResizeObserver(() => refit(box));
  const changed = new MutationObserver(() => refit(box));
  sized.observe(box);
  changed.observe(box, {childList: true, characterData: true, subtree: true});
  document.fonts?.ready.then(() => refit(box));
  return {destroy: () => (sized.disconnect(), changed.disconnect())};
}
