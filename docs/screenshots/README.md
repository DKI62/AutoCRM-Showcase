# Capture the Android demo

Use a fresh Android Emulator profile or a separate lab phone. Verify the launcher shows **Auto CRM Showcase Dev** and the package is `com.autocrm.showcase.dev`. Samsung or POCO customer installations, their backups and their gallery are unnecessary.

1. Run `npm ci`. Set `$env:APP_VARIANT = 'development'` and run `npm run android`.
2. Run `node --import tsx demo/generate.ts`. It creates `.cache/demo-backup/manifest.json` with five synthetic vehicles, notes, events and tasks relative to the current time. Generate and capture on the same date. The generator only writes an ignored folder.
3. Push the folder to the demo device. In the demo app open **Настройки → Контроль и хранение → Восстановить из папки** and select the imported folder. Keep the sample backup separate from any personal exports.

```powershell
adb -s emulator-5554 push .cache/demo-backup /sdcard/Download/AutoCRM-Showcase-Demo
```

If needed, add properly licensed or self-created synthetic media only. The sample intentionally contains no contacts, photos, links or listings.

| File | Capture |
|---|---|
| home-dark.png | Main dashboard with today's reminders |
| vehicles-dark.png | Active vehicle list and filters |
| vehicle-dark.png | In-progress card with prices and timeline |
| create-dark.png | New vehicle form using fictitious values |
| edit-dark.png | Editing a sample vehicle and free-form notes |
| tasks-dark.png | Today and upcoming tasks |
| archive-dark.png | Completed vehicle with its reason |
| settings-dark.png | Settings showing appearance, backup and reminders |
| home-light.png | Same main screen in light theme |
| vehicle-light.png | Same card in light theme |

Capture after closing the emulator notification shade and without personal logins. For lossless frames capture on the device first, then pull to the named path.

```powershell
adb -s emulator-5554 shell screencap -p /sdcard/showcase.png
adb -s emulator-5554 pull /sdcard/showcase.png docs/screenshots/home-dark.png
```

Use a 1280 × 640 GitHub social preview. Set the background to `#101019`, use the name **Auto CRM** and the subtitle **Offline-first Android CRM** on the left, then place two uncropped real captures of the vehicle and task screens on the right. Preserve the original aspect ratios and export `docs/banner.png`. Add photo credits if needed. Review each frame for account names, notification banners and realistic contact data before adding it to the README.

On Windows with Pillow available, run Python on demo/banner.py to compose the two reviewed portrait captures. The script stops if either capture is missing.

No Android captures or screenshot-based banner have been committed yet.
