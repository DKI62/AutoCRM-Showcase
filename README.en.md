[Русский](README.md) · [**English**](README.en.md)

# AutoCRM Showcase

![AutoCRM Showcase dashboard, vehicle list, and photo attachments captured on Android](docs/banner.png)

**Offline-first Android CRM for vehicle sourcing and follow-up.**

Vehicle sourcing involves calls, inspection photos, estimates, and reminders. When that information is spread across apps, it is easy to lose the next action. AutoCRM keeps it with the vehicle record, so it can be checked and updated during an inspection with limited connectivity.

Showcase is a portfolio edition with its own Android package and sample records. [Engineering case study](docs/CASE-STUDY.md) · [Samsung setup](docs/ANDROID-DEMO.md)

## Features

- Vehicle records with specifications, valuations, statuses, search, and filters.
- Photo and video attachments, notes, and a timeline for each vehicle.
- Tasks with rescheduling, recurrence, and local Android reminders.
- Vehicle archive, folder-based export, and validated restore.
- Light, dark, and system appearance settings.

## Gallery

These screens were captured on a Samsung running Showcase with sample records. Select an image to open the full capture.

<!-- showcase-gallery:start -->

| | |
|---|---|
| <strong>Dashboard and agenda</strong><br><a href="docs/screenshots/home-dark.png"><img src="docs/screenshots/home-dark.png" alt="Dashboard and agenda" width="255"></a> | <strong>Vehicle list and filters</strong><br><a href="docs/screenshots/vehicles-dark.png"><img src="docs/screenshots/vehicles-dark.png" alt="Vehicle list and filters" width="255"></a> |
| <strong>Vehicle card and photos</strong><br><a href="docs/screenshots/vehicle-photos-dark.png"><img src="docs/screenshots/vehicle-photos-dark.png" alt="Vehicle card and photos" width="255"></a> | <strong>Notes and vehicle timeline</strong><br><a href="docs/screenshots/history-dark.png"><img src="docs/screenshots/history-dark.png" alt="Notes and vehicle timeline" width="255"></a> |
| <strong>Active tasks</strong><br><a href="docs/screenshots/tasks-dark.png"><img src="docs/screenshots/tasks-dark.png" alt="Active tasks" width="255"></a> | <strong>Scheduling and recurrence</strong><br><a href="docs/screenshots/task-edit-dark.png"><img src="docs/screenshots/task-edit-dark.png" alt="Scheduling and recurrence" width="255"></a> |
| <strong>Vehicle archive</strong><br><a href="docs/screenshots/archive-dark.png"><img src="docs/screenshots/archive-dark.png" alt="Vehicle archive" width="255"></a> | <strong>Dashboard in light mode</strong><br><a href="docs/screenshots/home-light.png"><img src="docs/screenshots/home-light.png" alt="Dashboard in light mode" width="255"></a> |
| <strong>Notification settings</strong><br><a href="docs/screenshots/notifications-dark.png"><img src="docs/screenshots/notifications-dark.png" alt="Notification settings" width="255"></a> | <strong>Backup and restore</strong><br><a href="docs/screenshots/backup-dark.png"><img src="docs/screenshots/backup-dark.png" alt="Backup and restore" width="255"></a> |

<!-- showcase-gallery:end -->

## Stack and architecture

React Native, Expo SDK 57, Expo Router, TypeScript, SQLite, and a project-local Expo module in Kotlin that opens Android's exact alarm settings. The repository also contains Cloudflare Worker handlers and protocol tests with a D1 adapter and a simulated Telegram transport.

```mermaid
flowchart LR
    subgraph Mobile ["Showcase on Android"]
        Screens["Expo Router screens"] --> Repository["CRM repository"]
        Repository --> SQLite[("SQLite records and task outbox")]
        Repository --> Media["App-private photo and video files"]
        Repository --> Reminders["Android notification channels and alarms"]
        Repository --> Backup["Folder export and restore"]
    end

    subgraph Tests ["Server protocol tests"]
        Fixtures["Synthetic requests"] --> Worker["Worker handlers"]
        Worker --> D1[("Temporary SQLite through a D1 adapter")]
        Worker --> FakeBot["Simulated Telegram responses"]
    end
```

SQLite stores vehicles, notes, tasks, timeline events, and settings. The [CRM repository](src/repositories/crm-repository.ts) serializes writes and groups related changes into transactions. [Migrations](src/storage/migrations.ts) preserve IDs and relationships. Photos and videos live in app-private storage. Restore verifies paths, sizes, checksums, and record relationships.

## Run locally

On Windows, use Node.js 24, npm, JDK 17, and an Android SDK with an emulator or a test device.

```powershell
npm ci
$env:APP_VARIANT = 'development'
npm run android
```

Use `npm start` to restart Metro. The development package is `com.autocrm.showcase.dev`. The standalone package is `com.autocrm.showcase` and runs without Metro. [Build the APK and import sample data](docs/ANDROID-DEMO.md)

## Checks

```powershell
npm run typecheck
npx --no-install eslint src server tests demo app.config.ts
npm test
```

On Windows the suite includes native SQLite regressions and server protocol tests with synthetic data. [CI and known dependency advisories](docs/GITHUB.md)

## Demo scope and limitations

Showcase runs locally. Live Telegram and OTA are disabled. Pairing and synchronization are exercised by isolated tests. Notification timing depends on Android permissions and power management. Folder exports are stored unencrypted. [Server tests](docs/SERVER.md) · [Changelog](CHANGELOG.md) · [Security policy](SECURITY.md)

## Licensing

**All rights reserved.** This repository is provided for portfolio review. Third-party components retain their own licenses and notices. [Terms](LICENSE.md)
