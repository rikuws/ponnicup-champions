import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { pool } from './db';
import { fetchFootballData, fetchOdds } from './providers';
import { persistFootball, persistOdds, upcomingFixtures, seasonId } from './ingest';
import { processBonuses } from './engine';

function safeError(error:unknown) {
  let message=error instanceof Error?error.message:'Tietojen päivitys epäonnistui.';
  for(const key of [process.env.FOOTBALL_API_KEY,process.env.ODDS_API_KEY]) if(key) message=message.replaceAll(key,'[redacted]');
  return message.slice(0,400);
}
async function status(provider:string,enabled:boolean,error:string|null,success=false) {
  await pool.query(`INSERT INTO sync_status(provider,enabled,last_error,last_success_at) VALUES($1,$2,$3,CASE WHEN $4 THEN now() ELSE NULL END)
    ON CONFLICT(provider) DO UPDATE SET enabled=EXCLUDED.enabled,last_error=EXCLUDED.last_error,last_success_at=CASE WHEN $4 THEN now() ELSE sync_status.last_success_at END,updated_at=now()`,[provider,enabled,error,success]);
}
export async function syncAll(force=false) {
  const connection=await pool.connect();
  const locked=(await connection.query("SELECT pg_try_advisory_lock(hashtext('ponnicup:sync')) locked")).rows[0].locked;
  if(!locked){connection.release();return {skipped:'already_running'};}
  const summary:Record<string,unknown>={};
  try{
    await processBonuses();
    const active=(await pool.query(`SELECT EXISTS(SELECT 1 FROM matches WHERE season_id=$1 AND kickoff_at BETWEEN now()-interval '5 hours' AND now()+interval '1 hour') active`,[seasonId()])).rows[0].active;
    const last=(await pool.query("SELECT provider,last_success_at FROM sync_status")).rows;
    const due=(provider:string,minutes:number)=>force||!last.some(r=>r.provider===provider&&r.last_success_at&&Date.now()-+new Date(r.last_success_at)<minutes*60_000);
    if(!process.env.FOOTBALL_API_KEY) {await status('football-data',false,'Ottelu- ja tulostietojen yhteys odottaa käyttöönottoa.');summary.football='not_configured';}
    else if(due('football-data',active?5:360)) {
      try {const data=await fetchFootballData();summary.football=await persistFootball(data);await status('football-data',true,data.warnings?.join(' ')||null,true);}
      catch(e){const error=safeError(e);await status('football-data',true,error);summary.football={error};}
    }
    if(!process.env.ODDS_API_KEY){await status('odds-api',false,'Kerroinyhteys odottaa käyttöönottoa.');summary.odds='not_configured';}
    else if(due('odds-api',active?30:360)){
      try {const fixtures=await upcomingFixtures();summary.odds=await persistOdds(fixtures.length?await fetchOdds(fixtures):[]);await status('odds-api',true,null,true);}
      catch(e){const error=safeError(e);await status('odds-api',true,error);summary.odds={error};}
    }
    return summary;
  }finally{await connection.query("SELECT pg_advisory_unlock(hashtext('ponnicup:sync'))");connection.release();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) syncAll(process.argv.includes('--force')).then(async summary=>{console.info(JSON.stringify(summary));await pool.end();if(Object.values(summary).some(x=>x&&typeof x==='object'&&'error' in x))process.exitCode=1;}).catch(async error=>{console.error(safeError(error));await pool.end();process.exitCode=1;});
