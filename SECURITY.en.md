[Русский](SECURITY.md) · [**English**](SECURITY.en.md)

# Security

[Back to the project](README.en.md)

Report vulnerabilities through GitHub's private reporting feature where available, or contact the maintainer privately. Include the affected version, steps using test data, and the expected result. Omit tokens, real records, and database exports.

Showcase disables live Telegram and Expo OTA updates. Server tests use synthetic data. Folder exports are unencrypted. Keep backups, keys, and local environment settings out of Git.

## Known advisories

Three High entries in `npm audit` reflect one Android dependency chain: `expo-router@57.0.31` → `query-string@7.1.3` → `decode-uri-component@0.2.2`. The decoder advisories concern availability when processing malformed input. Showcase limits incoming URL length and rejects malformed encoding. The Worker bundle excludes this chain. [CVE-2026-118664](https://github.com/advisories/GHSA-qr28-fpjm-wq7f) · [CVE-2026-45822](https://github.com/advisories/GHSA-vcc3-ghjq-m6fr)

Overriding the decoder with the patched ESM release `0.5.1` would break the CommonJS call in `query-string@7.1.3`. The checked Router 57.0.32 release retains this chain. Router 58.0.13 removes the `query-string` dependency. Fixing it on SDK 57 requires a separately tested backport. [Router 57.0.32 metadata](https://registry.npmjs.org/expo-router/57.0.32) · [Router 58.0.13 metadata](https://registry.npmjs.org/expo-router/58.0.13)
