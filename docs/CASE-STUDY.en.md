[Русский](CASE-STUDY.md) · [**English**](CASE-STUDY.en.md)

# AutoCRM Showcase — engineering case study

[Back to the project](../README.en.md)

## Problem and role

Vehicle sourcing requires keeping track of conversations, inspection photos, and the next follow-up. I designed the data model and Android workflows, built the mobile and server components, and checked storage and reminder behavior.

## On-device data

SQLite stores vehicle records, history, tasks, and settings. A shared query queue keeps unrelated operations out of transactions. When the app records a vehicle action, it commits related changes together. Migrations preserve existing IDs so the associated tasks and attachments stay available.

Photos and videos live outside the database. A backup contains a manifest and media files. Restore checks the sizes and checksums of attachments, adds missing vehicle records, and rebuilds search entries and reminders for those records.

## Reminders and the sync protocol

Expo Notifications schedules local reminders. The Kotlin module checks exact alarm access and opens Android system settings. On startup and when the app returns to the foreground, it reconciles the reminder queue with Android.

The server protocol keeps task revisions and acknowledges exchanges. When an action refers to an older revision, the app can record a conflict and keep the newer data. Tests also cover on-device confirmation of a new pairing. Showcase exercises these paths with synthetic data and simulated delivery. [Server protocol](SERVER.en.md)

## Verification

Tests cover migrations, transaction rollback, data restore, repeated requests, and device isolation. Notification behavior on a device depends on Android permissions and power settings. [Running tests](../README.en.md#testing-and-ci)
