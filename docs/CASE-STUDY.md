# Auto CRM · engineering case study

## Problem and role

The client needed a phone-first record of vehicle leads, inspection history and callbacks that continued to work without reliable connectivity. I designed the data model and Android workflow, implemented mobile and server code, investigated device-specific failures, and prepared signed APK updates and migration checks.

## Local data and ownership

SQLite is the source of truth for vehicle cards, notes, tasks, timeline events, attachment metadata and settings. The repository queues writes and groups changes that must succeed together in transactions. Migrations preserve stable IDs and relationships. Images and video live in app-private storage, and backup manifests verify filenames, sizes, checksums and referential consistency. Restore merges records and rebuilds relevant indexes and reminders.

## Queue and companion service

A device-scoped outbox records task revisions. The phone sends a narrow projection, retries transient failures and advances its upload state after an acknowledgement. Inbound actions are ordered and applied transactionally. Stale actions can record a conflict without overwriting newer CRM edits.

The companion service uses a Cloudflare Worker and D1 for authorized task mirrors, queued actions and scheduled reminders. Pairing v2 stages the account and requires confirmation with a code on the CRM device. Short-lived pairing links do not grant access on their own. Compatibility tests exercise old device keys, non-empty queues, action acknowledgement and rejection of uploads before confirmation.

## Android behavior and delivery

Local reminders use Android notification channels and permission-aware scheduling. The native alarm module opens the appropriate system settings. Telegram's one overdue repeat and Android's local notification are separate paths. Folder exports support recovery and are validated before merge.

Expo prebuild and EAS were used in the deployed edition. Signed updates retain the package and certificate and advance the Android version code. Artifact checks compare the manifest and signer before a device update. APK availability and physical acceptance are distinct checkpoints.

## Limits

The app targets Android. Exact reminder delivery depends on platform policy. The Showcase app runs locally. Its server protocol tests use temporary SQLite through a D1 adapter and a fake Telegram transport. Device acceptance requires testing on Android hardware. [Architecture diagram](../README.en.md#stack-and-architecture) · [Dependency review and CI](GITHUB.md#verification-notes).

## Résumé summary

Built an offline-first Android CRM for automotive workflows using React Native, Expo and SQLite. Implemented transactional migrations, media backup and restore, permission-aware native reminders, and a revisioned Telegram synchronization protocol with device-confirmed pairing on Cloudflare Workers and D1.
