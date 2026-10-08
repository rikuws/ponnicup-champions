import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';

const databaseUrl = process.env.HTTP_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
let db: typeof import('../server/db');
let auth: typeof import('../server/auth');
let http: typeof import('../server/index');
let origin = '';
let pinHash = '';

async function call(path: string, method = 'GET', payload?: unknown, cookie?: string, extraHeaders: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extraHeaders };
  if (cookie) headers.Cookie = cookie;
  if (payload !== undefined && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
  return fetch(`${origin}${path}`, { method, headers, body: payload === undefined ? undefined : typeof payload === 'string' ? payload : JSON.stringify(payload) });
}
async function login(userId = 'riku', pin: string | number = '654321') {
  const response = await call('/api/login', 'POST', { userId, pin });
  expect(response.status).toBe(200);
  return { cookie: response.headers.get('set-cookie')!.split(';')[0], response, user: (await response.json()).user };
}

suite('real HTTP API integration', () => {
  beforeAll(async () => {
    if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_test')) throw new Error('HTTP integration database name must end with _test');
    process.env.DATABASE_URL = databaseUrl;
    process.env.SEASON_ID = 'http-season';
    vi.stubEnv('FOOTBALL_API_KEY', ''); vi.stubEnv('ODDS_API_KEY', '');
    vi.stubEnv('NODE_ENV', 'test');
    db = await import('../server/db'); auth = await import('../server/auth');
    await (await import('../server/migrate')).migrate();
    pinHash = await auth.hashPin('654321');
    http = await import('../server/index');
    await new Promise<void>((resolve, reject) => { http.server.once('error', reject); http.server.listen(0, '127.0.0.1', resolve); });
    origin = `http://127.0.0.1:${(http.server.address() as AddressInfo).port}`;
    vi.stubEnv('PUBLIC_ORIGIN', origin);
  });
  beforeEach(async () => {
    await db.pool.query('TRUNCATE seasons,users,teams,login_attempts,sync_status CASCADE');
    await db.pool.query(`INSERT INTO seasons(id,name,competition,game_start_at,config) VALUES('http-season','HTTP integration season','CL',now()-interval '1 day',$1)`, [{ startingBalance: 1000, dailyBonus: 100, minimumStake: 1, recoveryThreshold: 500 }]);
    for (const [id, role, reset] of [['riku', 'admin', false], ['henri', 'player', false], ['antti', 'player', true]]) {
      await db.pool.query('INSERT INTO users(id,display_name,role,pin_hash,pin_reset_required) VALUES($1,$1,$2,$3,$4)', [id, role, pinHash, reset]);
      await db.pool.query("INSERT INTO ledger(user_id,season_id,amount,type) VALUES($1,'http-season',1000,'starting_balance')", [id]);
    }
    await db.pool.query("INSERT INTO rounds(id,season_id,name,stage,number,starts_at,ends_at) VALUES('http-round','http-season','HTTP round','league',1,now()+interval '1 day',now()+interval '2 days')");
    await db.pool.query("INSERT INTO teams(id,name,short_name) VALUES('http-home','HTTP Home','Home'),('http-away','HTTP Away','Away')");
    await db.pool.query(`INSERT INTO matches(id,season_id,round_id,home_team_id,away_team_id,kickoff_at,date_finland,stage,status)
      VALUES('http-match','http-season','http-round','http-home','http-away',now()+interval '1 day',(now()+interval '1 day')::date,'league','scheduled')`);
  });
  afterAll(async () => {
    if (http) await new Promise<void>((resolve, reject) => http.server.close(error => error ? reject(error) : resolve()));
    if (db) await db.pool.end();
    vi.unstubAllEnvs();
  });

  it('uses an opaque HttpOnly strict cookie and returns live PostgreSQL data with no-store', async () => {
    expect((await call('/api/game')).status).toBe(401);
    const current = await login();
    expect(current.cookie).toMatch(/^ponnicup_session=[A-Za-z0-9_-]{43}$/);
    expect(current.response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(current.response.headers.get('set-cookie')).toContain('SameSite=Strict');
    const first = await call('/api/game?roundId=http-round', 'GET', undefined, current.cookie);
    expect(first.status).toBe(200); expect(first.headers.get('cache-control')).toBe('no-store');
    const game = await first.json();
    expect(game.season.name).toBe('HTTP integration season'); expect(game.matches[0].id).toBe('http-match'); expect(game.wallet.bankroll).toBe(1000);
    expect(JSON.stringify(game)).not.toMatch(/pin_hash|scrypt\$|654321/);
    await db.pool.query("INSERT INTO ledger(user_id,season_id,amount,type) VALUES('riku','http-season',77,'test_adjustment')");
    const fresh = await call('/api/game?roundId=http-round', 'GET', undefined, current.cookie, { 'If-None-Match': 'stale-demo' });
    expect(fresh.status).toBe(200); expect((await fresh.json()).wallet.bankroll).toBe(1077);
    expect((await db.pool.query('SELECT id FROM sessions')).rows[0].id).not.toBe(current.cookie.split('=')[1]);
  });

  it('gates first-login sessions until PIN change and revokes the old cookie', async () => {
    const initial = await login('antti');
    expect(initial.user.pinResetRequired).toBe(true);
    expect((await call('/api/session', 'GET', undefined, initial.cookie)).status).toBe(200);
    expect((await call('/api/game', 'GET', undefined, initial.cookie)).status).toBe(403);
    expect((await call('/api/bets', 'POST', { bets: [] }, initial.cookie)).status).toBe(403);
    const changed = await call('/api/pin', 'POST', { currentPin: '654321', newPin: '987654' }, initial.cookie);
    expect(changed.status).toBe(200); expect((await changed.json()).user.pinResetRequired).toBe(false);
    const nextCookie = changed.headers.get('set-cookie')!.split(';')[0];
    expect(nextCookie).not.toBe(initial.cookie);
    expect((await call('/api/game', 'GET', undefined, initial.cookie)).status).toBe(401);
    expect((await call('/api/game', 'GET', undefined, nextCookie)).status).toBe(200);
  });

  it('rejects invalid JSON, wrong content types, array bodies and oversized requests with client statuses', async () => {
    expect((await call('/api/login', 'POST', '{', undefined)).status).toBe(400);
    expect((await call('/api/login', 'POST', '[]')).status).toBe(400);
    expect((await call('/api/login', 'POST', '{}', undefined, { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await call('/api/login', 'POST', JSON.stringify({ userId: 'riku', pin: '1'.repeat(70_000) }))).status).toBe(413);
    expect((await call('/api/login', 'POST', { userId: 'riku', pin: 654321 })).status).toBe(401);
    const user = await login();
    expect((await call('/api/pin', 'POST', { currentPin: '654321', newPin: 123456 }, user.cookie)).status).toBe(400);
    expect((await call('/api/bets', 'POST', { bets: 'invalid' }, user.cookie)).status).toBe(400);
    expect((await call('/api/admin/results', 'POST', { matchId: 'http-match', status: 'final', homeScore: '2', awayScore: 0, reason: 'Invalid score' }, user.cookie)).status).toBe(400);
    expect((await call('/api/unknown', 'GET', undefined, user.cookie)).status).toBe(404);
  });

  it('rejects cross-site writes and malformed origins without changing data', async () => {
    const user = await login();
    const payload = { currentPin: '654321', newPin: '987654' };
    expect((await call('/api/pin', 'POST', payload, user.cookie, { Origin: 'https://other.example' })).status).toBe(403);
    expect((await call('/api/pin', 'POST', payload, user.cookie, { Origin: origin, 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await call('/api/pin', 'POST', payload, user.cookie, { Origin: 'not-an-origin' })).status).toBe(403);
    const hash = (await db.pool.query("SELECT pin_hash FROM users WHERE id='riku'")).rows[0].pin_hash;
    expect(await auth.verifyPin('654321', hash)).toBe(true);
    // Cover development's Host comparison as well as the configured production-origin path.
    const configured = process.env.PUBLIC_ORIGIN; delete process.env.PUBLIC_ORIGIN;
    try { expect((await call('/api/logout', 'POST', undefined, user.cookie, { Origin: 'not-an-origin' })).status).toBe(403); }
    finally { process.env.PUBLIC_ORIGIN = configured; }
  });

  it('denies player access to every administration route', async () => {
    const player = await login('henri');
    expect((await call('/api/admin', 'GET', undefined, player.cookie)).status).toBe(403);
    for (const path of ['/api/admin/results', '/api/admin/config', '/api/admin/sync']) expect((await call(path, 'POST', {}, player.cookie)).status).toBe(403);
    expect((await db.pool.query('SELECT count(*) FROM audit_log')).rows[0].count).toBe('0');
    expect((await db.pool.query("SELECT status FROM matches WHERE id='http-match'")).rows[0].status).toBe('scheduled');
  });

  it('accepts audited administrator corrections and returns a genuine synchronization summary', async () => {
    const admin = await login();
    const correction = await call('/api/admin/results', 'POST', { matchId: 'http-match', status: 'final', homeScore: 2, awayScore: 1, reason: 'Verified manual score correction' }, admin.cookie);
    expect(correction.status).toBe(200);
    const result = (await db.pool.query("SELECT status,home_score,away_score,result_override FROM matches WHERE id='http-match'")).rows[0];
    expect(result).toEqual({ status: 'final', home_score: 2, away_score: 1, result_override: true });
    const sync = await call('/api/admin/sync', 'POST', {}, admin.cookie);
    expect(sync.status).toBe(200);
    expect((await sync.json()).summary).toEqual({ football: 'not_configured', odds: 'not_configured' });
    const audit = (await db.pool.query("SELECT actor_id,action FROM audit_log WHERE action IN ('result_updated','manual_sync') ORDER BY created_at")).rows;
    expect(audit.some(row => row.actor_id === 'riku' && row.action === 'manual_sync')).toBe(true);
    expect((await call('/api/admin', 'GET', undefined, admin.cookie)).status).toBe(200);
  });

  it('logs out persistently and treats expired/revoked credentials as unauthenticated', async () => {
    const current = await login();
    const response = await call('/api/logout', 'POST', undefined, current.cookie);
    expect(response.status).toBe(200); expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await (await call('/api/session', 'GET', undefined, current.cookie)).json()).user).toBeNull();
    const expired = await login();
    await db.pool.query("UPDATE sessions SET expires_at=now()-interval '1 minute'");
    expect((await call('/api/game', 'GET', undefined, expired.cookie)).status).toBe(401);
    expect((await call('/api/game', 'GET', undefined, 'ponnicup_session=garbage')).status).toBe(401);
  });
});
