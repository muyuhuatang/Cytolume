/** Boot the committed HRA snapshot. Failure is explicit; there is no CDN fallback. */
import type { BodySex } from './body-map.ts';

const appBase = new URL(import.meta.env.BASE_URL, window.location.href);
const root = new URL('vendor/hra/', appBase);

interface Snapshot {
  schemaVersion: number;
  id: string;
  component: { script: string; stylesheet: string };
  files: Array<{ path: string; sha256: string }>;
}

let loaded: Promise<Snapshot> | undefined;
let workerReady: Promise<ServiceWorker> | undefined;

function resource(path: string): URL {
  const url = new URL(path, root);
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) throw new Error('Invalid HRA snapshot path');
  return url;
}

function loadSnapshot(): Promise<Snapshot> {
  loaded ??= fetch(resource('snapshot.json'), { cache: 'no-cache' }).then(async response => {
    if (!response.ok) throw new Error(`Local HRA snapshot is missing (${response.status})`);
    const value = await response.json() as Snapshot;
    if (value.schemaVersion !== 1 || !/^[a-f0-9]{20}$/.test(value.id)) throw new Error('Invalid local HRA snapshot');
    return value;
  });
  return loaded;
}

function timeout<T>(promise: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), milliseconds);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

async function localWorker(snapshot: Snapshot): Promise<ServiceWorker> {
  workerReady ??= (async () => {
    if (!('serviceWorker' in navigator)) throw new Error('The local HRA panel requires HTTPS or localhost');
    const url = new URL('hra-scene-sw.js', appBase);
    url.searchParams.set('snapshot', snapshot.id);
    const registration = await navigator.serviceWorker.register(url.href, { scope: appBase.pathname, updateViaCache: 'none' });
    const worker = registration.installing ?? registration.waiting ?? registration.active;
    if (!worker || worker.scriptURL !== url.href) throw new Error('The local HRA worker did not register');
    if (worker.state !== 'activated') {
      await timeout(new Promise<void>((resolve, reject) => {
        const check = (): void => {
          if (worker.state === 'activated' || worker.state === 'redundant') {
            worker.removeEventListener('statechange', check);
            if (worker.state === 'activated') resolve();
            else reject(new Error('The local HRA worker failed to activate'));
          }
        };
        worker.addEventListener('statechange', check);
        check();
      }), 15000, 'Local HRA worker activation timed out');
    }
    return worker;
  })();
  return workerReady;
}

/** Acknowledged before the component requests scenes; independent per tab. */
export async function setHraBodySex(sex: BodySex): Promise<void> {
  const snapshot = await loadSnapshot();
  const worker = await localWorker(snapshot);
  const channel = new MessageChannel();
  try {
    const ack = new Promise<void>((resolve, reject) => {
      channel.port1.onmessage = event => {
        if (event.data?.ok && event.data.snapshot === snapshot.id) resolve();
        else reject(new Error(event.data?.error ?? 'Local HRA worker handshake failed'));
      };
    });
    worker.postMessage({ type: 'cyto:hra-init', snapshot: snapshot.id, sex }, [channel.port2]);
    await timeout(ack, 15000, 'Local HRA snapshot handshake timed out');
    if (navigator.serviceWorker.controller?.scriptURL !== worker.scriptURL) {
      await timeout(new Promise<void>(resolve => {
        const check = (): void => {
          if (navigator.serviceWorker.controller?.scriptURL === worker.scriptURL) {
            navigator.serviceWorker.removeEventListener('controllerchange', check);
            resolve();
          }
        };
        navigator.serviceWorker.addEventListener('controllerchange', check);
        check();
      }), 5000, 'The local HRA worker is not controlling this page');
    }
  } finally { channel.port1.close(); channel.port2.close(); }
}

let bundle: Promise<void> | undefined;

/** Load local bytes with SRI after the static API adapter has taken control. */
export async function loadHraBody(sex: BodySex): Promise<void> {
  await setHraBodySex(sex);
  const snapshot = await loadSnapshot();
  bundle ??= (async () => {
    const global = globalThis as unknown as { __cytolumeHraApiBase: string; dbOptions?: Record<string, unknown> };
    global.__cytolumeHraApiBase = new URL('api', root).href;
    global.dbOptions = { ...global.dbOptions, remoteApiEndpoint: global.__cytolumeHraApiBase, dataSources: [] };
    const integrity = (path: string): string => {
      const hash = snapshot.files.find(record => record.path === path)?.sha256;
      if (!hash || !/^[a-f0-9]{64}$/.test(hash)) throw new Error(`Missing HRA integrity record: ${path}`);
      return `sha256-${btoa(String.fromCharCode(...hash.match(/../g)!.map(x => parseInt(x, 16))))}`;
    };
    const style = document.createElement('link');
    style.rel = 'stylesheet';
    style.href = resource(snapshot.component.stylesheet).href;
    style.integrity = integrity(snapshot.component.stylesheet);
    document.head.appendChild(style);
    await timeout(new Promise<void>((resolve, reject) => {
      const script = document.createElement('script');
      script.src = resource(snapshot.component.script).href;
      script.integrity = integrity(snapshot.component.script);
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('The pinned local HRA component failed to load or failed its integrity check'));
      document.head.appendChild(script);
    }), 15000, 'Local HRA component load timed out');
    await timeout(customElements.whenDefined('ccf-body-ui-wc'), 15000, 'Local HRA component registration timed out');
  })();
  return bundle;
}

export const hraAttributionUrl = new URL('ATTRIBUTION.txt', root).href;
