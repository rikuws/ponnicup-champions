import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { pool, transaction } from './db';
import type { User } from '../shared/contracts';

export class AuthError extends Error {
  constructor(message: string, public status = 401, public code = 'UNAUTHORIZED') { super(message); }
}
function derive(pin: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(pin, salt, 64, { N: 16384, r: 8, p: 1 }, (error, key) => error ? reject(error) : resolve(key)));
}
export async function hashPin(pin: string) {
  if (typeof pin !== 'string' || !/^\d{6,32}$/.test(pin)) throw new AuthError('PINin pitää olla 6–32 numeroa.', 400, 'INVALID_PIN');
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(pin, salt);
  return `scrypt$${salt}$${hash.toString('hex')}`;
}
export async function verifyPin(pin: string, encoded: string): Promise<boolean> {
  const [format, salt, expected] = encoded.split('$');
  if (format !== 'scrypt' || !/^[a-f0-9]{32}$/.test(salt ?? '') || !/^[a-f0-9]{128}$/.test(expected ?? '') || pin.length > 128) return false;
  const actual = await derive(pin, salt);
  return timingSafeEqual(actual, Buffer.from(expected, 'hex'));
}
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const dummyHash = `scrypt$${'0'.repeat(32)}$${'0'.repeat(128)}`;
function mapUser(row: { id: string; display_name: string; role: 'player' | 'admin'; pin_reset_required: boolean }): User {
  return { id: row.id, displayName: row.display_name, role: row.role, pinResetRequired: row.pin_reset_required };
}

export async function login(userId: string, pin: string, ip: string): Promise<{ user: User; token: string }> {
  if (typeof userId !== 'string' || userId.length > 100 || typeof pin !== 'string' || pin.length > 128) throw new AuthError('Virheellinen pelaaja tai PIN.');
  const keys = [`user:${userId}`, `ip:${tokenHash(ip || 'unknown')}`].sort();
  const result = await transaction(async (db) => {
    for (const key of keys) await db.query('INSERT INTO login_attempts(key) VALUES ($1) ON CONFLICT DO NOTHING', [key]);
    const attempts = (await db.query('SELECT * FROM login_attempts WHERE key = ANY($1) ORDER BY key FOR UPDATE', [keys])).rows;
    const now = Date.now();
    if (attempts.some((attempt) => attempt.locked_until && +new Date(attempt.locked_until) > now)) return { kind: 'limited' as const };
    const row = (await db.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [userId])).rows[0];
    const valid = await verifyPin(pin, row?.pin_hash ?? dummyHash);
    if (!row || !valid) {
      for (const attempt of attempts) {
        const failures = +new Date(attempt.window_started_at) < now - 15 * 60_000 ? 1 : attempt.failures + 1;
        const threshold = attempt.key.startsWith('ip:') ? 25 : 5;
        await db.query(`UPDATE login_attempts SET failures=$2::integer, window_started_at=CASE WHEN window_started_at < now()-interval '15 minutes' THEN now() ELSE window_started_at END,
          locked_until=CASE WHEN $2::integer >= $3::integer THEN now()+interval '15 minutes' ELSE NULL END WHERE key=$1`, [attempt.key, failures, threshold]);
      }
      return { kind: 'invalid' as const };
    }
    await db.query('DELETE FROM login_attempts WHERE key=$1', [`user:${userId}`]);
    const token = randomBytes(32).toString('base64url');
    await db.query("INSERT INTO sessions(id,user_id,expires_at) VALUES ($1,$2,now()+interval '30 days')", [tokenHash(token), userId]);
    // Keep this small table bounded without retaining expired credentials.
    await db.query("DELETE FROM sessions WHERE expires_at < now()-interval '7 days' OR revoked_at < now()-interval '7 days'");
    await db.query("DELETE FROM login_attempts WHERE window_started_at < now()-interval '1 day' AND (locked_until IS NULL OR locked_until < now())");
    return { kind: 'success' as const, user: mapUser(row), token };
  });
  if (result.kind === 'limited') throw new AuthError('Liian monta yritystä. Kokeile 15 minuutin kuluttua.', 429, 'RATE_LIMITED');
  if (result.kind === 'invalid') throw new AuthError('Virheellinen pelaaja tai PIN.');
  return { user: result.user, token: result.token };
}
export async function getSession(token: string): Promise<User | null> {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = (await pool.query('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id=$1 AND s.expires_at > now() AND s.revoked_at IS NULL', [tokenHash(token)])).rows[0];
  return row ? mapUser(row) : null;
}
export async function logout(token: string) {
  if (typeof token === 'string') await pool.query('UPDATE sessions SET revoked_at=now() WHERE id=$1 AND revoked_at IS NULL', [tokenHash(token)]);
}
export async function changePin(userId: string, currentPin: string, newPin: string): Promise<User> {
  if (currentPin === newPin) throw new AuthError('Valitse uusi PIN.', 400, 'INVALID_PIN');
  if (typeof currentPin !== 'string' || currentPin.length > 128) throw new AuthError('Nykyinen PIN ei täsmää.');
  const encoded = await hashPin(newPin);
  const result = await transaction(async (db) => {
    const key = `pin-change:${userId}`;
    await db.query('INSERT INTO login_attempts(key) VALUES ($1) ON CONFLICT DO NOTHING', [key]);
    const attempt = (await db.query('SELECT * FROM login_attempts WHERE key=$1 FOR UPDATE', [key])).rows[0];
    if (attempt.locked_until && +new Date(attempt.locked_until) > Date.now()) return { kind: 'limited' as const };
    const row = (await db.query('SELECT * FROM users WHERE id=$1 FOR UPDATE', [userId])).rows[0];
    if (!row || !(await verifyPin(currentPin, row.pin_hash))) {
      const failures = +new Date(attempt.window_started_at) < Date.now()-15*60_000 ? 1 : attempt.failures+1;
      await db.query(`UPDATE login_attempts SET failures=$2::integer,
        window_started_at=CASE WHEN window_started_at < now()-interval '15 minutes' THEN now() ELSE window_started_at END,
        locked_until=CASE WHEN $2::integer>=5 THEN now()+interval '15 minutes' ELSE NULL END WHERE key=$1`, [key,failures]);
      return { kind: 'invalid' as const };
    }
    const updated = (await db.query('UPDATE users SET pin_hash=$2,pin_reset_required=false WHERE id=$1 RETURNING *', [userId, encoded])).rows[0];
    await db.query('DELETE FROM login_attempts WHERE key=$1', [key]);
    await db.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [userId]);
    await db.query("INSERT INTO audit_log(actor_id,action,reason) VALUES ($1,'pin_changed','Pelaaja vaihtoi PINin; vanhat istunnot suljettiin.')", [userId]);
    return { kind: 'success' as const, user: mapUser(updated) };
  });
  if (result.kind === 'limited') throw new AuthError('Liian monta yritystä. Kokeile 15 minuutin kuluttua.',429,'RATE_LIMITED');
  if (result.kind === 'invalid') throw new AuthError('Nykyinen PIN ei täsmää.');
  return result.user;
}
