# FMP POS V2

Point of Sale for FMP phone repair & retail stores. Monorepo:

| Path | What |
| --- | --- |
| `apps/repair-pos` | Repair-shop POS (React + Vite) — Register, Repairs, Inventory, Customers, Reports |
| `apps/retail-pos` | Retail/carrier POS (Phase 4) — device sales, activations, bill payments |
| `packages/shared` | Domain types + money logic (integer cents, tax, trade-in, drawer math) |
| `packages/ui` | Design system from the iPad POS UI Kit (tokens, chips, buttons, modals) |
| `server` | Express + Socket.IO API, Drizzle ORM, PostgreSQL (PGlite locally, Render Postgres in prod) |
| `bridge` | Windows print bridge for the store PC — Rongta receipts, Niimbot labels |
| `design` | The approved design reference (serve with `node design/serve.js`, port 4173) |

## Develop

```bash
npm install
npm run dev        # API on :3001 + app on :5173 (PGlite auto-seeds demo data)
```

Demo PINs: Mike (manager) `1234`, Sara `2345`, Deon `3456`.

## Test

```bash
npm test           # money logic + API tests (in-memory Postgres)
```

## Deploy

Render blueprint in `render.yaml` (web service + Postgres). Push to `main` on GitHub,
connect the repo in Render, and it builds `npm run build` / runs `npm run start`.
Migrations apply automatically at server start.
