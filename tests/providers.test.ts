import { afterEach, describe, expect, it, vi } from 'vitest';
import { clubNamesMatch, discoverUclLeague, fetchFootballData, fetchOdds, matchOddsEvents, normalizeFootballMatches, normalizeFootballScores, normalizeFootballStandings, normalizeOdds, normalizeScorers, playerIdentity } from '../server/providers';
import type { ImportedFixture } from '../shared/imports';

const home = { id: 5, name: 'FC Bayern München', shortName: 'Bayern', crest: 'https://crests.football-data.org/5.svg' };
const away = { id: 81, name: 'FC Barcelona', shortName: 'Barcelona', crest: 'https://crests.football-data.org/81.svg' };
const person = (id: number, name = `Football Player ${id}`) => ({ id, name });
const homeLineup = Array.from({ length: 11 }, (_, i) => person(i + 1));
const awayLineup = Array.from({ length: 11 }, (_, i) => person(i + 21));
function rawMatch(overrides: Record<string, unknown> = {}) {
  return { id: 600001, competition: { code: 'CL' }, season: { startDate: '2026-07-07' }, utcDate: '2026-09-15T19:00:00Z', status: 'TIMED', stage: 'LEAGUE_STAGE', matchday: 1, homeTeam: home, awayTeam: away, score: { duration: 'REGULAR', fullTime: { home: null, away: null } }, ...overrides };
}
function finishedMatch(overrides: Record<string, unknown> = {}) {
  return rawMatch({ status: 'FINISHED', homeTeam: { ...home, lineup: homeLineup, bench: [person(12, 'Leroy Sané'), person(13)] }, awayTeam: { ...away, lineup: awayLineup, bench: [person(32)] }, substitutions: [], goals: [], score: { duration: 'REGULAR', fullTime: { home: 0, away: 0 } }, ...overrides });
}
function fixture(overrides: Partial<ImportedFixture> = {}): ImportedFixture {
  return { id: 'fd-600001', providerId: '600001', homeTeam: { ...home, id: 'fd-5' }, awayTeam: { ...away, id: 'fd-81' }, kickoffAtUtc: '2026-09-15T19:00:00.000Z', stage: 'league', roundId: 'ucl-2026-league-1', roundName: 'League phase · Matchday 1', roundNumber: 1, leg: null, tieId: null, status: 'scheduled', ...overrides };
}
const respond = (data: unknown, status = 200, headers?: Record<string, string>) => new Response(JSON.stringify(data), { status, headers });
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe('football-data fixtures and knockout scores', () => {
  it('imports the league phase with stable IDs and filters qualifying and other competitions', () => {
    const imported = normalizeFootballMatches({ matches: [rawMatch(), rawMatch({ id: 2, stage: 'PLAYOFFS', utcDate: '2026-08-25T19:00:00Z' }), rawMatch({ id: 3, competition: { code: 'PL' } }), rawMatch({ id: 4, stage: 'QUALIFICATION_ROUND_3' })] });
    expect(imported.fixtures).toHaveLength(1);
    expect(imported.fixtures[0]).toMatchObject({ id: 'fd-600001', providerId: '600001', homeTeam: { id: 'fd-5' }, roundId: 'ucl-2026-league-1', roundNumber: 1, leg: null, tieId: null });
  });

  it('keeps 90-minute scores separate and removes the shootout tally from final goals', () => {
    expect(normalizeFootballScores({ duration: 'PENALTY_SHOOTOUT', winner: 'HOME_TEAM', fullTime: { home: 7, away: 6 }, regularTime: { home: 1, away: 1 }, extraTime: { home: 0, away: 0 }, penalties: { home: 6, away: 5 } })).toEqual({ normal: { home: 1, away: 1 }, final: { home: 1, away: 1 }, penalties: { home: 6, away: 5 } });
    expect(normalizeFootballScores({ duration: 'EXTRA_TIME', fullTime: { home: 2, away: 1 } }).normal).toBeNull();
    const imported = normalizeFootballMatches({ matches: [finishedMatch({ score: { duration: 'PENALTY_SHOOTOUT', fullTime: { home: 7, away: 6 } } })] });
    expect(imported.results).toEqual([]);
    expect(imported.warnings?.[0]).toContain('settlement held');
  });

  it('groups legs independently of orientation and uses aggregate winner, not second-match winner', () => {
    const first = finishedMatch({ id: 100, stage: 'LAST_16', utcDate: '2027-03-09T20:00:00Z', matchday: 11, score: { duration: 'REGULAR', winner: 'HOME_TEAM', fullTime: { home: 3, away: 0 } } });
    const second = finishedMatch({ id: 101, stage: 'LAST_16', utcDate: '2027-03-16T20:00:00Z', matchday: 12, homeTeam: away, awayTeam: home, score: { duration: 'REGULAR', winner: 'HOME_TEAM', fullTime: { home: 1, away: 0 } } });
    const result = normalizeFootballMatches({ matches: [second, first] });
    expect(result.fixtures.map(row => row.leg)).toEqual([1, 2]);
    expect(result.fixtures[0].tieId).toBe(result.fixtures[1].tieId);
    expect(result.fixtures.map(row => row.roundNumber)).toEqual([11, 12]);
    expect(result.results[0].advancingTeamId).toBeNull();
    expect(result.results[1].advancingTeamId).toBe('fd-5');
    expect(normalizeFootballMatches({ matches: [second] }).results[0].advancingTeamId).toBeNull();
  });

  it('does not use the abolished away-goals rule and waits for a resolved aggregate', () => {
    const first = finishedMatch({ id: 100, stage: 'QUARTER_FINALS', utcDate: '2027-04-06T19:00:00Z', score: { duration: 'REGULAR', fullTime: { home: 2, away: 1 } } });
    const second = finishedMatch({ id: 101, stage: 'QUARTER_FINALS', utcDate: '2027-04-13T19:00:00Z', homeTeam: away, awayTeam: home, score: { duration: 'REGULAR', winner: 'HOME_TEAM', fullTime: { home: 1, away: 0 } } });
    expect(normalizeFootballMatches({ matches: [first, second] }).results[1].advancingTeamId).toBeNull();
  });

  it('uses extra-time goals in aggregate and a shootout only to resolve a tied aggregate', () => {
    const first = finishedMatch({ id: 100, stage: 'SEMI_FINALS', utcDate: '2027-04-27T19:00:00Z', score: { duration: 'REGULAR', fullTime: { home: 1, away: 0 } } });
    const second = finishedMatch({ id: 101, stage: 'SEMI_FINALS', utcDate: '2027-05-04T19:00:00Z', homeTeam: away, awayTeam: home, score: { duration: 'PENALTY_SHOOTOUT', regularTime: { home: 1, away: 0 }, extraTime: { home: 1, away: 1 }, penalties: { home: 4, away: 5 }, fullTime: { home: 6, away: 6 } } });
    const result = normalizeFootballMatches({ matches: [first, second] }).results[1];
    expect(result).toMatchObject({ homeScore: 1, awayScore: 0, homeScoreFinal: 2, awayScoreFinal: 1, advancingTeamId: 'fd-5' });
  });
});

describe('scorer settlement evidence', () => {
  it('requires participant data even for a confirmed 0–0', () => {
    const raw = finishedMatch();
    expect(normalizeScorers(raw, 'fd-1', { home: 0, away: 0 }).scorerDataComplete).toBe(true);
    expect(normalizeScorers({ ...raw, homeTeam: home }, 'fd-1', { home: 0, away: 0 }).scorerDataComplete).toBe(false);
    expect(normalizeScorers({ ...raw, substitutions: undefined }, 'fd-1', { home: 0, away: 0 }).scorerDataComplete).toBe(false);
  });

  it('includes normal-time stoppage goals and confirmed substitutes; bench alone is not appearance', () => {
    const raw = finishedMatch({ substitutions: [{ minute: 90, injuryTime: 2, team: home, playerIn: person(12, 'Leroy Sané'), playerOut: person(1) }], goals: [{ minute: 90, injuryTime: 7, type: 'REGULAR', team: home, scorer: person(12, 'Leroy Sané') }] });
    const normalized = normalizeScorers(raw, 'fd-1', { home: 1, away: 0 });
    expect(normalized.scorerDataComplete).toBe(true);
    expect(normalized.scorerPlayerIds).toEqual([playerIdentity('fd-1', 'Leroy Sane')]);
    expect(normalized.appearedPlayerIds).toContain(playerIdentity('fd-1', 'Leroy Sané'));
    expect(normalized.registeredPlayerIds).toContain(playerIdentity('fd-1', 'Football Player 13'));
    expect(normalized.appearedPlayerIds).not.toContain(playerIdentity('fd-1', 'Football Player 13'));
  });

  it('reconciles all goals including own goals, and excludes extra-time and shootout scorers', () => {
    const raw = finishedMatch({ score: { duration: 'EXTRA_TIME', regularTime: { home: 1, away: 1 }, fullTime: { home: 2, away: 1 } }, goals: [
      { minute: 40, type: 'OWN', team: home, scorer: person(21) },
      { minute: 90, injuryTime: 4, type: 'PENALTY', team: away, scorer: person(22) },
      { minute: 104, type: 'REGULAR', team: home, scorer: person(2) },
      { minute: 120, type: 'PENALTY_SHOOTOUT', team: home, scorer: person(3) }
    ] });
    const result = normalizeScorers(raw, 'fd-1', { home: 1, away: 1 });
    expect(result.scorerDataComplete).toBe(true);
    expect(result.scorerPlayerIds).toEqual([playerIdentity('fd-1', 'Football Player 22')]);
    expect(normalizeScorers(raw, 'fd-1', { home: 2, away: 1 }).scorerDataComplete).toBe(false);
    expect(normalizeScorers({ ...raw, goals: [] }, 'fd-1', { home: 1, away: 1 }).scorerDataComplete).toBe(false);
  });

  it('recognizes elapsed-minute stoppage only when the provider confirms a regular finish', () => {
    const raw = finishedMatch({ goals: [{ minute: 95, type: 'REGULAR', team: home, scorer: person(1) }] });
    expect(normalizeScorers(raw, 'fd-1', { home: 1, away: 0 }).scorerDataComplete).toBe(true);
    const extra = { ...raw, score: { duration: 'EXTRA_TIME' } };
    expect(normalizeScorers(extra, 'fd-1', { home: 1, away: 0 }).scorerDataComplete).toBe(false);
  });

  it('holds ambiguous participant names and does not infer scorer appearance', () => {
    const raw = finishedMatch({ goals: [{ minute: 50, type: 'REGULAR', team: home, scorer: person(12, 'Leroy Sané') }] });
    expect(normalizeScorers(raw, 'fd-1', { home: 1, away: 0 }).scorerDataComplete).toBe(false);
    const namesCollide = finishedMatch({ awayTeam: { ...away, lineup: [person(21, 'Football Player 1'), ...awayLineup.slice(1)], bench: [] } });
    expect(normalizeScorers(namesCollide, 'fd-1', { home: 0, away: 0 }).scorerDataComplete).toBe(false);
  });
});

describe('provider requests', () => {
  it('requests 2026 CL fixtures with unfolded evidence and retains them when standings are forbidden', async () => {
    const mocked = vi.fn<typeof fetch>().mockResolvedValueOnce(respond({ matches: [rawMatch()] })).mockResolvedValueOnce(respond({ error: 'secret echoed by upstream' }, 403));
    const result = await fetchFootballData({ apiKey: 'secret', fetcher: mocked });
    expect(String(mocked.mock.calls[0][0])).toBe('https://api.football-data.org/v4/competitions/CL/matches?season=2026');
    expect(mocked.mock.calls[0][1]?.headers).toMatchObject({ 'X-Unfold-Goals': 'true', 'X-Unfold-Lineups': 'true', 'X-Unfold-Subs': 'true' });
    expect(result.fixtures).toHaveLength(1);
    expect(result.standings).toEqual([]);
    expect(result.warnings?.join()).toContain('HTTP 403');
    expect(result.warnings?.join()).not.toContain('secret');
  });

  it('normalizes the one total league table and rejects null numeric values', () => {
    const standing = { team: home, position: 1, playedGames: 2, won: 2, draw: 0, lost: 0, goalsFor: 6, goalsAgainst: 1, points: 6 };
    const make = (row: object) => ({ standings: [{ stage: 'LEAGUE_STAGE', type: 'TOTAL', table: [row] }] });
    expect(normalizeFootballStandings(make(standing))[0]).toMatchObject({ team: { id: 'fd-5' }, played: 2, drawn: 0, points: 6 });
    expect(() => normalizeFootballStandings(make({ ...standing, points: null }))).toThrow('invalid row');
  });

  it('bounds network time and removes credential-bearing transport errors', async () => {
    const broken = vi.fn<typeof fetch>().mockRejectedValue(new Error('https://api.example?apiKey=SECRET'));
    await expect(fetchFootballData({ apiKey: 'SECRET', fetcher: broken })).rejects.toThrow('network request failed');
    await expect(fetchFootballData({ apiKey: 'SECRET', fetcher: vi.fn<typeof fetch>(() => new Promise(() => {})), requestTimeoutMs: 5 })).rejects.toThrow('timed out');
  });
});

describe('Odds-API.io matching and markets', () => {
  const event = { id: 9001, home: 'Bayern Munich', away: 'Barcelona', date: '2026-09-15T19:00:00Z' };
  it('discovers UCL from the provider catalogue and rejects ambiguous/women’s leagues', () => {
    expect(discoverUclLeague([{ name: 'UEFA Champions League', slug: 'international-uefa-champions-league' }])).toBe('international-uefa-champions-league');
    expect(() => discoverUclLeague([{ name: 'UEFA Champions League Women', slug: 'women-uefa-champions-league' }])).toThrow();
    expect(() => discoverUclLeague([{ slug: 'uefa-champions-league' }, { slug: 'international-uefa-champions-league' }])).toThrow();
  });

  it('requires an exact alias pair, close kickoff, and a unique event', () => {
    expect(clubNamesMatch(fixture().homeTeam, 'Bayern Munich')).toBe(true);
    expect(clubNamesMatch(fixture().homeTeam, 'Bayern Munich II')).toBe(false);
    expect(matchOddsEvents([fixture()], [event])).toHaveLength(1);
    expect(matchOddsEvents([fixture()], [event, { ...event, id: 9002 }])).toEqual([]);
    expect(matchOddsEvents([fixture()], [{ ...event, date: '2026-09-22T19:00:00Z' }])).toEqual([]);
    expect(matchOddsEvents([fixture()], [{ ...event, home: 'Barcelona', away: 'Bayern Munich' }])[0].reversed).toBe(true);
  });

  it('orients real 1X2/exact-score odds and accepts only valid anytime player props', () => {
    const matched = matchOddsEvents([fixture()], [{ ...event, home: 'Barcelona', away: 'Bayern Munich' }])[0];
    const result = normalizeOdds(matched, { id: 9001, bookmakers: { Unibet: [
      { name: 'ML', odds: [{ home: '3.10', draw: '3.50', away: '2.25' }] },
      { name: 'Correct Score', odds: [{ label: '2-1', odds: '9.50' }, { label: 'Any other score', odds: '7.1' }] },
      { name: 'Player Props - Goals', odds: [{ label: 'Leroy Sané', hdp: 0.5, over: '2.70', under: '1.35' }, { label: 'Football Player 2', hdp: 1.5, over: '5.50' }] },
      { name: 'First Goalscorer', odds: [{ label: 'Football Player 1', odds: '8.00' }] }
    ] } }, '2026-09-08T12:00:00.000Z');
    expect(result.markets[0].selections.map(selection => selection.decimalOdds)).toEqual([2.25, 3.5, 3.1]);
    expect(result.markets[1].selections).toMatchObject([{ scoreHome: 1, scoreAway: 2, decimalOdds: 9.5 }]);
    expect(result.markets[2].selections).toMatchObject([{ playerId: playerIdentity('fd-600001', 'Leroy Sane'), decimalOdds: 2.7 }]);
    expect(result.markets[2].selections).toHaveLength(1);
  });

  it('never invents a draw or prices for unsupported/missing markets', () => {
    const matched = matchOddsEvents([fixture()], [event])[0];
    const result = normalizeOdds(matched, { bookmakers: { Unibet: [{ name: 'ML', odds: [{ home: 2, away: 3 }] }, { name: 'ML HT', odds: [{ home: 2, draw: 3, away: 4 }] }, { name: 'Correct Score', odds: [{ label: '0-0', odds: 0 }] }] } });
    expect(result.markets).toEqual([]);
  });

  it('uses v3 events then batches at most ten event IDs per odds request', async () => {
    const fixtures = Array.from({ length: 21 }, (_, i) => fixture({ id: `fd-${i + 1}`, providerId: String(i + 1), kickoffAtUtc: new Date(Date.UTC(2026, 8, 10, 0, i * 180)).toISOString() }));
    const events = fixtures.map((row, i) => ({ ...event, id: 9000 + i, date: row.kickoffAtUtc }));
    const calls: URL[] = [];
    const mocked = vi.fn<typeof fetch>(async input => {
      const url = new URL(String(input)); calls.push(url);
      if (url.pathname.endsWith('/leagues')) return respond([{ name: 'UEFA Champions League', slug: 'uefa-champions-league' }]);
      if (url.pathname.endsWith('/events')) return respond(events);
      return respond((url.searchParams.get('eventIds') ?? '').split(',').map(id => ({ id: Number(id), bookmakers: { Unibet: [{ name: 'ML', odds: [{ home: '2.00', draw: '3.00', away: '4.00' }] }] } })));
    });
    const result = await fetchOdds(fixtures, { apiKey: 'secret', fetcher: mocked, now: new Date('2026-09-08T12:00:00Z') });
    expect(result).toHaveLength(21);
    expect(calls.filter(url => url.pathname.endsWith('/odds/multi')).map(url => url.searchParams.get('eventIds')!.split(',').length)).toEqual([10, 10, 1]);
    expect(calls.every(url => url.origin === 'https://api.odds-api.io' && url.searchParams.get('apiKey') === 'secret')).toBe(true);
    expect(calls[1].searchParams.get('league')).toBe('uefa-champions-league');
  });

  it('stops at the provider rate limit without exposing keys or making another request', async () => {
    const mocked = vi.fn<typeof fetch>().mockResolvedValueOnce(respond([{ name: 'UEFA Champions League', slug: 'uefa-champions-league' }], 200, { 'X-RateLimit-Remaining': '0' }));
    await expect(fetchOdds([fixture()], { apiKey: 'secret', fetcher: mocked, now: new Date('2026-09-08T12:00:00Z') })).rejects.toThrow('rate limit exhausted');
    expect(mocked).toHaveBeenCalledTimes(1);
  });
});
