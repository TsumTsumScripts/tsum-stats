// Every popup (a top-bar menu, a suggestion list, the column picker, the chart
// tooltip, a toast) goes in the browser's top layer, above everything on the page
// whatever its z-index. A z-index alone is not enough: a theme that blurs or tilts
// its panels makes each one its own stacking context, which nothing inside can
// climb out of, so a list opened in one panel went under the next; and the wide
// rail scrolls, which clipped a list inside it. Where the browser has no popover
// support, the popup takes the highest z-index instead.
//
// use:popup on an element that exists only while it is open (inside an {#if}).
// With an align, it is also placed at its anchor (its parent, unless given) and
// kept there, checked every frame while open, so it follows the anchor however
// it moves (a scroll, a resize, a chart or theme loading above it): under it, or
// over it when there is more room above. The room it has is --popup-room on the
// element; its CSS caps its height with it, so a long list scrolls inside rather
// than off screen.

const TOP_LAYER = typeof HTMLElement !== 'undefined' && 'popover' in HTMLElement.prototype;
const EDGE = 8; // kept clear of the window's edges

/**
 * @param {HTMLElement} node
 * @param {{align?: 'start' | 'end' | 'stretch', gap?: number, anchor?: HTMLElement}} [opts]
 *   align: its left edge on the anchor's, its right edge on the anchor's, or the anchor's width.
 */
export function popup(node, opts = {}) {
  if (TOP_LAYER) {
    node.popover = 'manual';
    node.showPopover();
  } else {
    node.style.zIndex = '2147483647';
  }
  const hide = () => { if (TOP_LAYER && node.isConnected && node.matches(':popover-open')) node.hidePopover(); };
  if (!opts.align) return {destroy: hide};

  const anchor = opts.anchor ?? node.parentElement;
  node.style.position = 'fixed';
  let frame = 0, last = '';

  function place(a) {
    const gap = opts.gap ?? 6;
    // Its anchor scrolled out of the window (or out of the rail): nothing to point at.
    node.style.visibility = a.bottom < 0 || a.top > innerHeight ? 'hidden' : '';
    if (opts.align === 'stretch') node.style.width = `${a.width}px`;
    // Its height uncapped first, to see whether it fits under the anchor.
    node.style.removeProperty('--popup-room');
    const want = node.offsetHeight;
    const below = innerHeight - a.bottom - gap - EDGE, above = a.top - gap - EDGE;
    const up = want > below && above > below;
    const room = Math.max(0, Math.floor(up ? above : below));
    node.style.setProperty('--popup-room', `${room}px`);
    const w = node.offsetWidth, h = node.offsetHeight;
    const left = opts.align === 'end' ? a.right - w : a.left;
    node.style.left = `${Math.max(EDGE, Math.min(left, innerWidth - EDGE - w))}px`;
    node.style.top = `${up ? a.top - gap - h : a.bottom + gap}px`;
  }
  // One rectangle read a frame; it is placed again only when the anchor or the window changed.
  function watch() {
    const a = anchor.getBoundingClientRect();
    const seen = `${a.top} ${a.left} ${a.width} ${a.height} ${innerWidth} ${innerHeight}`;
    if (seen !== last) { last = seen; place(a); }
    frame = requestAnimationFrame(watch);
  }
  watch();
  // Its own content changing (a suggestion list narrowing) can change which way it fits.
  const sized = new ResizeObserver(() => { last = ''; });
  sized.observe(node);

  return {
    update(next) { opts = next ?? {}; last = ''; },
    destroy() {
      cancelAnimationFrame(frame);
      sized.disconnect();
      hide();
    },
  };
}
