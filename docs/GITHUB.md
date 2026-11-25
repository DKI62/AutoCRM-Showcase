# GitHub listing draft

**Description** — Offline-first Android CRM for automotive professionals. An isolated portfolio edition built with React Native, Expo, SQLite and a tested Cloudflare Worker protocol.

**Topics** — `android`, `react-native`, `expo`, `typescript`, `sqlite`, `offline-first`, `crm`, `automotive`, `cloudflare-workers`, `telegram-bot`, `portfolio`.

The [CI workflow](../.github/workflows/ci.yml) runs on Windows because the suite includes a native SQLite regression through Windows SQLite. It installs the lockfile, checks TypeScript, lints source and runs the automated tests. The workflow requests read-only repo access and uses synthetic server fixtures. It references no deployment or account secrets.

[Repository banner](banner.png)

## Verification notes

Expo Doctor passed 20 of 21 checks. The remaining check recommends patch updates for 10 Expo SDK 57 packages. Versions remain pinned to the verified lockfile.

The 25 November 2026 production audit reports three High entries in a single dependency chain.

| Installed version | Relationship | Finding |
| --- | --- | --- |
| `expo-router@57.0.31` | Direct | Inherits the finding through `query-string` |
| `query-string@7.1.3` | Transitive through Expo Router | Inherits the decoder advisories |
| `decode-uri-component@0.2.2` | Transitive through `query-string` | Availability issues CVE-2026-118664 (High) and CVE-2026-45822 (Moderate) |

All three entries belong to the Android runtime dependency tree. The vulnerable decoder can consume excessive CPU if untrusted input reaches its fallback parser. The Showcase system URL hook limits input to 4,096 characters and rejects malformed encoding before routing. The app's main Expo Router query parser uses URLSearchParams. This mitigates the reviewed Android entry points. Exploitability in the Showcase APK was not demonstrated. The Worker bundle excludes this dependency chain. [System URL guard](../src/services/system-path.ts) · [CVE-2026-118664 / GHSA-qr28-fpjm-wq7f](https://github.com/advisories/GHSA-qr28-fpjm-wq7f) · [CVE-2026-45822 / GHSA-vcc3-ghjq-m6fr](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr).

Decoder `0.5.1` addresses both advisories and ships as ESM. The installed `query-string@7.1.3` calls its CommonJS import as a function, which makes a plain override incompatible. Router `57.0.32` still uses the same chain. Expo Router `58.0.13` removes `query-string`. npm recommends `58.0.32`, which belongs to SDK 58 and requires a compatible native runtime and a new APK. The current APK and lockfile retain the SDK 57 chain. [Router 57.0.32 package metadata](https://registry.npmjs.org/expo-router/57.0.32) · [Router 58.0.13 package metadata](https://registry.npmjs.org/expo-router/58.0.13) · [Expo SDK compatibility](https://docs.expo.dev/versions/latest/).
