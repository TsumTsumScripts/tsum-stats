// The page's side of the global site: it is one when its index.html says so
// (`vite build --mode global` adds the tag), and then api() is answered by the
// global engine in a worker, from the files under data/global/. Modelled on
// ../snapshot/client.js.

/** True on the global site; the local server's page and a snapshot have no such tag. */
export const isGlobal = () => document.querySelector('meta[name="tsum-global"]') !== null;

let worker;
let seq = 0;
const pending = new Map();

function start() {
  worker = new Worker(new URL('./worker.js', import.meta.url), {type: 'module'});
  worker.onmessage = ({data: {id, ok, value, error}}) => {
    const {resolve, reject} = pending.get(id);
    pending.delete(id);
    if (ok) resolve(value);
    else reject(new Error(error));
  };
  return send({base: new URL('data/global/', document.baseURI).href});
}

let ready;
function send(message) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, {resolve, reject});
    worker.postMessage({id, ...message});
  });
}

/** api() for the global site: the server's routes and parameters, answered in the browser. */
export async function globalApi(path, params) {
  ready ??= start();
  await ready;
  return send({path, params});
}
