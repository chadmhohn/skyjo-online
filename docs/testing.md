# Test and CI foundation

Skyjo's deterministic gates run on Node 24 from the locked dependency graph.

## Local gates

- `npm run test:unit` runs the domain/UI and data/storage Vitest suites with coverage.
- `npm run build` creates the client and server output shared by browser and Lighthouse jobs.
- `npm run test:e2e:chromium` runs desktop Chromium behavior tests.
- `npm run test:e2e:webkit` runs phone, tablet portrait, and tablet landscape WebKit projects.
- `npm run test:a11y` rejects serious or critical Axe violations in Chromium and phone WebKit.
- `npm run test:visual` compares the four responsive table baselines on Linux.
- `npm run check:bundle` enforces 90 KiB JavaScript, 17 KiB CSS, and 115 KiB total initial gzip budgets.
- `npm run test:lighthouse` runs the built home and solo routes three times each and evaluates each median Lighthouse result.

Run `npm exec -- playwright install chromium webkit` once before local browser tests. CI installs the exact browser revisions from the locked `@playwright/test` package without a floating action or browser cache.

## Isolation and determinism

Every Playwright worker starts `server.mjs` on port `0` and waits for the actual port reported by Node. Each worker gets a unique temporary SQLite database, rooms JSON file, cookie names, access password, and session/invite secrets. The process is stopped gracefully and its server log is retained under `test-results/server/` before temporary data is removed.

Domain tests inject a seeded random source. Persistence tests use fixed timestamps and temporary files. Browser tests install a seeded `Math.random` implementation before application code loads. No test reads or writes `.data/`, production state, or production credentials.

Coverage thresholds are ratchets at the measured foundation baseline and must not decrease. The program release target remains at least 90% lines and 85% branches for domain, realtime, and persistence code; protocol and persistence implementation issues are expected to raise the ratchets as their tests land.

## Visual and device limits

Canonical screenshots use Chromium on `ubuntu-24.04` at `390x844`, `820x1180`, `1180x820`, and `1440x900`, with a maximum 0.5% differing-pixel ratio. Other operating systems skip pixel comparison because font rasterization is not portable. Refresh baselines only on the pinned Ubuntu runner after reviewing the rendered diffs.

WebKit projects provide engine and responsive-layout coverage; they do not represent PWA installation, push/audio resume, safe areas, or VoiceOver on a physical iPhone. Those remain part of the final device session.

Lighthouse runs three cold, storage-isolated mobile audits of both the home and solo routes. Performance must score at least 90, accessibility and best practices at least 95, LCP at most 2.5 seconds, CLS at most 0.1, and TBT at most 200 milliseconds. Every threshold fails CI rather than warning.
