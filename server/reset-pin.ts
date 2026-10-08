import { randomInt } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

/** Operator-only recovery. The returned plaintext is never persisted or logged here. */
export async function resetPlayerPin(userId: string, reason: string) {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(userId)) throw new Error('Give a valid player ID.');
  if (typeof reason !== 'string' || reason.trim().length < 5 || reason.length > 2000 || /[\u0000-\u001f]/.test(reason)) {
    throw new Error('Give a single-line recovery reason of 5–2000 characters.');
  }
  const { hashPin, verifyPin } = await import('./auth');
  const { transaction } = await import('./db');
  return transaction(async db => {
    // Authentication locks rate-limit rows before the user. Keep that order here
    // so a concurrent login/change cannot deadlock against recovery cleanup.
    const attemptKeys = [`pin-change:${userId}`, `user:${userId}`].sort();
    for (const key of attemptKeys) await db.query('INSERT INTO login_attempts(key) VALUES($1) ON CONFLICT DO NOTHING', [key]);
    await db.query('SELECT key FROM login_attempts WHERE key=ANY($1) ORDER BY key FOR UPDATE', [attemptKeys]);
    const player = (await db.query('SELECT id,display_name,pin_hash FROM users WHERE id=$1 FOR UPDATE', [userId])).rows[0];
    if (!player) throw new Error('Player not found; no PIN was changed.');
    let temporaryPin: string;
    do { temporaryPin = String(randomInt(10_000_000, 100_000_000)); }
    while (await verifyPin(temporaryPin, player.pin_hash));
    const encoded = await hashPin(temporaryPin);
    await db.query('UPDATE users SET pin_hash=$2,pin_reset_required=true WHERE id=$1', [userId, encoded]);
    const sessions = await db.query('UPDATE sessions SET revoked_at=now() WHERE user_id=$1 AND revoked_at IS NULL', [userId]);
    await db.query('DELETE FROM login_attempts WHERE key=ANY($1)', [[`user:${userId}`, `pin-change:${userId}`]]);
    await db.query("INSERT INTO audit_log(actor_id,action,reason,detail) VALUES(NULL,'operator_pin_reset',$1,$2)", [reason.trim(), JSON.stringify({ userId, sessionsRevoked: sessions.rowCount ?? 0 })]);
    return { userId, displayName: String(player.display_name), temporaryPin, sessionsRevoked: sessions.rowCount ?? 0 };
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help')) {
    process.stdout.write('Usage: node --env-file-if-exists=.env --import tsx server/reset-pin.ts --user <player-id> --reason <recovery-reason>\n\nRequires an interactive operator terminal and DATABASE_URL. Generates an 8-digit temporary PIN, revokes sessions and requires a PIN change at next login.\n');
    return;
  }
  if (args.length !== 4 || args[0] !== '--user' || args[2] !== '--reason') throw new Error('Use --user <player-id> --reason <recovery-reason>.');
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('PIN recovery requires an interactive terminal. Do not run it in deployment logs, CI, a cron job, a pipe or an output redirect.');
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must explicitly identify the target database.');
  const target = new URL(process.env.DATABASE_URL);
  if (!['postgresql:', 'postgres:'].includes(target.protocol)) throw new Error('DATABASE_URL must identify a PostgreSQL database.');
  const result = await resetPlayerPin(args[1], args[3]);
  // This is the sole intentional plaintext output, after the transaction commits.
  // The TTY-only CLI is never called by a web handler, start script or scheduled job.
  process.stdout.write(`\nPIN recovered for ${result.displayName} (${result.userId}).\nTemporary PIN: ${result.temporaryPin}\nSessions revoked: ${result.sessionsRevoked}\nShare privately with this player. They must choose a new PIN on the next login.\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'PIN recovery failed.'}\n`); process.exitCode = 1; })
    .finally(async () => { if (process.env.DATABASE_URL) await (await import('./db')).pool.end(); });
}
