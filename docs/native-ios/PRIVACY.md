# Native Privacy Inventory

This file is the repository-owned draft for the native app privacy manifest and App Store Connect privacy answers. It describes Skyjo Online v0.1.0 behavior; it is not a substitute for the public privacy policy required before a public App Store listing.

## Collected Data

The native app and first-party Skyjo server use the following data only for app functionality. Every category is linked to the account or device that supplied it, none is used for tracking, advertising, marketing, analytics, or sale, and there are no tracking domains.

| Apple category | Skyjo data | App functionality |
| --- | --- | --- |
| Name | Player display name | Account profile, room roster, scoring, and history |
| Email Address | Account email address | Authentication and account recovery/administration |
| Emails or Text Messages | In-room chat messages | Friend-facing multiplayer chat |
| Gameplay Content | Solo saves delivered for account stats, multiplayer state, results, and history | Resume games, enforce rules, synchronize rooms, and show stats |
| User ID | Server account ID | Own sessions, seats, saves, history, and administrative state |
| Device ID | Random installation ID and APNs device token | Register and retire per-installation turn notifications |
| Product Interaction | Successful-login timestamp | Protect accounts and operate authenticated sessions |
| Other Data Types | Notification environment, app version, and locale | Route APNs correctly and diagnose registration compatibility |

Passwords are transmitted only to authenticate or change credentials and are stored by the server as password hashes. Session cookies, invite tokens, APNs device tokens, and encrypted notification registration fields are security credentials, not analytics identifiers; they must remain absent from logs and artifacts.

## Data Not Collected

Skyjo v0.1.0 contains no advertising, third-party analytics, crash-reporting SDK, location, contacts, photos, audio recording, health, financial, purchase, browsing, or search collection. It does not use App Tracking Transparency because it does not track users across companies' apps, sites, or offline properties.

## Accessed APIs And Dependencies

- `UserDefaults` is declared with required-reason code `CA92.1` for preferences that are available only inside Skyjo.
- Native production code uses Apple frameworks and repository-local Swift packages only. There are no remote Swift Package Manager, binary, advertising, analytics, or crash-reporting dependencies.
- Runtime SBOM generation remains available through `npm run release:sbom`; it describes the server artifact and does not change the native privacy answers.

## Logging And Retention Boundaries

- Logs and evidence redact email addresses, cookies, passwords, invitation tokens, APNs tokens/fingerprints, provider credentials, room frames, hidden cards, and non-viewer drawn cards.
- Account, multiplayer, chat, game-history, and APNs retention are server-owned. Guest solo saves remain local and are not included in the App Store collection disclosure unless later delivered under an authenticated account.
- APNs registrations are deleted on opt-out/logout and safely retired after permanent provider rejection. Account data deletion remains tracked by issue #192.

## App Store Connect Answer Draft

Declare **Data Linked to You** for Name, Email Address, Emails or Text Messages, Gameplay Content, User ID, Device ID, Product Interaction, and Other Data Types. Select **App Functionality** as the only purpose for each. Select **No** for tracking and do not declare any data under **Data Used to Track You**.

This inventory creates no additional privacy blocker for internal TestFlight. External TestFlight still requires issue #193 branding/rights closure, Beta App Review readiness, and the documented physical gates. Public App Store submission is not authorized until issue #192 supplies in-app account deletion and the owner confirms the final privacy policy URL and App Store Connect answers.
