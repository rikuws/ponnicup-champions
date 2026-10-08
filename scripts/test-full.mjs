import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const useDocker = args.includes('--docker');
const testArgs = args.filter(arg => arg !== '--docker');
const directory = mkdtempSync(join(tmpdir(), 'ponnicup-tests-'));
const dataDirectory = join(directory, 'data');
const logFile = join(directory, 'postgres.log');
const username = 'ponnicup_test';
const password = randomBytes(24).toString('hex');
const container = `ponnicup-tests-${randomUUID()}`;
let backend;
let child;
let interrupted = false;

// Never load .env or inherit application database/provider settings into tests.
const environment = { ...process.env, NODE_ENV: 'test' };
for (const key of Object.keys(environment)) {
  if (key.startsWith('PG') || /^(DATABASE_URL|.*TEST_DATABASE_URL|FOOTBALL_.*|ODDS_.*|INITIAL_PINS_JSON)$/.test(key)) delete environment[key];
}

function command(binary, parameters, options = {}) {
  const result = spawnSync(binary, parameters, { cwd: root, env: environment, encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) {
    throw new Error(`${binary} failed: ${result.error?.message || result.stderr?.trim() || result.stdout?.trim() || `exit ${result.status}`}`);
  }
  return result.stdout.trim();
}

function available(binary) {
  return spawnSync(binary, ['--version'], { env: environment, stdio: 'ignore' }).status === 0;
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return port;
}

async function waitForDatabase(connectionString) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline && !interrupted) {
    const client = new pg.Client({ connectionString, connectionTimeoutMillis: 1000 });
    try {
      await client.connect();
      return;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 250));
    } finally {
      await client.end();
    }
  }
  throw new Error(interrupted ? 'Test run interrupted.' : 'Disposable PostgreSQL did not become ready within 30 seconds.');
}

function runTests(env) {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, [join(root, 'node_modules/vitest/vitest.mjs'), 'run', ...testArgs], { cwd: root, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => { child = undefined; resolve(code ?? (signal ? 1 : 0)); });
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    interrupted = true;
    process.exitCode = signal === 'SIGINT' ? 130 : 143;
    child?.kill(signal);
  });
}

try {
  let port;
  const nativeAvailable = userInfo().uid !== 0 && available('initdb') && available('pg_ctl');
  if (!useDocker && nativeAvailable) {
    backend = 'native';
    const passwordFile = join(directory, 'password');
    writeFileSync(passwordFile, password, { mode: 0o600 });
    command('initdb', ['-D', dataDirectory, '-U', username, '--auth-local=trust', '--auth-host=scram-sha-256', `--pwfile=${passwordFile}`, '--no-locale', '-E', 'UTF8']);
    rmSync(passwordFile);
    port = await availablePort();
    command('pg_ctl', ['-D', dataDirectory, '-l', logFile, '-o', `-h 127.0.0.1 -p ${port} -k '' -F`, '-w', 'start']);
  } else {
    if (!available('docker')) throw new Error('Install PostgreSQL (initdb and pg_ctl on PATH) or start Docker, then rerun npm run test:full.');
    backend = 'docker';
    command('docker', ['run', '--detach', '--name', container, '--publish', '127.0.0.1::5432', '--tmpfs', '/var/lib/postgresql/data:rw', '--env', `POSTGRES_USER=${username}`, '--env', 'POSTGRES_PASSWORD', 'postgres:16-alpine'], { env: { ...environment, POSTGRES_PASSWORD: password } });
    port = Number(command('docker', ['port', container, '5432/tcp']).split(':').at(-1));
  }

  const url = name => `postgresql://${username}:${password}@127.0.0.1:${port}/${name}`;
  await waitForDatabase(url('postgres'));
  const client = new pg.Client({ connectionString: url('postgres') });
  await client.connect();
  try {
    for (const name of ['engine_test', 'ingest_test', 'http_test']) await client.query(`CREATE DATABASE ${name}`);
  } finally {
    await client.end();
  }

  if (interrupted) throw new Error('Test run interrupted.');
  console.log(`Running ${testArgs.length ? 'selected' : 'all'} suites with three disposable PostgreSQL databases (${backend}, loopback port ${port}).`);
  const code = await runTests({
    ...environment,
    DATABASE_URL: url('engine_test'),
    TEST_DATABASE_URL: url('engine_test'),
    INGEST_TEST_DATABASE_URL: url('ingest_test'),
    HTTP_TEST_DATABASE_URL: url('http_test'),
  });
  if (!interrupted) process.exitCode = code;
} catch (error) {
  console.error(error.message);
  if (backend === 'native' && existsSync(logFile)) console.error(readFileSync(logFile, 'utf8').trim());
  process.exitCode ||= 1;
} finally {
  try {
    if (backend === 'docker') {
      const exists = spawnSync('docker', ['container', 'inspect', container], { env: environment, stdio: 'ignore' }).status === 0;
      if (exists) command('docker', ['rm', '--force', container]);
    } else if (backend === 'native' && existsSync(join(dataDirectory, 'postmaster.pid'))) {
      command('pg_ctl', ['-D', dataDirectory, '-m', 'immediate', '-w', 'stop']);
    }
    rmSync(directory, { recursive: true, force: true });
    console.log('Disposable test database resources removed.');
  } catch (error) {
    console.error(`Test database cleanup failed: ${error.message}\nTemporary directory retained at ${directory}.`);
    process.exitCode ||= 1;
  }
}
