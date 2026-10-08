import { createHash } from 'node:crypto';
import type { FootballImport, ImportedOdds, ImportedFixture } from '../shared/imports';
import type { ResultInput, Team } from '../shared/contracts';
import { transaction, type Db, pool } from './db';
import { applyResult } from './engine';
import { clubNamesMatch } from './providers';

export const seasonId = () => process.env.SEASON_ID || 'ucl-2026';
const dateFinland=(value:string)=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Helsinki',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
async function team(db:Db,t:Team) {
  await db.query(`INSERT INTO teams(id,name,short_name,crest) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET name=EXCLUDED.name,short_name=EXCLUDED.short_name,crest=COALESCE(EXCLUDED.crest,teams.crest)`,[t.id,t.name,t.shortName,t.crest]);
}

const lockGame = (db:Db) => db.query("SELECT pg_advisory_xact_lock(hashtext('ponnicup:game'))");
const footballBinding = (matchId:string) => /^fd-\d+$/.test(matchId) ? `football-data:${matchId.slice(3)}` : null;
const playerIdForMatch = (id:string,source:string,target:string) => id.startsWith(`player:${source}:`) ? `player:${target}:${id.slice(`player:${source}:`.length)}` : id;
type ExistingMatch = {id:string;season_id:string;provider_id:string|null;home_team_id:string;away_team_id:string;kickoff_at:Date;stage:string;round_number:number;result_override:boolean;tie_id:string|null};

function canonicalTeam(incoming:Team,known:Team[],aliases:Map<string,string>):Team {
  const direct=known.find(t=>t.id===incoming.id);
  if(direct){aliases.set(incoming.id,direct.id);return incoming;}
  const candidates=known.filter(t=>clubNamesMatch(t,incoming.name)||clubNamesMatch(incoming,t.name));
  if(candidates.length>1)throw new Error(`Ambiguous club identity for ${incoming.name}; reconcile duplicate clubs before importing.`);
  const canonical={...incoming,id:candidates[0]?.id??incoming.id};
  aliases.set(incoming.id,canonical.id);
  if(!candidates.length)known.push(canonical);
  return canonical;
}

function canonicalFixture(incoming:ImportedFixture,existing:ExistingMatch[]):ExistingMatch|undefined {
  const binding=footballBinding(incoming.id);
  const identified=existing.filter(row=>row.id===incoming.id || (binding!==null && row.provider_id===binding));
  if(identified.length>1)throw new Error(`Duplicate provider fixture binding for ${incoming.id}; import held.`);
  if(identified.length===1)return identified[0];
  const sameRound=existing.filter(row=>row.stage===incoming.stage && row.round_number===incoming.roundNumber);
  const sameClubs=sameRound.filter(row=>row.home_team_id===incoming.homeTeam.id && row.away_team_id===incoming.awayTeam.id);
  const near=(row:ExistingMatch)=>Math.abs(+new Date(row.kickoff_at)-Date.parse(incoming.kickoffAtUtc))<=2*3600_000;
  if(sameClubs.length===1 && near(sameClubs[0])){
    if(binding && sameClubs[0].provider_id?.startsWith('football-data:') && sameClubs[0].provider_id!==binding)throw new Error(`Conflicting provider fixture binding for ${incoming.id}; import held.`);
    return sameClubs[0];
  }
  if(sameClubs.length)throw new Error(`Ambiguous or rescheduled fixture ${incoming.id}; reconcile the existing calendar entry before importing.`);
  // A club cannot play a different fixture at the same time. This also catches reversed home/away listings.
  const overlapping=sameRound.filter(row=>near(row)&&[row.home_team_id,row.away_team_id].some(id=>id===incoming.homeTeam.id||id===incoming.awayTeam.id));
  if(overlapping.length)throw new Error(`Conflicting fixture identity for ${incoming.id}; the existing calendar has overlapping clubs.`);
  return undefined;
}

async function resolveMatchId(db:Db,incoming:string):Promise<string> {
  const binding=footballBinding(incoming);
  const matches=(await db.query('SELECT id FROM matches WHERE season_id=$1 AND (id=$2 OR ($3::text IS NOT NULL AND provider_id=$3))',[seasonId(),incoming,binding])).rows;
  if(matches.length>1)throw new Error(`Ambiguous stored fixture identity for ${incoming}.`);
  return matches[0]?.id??incoming;
}

export async function persistFootball(data:FootballImport) {
  const fixtureIds=new Map<string,string>();const teamIds=new Map<string,string>();
  await transaction(async db=>{
    await lockGame(db);
    const knownTeams:Team[]=(await db.query('SELECT id,name,short_name,crest FROM teams')).rows.map(row=>({id:row.id,name:row.name,shortName:row.short_name,crest:row.crest}));
    const existing:ExistingMatch[]=(await db.query(`SELECT m.*,r.number AS round_number FROM matches m JOIN rounds r ON r.id=m.round_id WHERE m.season_id=$1 FOR UPDATE OF m`,[seasonId()])).rows;
    for(const incoming of data.fixtures) {
      const f={...incoming,homeTeam:canonicalTeam(incoming.homeTeam,knownTeams,teamIds),awayTeam:canonicalTeam(incoming.awayTeam,knownTeams,teamIds)};
      if (!Number.isFinite(Date.parse(f.kickoffAtUtc))) throw new Error('Provider fixture has invalid kickoff.');
      const prior=canonicalFixture(f,existing);
      if(prior){
        if(dateFinland(f.kickoffAtUtc)!==dateFinland(new Date(prior.kickoff_at).toISOString())){
          const history=(await db.query(`SELECT EXISTS(SELECT 1 FROM bets b JOIN markets mk ON mk.id=b.market_id WHERE mk.match_id=$1) present`,[prior.id])).rows[0].present;
          if(history)throw new Error(`Fixture ${prior.id} moved to another Finland playing date after bets were saved; administrator postponement/void reconciliation is required.`);
        }
        if(prior.home_team_id!==f.homeTeam.id||prior.away_team_id!==f.awayTeam.id){
          const frozen=(await db.query(`SELECT EXISTS(SELECT 1 FROM selections s JOIN markets mk ON mk.id=s.market_id WHERE mk.match_id=$1) frozen`,[prior.id])).rows[0].frozen;
          if(frozen||prior.result_override)throw new Error(`Fixture ${prior.id} participants changed after prices or an override were saved; administrator reconciliation is required.`);
        }
        f.id=prior.id;
      }
      fixtureIds.set(incoming.id,f.id);
      if(f.tieId&&(f.homeTeam.id!==incoming.homeTeam.id||f.awayTeam.id!==incoming.awayTeam.id)) f.tieId=prior?.tie_id??`${seasonId()}-${f.stage}-${[f.homeTeam.id,f.awayTeam.id].sort().join('-')}`;
      // A public-calendar import must never erase a previously established football-data binding.
      const providerId=footballBinding(incoming.id)??(prior?.provider_id?.startsWith('football-data:')?prior.provider_id:incoming.providerId);
      await team(db,f.homeTeam);await team(db,f.awayTeam);
      await db.query(`INSERT INTO rounds(id,season_id,name,stage,number,starts_at,ends_at) VALUES($1,$2,$3,$4,$5,$6,$6)
        ON CONFLICT(id) DO UPDATE SET starts_at=LEAST(rounds.starts_at,EXCLUDED.starts_at),ends_at=GREATEST(rounds.ends_at,EXCLUDED.ends_at)`,[f.roundId,seasonId(),f.roundName,f.stage,f.roundNumber,f.kickoffAtUtc]);
      await db.query(`INSERT INTO matches(id,season_id,round_id,home_team_id,away_team_id,kickoff_at,date_finland,stage,status,leg,tie_id,provider_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT(id) DO UPDATE SET round_id=CASE WHEN matches.result_override THEN matches.round_id ELSE EXCLUDED.round_id END,
        kickoff_at=CASE WHEN matches.result_override THEN matches.kickoff_at ELSE EXCLUDED.kickoff_at END,
        date_finland=CASE WHEN matches.result_override THEN matches.date_finland ELSE EXCLUDED.date_finland END,
        home_team_id=CASE WHEN matches.result_override OR EXISTS(SELECT 1 FROM bets b JOIN markets mk ON mk.id=b.market_id WHERE mk.match_id=matches.id) THEN matches.home_team_id ELSE EXCLUDED.home_team_id END,
        away_team_id=CASE WHEN matches.result_override OR EXISTS(SELECT 1 FROM bets b JOIN markets mk ON mk.id=b.market_id WHERE mk.match_id=matches.id) THEN matches.away_team_id ELSE EXCLUDED.away_team_id END,
        stage=CASE WHEN matches.result_override THEN matches.stage ELSE EXCLUDED.stage END,
        leg=CASE WHEN matches.result_override THEN matches.leg ELSE EXCLUDED.leg END,
        tie_id=CASE WHEN matches.result_override THEN matches.tie_id ELSE EXCLUDED.tie_id END,provider_id=EXCLUDED.provider_id,
        status=CASE WHEN matches.result_override OR matches.status='final' THEN matches.status ELSE EXCLUDED.status END`,[f.id,seasonId(),f.roundId,f.homeTeam.id,f.awayTeam.id,f.kickoffAtUtc,dateFinland(f.kickoffAtUtc),f.stage,f.status,f.leg,f.tieId,providerId]);
      for(const type of ['main_1x2','exact_score','anytime_goalscorer']) await db.query(`INSERT INTO markets(id,match_id,type,status,required) VALUES($1,$2,$3,'draft',false) ON CONFLICT(match_id,type) DO NOTHING`,[`${f.id}:${type}`,f.id,type]);
      if(!prior)existing.push({id:f.id,season_id:seasonId(),provider_id:providerId,home_team_id:f.homeTeam.id,away_team_id:f.awayTeam.id,kickoff_at:new Date(f.kickoffAtUtc),stage:f.stage,round_number:f.roundNumber,result_override:false,tie_id:f.tieId});
      else if(!prior.result_override)Object.assign(prior,{provider_id:providerId,home_team_id:f.homeTeam.id,away_team_id:f.awayTeam.id,kickoff_at:new Date(f.kickoffAtUtc),stage:f.stage,round_number:f.roundNumber,tie_id:f.tieId});
    }
    if(data.standings.length) {
      for(const s of data.standings){
        const club=canonicalTeam(s.team,knownTeams,teamIds);await team(db,club);
        await db.query(`INSERT INTO club_standings(season_id,team_id,position,played,won,drawn,lost,goals_for,goals_against,points) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT(season_id,team_id) DO UPDATE SET position=EXCLUDED.position,played=EXCLUDED.played,won=EXCLUDED.won,drawn=EXCLUDED.drawn,lost=EXCLUDED.lost,goals_for=EXCLUDED.goals_for,goals_against=EXCLUDED.goals_against,points=EXCLUDED.points`,[seasonId(),club.id,s.position,s.played,s.won,s.drawn,s.lost,s.goalsFor,s.goalsAgainst,s.points]);
      }
    }
  });
  for(const incoming of data.results){
    const matchId=fixtureIds.get(incoming.matchId)??await resolveMatchId(pool,incoming.matchId);
    const players=(ids:string[]|undefined)=>ids?.map(id=>playerIdForMatch(id,incoming.matchId,matchId));
    const result:ResultInput={...incoming,matchId,scorerPlayerIds:players(incoming.scorerPlayerIds),appearedPlayerIds:players(incoming.appearedPlayerIds),registeredPlayerIds:players(incoming.registeredPlayerIds),advancingTeamId:incoming.advancingTeamId?(teamIds.get(incoming.advancingTeamId)??incoming.advancingTeamId):incoming.advancingTeamId};
    await applyResult(result);
  }
  return {fixtures:data.fixtures.length,standings:data.standings.length,results:data.results.length};
}
export async function persistOdds(data:ImportedOdds[]) {
  let opened=0;
  for(const incoming of data) await transaction(async db=>{
    await lockGame(db);
    const matchId=await resolveMatchId(db,incoming.matchId);
    const item={...incoming,matchId,markets:incoming.markets.map(market=>({...market,selections:market.selections.map(selection=>({...selection,key:playerIdForMatch(selection.key,incoming.matchId,matchId),playerId:selection.playerId?playerIdForMatch(selection.playerId,incoming.matchId,matchId):undefined}))}))};
    const match=(await db.query(`SELECT m.*,s.game_start_at FROM matches m JOIN seasons s ON s.id=m.season_id WHERE m.id=$1 FOR UPDATE OF m`,[item.matchId])).rows[0];
    if(!match || match.season_id!==seasonId() || match.status!=='scheduled' || +new Date(match.kickoff_at)<=Date.now() || +new Date(match.kickoff_at)<+new Date(match.game_start_at)) return;
    for(const incoming of item.markets){
      const market=(await db.query('SELECT * FROM markets WHERE match_id=$1 AND type=$2 FOR UPDATE',[item.matchId,incoming.type])).rows[0];
      if(!market || market.status!=='draft') continue;
      const valid=incoming.selections.filter(s=>Number.isFinite(s.decimalOdds)&&s.decimalOdds>1&&s.decimalOdds<=10000);
      if(incoming.type==='main_1x2' && !['home_win','draw','away_win'].every(k=>valid.some(s=>s.kind===k))) continue;
      if(!valid.length) continue;
      for(const s of valid){
        const id=market.id+':'+createHash('sha256').update(s.key).digest('hex').slice(0,20);
        await db.query(`INSERT INTO selections(id,market_id,label,kind,score_home,score_away,player_id) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(id) DO NOTHING`,[id,market.id,s.label,s.kind,s.scoreHome??null,s.scoreAway??null,s.playerId??null]);
        await db.query('INSERT INTO odds_snapshots(selection_id,decimal_odds,source,captured_at) VALUES($1,$2,$3,$4)',[id,s.decimalOdds,item.source,item.capturedAt]);
      }
      // First complete provider market becomes the shared, immutable price sheet.
      await db.query("UPDATE markets SET status='open',required=(type='main_1x2') WHERE id=$1",[market.id]);opened++;
    }
  });
  return {openedMarkets:opened};
}
export async function upcomingFixtures():Promise<ImportedFixture[]> {
  const rows=(await pool.query(`SELECT m.*,r.name round_name,r.number round_number,h.name home_name,h.short_name home_short,h.crest home_crest,a.name away_name,a.short_name away_short,a.crest away_crest
    FROM matches m JOIN rounds r ON r.id=m.round_id JOIN teams h ON h.id=m.home_team_id JOIN teams a ON a.id=m.away_team_id JOIN seasons s ON s.id=m.season_id
    WHERE m.season_id=$1 AND m.status='scheduled' AND m.kickoff_at>now() AND m.kickoff_at<now()+interval '10 days' AND m.kickoff_at>=s.game_start_at ORDER BY m.kickoff_at`,[seasonId()])).rows;
  return rows.map(r=>({id:r.id,providerId:r.provider_id,homeTeam:{id:r.home_team_id,name:r.home_name,shortName:r.home_short,crest:r.home_crest},awayTeam:{id:r.away_team_id,name:r.away_name,shortName:r.away_short,crest:r.away_crest},kickoffAtUtc:new Date(r.kickoff_at).toISOString(),roundId:r.round_id,roundName:r.round_name,roundNumber:r.round_number,stage:r.stage,leg:r.leg,tieId:r.tie_id,status:r.status}));
}
