# Ponnicup operations

This runbook covers the new Champions League application. The old World Cup repository and database are not migration or reset targets.

## Current release checkpoint

As of 8 September 2026, local build and 67 automated tests passed. A local logical backup was restored into a separate database and verified to contain 5 users, 144 fixtures, 36 clubs and 5,000 starting coins. That is **local restore proof**, not Railway recovery proof.

Railway PostgreSQL is provisioned. `web` and `sync` are configured; the web image has not yet been deployed at this checkpoint. Upload of the initial private PIN mapping awaits user approval. The intended application origin is [https://web-production-71ec.up.railway.app](https://web-production-71ec.up.railway.app).

Automatic Railway backups were **not enabled or verified**: the schedule mutation returned `OAUTH_INSUFFICIENT_GRANT`, although other project operations were allowed. Do not infer backup coverage from the existing database volume, successful application tests or the local restore drill.

## Services and configuration

| Service | Runtime | Configuration |
| --- | --- | --- |
| `web` | Node 22 Docker image; `npm start` | Same-origin API and Vite build; healthcheck `/api/health`; predeploy `npm run db:seed` |
| `sync` | Same image; `npm run sync` | Scheduled every 10 minutes; restart policy `NEVER`; exits when work is complete |
| `Postgres` | Railway PostgreSQL | Persistent volume; application services connect over private networking |

The current [.railway/railway.ts](../.railway/railway.ts) was checked against the configured infrastructure with no drift. It is the source of truth for the declared service settings. Preserve its TypeScript IaC format; do not add a legacy `railway.json` or `railway.toml`. Secret values use remote environment settings, not literal source values. Always review `railway config plan` before applying infrastructure changes. An application source upload uses `railway up`; it is separate from applying an infrastructure plan.

The Dockerfile builds assets and prunes development dependencies in a build stage, then runs the app as the unprivileged `node` user. It copies the API, shared types and fixture snapshot into the runtime. `.env`, local databases, tests and source-control metadata are excluded from the image context. No persistent application volume is required on `web` or `sync`.

### Environment variables

| Variable | Services | Value / purpose |
| --- | --- | --- |
| `DATABASE_URL` | `web`, `sync` | Railway reference `${{Postgres.DATABASE_URL}}`, resolving to the private database endpoint |
| `NODE_ENV` | `web`, `sync` | `production` |
| `SEASON_ID` | `web`, `sync` | `ucl-2026` |
| `GAME_START_AT` | `web` | `2026-10-13T00:00:00+03:00`; used only when creating the season |
| `PORT` | `web` | `3000`, matching the public service target |
| `PUBLIC_ORIGIN` | `web` | Exact HTTPS application origin, with no trailing slash |
| `INITIAL_PINS_JSON` | `web`, initial bootstrap only | Private JSON mapping for `henri`, `antti`, `ville`, `pekka`, `riku`; unique 6–8 digit temporary PINs |
| `FOOTBALL_API_KEY` | Both, optional | football-data.org credential |
| `ODDS_API_KEY` | Both, optional | Odds-API.io credential |

`DATABASE_URL` must not be a copied public TCP-proxy URL for service-to-service traffic. Private Railway hostnames are reachable inside the project's environment, not from an ordinary local `railway run`. For remote database operations, use an interactive service shell or a deliberately configured, temporary authenticated local connection. Never print environment listings containing secrets into a shared log.

Bootstrap PINs are needed only for missing users. The seed hashes them, requires first-login replacement and does not overwrite existing PINs or balances. After all five users exist and initialization is verified, remove the bootstrap mapping from the runtime environment if practical. Reseeding does not reset a forgotten PIN; use the recovery command below.

## First deployment and subsequent releases

1. Finish the private bootstrap-PIN approval/upload step. Confirm the linked project is `ponnicup`, the environment is `production`, and both application services reference the correct private database. Do not copy the local QA credential mapping into production.
2. Run the enabled full test suite and `npm run build` in the exact checkout to be uploaded. Verify pending database migrations and take a current backup before a release that changes persisted data.
3. Upload **web first**, using an explicit service target from the repository root:

```bash
railway up --service web --environment production --detach
railway deployment list --service web --environment production --json
```

Follow the deployment ID returned by the upload until it reaches `SUCCESS`. `--detach` returning successfully means the upload was queued, not that the application is healthy. Inspect scoped build/runtime logs if needed:

```bash
railway logs --service web --environment production --lines 100
```

4. Verify [the health endpoint](https://web-production-71ec.up.railway.app/api/health), the five-player login screen, a real session and mandatory first-PIN change. Check the 144-fixture calendar, ineligible first round, unchanged starting balances and unavailable-price states. `/api/health` alone only proves a database query works.
5. Upload the **same source checkout** to the worker, after successful web initialization:

```bash
railway up --service sync --environment production --detach
railway deployment list --service sync --environment production --json
railway logs --service sync --environment production --lines 100
```

6. Verify a completed worker run and bonus processing. With no provider keys, `not_configured` source summaries are expected; no odds are invented. Check admin source status separately from the job exit result. A scheduled source failure must not be mistaken for a successful refresh.
7. Record the verified deployment IDs and date in the README release checkpoint. Code is uploaded explicitly by CLI; do not assume a Git push also deploys these services.

## Running in manual mode

The seed imports the [UEFA calendar snapshot](../server/data/ucl-2026-fixtures.json) once when the season has no fixtures. It contains 144 league-phase matches and 36 clubs from the published calendar retrieved on 8 September 2026. It contains no prices or results. Later seeds preserve amended fixtures. Check schedule changes against UEFA before updating the game.

The admin logs in as Riku and completes the mandatory PIN change. Under **Ylläpito**:

- **Syötä kertoimet:** choose a future fixture; supply 1/X/2 prices and a source/reason. Optional score lines use `home-away;odds`, and scorer lines use `Full Player Name;odds`. Blank optional fields do not manufacture those markets. Existing bets retain their captured prices.
- **Lisää ottelu:** add a verified fixture, Finnish kickoff time and round. For two-leg rounds, select the leg and reuse the same tie for the return match. Avoid duplicating fixtures already in the calendar.
- **Tuloksen korjaus:** select the round/match and enter the 90-minute result. For knockouts, final scores may include extra time but must exclude shootout tallies. Advancement is about the whole tie.
- **Maalintekijät ja osallistuminen:** separately mark appearances, verified DNPs and scorers. Unknown participation stays unmarked and unresolved. Confirm only verified evidence.
- **Palauta automaattinen tulospäivitys:** leave unchecked to protect a manual result from future provider refreshes. Check only when intentionally returning authority to the provider.

Every manual change requires a reason and appears in the audit log. Confirm the resulting standings, wallet and bet states after saving. For postponed or cancelled matches, use the explicit result status and inspect refunds/held bets. Do not repair balances by editing ledger rows; settlement corrections preserve their history.

## Add providers later

Use [docs/providers.md](providers.md) to verify current competition, market and subscription coverage. Set each selected provider key on **both `web` and `sync`**: the admin refresh runs in the web service, while automatic refresh runs in the worker. Matching optional provider settings must also be present on both services. Publish the changed variables/redeploy both services, then request one admin refresh and inspect each source's last success/error and a sample real fixture/market.

The adapter reconciles existing public-calendar IDs instead of creating a second season. Ambiguous teams, participant changes after prices exist, or a change to another Finnish date after bets exist hold the import for adjudication. A generic successful HTTP response is not proof that optional scorer coverage is complete. Results with incomplete scorer evidence remain pending.

## Recover a forgotten PIN

The [operator-only recovery script](../server/reset-pin.ts) creates a random temporary eight-digit PIN, stores only its scrypt hash, requires a new PIN at next login, revokes all of that player's sessions, clears that player's login/PIN-change lock and adds an audit entry. It does not reset bets or balances. It prints the temporary value only in an interactive operator terminal; CI, redirected output and production job logs are rejected.

For production, open an interactive shell in the already deployed web service:

```bash
railway ssh --service web --environment production
```

Inside that shell, run the explicit account operation, changing the ID and reason as appropriate:

```bash
node --import tsx server/reset-pin.ts --user henri --reason 'Player requested access recovery'
```

For local recovery, use `node --env-file-if-exists=.env --import tsx server/reset-pin.ts ...` against the intended local database. Do not pipe or record the output. Share the temporary PIN privately with that one player. Verify a forced-PIN-change login and the audit record; the old sessions should no longer work. The helper is never executed by application startup or the worker.

## Enable and verify Railway backups

**Current state: not enabled or verified.** The CLI schedule request failed with `OAUTH_INSUFFICIENT_GRANT`; other Railway permissions do not imply backup mutation access.

In the Railway project, open **Postgres → Backups**. Select both **Daily** and **Weekly** schedules and save them. The current volume-backup reference specifies daily retention of 6 days and weekly retention of 27 days. Create an initial manual backup and wait for completion. Confirm the schedules and an actual backup entry; a configured schedule alone is not a recovery test. [Railway volume backups](https://docs.railway.com/volumes/backups).

Once the account/token has the required grant, the equivalent scoped CLI operation is:

```bash
railway postgres pitr schedule set --daily --weekly --service Postgres --environment production
railway postgres pitr schedule list --service Postgres --environment production --json
railway postgres pitr backup list --service Postgres --environment production --json
```

For optional point-in-time recovery, use **Postgres → Backups → Enable PITR**. Enabling redeploys PostgreSQL and starts a new recovery window; it does not supply historical coverage. Verify archive health and the first successful base backup before claiming protection. PITR restores to a new sibling service, so traffic is not switched automatically. [Railway point-in-time recovery](https://docs.railway.com/volumes/point-in-time-recovery).

## Restore and verify

Choose a known snapshot from **Postgres → Backups → Restore**. Railway stages a replacement volume at the original mount path and retains the old unmounted volume. Inspect **Details**, then **Deploy** to apply the restore. The selected snapshot becomes the service data; later game actions are absent from that restored state. Pause the web/worker writers while recovering and keep the original state until validation succeeds. [Railway restore workflow](https://docs.railway.com/volumes/backups).

Prefer a separate restored database for the first drill. With verified PITR coverage, a UTC timestamp can be restored to a sibling service:

```bash
railway postgres pitr restore --service Postgres --environment production --at <verified-UTC-timestamp> --new-service-name Postgres-restored
```

Before any cutover, verify migrations, roster, fixtures, ledger totals, bonus pools, bets, odds snapshots and settlement results against the expected snapshot. Run the application against the restored database in an isolated environment, including a login and readback. Only then change **both** service database references, redeploy and resume writes. Document the recovery point and any missing later activity. Revoke restored sessions if the incident involved access credentials.

For a portable logical backup/restore drill, use PostgreSQL client tools with the source and destination credentials in protected libpq service/passfile configuration. These examples contain no database passwords:

```bash
umask 077
pg_dump --dbname='service=ponnicup-source' --format=custom --no-owner --no-acl --file=ponnicup-backup.dump
pg_restore --dbname='service=ponnicup-isolated-restore' --no-owner --no-acl --exit-on-error ponnicup-backup.dump
```

The destination must be a new empty database, never the live app or the old cup. Keep dumps outside the repository with private access, then verify the restored state. The runtime web image does not include `pg_dump`/`pg_restore`; use an operator environment with matching PostgreSQL client tools. Local success does not enable or test Railway's automatic backup schedules. [Railway PostgreSQL backup guide](https://docs.railway.com/guides/postgres-backups-restores).

## Routine checks and failure recovery

- Check web health and worker exit/logs, then the admin source timestamps and unresolved matches. An empty provider key means manual mode; an enabled source with an error requires investigation.
- Check the volume backup list, schedule readback and available restore coverage periodically. Run another isolated restore after meaningful schema changes.
- Keep the full integration suites on separate databases ending in `_test`; they truncate their own data. `qa:seed` is for the explicitly named local QA database only.
- A code rollback does not roll back a database migration. Inspect schema compatibility first; use the validated restore procedure if persisted data must be recovered.
- Review a fresh `railway config plan` after any infrastructure change. Do not use `--show-values`, decrypt secrets into IaC, or broaden a failed permission request into unrelated account changes.
