# FMP POS V2

Point of Sale for FMP phone repair & retail stores. Monorepo:

| Path | What |
| --- | --- |
| `apps/repair-pos` | Repair-shop POS (React + Vite) — Register, Repairs, Inventory, Customers, Reports, Settings |
| `apps/retail-pos` | Retail/carrier POS — device sales, activations, bill payments (served at `/retail`) |
| `packages/shared` | Domain types + money logic (integer cents, tax, trade-in, drawer math) |
| `packages/pos-client` | Client pieces shared by both POS apps (auth/session, cart, PIN screen, modals, Customers/Inventory screens) |
| `packages/ui` | Design system from the iPad POS UI Kit (tokens, chips, buttons, modals) |
| `server` | Express + Socket.IO API, Drizzle ORM, PostgreSQL (PGlite locally, Render Postgres in prod) |
| `bridge` | Windows print bridge for the store PC — Rongta receipts over TCP or a USB share, Niimbot labels through Edge kiosk printing to the PC default printer |
| `design` | The approved design reference (serve with `node design/serve.js`, port 4173) |

## Develop

```bash
npm install
npm run dev        # API :3001 + repair POS :5173 + retail POS :5174 (local PGlite)
```

Local demo data requires explicit opt-in; see secure setup below.

## Test

```bash
npm test           # money logic + API tests (in-memory Postgres)
```

## Deploy

Render blueprint in `render.yaml` (web service + Postgres). Push to `main` on GitHub,
connect the repo in Render, and it builds `npm run build` / runs `npm run start`.
Migrations apply automatically at server start.

## Secure store and device setup

Production requires a unique `JWT_SECRET` of at least 32 characters and `DATABASE_URL`. Render supplies these through the blueprint. Demo seeding is disabled by default and forbidden in production.

For a new store, supply a private four-digit `FMP_BOOTSTRAP_PIN` through the host environment, then run:

```bash
npm run setup:store -w server -- --store "Repair store" --manager "Manager name"
```

Repeat with the second store's name. Run against the intended database; this applies migrations, creates the store and manager, and prints a one-use register pairing code valid for 15 minutes. Remove the bootstrap PIN from the host environment afterward. Treat pairing codes as credentials.

Enter the code and register name in the POS setup screen, then sign in with the manager PIN. Managers can issue register/bridge codes and revoke devices through **Settings → Registers & bridges** in repair POS or **Devices** in retail POS. Customers and store credit are shared; devices and staff belong to one store.

For an existing store, a trusted host operator can issue a recovery code:

```bash
npm run device:pair -w server -- --store-id 1 --kind pos
```

Replace the store ID with the intended store. To pair a print bridge, issue a `bridge` code, copy `bridge/config.example.json` to `bridge/config.json`, configure the API HTTPS URL and printers, and supply `FMP_PAIRING_CODE` in the environment:

```bash
npm run pair -w bridge
```

Remove the pairing-code environment value afterward. Protect `bridge/config.json` with Windows file permissions; it contains the device credential and is excluded from Git. Start the bridge normally.

For local demonstration only, set `SEED_DEMO=1` before `npm run dev`. Demo PINs: Mike `1234`, Sara `2345`, Deon `3456`. Use the host pairing command with the seeded store ID before signing in.

### Upgrading existing installations

Back up the database before rollout. Migration 0008 hashes existing register tokens in place, preserving pairing; previous session JWTs require sign-in again. Update the API, both apps and bridge together. Existing bridges need a new bridge pairing code.

This pass does not complete production readiness. Checkout/refund/repair money defects and hardware verification still block store cutover. See [security pass](audit/SECURITY-PASS.md) and [baseline audit](audit/PRODUCTION-AUDIT.md).

### Financial integrity upgrade

Migration 0009 separates repair allocations from tenders, adds original line amounts and refund claims, and introduces atomic document numbering and checkout retry IDs. Deploy both apps and the API together. Review the [financial repair report](audit/FINANCIAL-PASS.md) for data reconciliation, rollback implications, changed correction workflows and remaining release blockers before applying it to store data.
