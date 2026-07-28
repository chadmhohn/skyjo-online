# Skyjo client contracts

`contracts/v1` is the portable client/server contract bundle for the native app and the web client. Contract bundle versions are independent from the multiplayer protocol, shared-snapshot envelope, presence, database, and persistence schema versions.

## Authority and compatibility

- `game-state.schema.json` describes complete authoritative game state. It is never safe to send this shape to an untrusted client.
- `public-room-snapshot.schema.json` describes the redacted room snapshot. Face-down values are `null`, the draw pile is a count, the discard pile exposes only its top card, and a blind-drawn card is visible only to its current drawer.
- Protocol-v2 frames are exact. A removed, renamed, or retyped field or a changed action meaning requires an appropriate protocol or envelope version change.
- HTTP clients must ignore additive response fields. Canonical producer fixtures remain exact so accidental output and privacy leaks are detected.
- Optional WebSocket fields are omitted rather than encoded as `null`.
- Revisions are non-negative JavaScript-safe integers. Account, room, and game timestamps are epoch milliseconds; `/version` uses a canonical ISO-8601 timestamp.

JSON Schema enforces portable shape and bounds. Executable validators remain co-authoritative for relationships JSON Schema cannot express, including deck conservation, roster ordering and membership, phase coherence, viewer-specific hidden-card visibility, frame byte limits, and revision transitions.

`operational.schema.json` covers the JSON `/readyz` and `/version` responses. `/healthz` intentionally remains the plain-text body `ok` and is not a JSON DTO.

## Fixtures

Fixtures are synthetic and contain no credentials, cookies, tokens, production room data, or unredacted private wire captures.

```sh
npm run contracts:fixtures:check
npm run contracts:fixtures:update
npm run test:unit:contracts
npm run test:domain:parity
```

`domain-parity.json` is the executable IOS-3 golden corpus. It pins seeded deck and roster states, named rule transitions, strategy-version-1 AI decisions, hidden-information projections, and fixed/Mixed solo setup assignments. The domain-parity command checks the same corpus in TypeScript and Swift and enforces the Swift domain coverage floor.

The update command generates into a temporary directory, hashes every fixture in `manifest.json`, and atomically replaces the fixture directory only when its existing git state is clean. The check command never writes and fails for missing, stale, or unexpected files.

To change a contract, update the schema and producer together, deliberately regenerate the fixtures, review the semantic and privacy changes, and commit all three in the same pull request.
