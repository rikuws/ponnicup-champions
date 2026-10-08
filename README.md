# Pönnicup · Champions League 2026–27

Pönnicup is a private Champions League app for five friends, with coins, private picks, daily bonuses, rankings and awards. Midnight blue, white and silver define the app, from match screens to its home-screen icon. The default start is **13 October 2026, league matchday 2**. The old `../ponnicup-2026` project is untouched.

React + Vite serves a Finnish mobile-first interface. A Node API and scheduled worker use ordinary PostgreSQL transactions. The application does not need Supabase, Netlify or provider API keys to operate.

## Delivery checkpoint · 8 October 2026

| Area | Verified status |
| --- | --- |
| Source | Champions League application in `rikuws/ponnicup-champions` |
| Production build | TypeScript and Vite build pass |
| Automated tests | 76 tests pass, including all PostgreSQL/HTTP suites; no skipped tests |
| Repeatable checks | `npm run test:full` provisions and removes isolated test databases; GitHub Actions runs build and full tests |
| Knockout play | Linked manual legs, final, aggregate advancement, extra-time display, and correction handling implemented |
| Browser verification | Isolated QA login, both knockout legs from another round, extra-time aggregate, and result-evidence save/readback checked; 390px layout checked |
| Railway production | `web`, `sync`, and `Postgres` report offline; public health returns HTTP 404 |
| Backups | Railway recovery coverage remains unverified; the earlier local restore drill is not production recovery proof |

The core game also includes 1X2 and optional score/scorer bets, kickoff privacy, date-specific bonuses, rankings, awards, league standings and manual administration. Correcting a result retains the stored scorer/extra-time evidence; withdrawing a result clears it and reverses settlement. Future scheduled markets reopen after a status correction.

Intended deployment address: [web-production-71ec.up.railway.app](https://web-production-71ec.up.railway.app). Production activation remains separate from the implemented and locally verified application. Follow the [launch runbook](docs/operations.md).

## Run locally

Use **Node 22.13 or newer** and a PostgreSQL database dedicated to this application. The shipped Docker image uses Node 22. The example connection expects a local PostgreSQL listener on port `55439`; change it for your setup.

```bash
npm ci
cp .env.example .env
```

Edit `.env` with your local `DATABASE_URL` and five different **6–8 digit bootstrap PINs** in `INITIAL_PINS_JSON`. IDs are `henri`, `antti`, `ville`, `pekka` and `riku`; Riku is the admin. PIN values belong in private environment settings, never in source. On first login everyone must choose a new 6–32 digit PIN.

For Vite development, set `PUBLIC_ORIGIN=http://127.0.0.1:5173`, then run:

```bash
npm run db:seed
npm run dev:server
```

In another terminal:

```bash
npm run dev
```

Open [127.0.0.1:5173](http://127.0.0.1:5173). Vite proxies `/api` to port 3000. `PUBLIC_ORIGIN` must match the browser origin exactly; mixing `localhost` and `127.0.0.1` causes write requests to be rejected.

For the built application, set `PUBLIC_ORIGIN=http://localhost:3000` and run:

```bash
npm run build
npm start
```

Open [localhost:3000](http://localhost:3000). `GET /api/health` checks API/database connectivity. Server scripts load `.env` automatically. `npm test` does not load it automatically.

## Play without API keys

The first seed imports a checked-in **144-match UEFA league-phase calendar**, retrieved on 8 September 2026. All 36 clubs and eight league rounds are included; first-round fixtures are ineligible for betting. Existing fixtures, balances and PINs are preserved on subsequent seeds. The calendar is a snapshot, so later scheduling changes require verification. The [source URL and retrieval metadata](server/data/ucl-2026-fixtures.json) are stored with the data.

Odds remain closed until supplied. Log in as Riku, change the bootstrap PIN, and open **Ylläpito → Syötä kertoimet**. Enter verified or group-agreed 1X2 prices, optional score/scorer markets and a reason. After matches, use **Tuloksen korjaus** to enter verified results. The admin can also add fixtures. No demo balances, invented odds or synthetic results are used in the live interface.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Vite frontend |
| `npm run dev:server` | API with restart on source changes |
| `npm run db:migrate` | Apply pending SQL migrations |
| `npm run db:seed` | Migrate, create missing players/season/rounds and bootstrap an empty calendar |
| `npm run sync` | Process bonuses and refresh configured sources when due; exits after the run |
| `npm run sync -- --force` | Request an immediate source refresh |
| `npm run build` | Typecheck and build frontend assets |
| `npm start` | Serve built frontend and API together |
| `npm test` | Run enabled unit/integration suites |
| `npm run test:full` | Run every suite with automatically created disposable PostgreSQL databases |
| `npm run typecheck` | TypeScript validation |
| `npm run qa:seed` | Destructive fixture setup for the dedicated local QA database only |

Integration suites need **three separate disposable databases** whose names end in `_test`: `TEST_DATABASE_URL`, `INGEST_TEST_DATABASE_URL` and `HTTP_TEST_DATABASE_URL`. These suites truncate their databases. They are skipped when their respective variable is absent; a unit-only pass is not a full integration pass. Never point them at the application or old cup database.

For a complete test run, use `npm run test:full`. The runner starts a fresh PostgreSQL cluster on a random loopback port, creates the three test databases, and removes everything when the tests finish. It does not load `.env` and replaces inherited database connection settings. Have PostgreSQL's `initdb` and `pg_ctl` on `PATH`, or start Docker for the automatic `postgres:16-alpine` fallback. Use `npm run test:full -- --docker` to select Docker explicitly, or append a Vitest filter such as `npm run test:full -- tests/engine.integration.test.ts`. GitHub Actions runs the build and the complete suite through the Docker path.

## Operations and architecture

- [Operations and Railway delivery](docs/operations.md): environment settings, deployment, PIN recovery, backups and restore.
- [Providers](docs/providers.md): optional API setup, identity reconciliation, two-leg results and conservative scorer settlement.
- [Product](PRODUCT.md) and [Design](DESIGN.md): gameplay and interface decisions.
- [Shared API contracts](shared/contracts.ts), [database engine](server/engine.ts) and [schema migrations](server/migrations).
- [Railway infrastructure](.railway/railway.ts): current project configuration; no legacy Railway JSON/TOML configuration.

Bet placement, replacement and cancellation are transactional and retry-safe. The ledger is append-only. Sessions are revocable, PINs are salted with scrypt, and login attempts are rate-limited. Result corrections reverse previous settlement entries instead of rewriting financial history.
