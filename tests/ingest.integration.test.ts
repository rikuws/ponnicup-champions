import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FootballImport, ImportedFixture, ImportedOdds } from '../shared/imports';
import type { User } from '../shared/contracts';

const databaseUrl = process.env.INGEST_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
let db: typeof import('../server/db');
let ingest: typeof import('../server/ingest');
let engine: typeof import('../server/engine');
let hash = '';
let kickoff: string;
const admin: User = { id: 'riku', displayName: 'Riku', role: 'admin', pinResetRequired: false };
const home = { id: 'fd-5', name: 'Bayern Munich', shortName: 'Bayern', crest: null };
const away = { id: 'fd-81', name: 'Barcelona', shortName: 'Barcelona', crest: null };
function fixture(overrides: Partial<ImportedFixture> = {}): ImportedFixture {
  return { id: 'fd-600001', providerId: '600001', homeTeam: home, awayTeam: away, kickoffAtUtc: kickoff, roundId: 'ingest-league-1', roundName: 'Ingest round', roundNumber: 1, stage: 'league', leg: null, tieId: null, status: 'scheduled', ...overrides };
}
function data(fixtures: ImportedFixture[] = [fixture()]): FootballImport { return { fixtures, standings: [], results: [] }; }
function odds(matchId = 'fd-600001', price = 2): ImportedOdds {
  return { matchId, source: 'odds-api.io:9001', capturedAt: new Date().toISOString(), markets: [{ type: 'main_1x2', selections: [{ key: 'home', kind: 'home_win', label: 'Bayern', decimalOdds: price }, { key: 'draw', kind: 'draw', label: 'Draw', decimalOdds: 3 }, { key: 'away', kind: 'away_win', label: 'Barcelona', decimalOdds: 4 }] }] };
}

suite('PostgreSQL import integration', () => {
  beforeAll(async () => {
    if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('Ingest integration database name must end with _test');
    process.env.DATABASE_URL = databaseUrl; process.env.SEASON_ID = 'ingest-season';
    db = await import('../server/db'); ingest = await import('../server/ingest'); engine = await import('../server/engine');
    await (await import('../server/migrate')).migrate(); hash = await (await import('../server/auth')).hashPin('654321');
  });
  beforeEach(async () => {
    await db.pool.query('TRUNCATE seasons,users,teams,login_attempts,sync_status CASCADE');
    kickoff = new Date(Date.now() + 86400_000).toISOString();
    await db.pool.query("INSERT INTO seasons(id,name,competition,game_start_at,config) VALUES('ingest-season','Ingest season','CL',now()-interval '1 day',$1)", [{ startingBalance: 1000, dailyBonus: 100, minimumStake: 1, recoveryThreshold: 500 }]);
    await db.pool.query("INSERT INTO users(id,display_name,role,pin_hash,pin_reset_required) VALUES('riku','Riku','admin',$1,false)", [hash]);
    await db.pool.query("INSERT INTO ledger(user_id,season_id,amount,type) VALUES('riku','ingest-season',1000,'starting_balance')");
  });
  afterAll(async () => { if (db) await db.pool.end(); });

  it('replays fixtures and freezes the first complete real market without duplicate snapshots', async () => {
    await ingest.persistFootball(data()); await ingest.persistFootball(data());
    expect((await db.pool.query('SELECT count(*) FROM matches')).rows[0].count).toBe('1');
    expect((await db.pool.query('SELECT count(*) FROM markets')).rows[0].count).toBe('3');
    const opened = await Promise.all([ingest.persistOdds([odds()]), ingest.persistOdds([odds('fd-600001', 9)])]);
    expect(opened.reduce((sum, result) => sum + result.openedMarkets, 0)).toBe(1);
    const snapshots = (await db.pool.query('SELECT id,decimal_odds FROM odds_snapshots ORDER BY id')).rows;
    expect(snapshots).toHaveLength(3);
    await ingest.persistOdds([odds('fd-600001', 15)]);
    expect((await db.pool.query('SELECT id,decimal_odds FROM odds_snapshots ORDER BY id')).rows).toEqual(snapshots);
    expect((await db.pool.query("SELECT status,required FROM markets WHERE type='main_1x2'")).rows[0]).toEqual({ status: 'open', required: true });
    expect((await db.pool.query("SELECT status,required FROM markets WHERE type='anytime_goalscorer'")).rows[0]).toEqual({ status: 'draft', required: false });
  });

  it('preserves known standings when the optional provider resource fails', async () => {
    const initial = data();
    initial.standings = [{ team: home, position: 1, played: 1, won: 1, drawn: 0, lost: 0, goalsFor: 2, goalsAgainst: 0, points: 3 }];
    await ingest.persistFootball(initial);
    await ingest.persistFootball({ ...data(), warnings: ['Standings unavailable: subscription restriction'] });
    expect((await db.pool.query('SELECT position,points FROM club_standings')).rows).toEqual([{ position: 1, points: 3 }]);
    await ingest.persistFootball({ ...data(), standings: [{ ...initial.standings[0], position: 2, played: 2, drawn: 1, points: 4 }] });
    expect((await db.pool.query('SELECT position,points FROM club_standings')).rows).toEqual([{ position: 2, points: 4 }]);
  });

  it('keeps preseason, live and already-started fixtures closed and out of upcoming odds imports', async () => {
    const future = new Date(Date.now() + 86400_000).toISOString();
    const early = new Date(Date.now() + 3600_000).toISOString();
    await db.pool.query("UPDATE seasons SET game_start_at=now()+interval '2 hours' WHERE id='ingest-season'");
    const clubs=(prefix:string)=>({homeTeam:{id:`${prefix}-home`,name:`${prefix} home`,shortName:`${prefix} home`,crest:null},awayTeam:{id:`${prefix}-away`,name:`${prefix} away`,shortName:`${prefix} away`,crest:null}});
    await ingest.persistFootball(data([fixture({ id: 'future', kickoffAtUtc: future }), fixture({ id: 'preseason', kickoffAtUtc: early, ...clubs('preseason') }), fixture({ id: 'live', status: 'live', ...clubs('live') }), fixture({ id: 'past', kickoffAtUtc: new Date(Date.now() - 3600_000).toISOString(), ...clubs('past') })]));
    await ingest.persistOdds(['future', 'preseason', 'live', 'past'].map(id => odds(id)));
    expect((await db.pool.query("SELECT match_id FROM markets WHERE status='open'")).rows).toEqual([{ match_id: 'future' }]);
    expect((await ingest.upcomingFixtures()).map(row => row.id)).toEqual(['future']);
  });

  it('does not open incomplete 1X2 markets or create invented prices', async () => {
    await ingest.persistFootball(data());
    const incomplete = odds(); incomplete.markets[0].selections = incomplete.markets[0].selections.filter(row => row.kind !== 'draw');
    expect(await ingest.persistOdds([incomplete])).toEqual({ openedMarkets: 0 });
    expect((await db.pool.query('SELECT count(*) FROM odds_snapshots')).rows[0].count).toBe('0');
    expect((await db.pool.query('SELECT count(*) FROM selections')).rows[0].count).toBe('0');
  });

  it('applies provider corrections to unbet fixture clubs, kickoff and stage', async () => {
    await ingest.persistFootball(data());
    const corrected = fixture({ homeTeam: away, awayTeam: home, kickoffAtUtc: new Date(Date.now() + 2 * 86400_000).toISOString(), roundId: 'ingest-playoff-1', roundName: 'Play-offs', roundNumber: 9, stage: 'playoff', leg: 1, tieId: 'corrected-tie' });
    await ingest.persistFootball(data([corrected]));
    const row = (await db.pool.query("SELECT home_team_id,away_team_id,stage,round_id,leg,tie_id,kickoff_at FROM matches WHERE id='fd-600001'")).rows[0];
    expect(row).toMatchObject({ home_team_id: 'fd-81', away_team_id: 'fd-5', stage: 'playoff', round_id: 'ingest-playoff-1', leg: 1, tie_id: 'corrected-tie' });
    expect(new Date(row.kickoff_at).toISOString()).toBe(corrected.kickoffAtUtc);
  });

  it('settles imported results once and reverses a subsequent provider score correction', async () => {
    await ingest.persistFootball(data()); await ingest.persistOdds([odds()]);
    const selected = (await db.pool.query("SELECT s.id,s.market_id,o.id odds_id FROM selections s JOIN odds_snapshots o ON o.selection_id=s.id WHERE s.kind='home_win'")).rows[0];
    const [bet] = await engine.placeBets(admin, [{ marketId: selected.market_id, selectionId: selected.id, oddsSnapshotId: selected.odds_id, stake: 100, requestId: randomUUID() }]);
    const imported: FootballImport = { ...data([fixture({ status: 'final' })]), results: [{ matchId: 'fd-600001', status: 'final', homeScore: 2, awayScore: 0, reason: 'Official provider result' }] };
    await ingest.persistFootball(imported); await ingest.persistFootball(imported);
    expect((await db.pool.query('SELECT status,payout FROM bets WHERE id=$1', [bet.id])).rows[0]).toEqual({ status: 'won', payout: '200.00' });
    expect((await db.pool.query("SELECT count(*) FROM ledger WHERE type='bet_payout'")).rows[0].count).toBe('1');
    imported.results[0].homeScore = 0; imported.results[0].awayScore = 1;
    await ingest.persistFootball(imported);
    expect((await db.pool.query('SELECT status,payout FROM bets WHERE id=$1', [bet.id])).rows[0]).toEqual({ status: 'lost', payout: '0.00' });
    expect(Number((await db.pool.query("SELECT sum(amount) balance FROM ledger WHERE user_id='riku'")).rows[0].balance)).toBe(900);
  });

  it('holds a changed matchup once odds are frozen instead of applying scores to the wrong clubs', async () => {
    await ingest.persistFootball(data()); await ingest.persistOdds([odds()]);
    const selected = (await db.pool.query("SELECT s.id,s.market_id,o.id odds_id FROM selections s JOIN odds_snapshots o ON o.selection_id=s.id WHERE s.kind='home_win'")).rows[0];
    const [bet] = await engine.placeBets(admin, [{ marketId: selected.market_id, selectionId: selected.id, oddsSnapshotId: selected.odds_id, stake: 100, requestId: randomUUID() }]);
    const imported: FootballImport = { ...data([fixture({ homeTeam: away, awayTeam: home, status: 'final' })]), results: [{ matchId: 'fd-600001', status: 'final', homeScore: 2, awayScore: 0, reason: 'Provider changed orientation' }] };
    await expect(ingest.persistFootball(imported)).rejects.toThrow();
    expect((await db.pool.query('SELECT status,payout FROM bets WHERE id=$1', [bet.id])).rows[0]).toEqual({ status: 'placed', payout: '0.00' });
    expect((await db.pool.query("SELECT home_team_id,away_team_id FROM matches WHERE id='fd-600001'")).rows[0]).toEqual({ home_team_id: 'fd-5', away_team_id: 'fd-81' });
    expect((await db.pool.query("SELECT count(*) FROM ledger WHERE type='bet_payout'")).rows[0].count).toBe('0');
  });

  it('also holds changed clubs against frozen prices before anybody has bet', async () => {
    await ingest.persistFootball(data()); await ingest.persistOdds([odds()]);
    await expect(ingest.persistFootball(data([fixture({ homeTeam: away, awayTeam: home })]))).rejects.toThrow();
    expect((await db.pool.query("SELECT home_team_id FROM matches WHERE id='fd-600001'")).rows[0].home_team_id).toBe('fd-5');
  });

  it('preserves an administrator cancellation against subsequent provider fixture/status updates', async () => {
    await ingest.persistFootball(data());
    await engine.applyResult({ matchId: 'fd-600001', status: 'cancelled', homeScore: null, awayScore: null, reason: 'Verified administrator cancellation' }, admin.id);
    await ingest.persistFootball({ ...data(), results: [{ matchId: 'fd-600001', status: 'scheduled', homeScore: null, awayScore: null, reason: 'Older provider state' }] });
    expect((await db.pool.query("SELECT status,result_override FROM matches WHERE id='fd-600001'")).rows[0]).toEqual({ status: 'cancelled', result_override: true });
  });

  it('binds the live feed to public-calendar IDs, preserving frozen bets and translating scorers/results', async () => {
    const canonicalId='ucl-2026-league-1-bayern-barcelona';
    const calendar=fixture({id:canonicalId,providerId:'uefa-public-calendar',homeTeam:{...home,id:'uefa-bayern',name:'Bayern München'},awayTeam:{...away,id:'uefa-barcelona'}});
    await ingest.persistFootball(data([calendar]));
    const calendarOdds=odds(canonicalId);
    calendarOdds.markets.push({type:'anytime_goalscorer',selections:[{key:`player:${canonicalId}:leroy-sane`,kind:'player_anytime_goalscorer',label:'Leroy Sané',playerId:`player:${canonicalId}:leroy-sane`,decimalOdds:3}]});
    await ingest.persistOdds([calendarOdds]);
    const selected=(await db.pool.query("SELECT s.id,s.market_id,o.id odds_id FROM selections s JOIN odds_snapshots o ON o.selection_id=s.id WHERE s.kind='player_anytime_goalscorer'")).rows[0];
    const [bet]=await engine.placeBets(admin,[{marketId:selected.market_id,selectionId:selected.id,oddsSnapshotId:selected.odds_id,stake:50,requestId:randomUUID()}]);
    const live=data();live.standings=[{team:home,position:1,played:1,won:1,drawn:0,lost:0,goalsFor:1,goalsAgainst:0,points:3}];
    live.results=[{matchId:'fd-600001',status:'final',homeScore:1,awayScore:0,homeScoreFinal:1,awayScoreFinal:0,advancingTeamId:'fd-5',scorerDataComplete:true,scorerPlayerIds:['player:fd-600001:leroy-sane'],appearedPlayerIds:['player:fd-600001:leroy-sane'],registeredPlayerIds:['player:fd-600001:leroy-sane'],reason:'Official live result'}];
    await ingest.persistFootball(live);await ingest.persistFootball(live);
    expect((await db.pool.query('SELECT id,provider_id,home_team_id,advancing_team_id FROM matches')).rows).toEqual([{id:canonicalId,provider_id:'football-data:600001',home_team_id:'uefa-bayern',advancing_team_id:'uefa-bayern'}]);
    expect((await db.pool.query('SELECT count(*) FROM teams')).rows[0].count).toBe('2');
    expect((await db.pool.query('SELECT team_id FROM club_standings')).rows[0].team_id).toBe('uefa-bayern');
    expect((await db.pool.query('SELECT status,payout FROM bets WHERE id=$1',[bet.id])).rows[0]).toEqual({status:'won',payout:'150.00'});
    expect((await db.pool.query("SELECT count(*) FROM ledger WHERE type='bet_payout'")).rows[0].count).toBe('1');
    // Replaying the public snapshot cannot erase the live binding or create a second match.
    await ingest.persistFootball(data([calendar]));
    expect((await db.pool.query('SELECT provider_id FROM matches')).rows).toEqual([{provider_id:'football-data:600001'}]);
  });

  it('translates direct incoming FD odds and player keys to an existing calendar fixture', async () => {
    const canonicalId='ucl-2026-league-1-bayern-barcelona';
    await ingest.persistFootball(data([fixture({id:canonicalId,providerId:'uefa-public-calendar',homeTeam:{...home,id:'uefa-bayern'},awayTeam:{...away,id:'uefa-barcelona'}})]));
    await ingest.persistFootball(data());
    const liveOdds=odds();liveOdds.markets.push({type:'anytime_goalscorer',selections:[{key:'player:fd-600001:leroy-sane',kind:'player_anytime_goalscorer',label:'Leroy Sané',playerId:'player:fd-600001:leroy-sane',decimalOdds:3}]});
    expect(await ingest.persistOdds([liveOdds])).toEqual({openedMarkets:2});
    expect((await db.pool.query("SELECT player_id FROM selections WHERE kind='player_anytime_goalscorer'")).rows[0].player_id).toBe(`player:${canonicalId}:leroy-sane`);
    expect((await ingest.upcomingFixtures()).map(row=>row.id)).toEqual([canonicalId]);
  });

  it('reconciles all 144 bundled calendar fixtures without changing canonical club or match IDs', async () => {
    const calendar=(JSON.parse(readFileSync(new URL('../server/data/ucl-2026-fixtures.json',import.meta.url),'utf8')) as {fixtures:ImportedFixture[]}).fixtures;
    expect(calendar).toHaveLength(144);
    const names:Record<string,string>={'AEK Athens':'AEK Athens FC','Arsenal':'Arsenal FC','Aston Villa':'Aston Villa FC','Atlético de Madrid':'Club Atlético de Madrid','Barcelona':'FC Barcelona','Bayern München':'FC Bayern München','Bodø/Glimt':'FK Bodø/Glimt','Club Brugge':'Club Brugge KV','Como':'Como 1907','Fenerbahçe':'Fenerbahçe SK','Feyenoord':'Feyenoord Rotterdam','Galatasaray':'Galatasaray SK','Inter':'FC Internazionale Milano','LASK':'LASK Linz','Leipzig':'RB Leipzig','Lens':'RC Lens','Lille':'Lille OSC','Liverpool':'Liverpool FC','Manchester City':'Manchester City FC','Manchester United':'Manchester United FC','Napoli':'SSC Napoli','Paris Saint-Germain':'Paris Saint-Germain FC','Porto':'FC Porto','Real Betis':'Real Betis Balompié','Real Madrid':'Real Madrid CF','Roma':'AS Roma','Sabah':'Sabah FK','Shakhtar Donetsk':'FC Shakhtar Donetsk','Slavia Praha':'SK Slavia Praha','Slovan Bratislava':'ŠK Slovan Bratislava','Sporting CP':'Sporting Clube de Portugal','Stuttgart':'VfB Stuttgart','Viking':'Viking FK','Villarreal':'Villarreal CF'};
    const clubs=[...new Set(calendar.flatMap(row=>[row.homeTeam.id,row.awayTeam.id]))];
    const feedTeam=(club:ImportedFixture['homeTeam'])=>({...club,id:`fd-${1000+clubs.indexOf(club.id)}`,name:names[club.name]??club.name,shortName:'ZZZ'});
    const feed=calendar.map((row,index)=>({...row,id:`fd-${700000+index}`,providerId:String(700000+index),homeTeam:feedTeam(row.homeTeam),awayTeam:feedTeam(row.awayTeam)}));
    await ingest.persistFootball(data(calendar));
    await ingest.persistFootball(data(feed));
    await ingest.persistFootball(data(feed));
    expect((await db.pool.query('SELECT id FROM matches ORDER BY id')).rows.map(row=>row.id)).toEqual(calendar.map(row=>row.id).sort());
    expect((await db.pool.query('SELECT id FROM teams ORDER BY id')).rows.map(row=>row.id)).toEqual(clubs.sort());
    expect((await db.pool.query("SELECT count(*) FROM matches WHERE provider_id LIKE 'football-data:%'")).rows[0].count).toBe('144');
  });

  it('rejects ambiguous calendar duplicates and rescheduled unbound entries instead of adding another match', async () => {
    const calendar=fixture({id:'calendar-one',providerId:'uefa-public-calendar'});
    await ingest.persistFootball(data([calendar]));
    await db.pool.query(`INSERT INTO matches(id,season_id,round_id,home_team_id,away_team_id,kickoff_at,date_finland,stage,status) SELECT 'calendar-two',season_id,round_id,home_team_id,away_team_id,kickoff_at,date_finland,stage,status FROM matches WHERE id='calendar-one'`);
    await expect(ingest.persistFootball(data())).rejects.toThrow('Ambiguous');
    expect((await db.pool.query('SELECT count(*) FROM matches')).rows[0].count).toBe('2');
    await db.pool.query("DELETE FROM matches WHERE id='calendar-two'");
    await expect(ingest.persistFootball(data([fixture({kickoffAtUtc:new Date(Date.parse(kickoff)+86400_000).toISOString()})]))).rejects.toThrow('rescheduled');
    expect((await db.pool.query('SELECT count(*) FROM matches')).rows[0].count).toBe('1');
  });

  it('holds a second provider ID for an already bound fixture rather than replacing its binding', async () => {
    await ingest.persistFootball(data([fixture({id:'calendar-one',providerId:'uefa-public-calendar'})]));
    await ingest.persistFootball(data());
    await expect(ingest.persistFootball(data([fixture({id:'fd-600002',providerId:'600002'})]))).rejects.toThrow('Conflicting provider fixture binding');
    expect((await db.pool.query('SELECT id,provider_id FROM matches')).rows).toEqual([{id:'calendar-one',provider_id:'football-data:600001'}]);
  });

  it('holds a Finland playing-date shift after bet history, preserving original bonus date attribution', async () => {
    await ingest.persistFootball(data());await ingest.persistOdds([odds()]);
    const selected=(await db.pool.query("SELECT s.id,s.market_id,o.id odds_id FROM selections s JOIN odds_snapshots o ON o.selection_id=s.id WHERE s.kind='home_win'")).rows[0];
    await engine.placeBets(admin,[{marketId:selected.market_id,selectionId:selected.id,oddsSnapshotId:selected.odds_id,stake:50,requestId:randomUUID()}]);
    await engine.processBonuses(new Date(kickoff));
    expect(Number((await db.pool.query('SELECT bonus_stake FROM bets')).rows[0].bonus_stake)).toBe(50);
    await expect(ingest.persistFootball(data([fixture({kickoffAtUtc:new Date(Date.parse(kickoff)+86400_000).toISOString()})]))).rejects.toThrow('Finland playing date');
    expect(new Date((await db.pool.query('SELECT kickoff_at FROM matches')).rows[0].kickoff_at).toISOString()).toBe(kickoff);
    expect(Number((await db.pool.query('SELECT bonus_stake FROM bets')).rows[0].bonus_stake)).toBe(50);
  });
});
