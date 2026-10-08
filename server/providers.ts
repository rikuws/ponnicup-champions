import type { ClubStanding, ResultInput, Stage, Team } from '../shared/contracts';
import type { FootballImport, ImportedFixture, ImportedOdds } from '../shared/imports';

type Json = Record<string, unknown>;
type Pair = { home: number; away: number };
type FetchOptions = { apiKey?: string; fetcher?: typeof fetch; requestTimeoutMs?: number; maxRequests?: number };
type FootballOptions = FetchOptions & { season?: number };
type OddsOptions = FetchOptions & { now?: Date; lookaheadDays?: number; matchLimit?: number; bookmakers?: string[] };
type Budget = { used: number; max: number; remaining: number | null; deadline: number; timeout: number };
export type OddsEventMatch = { fixture: ImportedFixture; event: Json; reversed: boolean };

export class ProviderError extends Error {
  constructor(public readonly provider: string, message: string, public readonly status?: number) {
    super(`${provider}: ${message}`);
    this.name = 'ProviderError';
  }
}

const FD = 'football-data.org';
const ODDS = 'Odds-API.io';
const FD_URL = 'https://api.football-data.org/v4';
const ODDS_URL = 'https://api.odds-api.io/v3';
export const ODDS_UCL_LEAGUE_SLUG = 'uefa-champions-league';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ROUND_BASE: Record<Stage, number> = { league: 1, playoff: 9, round_of_16: 11, quarter_final: 13, semi_final: 15, final: 17 };
const STAGE_NAMES: Record<Stage, string> = { league: 'League phase', playoff: 'Knockout play-offs', round_of_16: 'Round of 16', quarter_final: 'Quarter-finals', semi_final: 'Semi-finals', final: 'Final' };

function object(value: unknown): Json { return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Json : {}; }
function list(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function str(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function id(value: unknown): string | null { return (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) || (typeof value === 'string' && /^\d+$/.test(value) && Number(value) > 0) ? String(value) : null; }
function integer(value: unknown): number | null {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}
function pair(value: unknown): Pair | null { const row = object(value); const home = integer(row.home); const away = integer(row.away); return home !== null && away !== null ? { home, away } : null; }
function timestamp(value: unknown): string | null { const text = str(value); return text && Number.isFinite(Date.parse(text)) ? new Date(text).toISOString() : null; }
function bounded(value: unknown, fallback: number, max: number): number { const number = integer(value); return number !== null && number > 0 ? Math.min(number, max) : fallback; }
function normalize(value: string): string { return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' '); }

function budget(options: FetchOptions, prefix: string, fallback: number): Budget {
  return { used: 0, max: bounded(options.maxRequests ?? process.env[`${prefix}_MAX_REQUESTS_PER_RUN`], fallback, 40), remaining: null, deadline: Date.now() + 120_000, timeout: bounded(options.requestTimeoutMs ?? process.env.PROVIDER_REQUEST_TIMEOUT_MS, 10_000, 30_000) };
}

async function request(provider: string, url: URL, headers: Record<string, string>, limits: Budget, fetcher: typeof fetch): Promise<unknown> {
  if (limits.used >= limits.max) throw new ProviderError(provider, `request budget (${limits.max}) exhausted`);
  if (limits.remaining !== null && limits.remaining <= 0) throw new ProviderError(provider, 'provider rate limit exhausted; retry after the provider reset');
  if (Date.now() >= limits.deadline) throw new ProviderError(provider, 'run time budget exhausted');
  limits.used++;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetcher(url, { headers: { Accept: 'application/json', ...headers }, signal: controller.signal, redirect: 'error' });
        const remaining = response.headers.get(provider === FD ? 'X-RequestsAvailable' : 'X-RateLimit-Remaining');
        if (remaining !== null) limits.remaining = integer(remaining);
        if (!response.ok) {
          const hint = response.status === 429 ? 'rate limit reached; retry after the provider reset' : response.status === 401 || response.status === 403 ? 'check API credentials and competition/market subscription access' : 'request failed';
          // Never interpolate the URL, response body or underlying exception: any may contain the API key.
          throw new ProviderError(provider, `${hint} (HTTP ${response.status})`, response.status);
        }
        const body = await response.text();
        if (body.length > 12_000_000) throw new ProviderError(provider, 'response exceeds the import size limit');
        try { return JSON.parse(body) as unknown; } catch { throw new ProviderError(provider, 'response was not valid JSON'); }
      })(),
      new Promise<never>((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new ProviderError(provider, `request timed out after ${limits.timeout} ms`)); }, Math.min(limits.timeout, limits.deadline - Date.now())); })
    ]);
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError(provider, 'network request failed');
  } finally { clearTimeout(timer); }
}

function team(value: unknown): Team | null {
  const row = object(value); const teamId = id(row.id); const name = str(row.name);
  if (!teamId || !name) return null;
  const crest = str(row.crest);
  return { id: `fd-${teamId}`, name, shortName: str(row.shortName) ?? str(row.tla) ?? name, crest: crest?.startsWith('https://') ? crest : null };
}

export function footballStage(value: unknown, kickoffAt: string, season = 2026): Stage | null {
  // PLAYOFFS is also used for August qualifying. The game starts with September's league phase.
  const date = Date.parse(kickoffAt);
  if (!Number.isFinite(date) || date < Date.UTC(season, 8, 1) || date >= Date.UTC(season + 1, 6, 1)) return null;
  switch (value) {
    case 'LEAGUE_STAGE': case 'LEAGUE_PHASE': case 'GROUP_STAGE': case 'REGULAR_SEASON': return 'league';
    case 'PLAYOFFS': case 'LAST_32': case 'KNOCKOUT_PHASE_PLAY_OFFS': return date >= Date.UTC(season + 1, 0, 1) ? 'playoff' : null;
    case 'LAST_16': return 'round_of_16';
    case 'QUARTER_FINALS': return 'quarter_final';
    case 'SEMI_FINALS': return 'semi_final';
    case 'FINAL': return 'final';
    default: return null;
  }
}

function status(value: unknown): ImportedFixture['status'] | null {
  switch (value) {
    case 'SCHEDULED': case 'TIMED': return 'scheduled';
    case 'IN_PLAY': case 'PAUSED': case 'EXTRA_TIME': case 'PENALTY_SHOOTOUT': return 'live';
    case 'FINISHED': return 'final';
    case 'SUSPENDED': case 'POSTPONED': return 'postponed';
    case 'CANCELLED': return 'cancelled';
    // Awarded/unknown results need explicit administrator adjudication.
    default: return null;
  }
}

export function normalizeFootballScores(value: unknown): { normal: Pair | null; final: Pair | null; penalties: Pair | null } {
  const row = object(value);
  const duration = row.duration;
  const normal = pair(row.regularTime) ?? (duration === 'REGULAR' ? pair(row.fullTime) : null);
  const penalties = duration === 'PENALTY_SHOOTOUT' ? pair(row.penalties) : null;
  let final: Pair | null = null;
  if (duration === 'REGULAR' || duration === 'EXTRA_TIME') final = pair(row.fullTime);
  if (duration === 'PENALTY_SHOOTOUT') {
    const extra = pair(row.extraTime); const full = pair(row.fullTime);
    if (normal && extra) final = { home: normal.home + extra.home, away: normal.away + extra.away };
    else if (full && penalties && full.home >= penalties.home && full.away >= penalties.away) final = { home: full.home - penalties.home, away: full.away - penalties.away };
  }
  return { normal, final, penalties };
}

// Exact, match-scoped identity bridges providers with independent numeric player IDs.
// Abbreviated/unknown names do not match registeredPlayerIds and must remain pending.
export function playerIdentity(matchId: string, name: string): string { return `player:${matchId}:${normalize(name).replace(/ /g, '-')}`; }

function normalTimeEvent(row: Json, duration?: unknown): boolean | null {
  const period = str(row.period)?.toUpperCase();
  if (period && ['EXTRA_TIME', 'EXTRA_TIME_FIRST_HALF', 'EXTRA_TIME_SECOND_HALF', 'PENALTY_SHOOTOUT', 'SHOOTOUT'].includes(period)) return false;
  const minute = integer(row.minute);
  if (minute === null) return null;
  // football-data represents 90+7 as minute:90, injuryTime:7. Minutes 91+ are extra time.
  return minute <= 90 || (duration === 'REGULAR' && minute <= 130);
}

export function normalizeScorers(raw: unknown, matchId: string, normal: Pair | null): Pick<ResultInput, 'scorerPlayerIds' | 'appearedPlayerIds' | 'registeredPlayerIds' | 'scorerDataComplete'> {
  const match = object(raw); const sides = [object(match.homeTeam), object(match.awayTeam)];
  const registered = new Set<string>(); const appeared = new Set<string>(); const providerPlayers = new Map<string, string>(); const canonicalOwner = new Map<string, string>();
  let complete = match.status === 'FINISHED' && normal !== null && Array.isArray(match.goals) && Array.isArray(match.substitutions);
  for (const side of sides) {
    const starters = list(side.lineup); const bench = list(side.bench);
    if (starters.length !== 11 || !Array.isArray(side.bench)) complete = false;
    for (const [index, value] of [...starters, ...bench].entries()) {
      const person = object(value); const providerId = id(person.id); const name = str(person.name);
      if (!providerId || !name) { complete = false; continue; }
      const key = playerIdentity(matchId, name);
      if ((canonicalOwner.has(key) && canonicalOwner.get(key) !== providerId) || (providerPlayers.has(providerId) && providerPlayers.get(providerId) !== key)) complete = false;
      canonicalOwner.set(key, providerId); providerPlayers.set(providerId, key); registered.add(key);
      if (index < starters.length) appeared.add(key);
    }
  }
  if (new Set(sides.flatMap(side => list(side.lineup).map(p => id(object(p).id)))).size !== 22) complete = false;
  for (const value of list(match.substitutions)) {
    const substitution = object(value); const included = normalTimeEvent(substitution, object(match.score).duration);
    if (included === null) { complete = false; continue; }
    if (!included) continue;
    const person = object(substitution.playerIn); const providerId = id(person.id); const key = providerId ? providerPlayers.get(providerId) : undefined;
    if (!key || (str(person.name) && key !== playerIdentity(matchId, String(person.name)))) { complete = false; continue; }
    appeared.add(key);
  }
  const scored = new Set<string>(); const counts = [0, 0];
  for (const value of list(match.goals)) {
    const goal = object(value); const included = normalTimeEvent(goal, object(match.score).duration);
    if (included === null) { complete = false; continue; }
    if (!included || goal.type === 'SHOOTOUT' || goal.type === 'PENALTY_SHOOTOUT') continue;
    if (!['REGULAR', 'PENALTY', 'OWN'].includes(String(goal.type))) { complete = false; continue; }
    const sideIndex = sides.findIndex(side => id(side.id) === id(object(goal.team).id));
    if (sideIndex < 0) { complete = false; continue; }
    counts[sideIndex]++;
    if (goal.type === 'OWN') continue; // Counts toward the score but never towards a scorer bet.
    const person = object(goal.scorer); const providerId = id(person.id); const key = providerId ? providerPlayers.get(providerId) : undefined;
    if (!key || !appeared.has(key) || (str(person.name) && key !== playerIdentity(matchId, String(person.name)))) { complete = false; continue; }
    scored.add(key);
  }
  if (!normal || counts[0] !== normal.home || counts[1] !== normal.away) complete = false;
  return { scorerPlayerIds: [...scored].sort(), appearedPlayerIds: [...appeared].sort(), registeredPlayerIds: [...registered].sort(), scorerDataComplete: complete };
}

function knownLeg(raw: Json, stage: Stage): number | null {
  if (stage === 'league' || stage === 'final') return null;
  const leg = integer(raw.leg); if (leg === 1 || leg === 2) return leg;
  const matchday = integer(raw.matchday);
  if (matchday === ROUND_BASE[stage] || matchday === ROUND_BASE[stage] + 1) return matchday - ROUND_BASE[stage] + 1;
  if (matchday === 1 || matchday === 2) return matchday;
  return null;
}

function roundMetadata(fixture: ImportedFixture, season: number, leagueNumber: number): void {
  const suffix = fixture.stage === 'league' ? String(leagueNumber) : fixture.stage === 'final' ? '' : fixture.leg === null ? '-unassigned' : `-${fixture.leg}`;
  fixture.roundId = `ucl-${season}-${fixture.stage}${fixture.stage === 'league' ? '-' : ''}${suffix}`;
  fixture.roundNumber = fixture.stage === 'league' ? leagueNumber : ROUND_BASE[fixture.stage] + (fixture.leg === 2 ? 1 : 0);
  fixture.roundName = fixture.stage === 'league' ? `League phase · Matchday ${leagueNumber}` : `${STAGE_NAMES[fixture.stage]}${fixture.leg ? ` · Leg ${fixture.leg}` : ''}`;
}

export function normalizeFootballMatches(payload: unknown, season = 2026): Pick<FootballImport, 'fixtures' | 'results' | 'warnings'> {
  const data = object(payload);
  if (!Array.isArray(data.matches)) throw new ProviderError(FD, 'matches response is missing its matches array');
  const warnings: string[] = []; const fixtures: ImportedFixture[] = []; const rawById = new Map<string, Json>();
  for (const value of data.matches) {
    const raw = object(value); const kickoff = timestamp(raw.utcDate); const providerId = id(raw.id);
    if (!kickoff || !providerId || (object(raw.competition).code && object(raw.competition).code !== 'CL')) continue;
    if (str(object(raw.season).startDate) && !String(object(raw.season).startDate).startsWith(`${season}-`)) continue;
    const stage = footballStage(raw.stage, kickoff, season); if (!stage) continue;
    const homeTeam = team(raw.homeTeam); const awayTeam = team(raw.awayTeam); const matchStatus = status(raw.status);
    if (!homeTeam || !awayTeam || homeTeam.id === awayTeam.id || !matchStatus) { warnings.push(`Fixture fd-${providerId} needs confirmed clubs and a supported match status.`); continue; }
    const matchday = integer(raw.matchday);
    if (stage === 'league' && (!matchday || matchday > 8)) { warnings.push(`Fixture fd-${providerId} has no valid league matchday.`); continue; }
    const matchId = `fd-${providerId}`;
    if (rawById.has(matchId)) throw new ProviderError(FD, `duplicate fixture ${matchId}`);
    const tieId = stage !== 'league' && stage !== 'final' ? `ucl-${season}-${stage}-${[homeTeam.id, awayTeam.id].sort().join('-')}` : null;
    const fixture: ImportedFixture = { id: matchId, providerId, homeTeam, awayTeam, kickoffAtUtc: kickoff, roundId: '', roundName: '', roundNumber: 0, stage, leg: knownLeg(raw, stage), tieId, status: matchStatus };
    roundMetadata(fixture, season, matchday ?? 1); fixtures.push(fixture); rawById.set(matchId, raw);
  }
  fixtures.sort((a, b) => a.kickoffAtUtc.localeCompare(b.kickoffAtUtc) || a.id.localeCompare(b.id));
  const ties = new Map<string, ImportedFixture[]>();
  for (const fixture of fixtures) if (fixture.tieId) ties.set(fixture.tieId, [...ties.get(fixture.tieId) ?? [], fixture]);
  for (const group of ties.values()) {
    if (group.length === 2 && group[0].homeTeam.id === group[1].awayTeam.id && group[0].awayTeam.id === group[1].homeTeam.id && group[0].kickoffAtUtc !== group[1].kickoffAtUtc) {
      group.forEach((fixture, index) => { fixture.leg = index + 1; roundMetadata(fixture, season, 1); });
    } else if (group.length > 2) { warnings.push(`Ambiguous two-leg tie ${group[0].tieId}; advancement held.`); }
  }
  const results: ResultInput[] = [];
  for (const fixture of fixtures) {
    const raw = rawById.get(fixture.id)!; const scores = normalizeFootballScores(raw.score);
    if (fixture.status === 'final' && !scores.normal) { warnings.push(`${fixture.id}: normal-time result missing; settlement held.`); continue; }
    let advancingTeamId: string | null = null;
    if (fixture.status === 'final' && scores.final) {
      if (fixture.stage === 'final') advancingTeamId = scores.final.home > scores.final.away ? fixture.homeTeam.id : scores.final.away > scores.final.home ? fixture.awayTeam.id : penaltyWinner(scores.penalties, fixture);
      const group = fixture.tieId ? ties.get(fixture.tieId) : undefined;
      if (fixture.leg === 2 && group?.length === 2 && group[0].leg === 1 && group[0].status === 'final') {
        const first = group[0]; const firstScores = normalizeFootballScores(rawById.get(first.id)!.score).final;
        if (firstScores && first.homeTeam.id === fixture.awayTeam.id && first.awayTeam.id === fixture.homeTeam.id) {
          const homeAggregate = firstScores.away + scores.final.home; const awayAggregate = firstScores.home + scores.final.away;
          advancingTeamId = homeAggregate > awayAggregate ? fixture.homeTeam.id : awayAggregate > homeAggregate ? fixture.awayTeam.id : penaltyWinner(scores.penalties, fixture);
        }
      }
    }
    results.push({ matchId: fixture.id, status: fixture.status, homeScore: scores.normal?.home ?? null, awayScore: scores.normal?.away ?? null, homeScoreFinal: scores.final?.home ?? null, awayScoreFinal: scores.final?.away ?? null, advancingTeamId, ...normalizeScorers(raw, fixture.id, scores.normal), reason: 'football-data.org Champions League import' });
  }
  return { fixtures, results, warnings };
}

function penaltyWinner(penalties: Pair | null, fixture: ImportedFixture): string | null { return !penalties ? null : penalties.home > penalties.away ? fixture.homeTeam.id : penalties.away > penalties.home ? fixture.awayTeam.id : null; }

export function normalizeFootballStandings(payload: unknown): ClubStanding[] {
  const data = object(payload);
  if (!Array.isArray(data.standings)) throw new ProviderError(FD, 'standings response is missing its standings array');
  const tables = data.standings.map(object).filter(row => row.type === 'TOTAL' && ['LEAGUE_STAGE', 'LEAGUE_PHASE', 'GROUP_STAGE', 'REGULAR_SEASON'].includes(String(row.stage)));
  if (tables.length === 0) return [];
  if (tables.length !== 1) throw new ProviderError(FD, 'expected one Champions League league-phase table');
  const standings: ClubStanding[] = [];
  for (const value of list(tables[0].table)) {
    const row = object(value); const club = team(row.team);
    const numbers = [row.position, row.playedGames, row.won, row.draw, row.lost, row.goalsFor, row.goalsAgainst, row.points].map(integer);
    if (!club || numbers.some(n => n === null) || numbers[0] === 0) throw new ProviderError(FD, 'invalid row in league-phase standings');
    const [position, played, won, drawn, lost, goalsFor, goalsAgainst, points] = numbers as number[];
    standings.push({ team: club, position, played, won, drawn, lost, goalsFor, goalsAgainst, points });
  }
  if (new Set(standings.map(row => row.team.id)).size !== standings.length) throw new ProviderError(FD, 'duplicate club in standings');
  return standings.sort((a, b) => a.position - b.position);
}

export async function fetchFootballData(options: FootballOptions = {}): Promise<FootballImport> {
  const apiKey = options.apiKey ?? process.env.FOOTBALL_API_KEY;
  if (!apiKey) throw new ProviderError(FD, 'FOOTBALL_API_KEY is required');
  const season = options.season ?? 2026;
  if (!Number.isInteger(season) || season < 2024 || season > 2100) throw new ProviderError(FD, 'invalid Champions League season');
  const fetcher = options.fetcher ?? fetch; const limits = budget(options, 'RESULT_IMPORT', 4);
  const headers = { 'X-Auth-Token': apiKey, 'X-Unfold-Goals': 'true', 'X-Unfold-Lineups': 'true', 'X-Unfold-Subs': 'true' };
  const matches = await request(FD, new URL(`${FD_URL}/competitions/CL/matches?season=${season}`), headers, limits, fetcher);
  const normalized = normalizeFootballMatches(matches, season);
  let standings: ClubStanding[] = [];
  try {
    standings = normalizeFootballStandings(await request(FD, new URL(`${FD_URL}/competitions/CL/standings?season=${season}`), { 'X-Auth-Token': apiKey }, limits, fetcher));
  } catch (error) {
    normalized.warnings!.push(error instanceof ProviderError ? `Standings unavailable: ${error.message}` : 'Standings unavailable: import failed');
  }
  return { ...normalized, standings };
}

// Explicit aliases only. Never compare by substring, initials, edit distance or shared suffix.
const CLUB_ALIASES = [
  ['FC Bayern München', 'Bayern', 'Bayern Munich', 'Bayern München', 'FC Bayern Munich'],
  ['FC Internazionale Milano', 'Inter', 'Inter Milan', 'Internazionale'],
  ['Paris Saint-Germain FC', 'Paris Saint-Germain', 'Paris SG', 'PSG'],
  ['Club Atlético de Madrid', 'Atlético Madrid', 'Atlético de Madrid', 'Atletico Madrid', 'Atletico de Madrid'],
  ['Sporting Clube de Portugal', 'Sporting CP', 'Sporting Lisbon', 'Sporting'],
  ['Real Madrid CF', 'Real Madrid'], ['FC Barcelona', 'Barcelona'],
  ['Arsenal FC', 'Arsenal'], ['Chelsea FC', 'Chelsea'], ['Liverpool FC', 'Liverpool'],
  ['Manchester City FC', 'Manchester City', 'Man City'], ['Manchester United FC', 'Manchester United', 'Man Utd', 'Man United'],
  ['Tottenham Hotspur FC', 'Tottenham Hotspur', 'Tottenham'], ['Newcastle United FC', 'Newcastle United', 'Newcastle'],
  ['Juventus FC', 'Juventus'], ['AC Milan', 'Milan'], ['SSC Napoli', 'Napoli'], ['Atalanta BC', 'Atalanta'],
  ['Borussia Dortmund', 'Dortmund'], ['Bayer 04 Leverkusen', 'Bayer Leverkusen', 'Leverkusen'],
  ['Eintracht Frankfurt', 'Frankfurt'], ['SL Benfica', 'Benfica'], ['FC Porto', 'Porto'],
  ['PSV Eindhoven', 'PSV'], ['AFC Ajax', 'Ajax'], ['Feyenoord Rotterdam', 'Feyenoord'],
  ['Club Brugge KV', 'Club Brugge', 'Brugge'], ['Olympique de Marseille', 'Marseille'],
  ['AS Monaco FC', 'AS Monaco', 'Monaco'], ['Villarreal CF', 'Villarreal'], ['Athletic Club', 'Athletic Bilbao'],
  ['FC København', 'FC Copenhagen', 'Copenhagen', 'Kobenhavn'], ['FK Bodø/Glimt', 'Bodø/Glimt', 'Bodo/Glimt'],
  ['Galatasaray SK', 'Galatasaray'], ['Olympiakos SFP', 'Olympiacos FC', 'Olympiacos', 'Olympiakos'],
  ['SK Slavia Praha', 'Slavia Praha', 'Slavia Prague'], ['Qarabağ FK', 'Qarabag FK', 'Qarabag'],
  ['Kairat Almaty', 'FC Kairat Almaty'], ['Pafos FC', 'Pafos'], ['Royale Union Saint-Gilloise', 'Union Saint-Gilloise', 'Union SG'],
  ['Celtic FC', 'Celtic'], ['Rangers FC', 'Rangers'], ['FC Salzburg', 'Red Bull Salzburg', 'Salzburg'],
  ['AEK Athens FC', 'AEK Athens', 'AEK'], ['Aston Villa FC', 'Aston Villa'], ['Como 1907', 'Como'],
  ['Fenerbahçe SK', 'Fenerbahçe'], ['LASK Linz', 'LASK'], ['RB Leipzig', 'Leipzig'],
  ['RC Lens', 'Racing Club de Lens', 'Lens'], ['Lille OSC', 'Lille'], ['Real Betis Balompié', 'Real Betis'],
  ['AS Roma', 'Roma'], ['Sabah FK', 'Sabah'], ['FC Shakhtar Donetsk', 'Shakhtar Donetsk'],
  ['ŠK Slovan Bratislava', 'Slovan Bratislava'], ['VfB Stuttgart', 'Stuttgart'], ['Viking FK', 'Viking']
].map(group => group.map(normalize));

export function clubNamesMatch(club: Team, candidate: string): boolean {
  const candidateKey = normalize(candidate); const names = [normalize(club.name), normalize(club.shortName)];
  // Three-letter team abbreviations are not sufficient cross-provider evidence.
  if (names.some(name => name.length > 3 && name === candidateKey)) return true;
  return CLUB_ALIASES.some(group => group.includes(candidateKey) && group.some(name => names.includes(name)));
}

export function matchOddsEvents(fixtures: ImportedFixture[], payload: unknown): OddsEventMatch[] {
  if (!Array.isArray(payload)) throw new ProviderError(ODDS, 'events response was not an array');
  const events = payload.map(object).filter(row => id(row.id) && str(row.home) && str(row.away) && timestamp(row.date));
  const matches: OddsEventMatch[] = []; const used = new Set<string>();
  for (const fixture of fixtures) {
    const candidates: OddsEventMatch[] = [];
    for (const event of events) {
      if (used.has(String(event.id)) || Math.abs(Date.parse(String(event.date)) - Date.parse(fixture.kickoffAtUtc)) > 2 * HOUR) continue;
      if (clubNamesMatch(fixture.homeTeam, String(event.home)) && clubNamesMatch(fixture.awayTeam, String(event.away))) candidates.push({ fixture, event, reversed: false });
      else if (clubNamesMatch(fixture.homeTeam, String(event.away)) && clubNamesMatch(fixture.awayTeam, String(event.home))) candidates.push({ fixture, event, reversed: true });
    }
    if (candidates.length === 1) { matches.push(candidates[0]); used.add(String(candidates[0].event.id)); }
    // Multiple candidate events could be duplicate/incompatible bookmaker fixtures: hold, never guess.
  }
  return matches;
}

function decimal(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value))) return null;
  const odds = Number(value); return Number.isFinite(odds) && odds > 1 && odds <= 100_000 ? odds : null;
}
function marketType(name: string): ImportedOdds['markets'][number]['type'] | null {
  const key = normalize(name);
  if (['ml', '1x2', 'match result', 'full time result', 'match winner'].includes(key)) return 'main_1x2';
  if (['correct score', 'exact score', 'full time correct score'].includes(key)) return 'exact_score';
  if (['anytime goalscorer', 'anytime goal scorer', 'player props goals', 'player goals'].includes(key)) return 'anytime_goalscorer';
  return null;
}

export function normalizeOdds(match: OddsEventMatch, value: unknown, capturedAt = new Date().toISOString(), preferredBooks = ['Unibet', 'Bet365']): ImportedOdds {
  const data = object(value); const books = object(data.bookmakers); const chosen = new Map<string, ImportedOdds['markets'][number]>();
  // One bookmaker per market, preserving a consistent 1X2 rather than cherry-picking prices.
  const bookOrder = [...new Set([...preferredBooks, ...Object.keys(books).sort()])];
  for (const book of bookOrder) {
    for (const raw of list(books[book])) {
      const market = object(raw); const type = marketType(String(market.name ?? ''));
      if (!type || chosen.has(type)) continue;
      const selections: ImportedOdds['markets'][number]['selections'] = [];
      for (const value of list(market.odds)) {
        const row = object(value);
        if (type === 'main_1x2') {
          const home = decimal(match.reversed ? row.away : row.home); const draw = decimal(row.draw); const away = decimal(match.reversed ? row.home : row.away);
          if (home && draw && away) {
            selections.push({ key: 'home', label: match.fixture.homeTeam.shortName, kind: 'home_win', decimalOdds: home }, { key: 'draw', label: 'Draw', kind: 'draw', decimalOdds: draw }, { key: 'away', label: match.fixture.awayTeam.shortName, kind: 'away_win', decimalOdds: away });
            break;
          }
        } else if (type === 'exact_score') {
          const score = /^\s*(\d{1,2})\s*[-:]\s*(\d{1,2})\s*$/.exec(String(row.label ?? '')); const odds = decimal(row.odds);
          if (!score || !odds) continue;
          const scoreHome = Number(score[match.reversed ? 2 : 1]); const scoreAway = Number(score[match.reversed ? 1 : 2]);
          selections.push({ key: `${scoreHome}-${scoreAway}`, label: `${scoreHome}–${scoreAway}`, kind: 'exact_score', decimalOdds: odds, scoreHome, scoreAway });
        } else {
          let name = str(row.playerName) ?? str(row.player) ?? str(row.player_name) ?? str(row.label) ?? str(row.name);
          if (!name || ['none', 'no goalscorer', 'no goal scorer', 'own goal', 'no goal'].includes(normalize(name))) continue;
          const suffix = /\s*\(([^)]+)\)\s*$/.exec(name);
          if (suffix && (clubNamesMatch(match.fixture.homeTeam, suffix[1]) || clubNamesMatch(match.fixture.awayTeam, suffix[1]))) name = name.slice(0, suffix.index).trim();
          const propGoals = ['player goals', 'player props goals'].includes(normalize(String(market.name)));
          // An over-1.5 or first/last scorer price is never an anytime-goalscorer price.
          if (propGoals && Number(row.hdp) !== 0.5) continue;
          if (row.hdp !== undefined && Number(row.hdp) !== 0.5) continue;
          const odds = decimal(row.odds) ?? decimal(row.yes) ?? decimal(row.over);
          if (!odds || normalize(name).length < 3) continue;
          const playerId = playerIdentity(match.fixture.id, name);
          selections.push({ key: playerId, label: name, kind: 'player_anytime_goalscorer', decimalOdds: odds, playerId });
        }
      }
      const unique = new Map(selections.map(selection => [selection.key, selection]));
      if (unique.size > 0) chosen.set(type, { type, selections: [...unique.values()] });
    }
  }
  return { matchId: match.fixture.id, source: `odds-api.io:${String(data.id ?? match.event.id)}`, capturedAt, markets: [...chosen.values()] };
}

export function discoverUclLeague(payload: unknown, configuredSlug?: string): string {
  if (!Array.isArray(payload)) throw new ProviderError(ODDS, 'leagues response was not an array');
  const leagues = payload.map(object);
  if (configuredSlug) {
    const found = leagues.find(row => row.slug === configuredSlug);
    if (!found) throw new ProviderError(ODDS, 'configured Champions League slug is absent from the football leagues feed');
    return configuredSlug;
  }
  const candidates = leagues.filter(row => {
    const name = normalize(String(row.name ?? '')); const slug = String(row.slug ?? '');
    return (slug === ODDS_UCL_LEAGUE_SLUG || slug.endsWith(`-${ODDS_UCL_LEAGUE_SLUG}`) || ['champions league', 'uefa champions league', 'international clubs uefa champions league'].includes(name)) && !/women|youth|qualif|afc|caf|concacaf/.test(`${slug} ${name}`);
  });
  if (candidates.length !== 1 || !str(candidates[0].slug)) throw new ProviderError(ODDS, 'could not identify one men’s UEFA Champions League; verify ODDS_API_LEAGUE_SLUG against /v3/leagues');
  return String(candidates[0].slug);
}

export async function fetchOdds(fixtures: ImportedFixture[], options: OddsOptions = {}): Promise<ImportedOdds[]> {
  const apiKey = options.apiKey ?? process.env.ODDS_API_KEY;
  if (!apiKey) throw new ProviderError(ODDS, 'ODDS_API_KEY is required');
  const now = options.now ?? new Date(); const days = bounded(options.lookaheadDays ?? process.env.ODDS_IMPORT_LOOKAHEAD_DAYS, 10, 60);
  const limit = bounded(options.matchLimit ?? process.env.ODDS_IMPORT_MATCH_LIMIT_PER_RUN, 40, 200);
  const upcoming = fixtures.filter(fixture => fixture.status === 'scheduled' && Date.parse(fixture.kickoffAtUtc) > now.getTime() && Date.parse(fixture.kickoffAtUtc) <= now.getTime() + days * DAY).sort((a, b) => a.kickoffAtUtc.localeCompare(b.kickoffAtUtc)).slice(0, limit);
  if (!upcoming.length) return [];
  const limits = budget(options, 'ODDS_IMPORT', 10); const fetcher = options.fetcher ?? fetch;
  const bookmakers = options.bookmakers ?? (process.env.ODDS_API_BOOKMAKERS ?? 'Unibet,Bet365').split(',').map(value => value.trim()).filter(Boolean);
  if (!bookmakers.length || bookmakers.length > 30) throw new ProviderError(ODDS, 'choose 1–30 bookmakers with ODDS_API_BOOKMAKERS');
  const get = (path: string, params: Record<string, string>) => {
    const url = new URL(`${ODDS_URL}${path}`); url.searchParams.set('apiKey', apiKey);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return request(ODDS, url, {}, limits, fetcher);
  };
  const league = discoverUclLeague(await get('/leagues', { sport: 'football' }), process.env.ODDS_API_LEAGUE_SLUG);
  const events = await get('/events', { sport: 'football', league, status: 'pending', from: new Date(Date.parse(upcoming[0].kickoffAtUtc) - 2 * HOUR).toISOString(), to: new Date(Date.parse(upcoming.at(-1)!.kickoffAtUtc) + 2 * HOUR).toISOString(), limit: '500' });
  if (Array.isArray(events) && events.length >= 500) throw new ProviderError(ODDS, 'event discovery reached its cap; narrow the import range');
  const matched = matchOddsEvents(upcoming, events);
  if (!matched.length) throw new ProviderError(ODDS, 'no upcoming fixtures matched the provider’s Champions League events; verify coverage and club aliases');
  const output: ImportedOdds[] = [];
  for (let start = 0; start < matched.length; start += 10) {
    const batch = matched.slice(start, start + 10);
    const payload = await get('/odds/multi', { eventIds: batch.map(match => String(match.event.id)).join(','), bookmakers: bookmakers.join(',') });
    if (!Array.isArray(payload)) throw new ProviderError(ODDS, 'multi-event odds response was not an array');
    const seen = new Set<string>();
    for (const raw of payload) {
      const event = object(raw); const eventId = id(event.id); if (!eventId) continue;
      const match = batch.find(item => String(item.event.id) === eventId);
      if (!match || seen.has(eventId)) continue;
      // ID is from this provider's discovered events, not a football-data numeric ID.
      seen.add(eventId);
      const odds = normalizeOdds(match, event, new Date().toISOString(), bookmakers);
      if (odds.markets.length) output.push(odds);
    }
  }
  if (!output.length) throw new ProviderError(ODDS, 'matched events contained no supported real odds; check bookmaker access');
  return output;
}
