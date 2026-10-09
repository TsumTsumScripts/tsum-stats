// Appearance: style (Accessible, the default, or Felt), theme and size, kept in
// this browser. Loaded in <head> without `defer`, after the stylesheets, so the
// right look is on before the page draws. Each style's sheet is a <link
// data-style>; the one not in use gets media="not all". Felt is dark only, so
// theme and size apply to the Accessible style (a11y.css reads data-theme and
// data-size on <html>). The Aa button's popover holds the choices.
(function () {
  'use strict';

  // Prefixed: the Stats site shares this origin (127.0.0.1:8090).
  var KEY = { style: 'starterStyle', theme: 'starterTheme', size: 'starterSize' };
  var SIZES = ['xs', 's', 'm', 'l'];
  var root = document.documentElement;
  var lightQuery = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;

  function get(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function put(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (e) { /* not remembered; the page still switches */ }
  }

  /** The stored choices, with defaults: Accessible, follow the device, Small. */
  function choices() {
    var theme = get(KEY.theme);
    var size = get(KEY.size);
    return {
      style: get(KEY.style) === 'felt' ? 'felt' : 'a11y',
      theme: theme === 'dark' || theme === 'light' ? theme : 'device',
      size: SIZES.indexOf(size) >= 0 ? size : 's',
    };
  }

  function apply() {
    var c = choices();
    root.setAttribute('data-style', c.style);
    root.setAttribute('data-size', c.size);
    var light = c.theme === 'light' || (c.theme === 'device' && lightQuery !== null && lightQuery.matches);
    root.setAttribute('data-theme', light ? 'light' : 'dark');
    var sheets = document.querySelectorAll('link[data-style]');
    for (var i = 0; i < sheets.length; i++) {
      sheets[i].media = sheets[i].getAttribute('data-style') === c.style ? 'all' : 'not all';
    }
    refreshPanel(c);
  }

  /** Checks the radios that match; theme and size are greyed out under Felt. */
  function refreshPanel(c) {
    var panel = document.getElementById('appearance');
    if (panel === null) return;
    var inputs = panel.querySelectorAll('input[type="radio"]');
    for (var i = 0; i < inputs.length; i++) {
      inputs[i].checked = inputs[i].value === c[inputs[i].name];
    }
    var felt = c.style === 'felt';
    panel.querySelectorAll('[data-a11y-only]').forEach(function (set) { set.disabled = felt; });
    document.getElementById('appearance-felt-note').hidden = !felt;
  }

  apply();
  if (lightQuery !== null && lightQuery.addEventListener) {
    lightQuery.addEventListener('change', apply);
  }

  document.addEventListener('DOMContentLoaded', function () {
    var panel = document.getElementById('appearance');
    if (panel === null) return;
    panel.addEventListener('change', function (event) {
      var input = event.target;
      if (!(input.name in KEY)) return;
      // "device" is the absence of a choice.
      put(KEY[input.name], input.name === 'theme' && input.value === 'device' ? null : input.value);
      apply();
    });
    refreshPanel(choices());
  });
})();
