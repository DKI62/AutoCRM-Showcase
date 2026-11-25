[Русский](SECURITY.md) · [**English**](SECURITY.en.md)

# Security

[Back to the project](README.en.md)

Report vulnerabilities privately through GitHub or directly to the maintainer. Use test data and omit tokens and real records.

Showcase disables live Telegram and Expo OTA. Server tests use synthetic data. Backups are unencrypted; keep them and credentials out of Git.

## Known advisories

Three High entries in `npm audit` reflect one dependency chain: `expo-router@57.0.31` → `query-string@7.1.3` → `decode-uri-component@0.2.2` ([CVE-2026-118664](https://github.com/advisories/GHSA-qr28-fpjm-wq7f), [CVE-2026-45822](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr)). Malformed input can affect application availability.

Showcase limits incoming URL length and rejects malformed encoding. The Worker bundle excludes this chain. The vulnerabilities remain unresolved: a direct decoder upgrade is incompatible with the current CommonJS call. A separately verified Expo Router upgrade or backport is required.
