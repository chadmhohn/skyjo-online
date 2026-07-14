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
- `npm run certify:automated` runs the release-only eight-client browser persona, 20-room realtime load, and three SIGKILL persistence/restart trials. It requires the pinned Linux k6 binary in `SKYJO_K6_BIN` and an exact full-SHA production build.

Run `npm exec -- playwright install chromium webkit` once before local browser tests. CI installs the exact browser revisions from the locked `@playwright/test` package without a floating action or browser cache.

## Isolation and determinism

Every Playwright worker starts `server.mjs` on port `0` and waits for the actual port reported by Node. Each worker gets a unique temporary SQLite database, rooms JSON file, cookie names, access password, and session/invite secrets. The process is stopped gracefully and its server log is retained under `test-results/server/` before temporary data is removed.

Domain tests inject a seeded random source. Persistence tests use fixed timestamps and temporary files. Browser tests install a seeded `Math.random` implementation before application code loads. No test reads or writes `.data/`, production state, or production credentials.

Coverage thresholds are ratchets at the measured foundation baseline and must not decrease. The program release target remains at least 90% lines and 85% branches for domain, realtime, and persistence code; protocol and persistence implementation issues are expected to raise the ratchets as their tests land.

## Visual and device limits

Canonical screenshots use Chromium on `ubuntu-24.04` at `390x844`, `820x1180`, `1180x820`, and `1440x900`, with a maximum 0.5% differing-pixel ratio. Other operating systems skip pixel comparison because font rasterization is not portable. Refresh baselines only on the pinned Ubuntu runner after reviewing the rendered diffs.

WebKit projects provide engine and responsive-layout coverage; they do not represent PWA installation, push/audio resume, safe areas, or VoiceOver on a physical iPhone. Those remain part of the final device session.

Lighthouse runs three cold, storage-isolated mobile audits of both the home and solo routes. Performance must score at least 90, accessibility and best practices at least 95, LCP at most 2.5 seconds, CLS at most 0.1, and TBT at most 200 milliseconds. Every threshold fails CI rather than warning.

## Release certification

`CI / Load & Recovery` runs for every pull request, protected-main push, and `v*` tag. It is also a dependency of the VPS canary. The scheduled workflow repeats the same certification from protected `main` each night.

The load lane uses k6 v2.0.0's global `k6/websockets` event loop. Twenty `per-vu-iterations` room controllers each own eight distinct authenticated sockets for ten minutes. Each room serializes 600 authoritative chat-marker commands; all eight clients must observe every resulting revision. The runner rejects anything other than exactly 20 rooms, 160 unique authenticated sessions, 160 connected clients, 12,000 commands, and 96,000 observations. It also rejects an error rate at or above 0.1%, propagation p95 above 250ms, any redaction or revision divergence, interrupted iterations, or measured application RSS at or above 256 MiB.

Account creation is an explicit unmeasured bootstrap stage because password scrypt allocation changes a process's native-memory high-water mark without representing the long-running room workload. One disposable server creates all 160 distinct accounts and durable sessions through the real HTTP API, records its own RSS trace, and stops gracefully. A fresh server then opens the same SQLite and room state. The measured boundary begins before that fresh process proves every session maps to a unique account and continues through all 160 WebSockets and the complete ten-minute workload. No topology, authentication, command, or release-identity proof is omitted by the process restart.

Recovery certification uses three isolated state directories. Each trial establishes a durable baseline, sends acknowledged commands across different offsets in the 250ms persistence window, kills Node with `SIGKILL`, and inspects only the atomic room snapshot. A monotonic clock measures the age of the oldest acknowledged command that is absent from the post-crash snapshot at the instant the crash signal is issued; the RPO is zero when every acknowledgement is durable. That mutation age must be at most 500ms. This definition neither counts an idle gap before the first lost mutation nor omits exposure after the final acknowledgement. Restart readiness and same-seat resynchronization must each finish within 15 seconds.

The bounded stage trace is `test-results/certification/rss-stages.json` with its own SHA-256 sidecar. It records the source SHA, bootstrap and measured-stage peaks, finite periodic samples, the exclusive limit, and whether the measured stage passed; it never contains credentials or process paths. It is written before an RSS gate failure so the exact finite peak survives in CI artifacts. Recovery writes `test-results/certification/recovery-trials.json` and its SHA-256 sidecar after every SIGKILL trial and before enforcing the RPO threshold, preserving only the trial number, acknowledged/durable/lost counts, calculated RPO, and pass result. The combined artifact is `test-results/certification/automated.json` with an exact SHA-256 sidecar. These files contain only bounded release identity, counts, timings, booleans, and digests. Validation rejects credentials, cookies, email addresses, room/player identifiers, filesystem paths, SQL, logs, and raw protocol frames. JSON is canonically key-sorted before checksumming. Do not hand-edit it.
