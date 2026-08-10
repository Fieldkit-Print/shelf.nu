import { existsSync } from "fs";
import { resolve, dirname } from "path";
import { createRequire } from "module";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";
import { reactRouterHonoServer } from "react-router-hono-server/dev";
import { cjsInterop } from "vite-plugin-cjs-interop";
import { VitePWA } from "vite-plugin-pwa";
import { init } from "@paralleldrive/cuid2";

const require = createRequire(import.meta.url);

const createHash = init({
  length: 8,
});

const buildHash = process.env.BUILD_HASH || createHash();

// Resolve the generated Prisma browser entry that contains enum runtime values.
// In pnpm, .prisma/client lives inside the @prisma/client store directory,
// not at the project root, so we resolve the path dynamically.
const prismaClientDir = dirname(require.resolve("@prisma/client/package.json"));
const prismaClientIndexBrowser = resolve(
  prismaClientDir,
  "../../.prisma/client/index-browser.js"
);

// Fail fast if the Prisma browser bundle is missing. Without it, enums like
// OrganizationRoles silently resolve to `undefined` in the browser at runtime.
if (!existsSync(prismaClientIndexBrowser)) {
  throw new Error(
    `Prisma browser bundle not found at ${prismaClientIndexBrowser}. ` +
      `Run "prisma generate" or check that the .prisma/client path is correct.`
  );
}

// Use HTTPS when cert files are present (mkcert / local dev).
// Skip HTTPS with DISABLE_HTTPS=true (e.g. mobile companion testing over LAN).
const certKeyPath = resolve(__dirname, ".cert/key.pem");
const certPath = resolve(__dirname, ".cert/cert.pem");
const httpsConfig =
  process.env.DISABLE_HTTPS !== "true" &&
  existsSync(certKeyPath) &&
  existsSync(certPath)
    ? { key: certKeyPath, cert: certPath }
    : undefined;

export default defineConfig(({ isSsrBuild }) => ({
  envDir: "../..",
  ssr: {
    noExternal: ["@shelf/database"],
  },
  server: {
    port: 3000,
    https: httpsConfig,
    warmup: {
      clientFiles: [
        "./app/entry.client.tsx",
        "./app/root.tsx",
        "./app/routes/**/*.tsx",
        "./app/routes/**/*.ts",
        "!./app/routes/**/*.test.server.ts",
      ],
    },
  },
  optimizeDeps: {
    include: ["./app/routes/**/*.tsx", "./app/routes/**/*.ts"],
  },
  build: {
    target: "ES2022",
    assetsDir: `file-assets`,
    rollupOptions: {
      output: {
        entryFileNames: `file-assets/${buildHash}/[name]-[hash].js`,
        chunkFileNames() {
          return `file-assets/${buildHash}/[name]-[hash].js`;
        },
        assetFileNames() {
          return `file-assets/${buildHash}/[name][extname]`;
        },
      },
    },
  },
  resolve: {
    alias: {
      ".prisma/client/index-browser": prismaClientIndexBrowser,
      // Use lottie_light version to avoid eval warnings
      "lottie-web": "lottie-web/build/player/lottie_light.js",
    },
  },
  plugins: [
    cjsInterop({
      // List of CJS dependencies that require interop
      dependencies: ["react-microsoft-clarity", "@markdoc/markdoc"],
    }),
    reactRouterHonoServer({
      serverEntryPoint: "./server/index.ts",
    }),
    reactRouter(),
    tsconfigPaths(),
    /**
     * PWA packaging — primarily so the warehouse scanner is installable and
     * survives bad Wi-Fi.
     *
     * Notes specific to this app being SSR (React Router + Hono), not an SPA:
     *
     * - No `navigateFallback`. Documents are server-rendered per request; a
     *   cached app shell would serve stale HTML and break loader data.
     *   Navigations stay NetworkFirst so the app degrades to a real offline
     *   page rather than silently showing yesterday's screen.
     * - `manifest: false` — we already ship and link a hand-written manifest
     *   at /static/manifest.json, and letting the plugin emit a second one
     *   means two competing manifests.
     *
     * The payoff is the zxing WASM: ~1MB that previously came from a CDN on
     * first decode. Precached here, the scanner starts instantly and keeps
     * decoding when the network drops.
     */
    /**
     * Client build only. React Router runs Vite twice; without this guard the
     * SSR pass emits a second, never-served service worker into build/server
     * and does the whole precache walk again for nothing.
     */
    !isSsrBuild &&
      VitePWA({
        registerType: "autoUpdate",
        injectRegister: "script-defer",
        manifest: false,
        /**
         * React Router emits the browser bundle to `build/client`, not Vite's
         * default `dist`. Without this the plugin writes sw.js into an empty
         * `dist/` and reports "precache 0 entries" — a service worker that
         * ships and caches nothing, which is worse than none at all because it
         * looks installed.
         */
        outDir: "build/client",
        workbox: {
          // The decoder binary is the whole point — it must be precached.
          globPatterns: ["**/*.{js,css,wasm,woff2}"],
          // Default is 2MB; the zxing binary alone is ~1MB.
          maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
          navigateFallback: undefined,
          cleanupOutdatedCaches: true,
          clientsClaim: true,
          skipWaiting: true,
          runtimeCaching: [
            {
              // Asset images and QR previews: show something rather than a
              // broken icon when the connection drops mid-shift.
              urlPattern: ({ request }: { request: Request }) =>
                request.destination === "image",
              handler: "StaleWhileRevalidate",
              options: {
                cacheName: "images",
                expiration: {
                  maxEntries: 200,
                  maxAgeSeconds: 60 * 60 * 24 * 7,
                },
              },
            },
          ],
        },
        devOptions: {
          // Keep the service worker out of the way during development —
          // a stale precache while iterating is worse than no offline support.
          enabled: false,
        },
      }),
  ],
}));
