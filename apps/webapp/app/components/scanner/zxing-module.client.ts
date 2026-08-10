/**
 * Serves the zxing decoder WASM from our own origin.
 *
 * By default `zxing-wasm` fetches its ~1MB WASM binary from
 * `https://fastly.jsdelivr.net/npm/zxing-wasm@<version>/dist/` at runtime, on
 * first decode. That makes scanning depend on a third-party CDN being
 * reachable — the exact thing that fails on warehouse Wi-Fi, and the reason
 * the scanner can sit there showing a live camera feed while decoding nothing.
 *
 * Importing the binary with Vite's `?url` emits it into our client bundle with
 * a content hash, so it is same-origin, versioned with the deploy, and
 * cacheable by the service worker. Once cached the scanner starts instantly
 * and keeps working offline.
 *
 * `.client` suffix: this must never run during SSR. `setZXingModuleOverrides`
 * mutates module-level state in zxing-wasm, and doing that on the server would
 * leak one request's configuration into the next.
 *
 * @see {@link file://./utils.tsx} the decode path that consumes this
 */

import { setZXingModuleOverrides } from "zxing-wasm/reader";
import wasmUrl from "zxing-wasm/reader/zxing_reader.wasm?url";

let configured = false;

/**
 * Points zxing at the locally-served WASM. Idempotent — safe to call from
 * every component that decodes, which is how we guarantee it runs before the
 * first `readBarcodes` without ordering imports carefully.
 */
export function configureZXingWasm(): void {
  if (configured) return;
  configured = true;

  setZXingModuleOverrides({
    /**
     * Emscripten's hook for resolving auxiliary files. Only the `.wasm` is
     * redirected; anything else falls back to the default resolution so a
     * future zxing release adding a sidecar file doesn't silently 404.
     */
    locateFile: (path: string, prefix: string) =>
      path.endsWith(".wasm") ? wasmUrl : `${prefix}${path}`,
  });
}

/** The resolved same-origin URL, exported so the service worker can precache it. */
export const ZXING_WASM_URL = wasmUrl;
