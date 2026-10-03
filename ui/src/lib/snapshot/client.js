// The page's side of a snapshot: it is one when the exported index.html says
// so, and then api() is answered by the engine in a worker instead of the server.

/** True on a published snapshot; the live server's page has no such tag. */
export const isSnapshot = () => document.querySelector('meta[name="tsum-snapshot"]') !== null;

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
  return send({base: new URL('data/snapshot/', document.baseURI).href});
}

let ready;
function send(message) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, {resolve, reject});
    worker.postMessage({id, ...message});
  });
}

/** api() for a snapshot: same routes and parameters, answered in the browser. */
export async function snapshotApi(path, params) {
  ready ??= start();
  await ready;
  return send({path, params});
}
