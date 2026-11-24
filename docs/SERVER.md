# Local server and independent infrastructure

The Worker preserves the D1-backed pairing, authentication, sync, callbacks and scheduled delivery logic. The Showcase transport accepts only an injected test fixture. It returns no live messages and has no production account, bot or database binding.

## Local protocol checks

Use `npm test` for synthetic end-to-end scenarios in SQLite WASM, including a pre-migration binding, pending uploads, action acknowledgements and notification scheduling. The fixtures do not use network requests for delivery.

To inspect the Worker HTTP surface locally, install Wrangler separately and run these commands from the repository root. The example UUID is a local placeholder.

```powershell
Copy-Item server/telegram/.dev.vars.example server/telegram/.dev.vars
wrangler d1 migrations apply DB --local --config server/telegram/wrangler.example.jsonc
wrangler dev --local --config server/telegram/wrangler.example.jsonc --ip 127.0.0.1
Invoke-RestMethod http://127.0.0.1:8787/health
```

The local HTTP instance has no delivery callback. Synthetic callback and delivery behavior are exercised by the test suite. The Showcase app does not connect to this instance automatically.

## Adapting to infrastructure you own

Use a private fork and create a dedicated Worker, D1 database and test bot in accounts you control. Configure a binding named `DB`, apply migrations in order against a clean staging database and use new values from the host secret store. Existing v1 installations need a migration checkpoint and a safe rollback plan.

Live integration requires deliberate changes in that private fork to replace the fixture with a reviewed Bot API transport and to enable the mobile requester against your own HTTPS origin. Verify webhook authenticity, keep authorization and pairing secrets separate, test pairing before uploading any records, and enable schedules only after testing delivery against synthetic data. This repository does not ship deployment automation.
