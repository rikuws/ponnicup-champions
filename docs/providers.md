# Football and odds imports

The app uses football-data.org v4 for fixtures, league standings and results, and Odds-API.io v3 for real pre-match prices. Provider requests happen in the server/cron process. Database settlement remains transactional and separate from these adapters.

## Configuration

| Variable | Meaning | Default |
| --- | --- | --- |
| `FOOTBALL_API_KEY` | football-data.org token, sent in `X-Auth-Token` | Required for football imports |
| `ODDS_API_KEY` | Odds-API.io key; this provider requires a query parameter | Required for odds imports |
| `ODDS_API_BOOKMAKERS` | Ordered, comma-separated bookmaker names the account can access | `Unibet,Bet365` |
| `ODDS_API_LEAGUE_SLUG` | Optional explicit slug, verified against the provider catalogue | Discover men's UEFA Champions League |
| `ODDS_IMPORT_LOOKAHEAD_DAYS` | Upcoming odds import window | `10` |
| `ODDS_IMPORT_MATCH_LIMIT_PER_RUN` | Nearest eligible fixtures per run | `40` |
| `ODDS_IMPORT_MAX_REQUESTS_PER_RUN` | Request cap including league/event discovery | `10` |
| `RESULT_IMPORT_MAX_REQUESTS_PER_RUN` | Football requests per run | `4` |
| `PROVIDER_REQUEST_TIMEOUT_MS` | Timeout covering response and JSON body | `10000` |

Both import functions accept injected credentials/fetch for tests. Football season defaults to starting year `2026`, i.e. 2026/27. Requests stop on rate exhaustion/HTTP 429 and have a 120-second total run budget. Errors never include upstream bodies, credential-bearing URLs or transport error strings. Do not log raw fetch options or URLs elsewhere.

## Football normalization

`fetchFootballData()` requests `/v4/competitions/CL/matches?season=2026` and the corresponding standings resource. It requests unfolded goals, lineups and substitutions. Fixtures use `fd-<provider match id>` and clubs `fd-<provider team id>`. Missing participant IDs are skipped with warnings. Qualification, August play-offs and other competitions are excluded. League matchdays must be 1–8. Rounds use `ucl-2026-league-1` through `ucl-2026-league-8`; knockout rounds use the stage and leg, for example `ucl-2026-round_of_16-1`.

Two-leg tie IDs use season, stage and sorted club IDs. Both completed legs and their goal totals are required before choosing an advancing club. A second-leg match winner is never treated as the aggregate winner. Away goals do not break ties. Shootouts only resolve equal aggregate scores. An unpaired fixture cannot establish advancement. Unsupported/awarded statuses require administrator adjudication.

Normal-time markets use `score.regularTime` when extra time or penalties occur; a missing value holds settlement. For a regular finish, `score.fullTime` is sufficient. Football-data's `fullTime` can include shootout goals, so display/aggregate scores use regular-time plus extra-time goals or subtract the explicit shootout tally. See [score semantics](https://docs.football-data.org/general/v4/overtime.html).

Standings failure does not discard valid fixtures/results: `FootballImport.warnings` records the error and `standings` is empty. Persistence must preserve previously known standings when this happens. See [competition resources](https://docs.football-data.org/general/v4/competition.html).

## Scorer evidence and identity

Results are marked `scorerDataComplete` only after a finished match has two complete starting XIs, bench lists, an unfolded substitution array, and goals that reconcile by team with the normal-time score. Goal scorers must map to confirmed participants. Own goals contribute to score reconciliation but never win a scorer selection. Extra-time and shootout goals are excluded. `minute: 90, injuryTime: 7` counts; elapsed minutes above 90 count as stoppage only when the provider confirms a regular finish. See [match fields](https://docs.football-data.org/general/v4/match.html) and [unfolding headers](https://docs.football-data.org/general/v4/policies.html).

The providers use unrelated numeric player IDs. `playerIdentity()` creates a match-scoped identifier from the exact normalized full name. It handles accents, punctuation and case; it does not guess initials, nicknames or misspellings. `registeredPlayerIds` contains known lineup/bench players, and `appearedPlayerIds` contains normal-time starters and verified substitutes. Unknown odds labels must remain pending, even with a complete scorer feed. Only a registered player confirmed absent from appearances can be treated as DNP. Same-name collisions hold the scorer market. This conservative approach may require an audited manual correction for incompatible names or insufficient provider subscription coverage.

## Odds normalization

`fetchOdds()` loads the football league catalogue, then upcoming events, then `/v3/odds/multi` batches of at most ten event IDs. The provider documents `uefa-champions-league`; discovery also accepts that exact suffix when the current catalogue adds a regional prefix. It rejects ambiguous, women's, youth and qualifying catalogues. See [provider workflow](https://feedback.odds-api.io/en/help/articles/6035212-understanding-the-api-workflow), [event filters](https://docs.odds-api.io/api-reference/events/get-events), and [batch endpoint](https://docs.odds-api.io/api-reference/odds/get-odds-for-multiple-events).

Event matching requires both exact club names or explicit aliases, kickoff times within two hours and exactly one candidate. After matching, the odds event ID must match an ID from that discovery response. Football-data IDs are never compared with Odds-API numeric IDs. Reversed home/away listings are normalized. Unmatched events are left untouched; when none match, the import reports a diagnostic error.

Supported prices are three-way `ML`/match-result markets, explicit correct-score rows, and anytime-goalscorer rows. Player-goals over/under rows are accepted only at 0.5 goals. First/last goalscorer, half-time, two-way ML and unsupported prices are skipped. One bookmaker supplies each market's selections; no synthetic prices, fallback odds or draw prices are generated. Unsupported optional markets stay absent. See [market example format](https://docs.odds-api.io/examples/player-props).

The adapter tests cover aggregate winners, penalty normalization, missing normal-time results, incomplete scorer feeds, own goals, DNP evidence, alias ambiguity, reversed odds, ten-event batching, request timeouts, redaction and rate exhaustion. Account entitlements and live feed availability must also be verified against the actual deployment credentials.

## Public-calendar reconciliation and import holds

When API access is added after a public UEFA calendar or manual setup, ingestion preserves the existing match and club primary IDs. It binds an incoming football-data fixture through `matches.provider_id = football-data:<id>`, using exact/explicit club aliases, stage, round and kickoff within two hours. Unbound ambiguous or rescheduled entries stop the import for reconciliation; they do not silently create duplicate fixtures. Results, advancement club IDs and match-scoped scorer/odds identifiers are translated to the existing IDs. Replaying the public calendar never erases an established live-provider binding.

The import transaction uses the same game advisory lock as betting and settlement. A provider changing participants after prices are frozen holds the import; applying a new home score to an old home club would pay the wrong bets. A move to another Finland playing date after any bet history also holds the import, because its bonus funding belongs to the original date. These cases require an explicit administrator postponement/void workflow before normal syncing resumes. Administrator result overrides are preserved. The sync status records the diagnostic rather than continuing with conflicting identities or date attribution.
