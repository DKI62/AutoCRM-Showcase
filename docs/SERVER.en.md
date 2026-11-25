[Русский](SERVER.md) · [**English**](SERVER.en.md)

# Server protocol

[Back to the project](../README.en.md)

Cloudflare Worker handlers use a D1 binding to store device state, task revisions, and pending actions. New pairings require confirmation on the device. Task updates carry revision numbers and action processing is acknowledged separately.

The Showcase app sends no requests to the server. In automated tests, the Worker receives synthetic requests, temporary SQLite stands in for D1, and a test transport simulates Telegram responses.

## Local checks

Run `npm test` from the repository root. Tests cover pairing confirmation, task exchanges, action acknowledgements, and scheduled reminders.

To check the health route manually, install Wrangler and run the following commands from the repository root. The example uses local D1 and test settings.

```powershell
Copy-Item server/telegram/.dev.vars.example server/telegram/.dev.vars
wrangler d1 migrations apply DB --local --config server/telegram/wrangler.example.jsonc
wrangler dev --local --config server/telegram/wrangler.example.jsonc --ip 127.0.0.1
```

Run `Invoke-RestMethod http://127.0.0.1:8787/health` in another terminal. Automated tests inject a transport to verify message handling. The local Wrangler instance runs without that transport.
