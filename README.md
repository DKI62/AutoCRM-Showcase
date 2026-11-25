[**Русский**](README.md) · [English](README.en.md)

# AutoCRM Showcase

![AutoCRM Showcase. Главная, список автомобилей и фотографии из реальной Android-сборки](docs/banner.png)

**Автономная Android CRM для подбора и оценки автомобилей.**

В работе с автомобилем легко потерять договорённости, фотографии осмотра и срок следующего звонка, если они лежат в разных приложениях. AutoCRM собирает их в карточке автомобиля. Информацию можно открыть и обновить без связи, например во время осмотра.

Showcase — портфолио-версия с отдельным Android-пакетом и демонстрационными данными. [Инженерный кейс](docs/CASE-STUDY.md) · [Запуск на Samsung](docs/ANDROID-DEMO.md)

## Возможности

- Карточки автомобилей с характеристиками, оценками, статусами, поиском и фильтрами.
- Фото и видео, заметки и история изменений по автомобилю.
- Задачи, перенос сроков, повторения и локальные напоминания Android.
- Архив автомобилей, экспорт и восстановление из папки.
- Светлая, тёмная и системная темы.

## Галерея

Кадры сняты на Samsung в Showcase с демонстрационными записями. Нажмите на изображение, чтобы открыть его в полном размере.

<!-- showcase-gallery:start -->

| | |
|---|---|
| <strong>Главная и план дня</strong><br><a href="docs/screenshots/home-dark.png"><img src="docs/screenshots/home-dark.png" alt="Главная и план дня" width="255"></a> | <strong>Автомобили и фильтры</strong><br><a href="docs/screenshots/vehicles-dark.png"><img src="docs/screenshots/vehicles-dark.png" alt="Автомобили и фильтры" width="255"></a> |
| <strong>Карточка и фотографии</strong><br><a href="docs/screenshots/vehicle-photos-dark.png"><img src="docs/screenshots/vehicle-photos-dark.png" alt="Карточка и фотографии" width="255"></a> | <strong>Заметки и история</strong><br><a href="docs/screenshots/history-dark.png"><img src="docs/screenshots/history-dark.png" alt="Заметки и история" width="255"></a> |
| <strong>Активные задачи</strong><br><a href="docs/screenshots/tasks-dark.png"><img src="docs/screenshots/tasks-dark.png" alt="Активные задачи" width="255"></a> | <strong>Сроки и повторения</strong><br><a href="docs/screenshots/task-edit-dark.png"><img src="docs/screenshots/task-edit-dark.png" alt="Сроки и повторения" width="255"></a> |
| <strong>Архив автомобилей</strong><br><a href="docs/screenshots/archive-dark.png"><img src="docs/screenshots/archive-dark.png" alt="Архив автомобилей" width="255"></a> | <strong>Главная в светлой теме</strong><br><a href="docs/screenshots/home-light.png"><img src="docs/screenshots/home-light.png" alt="Главная в светлой теме" width="255"></a> |
| <strong>Настройки уведомлений</strong><br><a href="docs/screenshots/notifications-dark.png"><img src="docs/screenshots/notifications-dark.png" alt="Настройки уведомлений" width="255"></a> | <strong>Экспорт и восстановление</strong><br><a href="docs/screenshots/backup-dark.png"><img src="docs/screenshots/backup-dark.png" alt="Экспорт и восстановление" width="255"></a> |

<!-- showcase-gallery:end -->

## Стек и архитектура

React Native, Expo SDK 57, Expo Router, TypeScript, SQLite и локальный модуль Expo на Kotlin для открытия настроек точных будильников Android. В репозитории также есть обработчики Cloudflare Worker и тесты протокола с адаптером D1 и имитацией Telegram.

```mermaid
flowchart LR
    subgraph Mobile ["Showcase на Android"]
        Screens["Экраны Expo Router"] --> Repository["Репозиторий CRM"]
        Repository --> SQLite[("SQLite и очередь изменений задач")]
        Repository --> Media["Фото и видео в каталоге приложения"]
        Repository --> Reminders["Каналы уведомлений и будильники Android"]
        Repository --> Backup["Экспорт и восстановление из папки"]
    end

    subgraph Tests ["Тесты серверного протокола"]
        Fixtures["Синтетические запросы"] --> Worker["Обработчики Worker"]
        Worker --> D1[("Временная SQLite через адаптер D1")]
        Worker --> FakeBot["Имитация ответов Telegram"]
    end
```

SQLite хранит карточки, заметки, задачи, события и настройки. [Репозиторий CRM](src/repositories/crm-repository.ts) последовательно выполняет записи и объединяет связанные изменения в транзакции. [Миграции](src/storage/migrations.ts) сохраняют идентификаторы и связи. Фото и видео хранятся в каталоге приложения. При восстановлении проверяются пути, размеры, контрольные суммы и связи записей.

## Локальный запуск

Для сборки на Windows нужны Node.js 24, npm, JDK 17 и Android SDK, а также эмулятор или тестовое устройство.

```powershell
npm ci
$env:APP_VARIANT = 'development'
npm run android
```

Для последующих запусков Metro используйте `npm start`. Пакет Development Build — `com.autocrm.showcase.dev`. Автономный Showcase использует `com.autocrm.showcase` и запускается без Metro. [Сборка APK и импорт демоданных](docs/ANDROID-DEMO.md)

## Проверки

```powershell
npm run typecheck
npx --no-install eslint src server tests demo app.config.ts
npm test
```

На Windows тесты включают регрессии на системной SQLite и сценарии серверного протокола на синтетических данных. [CI и известные замечания по зависимостям](docs/GITHUB.md)

## Демонстрационный режим и ограничения

Showcase работает локально. В этой редакции сетевой Telegram и OTA отключены. Привязка и синхронизация проверяются в изолированных тестах. Доставка уведомлений зависит от разрешений Android и настроек энергосбережения. Резервные копии в папке хранятся без шифрования. [Серверные тесты](docs/SERVER.md) · [Изменения](CHANGELOG.md) · [Политика безопасности](SECURITY.md)

## Лицензирование

**All rights reserved.** Исходники предоставляются для ознакомления с портфолио. Лицензии и уведомления сторонних компонентов действуют отдельно. [Условия использования](LICENSE.md)
