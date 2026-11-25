[Русский](ANDROID.md) · [**English**](ANDROID.en.md)

# Android build and sample data

[Back to the project](../README.en.md)

## Prerequisites

Install Node.js 24 with npm, JDK 17, Android Studio, and the Android SDK with Platform Tools and Build-Tools. Use PowerShell 7.2 or later. Windows PowerShell 5.1 parses the build script, but its error handling can stop the script when `java -version` writes to stderr. Set up an emulator or connect an Android device with USB debugging enabled. Check the Java version with `java -version` and device access with `adb devices`. Set `JAVA_HOME` to JDK 17 and set `ANDROID_HOME` if the SDK is installed outside the default location.

The initial dependency installation and Gradle setup require an internet connection. Run the commands from the repository root.

## Development build

```powershell
npm ci
$env:APP_VARIANT = 'development'
npm run android
# To restart Metro later
npm start
```

The development build uses `com.autocrm.showcase.dev`. Expo Go lacks the `AutoCrmAlarmAccess` module, which checks exact alarm access on Android and opens system settings.

## Standalone APK

Build the standalone variant in a separate checkout without a generated `android` directory from the development build. The script checks the `com.autocrm.showcase` package, demo signing configuration, and APK manifest.

```powershell
npm ci
pwsh -NoProfile -File demo/build-samsung.ps1
pwsh -NoProfile -File demo/pack-sample.ps1
```

The first script writes `.cache/samsung/auto-crm-showcase.apk`. The second creates `.cache/samsung/auto-crm-showcase-data.zip`. The standalone app runs without Metro.

## Import the sample data

1. Copy the APK and ZIP to your Android device. Install **Auto CRM Showcase**.
2. Extract the ZIP into its own folder. In the app, open **Настройки → Контроль и хранение → Восстановить из папки** (Settings → Review and storage → Restore from folder).
3. Select the folder containing `manifest.json` and `media`, then confirm the import. The sample has five vehicles, four tasks, history, and a demo photo. Importing it again skips vehicle IDs already present in the app.
