// Runs the snapshot engine off the page's thread: the page posts a route and
// its parameters, and gets the server's answer back. It also keeps the months
// it has loaded, so a filter change does not fetch or parse them again.
import {createEngine} from './engine.js';

let engine;

self.onmessage = async ({data: {id, base, path, params}}) => {
  try {
    if (base) {
      engine = createEngine({
        async json(name) {
          const res = await fetch(new URL(name, base));
          if (!res.ok) throw new Error(`${name}: ${res.status}`);
          return res.json();
        },
      });
      self.postMessage({id, ok: true});
    } else {
      self.postMessage({id, ok: true, value: await engine.call(path, params)});
    }
  } catch (e) {
    self.postMessage({id, ok: false, error: e.message});
  }
};
