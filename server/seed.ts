import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import type { ImportedFixture } from '../shared/imports';
import { persistFootball } from './ingest';
import { pool, transaction } from './db';
import { hashPin } from './auth';
import { migrate } from './migrate';

export const SEASON_ID = process.env.SEASON_ID || 'ucl-2026';
export const roster = [ ['henri','Henri'], ['antti','Antti'], ['ville','Ville'], ['pekka','Pekka'], ['riku','Riku'] ] as const;
// UEFA's published 2026/27 calendar, checked 2026-09-08.
const roundDates = [ ['2026-09-08','2026-09-10'],['2026-10-13','2026-10-14'],['2026-10-20','2026-10-21'],['2026-11-03','2026-11-04'],['2026-11-24','2026-11-25'],['2026-12-08','2026-12-09'],['2027-01-19','2027-01-20'],['2027-01-27','2027-01-27'] ];
const knockoutRounds = [
  ['playoff-1','Pudotuspelikarsinta · 1. osa','playoff','2027-02-16','2027-02-17'],
  ['playoff-2','Pudotuspelikarsinta · 2. osa','playoff','2027-02-23','2027-02-24'],
  ['round_of_16-1','Neljännesvälierät · 1. osa','round_of_16','2027-03-09','2027-03-10'],
  ['round_of_16-2','Neljännesvälierät · 2. osa','round_of_16','2027-03-16','2027-03-17'],
  ['quarter_final-1','Puolivälierät · 1. osa','quarter_final','2027-04-06','2027-04-07'],
  ['quarter_final-2','Puolivälierät · 2. osa','quarter_final','2027-04-13','2027-04-14'],
  ['semi_final-1','Välierät · 1. osa','semi_final','2027-04-27','2027-04-28'],
  ['semi_final-2','Välierät · 2. osa','semi_final','2027-05-04','2027-05-05'],
  ['final','Finaali','final','2027-06-05','2027-06-05'],
] as const;

const localBoundary=(date:string,end=false)=>`${date}T${end?'23:59:59':'00:00:00'}${['04','05','06','07','08','09','10'].includes(date.slice(5,7))?'+03:00':'+02:00'}`;

export async function seed() {
  await migrate();
  const pins = JSON.parse(process.env.INITIAL_PINS_JSON || '{}') as Record<string,string>;
  const existing = new Set((await pool.query('SELECT id FROM users')).rows.map(r=>r.id));
  const hashes = new Map<string,string>();
  for (const [id] of roster) {
    if (!existing.has(id)) {
      if (!/^[0-9]{6,8}$/.test(pins[id] || '')) throw new Error(`INITIAL_PINS_JSON must contain a unique 6–8 digit bootstrap PIN for ${id}.`);
      hashes.set(id, await hashPin(pins[id]));
    }
  }
  const newPins = [...hashes.keys()].map(id=>pins[id]);
  if (new Set(newPins).size !== newPins.length) throw new Error('Each new player needs a different bootstrap PIN.');
  await transaction(async db => {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('ponnicup:seed'))");
    await db.query(`INSERT INTO seasons(id,name,competition,game_start_at,config) VALUES($1,$2,'CL',$3,$4)
      ON CONFLICT(id) DO NOTHING`, [SEASON_ID, 'Ponnicup · Champions League 2026/27', process.env.GAME_START_AT || '2026-10-13T00:00:00+03:00', {startingBalance:1000,dailyBonus:100,minimumStake:1,recoveryThreshold:500}]);
    for (const [id,name] of roster) {
      if (hashes.has(id)) await db.query('INSERT INTO users(id,display_name,role,pin_hash,pin_reset_required) VALUES($1,$2,$3,$4,true) ON CONFLICT(id) DO NOTHING',[id,name,id==='riku'?'admin':'player',hashes.get(id)]);
      await db.query(`INSERT INTO ledger(user_id,season_id,amount,type) SELECT $1,id,(config->>'startingBalance')::numeric,'starting_balance' FROM seasons WHERE id=$2
        ON CONFLICT (user_id,season_id) WHERE type='starting_balance' DO NOTHING`,[id,SEASON_ID]);
    }
    for (let i=0;i<roundDates.length;i++) {
      const [start,end]=roundDates[i];
      await db.query(`INSERT INTO rounds(id,season_id,name,stage,number,starts_at,ends_at) VALUES($1,$2,$3,'league',$4,$5,$6) ON CONFLICT(id) DO NOTHING`,[`ucl-2026-league-${i+1}`,SEASON_ID,`Liigavaihe · kierros ${i+1}`,i+1,localBoundary(start),localBoundary(end,true)]);
    }
    for (let i=0;i<knockoutRounds.length;i++) {
      const [key,name,stage,start,end]=knockoutRounds[i];
      await db.query(`INSERT INTO rounds(id,season_id,name,stage,number,starts_at,ends_at) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`,[`ucl-2026-${key}`,SEASON_ID,name,stage,i+9,localBoundary(start),localBoundary(end,true)]);
    }
    for (const [provider,enabled] of [['football-data',!!process.env.FOOTBALL_API_KEY],['odds-api',!!process.env.ODDS_API_KEY]] as const) {
      await db.query(`INSERT INTO sync_status(provider,enabled) VALUES($1,$2) ON CONFLICT(provider) DO UPDATE SET enabled=EXCLUDED.enabled`,[provider,enabled]);
    }
  });
  // Bootstrap once only: redeploys must not overwrite amended fixtures or results.
  if (SEASON_ID==='ucl-2026' && !(await pool.query('SELECT 1 FROM matches WHERE season_id=$1 LIMIT 1',[SEASON_ID])).rowCount) {
    const calendar=JSON.parse(await readFile(new URL('./data/ucl-2026-fixtures.json',import.meta.url),'utf8')) as {fixtures:ImportedFixture[]};
    await persistFootball({fixtures:calendar.fixtures,standings:[],results:[]});
    console.info(`Imported ${calendar.fixtures.length} published UEFA fixtures; odds remain closed until explicitly supplied.`);
  }
  console.info('Season ready; five players seeded without changing existing PINs or balances.');
}
if (process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) seed().then(()=>pool.end()).catch(async error=>{console.error(error.message);await pool.end();process.exitCode=1;});
