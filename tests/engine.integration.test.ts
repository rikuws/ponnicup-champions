import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { BetInput, User } from '../shared/contracts';

const databaseUrl=process.env.TEST_DATABASE_URL;
const suite=databaseUrl?describe:describe.skip;
let db:typeof import('../server/db');let engine:typeof import('../server/engine');let auth:typeof import('../server/auth');
let tomorrow:Date;let nextDay:Date;let pinHash:string;
const user:User={id:'riku',displayName:'Riku',role:'admin',pinResetRequired:false};
const other:User={id:'henri',displayName:'Henri',role:'player',pinResetRequired:false};
async function match(id:string,kind:'main_1x2'|'anytime_goalscorer'='main_1x2',kickoff=tomorrow) {
  await db.pool.query(`INSERT INTO matches(id,season_id,round_id,home_team_id,away_team_id,kickoff_at,date_finland,stage,status)
    VALUES($1,'ucl','r1','home','away',$2,($2::timestamptz AT TIME ZONE 'Europe/Helsinki')::date,'league','scheduled')`,[id,kickoff]);
  await db.pool.query("INSERT INTO markets(id,match_id,type,status,required) VALUES($1,$2,$3,'open',$4)",[`${id}-market`,id,kind,kind==='main_1x2']);
  if(kind==='main_1x2') {
    for(const [key,label,odds] of [['home_win','1',2],['draw','X',3.2],['away_win','2',4]] as const) {
      await db.pool.query('INSERT INTO selections(id,market_id,label,kind) VALUES($1,$2,$3,$4)',[`${id}-${key}`,`${id}-market`,label,key]);
      await db.pool.query("INSERT INTO odds_snapshots(id,selection_id,decimal_odds,source) VALUES($1,$2,$3,'test')",[`${id}-${key}-odds`,`${id}-${key}`,odds]);
    }
  }else{
    for(const player of ['winner','unused','unknown','played']) {
      await db.pool.query("INSERT INTO selections(id,market_id,label,kind,player_id) VALUES($1,$2,$3,'player_anytime_goalscorer',$3)",[`${id}-${player}`,`${id}-market`,player]);
      await db.pool.query("INSERT INTO odds_snapshots(id,selection_id,decimal_odds,source) VALUES($1,$2,3,'test')",[`${id}-${player}-odds`,`${id}-${player}`]);
    }
  }
}
function input(id:string,stake=100,kind='home_win'):BetInput {return {marketId:`${id}-market`,selectionId:`${id}-${kind}`,oddsSnapshotId:`${id}-${kind}-odds`,stake,requestId:randomUUID()};}
async function balance(userId=user.id) {return Number((await db.pool.query('SELECT sum(amount) AS balance FROM ledger WHERE user_id=$1',[userId])).rows[0].balance);}
async function betRow(id:string) {return (await db.pool.query('SELECT * FROM bets WHERE id=$1',[id])).rows[0];}

suite('PostgreSQL engine integration',()=>{
  beforeAll(async()=>{
    if(!databaseUrl || !new URL(databaseUrl).pathname.endsWith('_test'))throw new Error('Integration database name must end with _test');
    process.env.DATABASE_URL=databaseUrl;process.env.SEASON_ID='ucl';
    db=await import('../server/db');engine=await import('../server/engine');auth=await import('../server/auth');
    await (await import('../server/migrate')).migrate();pinHash=await auth.hashPin('654321');
  });
  beforeEach(async()=>{
    await db.pool.query('TRUNCATE seasons,users,teams,login_attempts,sync_status CASCADE');
    tomorrow=new Date();tomorrow.setUTCDate(tomorrow.getUTCDate()+1);tomorrow.setUTCHours(17,0,0,0);
    nextDay=new Date(tomorrow);nextDay.setUTCDate(nextDay.getUTCDate()+1);
    await db.pool.query('INSERT INTO seasons(id,name,competition,game_start_at,config) VALUES($1,$2,$3,$4,$5)',[
      'ucl','Champions League','UCL',new Date(Date.now()-86400000),JSON.stringify({startingBalance:1000,dailyBonus:100,minimumStake:1,recoveryThreshold:500})]);
    for(const player of [user,other]) {
      await db.pool.query('INSERT INTO users(id,display_name,role,pin_hash,pin_reset_required) VALUES($1,$2,$3,$4,false)',[player.id,player.displayName,player.role,pinHash]);
      await db.pool.query("INSERT INTO ledger(user_id,season_id,amount,type) VALUES($1,'ucl',1000,'starting_balance')",[player.id]);
    }
    await db.pool.query("INSERT INTO rounds(id,season_id,name,stage,number,starts_at,ends_at) VALUES('r1','ucl','Round 1','league',1,$1,$2)",[tomorrow,nextDay]);
    await db.pool.query("INSERT INTO teams(id,name,short_name) VALUES('home','Home FC','HOM'),('away','Away FC','AWY')");
  });
  afterAll(async()=>{if(db)await db.pool.end();});
  it('commits a batch atomically and rolls every bet back if one cannot be funded',async()=>{
    await match('a');await match('b');
    await expect(engine.placeBets(user,[input('a',600),input('b',600)])).rejects.toMatchObject({code:'INSUFFICIENT_FUNDS'});
    expect((await db.pool.query('SELECT count(*) FROM bets')).rows[0].count).toBe('0');expect(await balance()).toBe(1000);
    expect((await db.pool.query('SELECT count(*) FROM idempotency')).rows[0].count).toBe('0');
  });
  it('serializes concurrent wagers on different markets to prevent overspending',async()=>{
    await match('a');await match('b');
    const results=await Promise.allSettled([engine.placeBets(user,[input('a',600)]),engine.placeBets(user,[input('b',600)])]);
    expect(results.filter(result=>result.status==='fulfilled')).toHaveLength(1);expect(await balance()).toBe(400);
  });
  it('replays a committed request once and rejects reuse with different content',async()=>{
    await match('a');const request=input('a',100);
    const first=await engine.placeBets(user,[request]);const second=await engine.placeBets(user,[request]);
    expect(second).toEqual(first);expect(await balance()).toBe(900);
    await expect(engine.placeBets(user,[{...request,stake:200}])).rejects.toMatchObject({code:'IDEMPOTENCY_CONFLICT'});
  });
  it('preserves the original bet and funds when replacement fails',async()=>{
    await match('a');const [bet]=await engine.placeBets(user,[input('a',500)]);
    await expect(engine.placeBets(user,[input('a',1200,'draw')])).rejects.toMatchObject({code:'INSUFFICIENT_FUNDS'});
    expect((await betRow(bet.id)).status).toBe('placed');expect(await balance()).toBe(500);
  });
  it('redistributes existing stakes across a batch without order-dependent funding failures',async()=>{
    await match('a');await match('b');await engine.placeBets(user,[input('a',100),input('b',900)]);
    const bets=await engine.placeBets(user,[input('a',900),input('b',100)]);
    expect(bets.map(bet=>bet.stake)).toEqual([900,100]);expect(await balance()).toBe(0);
  });
  it('rejects stale odds, pre-season matches and kickoff-crossed batches',async()=>{
    await match('a');await match('locked','main_1x2',new Date(Date.now()-1000));
    await expect(engine.placeBets(user,[input('a'),input('locked')])).rejects.toMatchObject({code:'MARKET_LOCKED'});
    expect(await balance()).toBe(1000);
    await db.pool.query("INSERT INTO odds_snapshots(id,selection_id,decimal_odds,source,captured_at) VALUES('latest','a-home_win',2.5,'test',now()+interval '1 minute')");
    await expect(engine.placeBets(user,[input('a')])).rejects.toMatchObject({code:'ODDS_CHANGED'});
    await db.pool.query("UPDATE seasons SET game_start_at=$1 WHERE id='ucl'",[nextDay]);
    await expect(engine.placeBets(user,[input('a')])).rejects.toMatchObject({code:'INELIGIBLE_MATCH'});
  });
  it('settles 90-minute draws regardless of advancement, repeats safely, and reverses corrections',async()=>{
    await match('a');const [bet]=await engine.placeBets(user,[input('a',100,'draw')]);
    const result={matchId:'a',status:'final' as const,homeScore:1,awayScore:1,homeScoreFinal:2,awayScoreFinal:1,advancingTeamId:'home',reason:'Verified result'};
    await engine.applyResult(result,user.id);expect((await betRow(bet.id)).status).toBe('won');expect(await balance()).toBe(1220);
    const count=(await db.pool.query('SELECT count(*) FROM ledger')).rows[0].count;
    await engine.applyResult({...result,reason:'Repeated import'});expect((await db.pool.query('SELECT count(*) FROM ledger')).rows[0].count).toBe(count);
    await engine.applyResult({...result,homeScore:2,reason:'Corrected normal time'},user.id);expect(await balance()).toBe(900);expect((await betRow(bet.id)).status).toBe('lost');
    await engine.applyResult({...result,status:'cancelled',homeScore:null,awayScore:null,reason:'Match cancelled'},user.id);expect(await balance()).toBe(1000);
  });
  it('preserves manual results across imports until an admin explicitly releases the override',async()=>{
    await match('a');const [bet]=await engine.placeBets(user,[input('a')]);
    const manual={matchId:'a',status:'final' as const,homeScore:2,awayScore:0,reason:'Manually verified result'};
    await engine.applyResult(manual,user.id);expect((await betRow(bet.id)).status).toBe('won');
    await engine.applyResult({...manual,homeScore:0,awayScore:2,reason:'Stale upstream result'});
    expect((await betRow(bet.id)).status).toBe('won');expect(await balance()).toBe(1100);
    await engine.applyResult({...manual,releaseOverride:true,reason:'Return to automatic results'},user.id);
    expect((await db.pool.query("SELECT result_override FROM matches WHERE id='a'")).rows[0].result_override).toBe(false);
    await engine.applyResult({...manual,homeScore:0,awayScore:2,reason:'Fresh upstream result'});
    expect((await betRow(bet.id)).status).toBe('lost');expect(await balance()).toBe(900);
  });
  it('keeps scheduled priced markets open and reopens them when a postponement is reversed',async()=>{
    await match('a');
    await db.pool.query("INSERT INTO markets(id,match_id,type,status,required) VALUES('a-scorer','a','anytime_goalscorer','draft',false)");
    const scheduled={matchId:'a',status:'scheduled' as const,homeScore:null,awayScore:null,reason:'Verified upcoming fixture'};
    await engine.applyResult(scheduled);
    expect((await db.pool.query("SELECT id,status FROM markets ORDER BY id")).rows).toEqual([{id:'a-market',status:'open'},{id:'a-scorer',status:'draft'}]);
    await db.pool.query("UPDATE markets SET status='locked' WHERE match_id='a'");
    await engine.applyResult(scheduled);
    expect((await db.pool.query("SELECT id,status FROM markets ORDER BY id")).rows).toEqual([{id:'a-market',status:'open'},{id:'a-scorer',status:'draft'}]);
    await engine.placeBets(user,[input('a')]);
    await engine.applyResult({...scheduled,status:'postponed',reason:'Kickoff postponed'});
    await expect(engine.placeBets(user,[input('a',50)])).rejects.toMatchObject({code:'MARKET_LOCKED'});
    await engine.applyResult({...scheduled,reason:'Original kickoff confirmed again'});
    const [bet]=await engine.placeBets(user,[input('a',50)]);
    expect(bet.stake).toBe(50);expect(await balance()).toBe(950);
    await engine.applyResult({...scheduled,status:'cancelled',reason:'Fixture cancelled'});
    await engine.applyResult({...scheduled,reason:'Cancellation corrected before kickoff'});
    expect((await db.pool.query("SELECT id,status FROM markets ORDER BY id")).rows).toEqual([{id:'a-market',status:'open'},{id:'a-scorer',status:'draft'}]);
    expect((await betRow(bet.id)).status).toBe('placed');expect(await balance()).toBe(950);
  });
  it('shows both knockout legs across rounds and invalidates advancement after an earlier-leg correction',async()=>{
    await match('first');await match('second','main_1x2',nextDay);
    await db.pool.query("INSERT INTO rounds(id,season_id,name,stage,number,starts_at,ends_at) VALUES('knockout-second','ucl','Second leg','round_of_16',12,$1,$1)",[nextDay]);
    await db.pool.query("UPDATE matches SET stage='round_of_16',tie_id='knockout-tie',leg=1 WHERE id='first'");
    await db.pool.query("UPDATE matches SET stage='round_of_16',tie_id='knockout-tie',leg=2,round_id='knockout-second',home_team_id='away',away_team_id='home' WHERE id='second'");
    await engine.applyResult({matchId:'first',status:'final',homeScore:3,awayScore:0,reason:'First leg verified'});
    await engine.applyResult({matchId:'second',status:'final',homeScore:1,awayScore:0,advancingTeamId:'home',reason:'Return leg verified'});
    let game=await engine.getGame(user,'r1');
    expect(game.matches.map(match=>match.id)).toEqual(['first']);
    expect(game.ties[0]).toMatchObject({homeAggregate:3,awayAggregate:1,advancingTeamId:'home',matchIds:['first','second']});
    expect(game.ties[0].legs.map(leg=>({id:leg.id,home:leg.homeTeam.id,away:leg.awayTeam.id,roundId:leg.roundId}))).toEqual([{id:'first',home:'home',away:'away',roundId:'r1'},{id:'second',home:'away',away:'home',roundId:'knockout-second'}]);
    expect(game.ties[0].legs.every(leg=>leg.homeScoreFinal===null&&leg.awayScoreFinal===null)).toBe(true);
    await engine.applyResult({matchId:'first',status:'final',homeScore:1,awayScore:0,reason:'First leg score corrected'},user.id);
    game=await engine.getGame(user,'knockout-second');
    expect(game.ties[0]).toMatchObject({homeAggregate:1,awayAggregate:1,advancingTeamId:null});
    expect(game.matches[0].result.advancingTeamId).toBeNull();
    await engine.applyResult({matchId:'second',status:'final',homeScore:1,awayScore:0,advancingTeamId:'away',reason:'Shootout winner separately verified'},user.id);
    expect((await engine.getGame(user)).ties[0].advancingTeamId).toBe('away');
    await engine.applyResult({matchId:'first',status:'postponed',homeScore:null,awayScore:null,reason:'First leg result withdrawn'},user.id);
    expect((await engine.getGame(user)).ties[0].advancingTeamId).toBeNull();
  });
  it('includes a single-match final and its verified result evidence without a two-leg tie ID',async()=>{
    await match('final','anytime_goalscorer');
    await db.pool.query("UPDATE matches SET stage='final' WHERE id='final'");
    const [bet]=await engine.placeBets(user,[input('final',50,'winner')]);
    expect((await engine.getGame(user)).ties[0]).toMatchObject({stage:'final',homeAggregate:null,awayAggregate:null,advancingTeamId:null,matchIds:['final']});
    await engine.applyResult({matchId:'final',status:'final',homeScore:1,awayScore:1,homeScoreFinal:2,awayScoreFinal:1,advancingTeamId:'home',scorerDataComplete:true,scorerPlayerIds:['winner'],appearedPlayerIds:['winner','played'],registeredPlayerIds:['winner','played','unused'],reason:'Final with extra time verified'},user.id);
    const game=await engine.getGame(user);
    expect(game.ties[0]).toMatchObject({homeAggregate:2,awayAggregate:1,advancingTeamId:'home'});
    expect(game.ties[0].legs[0]).toMatchObject({homeScore:1,awayScore:1,homeScoreFinal:2,awayScoreFinal:1});
    expect(game.matches[0].result).toEqual({homeScoreFinal:2,awayScoreFinal:1,advancingTeamId:'home',scorerDataComplete:true,scorerPlayerIds:['winner'],appearedPlayerIds:['played','winner'],registeredPlayerIds:['played','unused','winner'],override:true});
    await engine.applyResult({...game.matches[0].result,matchId:'final',status:'final',homeScore:1,awayScore:1,reason:'Admin reviewed persisted result evidence'},user.id);
    expect((await engine.getGame(user)).matches[0].result).toEqual(game.matches[0].result);
    expect((await betRow(bet.id)).status).toBe('won');expect(await balance()).toBe(1100);
    await engine.applyResult({...game.matches[0].result,matchId:'final',status:'scheduled',homeScore:1,awayScore:1,reason:'Final result withdrawn before kickoff'},user.id);
    let withdrawn=(await engine.getGame(user)).matches[0];
    expect(withdrawn).toMatchObject({homeScore:null,awayScore:null,result:{homeScoreFinal:null,awayScoreFinal:null,advancingTeamId:null,scorerPlayerIds:[],appearedPlayerIds:[],registeredPlayerIds:[],scorerDataComplete:false}});
    expect((await betRow(bet.id)).status).toBe('placed');expect(await balance()).toBe(950);
    await engine.applyResult({...game.matches[0].result,matchId:'final',status:'live',homeScore:1,awayScore:0,reason:'Verified live score'},user.id);
    withdrawn=(await engine.getGame(user)).matches[0];
    expect(withdrawn).toMatchObject({homeScore:1,awayScore:0,result:{homeScoreFinal:null,awayScoreFinal:null,advancingTeamId:null,scorerPlayerIds:[],appearedPlayerIds:[],registeredPlayerIds:[],scorerDataComplete:false}});
  });
  it('rejects malformed result booleans and inconsistent goal evidence without changing bets',async()=>{
    await match('a');const [bet]=await engine.placeBets(user,[input('a')]);
    const result={matchId:'a',status:'final' as const,homeScore:1,awayScore:0,reason:'Verified result'};
    await expect(engine.applyResult({...result,scorerDataComplete:'false' as unknown as boolean})).rejects.toMatchObject({status:400});
    await expect(engine.applyResult({...result,releaseOverride:'false' as unknown as boolean})).rejects.toMatchObject({status:400});
    await expect(engine.applyResult({...result,homeScoreFinal:2})).rejects.toMatchObject({status:400});
    await expect(engine.applyResult({...result,homeScoreFinal:0,awayScoreFinal:0})).rejects.toMatchObject({status:400});
    await expect(engine.applyResult({...result,scorerDataComplete:true,scorerPlayerIds:['winner'],appearedPlayerIds:[]})).rejects.toMatchObject({status:400});
    expect((await betRow(bet.id)).status).toBe('placed');expect(await balance()).toBe(900);
  });
  it('holds incomplete and unmapped scorer data while settling verified participation',async()=>{
    for(const id of ['winner','unused','unknown','played']){await match(id,'anytime_goalscorer');await engine.placeBets(user,[input(id,50,id)]);}
    for(const id of ['winner','unused','unknown','played']){
      const result={matchId:id,status:'final' as const,homeScore:1,awayScore:0,reason:'Official scorer data',scorerPlayerIds:['winner'],appearedPlayerIds:['winner','played'],registeredPlayerIds:['winner','played','unused']};
      await engine.applyResult(result);
      expect((await db.pool.query('SELECT status FROM bets WHERE market_id=$1',[`${id}-market`])).rows[0].status).toBe('placed');
      await engine.applyResult({...result,scorerDataComplete:true});
    }
    const statuses=(await db.pool.query('SELECT market_id,status FROM bets ORDER BY market_id')).rows;
    expect(statuses).toEqual([{market_id:'played-market',status:'lost'},{market_id:'unknown-market',status:'placed'},{market_id:'unused-market',status:'voided'},{market_id:'winner-market',status:'won'}]);
  });
  it('grants only playing dates, refills preplaced bets oldest first and never grants twice',async()=>{
    await match('a');await match('b');const [first]=await engine.placeBets(user,[input('a',70)]);const [second]=await engine.placeBets(user,[input('b',80)]);
    expect(await balance()).toBe(850);await engine.processBonuses(tomorrow);await engine.processBonuses(tomorrow);
    expect(await balance()).toBe(950);expect(Number((await betRow(first.id)).bonus_stake)).toBe(70);expect(Number((await betRow(second.id)).bonus_stake)).toBe(30);
    const pool=(await db.pool.query("SELECT * FROM bonuses WHERE user_id='riku'")).rows[0];expect(Number(pool.used)).toBe(100);expect(Number(pool.available)).toBe(0);
    expect((await db.pool.query("SELECT count(*) FROM bonuses WHERE user_id='riku'")).rows[0].count).toBe('1');
  });
  it('does not inflate wealth or ranking when a player places a bonus-only bet',async()=>{
    await match('a');await match('b');await engine.processBonuses(tomorrow);
    const [bonusBet]=await engine.placeBets(user,[input('a',100)]);
    expect(bonusBet.bonusStake).toBe(100);expect(bonusBet.bankrollStake).toBe(0);
    let game=await engine.getGame(user,'r1');
    expect(game.wallet).toMatchObject({bankroll:1000,openStake:0,total:1000});
    expect(game.leaderboard.every(player=>player.total===1000&&player.rank===1)).toBe(true);
    await engine.placeBets(user,[input('b',75)]);
    game=await engine.getGame(user,'r1');expect(game.wallet).toMatchObject({bankroll:925,openStake:75,total:1000});
    expect(game.leaderboard.find(player=>player.userId===user.id)).toMatchObject({openStake:75,total:1000,rank:1});
  });
  it('converts unused bonus only below the liquid balance threshold, otherwise expires it',async()=>{
    await match('a');await engine.processBonuses(tomorrow);
    await db.pool.query("INSERT INTO ledger(user_id,season_id,amount,type) VALUES('riku','ucl',-600,'test_adjustment')");
    await engine.processBonuses(nextDay);await engine.processBonuses(nextDay);
    expect(await balance()).toBe(500);expect(await balance(other.id)).toBe(1000);
    const pools=(await db.pool.query('SELECT user_id,converted,expired FROM bonuses ORDER BY user_id')).rows;
    expect(pools).toEqual([{user_id:'henri',converted:'0.00',expired:'100.00'},{user_id:'riku',converted:'100.00',expired:'0.00'}]);
  });
  it('reconciles a result correction after a refunded bonus was spent on another bet',async()=>{
    await match('a');await match('b');await engine.processBonuses(tomorrow);
    const [first]=await engine.placeBets(user,[input('a',100)]);
    await engine.applyResult({matchId:'a',status:'cancelled',homeScore:null,awayScore:null,reason:'First cancellation'});
    const [second]=await engine.placeBets(user,[input('b',100)]);expect(await balance()).toBe(1000);
    await engine.applyResult({matchId:'a',status:'final',homeScore:0,awayScore:1,reason:'Official correction'});
    expect((await betRow(first.id)).status).toBe('lost');expect(Number((await betRow(second.id)).bonus_stake)).toBe(0);expect(Number((await betRow(second.id)).bankroll_stake)).toBe(100);expect(await balance()).toBe(900);
    expect(Number((await db.pool.query("SELECT used FROM bonuses WHERE user_id='riku'")).rows[0].used)).toBe(100);
  });
  it('hides other selections until kickoff and computes balances with SQL beyond row-page limits',async()=>{
    await match('a');await engine.placeBets(other,[input('a',100)]);
    await db.pool.query("INSERT INTO ledger(user_id,season_id,amount,type) SELECT 'riku','ucl',1,'test_adjustment' FROM generate_series(1,1200)");
    const game=await engine.getGame(user,'r1');expect(game.matches[0].markets[0].revealedBets).toEqual([]);expect(game.matches[0].markets[0].userBet).toBe(null);expect(game.matches[0].submittedMainBets).toBe(1);expect(game.wallet.bankroll).toBe(2200);
    await db.pool.query("UPDATE matches SET kickoff_at=now()-interval '1 minute' WHERE id='a'");
    const revealed=await engine.getGame(user,'r1');expect(revealed.matches[0].markets[0].revealedBets[0].selectionId).toBe('a-home_win');
  });
  it('authenticates with opaque revocable sessions and persists failed-attempt limits',async()=>{
    const login=await auth.login(user.id,'654321','127.0.0.1');expect((await auth.getSession(login.token))?.id).toBe(user.id);
    const stored=(await db.pool.query('SELECT id FROM sessions')).rows[0].id;expect(stored).not.toBe(login.token);
    await auth.logout(login.token);expect(await auth.getSession(login.token)).toBe(null);
    for(let i=0;i<5;i++)await expect(auth.login(user.id,'000000','127.0.0.2')).rejects.toMatchObject({status:401});
    await expect(auth.login(user.id,'654321','127.0.0.2')).rejects.toMatchObject({status:429});
  });
  it('requires an initial PIN change, revokes old sessions, and expires sessions',async()=>{
    await db.pool.query("UPDATE users SET pin_reset_required=true WHERE id='riku'");await match('a');
    await expect(engine.placeBets(user,[input('a')])).rejects.toMatchObject({code:'PIN_RESET_REQUIRED'});
    const old=await auth.login(user.id,'654321','127.0.0.1');await auth.changePin(user.id,'654321','987654');expect(await auth.getSession(old.token)).toBe(null);
    const current=await auth.login(user.id,'987654','127.0.0.1');expect(current.user.pinResetRequired).toBe(false);
    await db.pool.query("UPDATE sessions SET expires_at=now()-interval '1 minute'");expect(await auth.getSession(current.token)).toBe(null);
  });
  it('recovers a forgotten PIN without changing the player wallet or betting history',async()=>{
    const {resetPlayerPin}=await import('../server/reset-pin');
    await match('a');const [bet]=await engine.placeBets(user,[input('a',125)]);
    const originalBet=await betRow(bet.id);
    const originalLedger=(await db.pool.query('SELECT * FROM ledger ORDER BY id')).rows;
    const first=await auth.login(user.id,'654321','127.0.0.1');
    const second=await auth.login(user.id,'654321','127.0.0.2');
    const unrelated=await auth.login(other.id,'654321','127.0.0.3');
    for(const key of [`user:${user.id}`,`pin-change:${user.id}`])await db.pool.query("INSERT INTO login_attempts(key,failures,locked_until) VALUES($1,5,now()+interval '1 hour') ON CONFLICT(key) DO UPDATE SET failures=5,locked_until=EXCLUDED.locked_until",[key]);
    const recovery=await resetPlayerPin(user.id,'Player requested a forgotten PIN reset');
    expect(recovery).toMatchObject({userId:user.id,displayName:user.displayName,sessionsRevoked:2});
    expect(/^\d{8}$/.test(recovery.temporaryPin)).toBe(true);
    expect(recovery.temporaryPin==='654321').toBe(false);
    expect(await auth.getSession(first.token)).toBe(null);expect(await auth.getSession(second.token)).toBe(null);
    expect((await auth.getSession(unrelated.token))?.id).toBe(other.id);
    expect((await db.pool.query('SELECT count(*) FROM login_attempts WHERE key=ANY($1)',[[`user:${user.id}`,`pin-change:${user.id}`]])).rows[0].count).toBe('0');
    await expect(auth.login(user.id,'654321','127.0.0.4')).rejects.toMatchObject({status:401});
    const recovered=await auth.login(user.id,recovery.temporaryPin,'127.0.0.4');
    expect(recovered.user.pinResetRequired).toBe(true);
    await expect(engine.placeBets(recovered.user,[input('a',200)])).rejects.toMatchObject({code:'PIN_RESET_REQUIRED'});
    const stored=(await db.pool.query('SELECT pin_hash FROM users WHERE id=$1',[user.id])).rows[0].pin_hash;
    expect(stored.startsWith('scrypt$')).toBe(true);expect(stored===recovery.temporaryPin).toBe(false);
    expect(await auth.verifyPin(recovery.temporaryPin,stored)).toBe(true);
    const audit=(await db.pool.query("SELECT * FROM audit_log WHERE action='operator_pin_reset'")).rows;
    expect(audit).toHaveLength(1);expect(audit[0].detail).toEqual({userId:user.id,sessionsRevoked:2});
    expect(JSON.stringify(audit).includes(recovery.temporaryPin)).toBe(false);
    expect(await balance()).toBe(875);expect(await betRow(bet.id)).toEqual(originalBet);
    expect((await db.pool.query('SELECT * FROM ledger ORDER BY id')).rows).toEqual(originalLedger);
  });
  it('rolls an invalid recovery target back without modifying users, sessions or rate-limit rows',async()=>{
    const {resetPlayerPin}=await import('../server/reset-pin');
    const original=await auth.login(user.id,'654321','127.0.0.1');
    const beforeUsers=(await db.pool.query('SELECT * FROM users ORDER BY id')).rows;
    const beforeSessions=(await db.pool.query('SELECT * FROM sessions ORDER BY id')).rows;
    const beforeAttempts=(await db.pool.query('SELECT * FROM login_attempts ORDER BY key')).rows;
    await expect(resetPlayerPin('missing-player','Player recovery requested')).rejects.toThrow('Player not found');
    expect((await db.pool.query('SELECT * FROM users ORDER BY id')).rows).toEqual(beforeUsers);
    expect((await db.pool.query('SELECT * FROM sessions ORDER BY id')).rows).toEqual(beforeSessions);
    expect((await db.pool.query('SELECT * FROM login_attempts ORDER BY key')).rows).toEqual(beforeAttempts);
    expect((await db.pool.query('SELECT count(*) FROM audit_log')).rows[0].count).toBe('0');
    expect((await auth.getSession(original.token))?.id).toBe(user.id);expect(await balance()).toBe(1000);
  });
  it('rate limits guesses of the existing PIN during a PIN change',async()=>{
    for(let i=0;i<5;i++)await expect(auth.changePin(user.id,'000000','987654')).rejects.toMatchObject({status:401});
    await expect(auth.changePin(user.id,'654321','987654')).rejects.toMatchObject({status:429});
  });
  it('defaults to the first game-eligible round and includes archived results in derived UCL standings',async()=>{
    await db.pool.query("UPDATE seasons SET game_start_at=$1 WHERE id='ucl'",[tomorrow]);
    await db.pool.query("UPDATE rounds SET starts_at=now()-interval '1 hour',ends_at=now()+interval '1 hour' WHERE id='r1'");
    await db.pool.query("INSERT INTO rounds(id,season_id,name,stage,number,starts_at,ends_at) VALUES('r2','ucl','Round 2','league',2,$1,$2)",[tomorrow,nextDay]);
    await match('archive','main_1x2',new Date(Date.now()-60_000));
    await engine.applyResult({matchId:'archive',status:'final',homeScore:2,awayScore:0,reason:'Verified earlier league result'});
    const game=await engine.getGame(user);
    expect(game.selectedRoundId).toBe('r2');expect(game.wallet.bankroll).toBe(1000);expect(game.wallet.bonuses).toEqual([]);
    expect(game.standings.map(s=>({team:s.team.id,played:s.played,points:s.points,goalsFor:s.goalsFor}))).toEqual([{team:'home',played:1,points:3,goalsFor:2},{team:'away',played:1,points:0,goalsFor:0}]);
    expect((await engine.getGame(user,'r1')).selectedRoundId).toBe('r1');
  });
  it('shows a tied zero-game table from known league clubs until results are confirmed',async()=>{
    await match('a');const table=(await engine.getGame(user)).standings;
    expect(table).toHaveLength(2);expect(table.every(row=>row.position===1&&row.played===0&&row.points===0)).toBe(true);
  });
  it('creates audited manual fixtures with deduplicated clubs and closed draft markets',async()=>{
    const fixture={homeName:'Real Madrid',awayName:'FC Barcelona',kickoffAtUtc:tomorrow.toISOString(),roundId:'r1',stage:'league' as const,reason:'Official UEFA schedule'};
    await expect(engine.createManualMatch(fixture,other.id)).rejects.toMatchObject({status:403});
    const {id}=await engine.createManualMatch(fixture,user.id);
    expect(id).toMatch(/^manual-match-/);expect((await db.pool.query('SELECT status FROM markets WHERE match_id=$1',[id])).rows.map(row=>row.status)).toEqual(['draft','draft','draft']);
    await engine.createManualMatch({...fixture,homeName:'real madrid',awayName:'FC BARCELONA',kickoffAtUtc:nextDay.toISOString()},user.id);
    expect((await db.pool.query("SELECT count(*) FROM teams WHERE id LIKE 'manual-team-%'")).rows[0].count).toBe('2');
    await expect(engine.createManualMatch(fixture,user.id)).rejects.toMatchObject({code:'MATCH_EXISTS'});
    await expect(engine.createManualMatch({...fixture,kickoffAtUtc:new Date(0).toISOString()},user.id)).rejects.toMatchObject({status:400});
    await expect(engine.createManualMatch({...fixture,stage:'final'},user.id)).rejects.toMatchObject({status:400});
    expect((await engine.getAdmin()).fixtures).toHaveLength(2);
  });
  it('creates linked manual knockout legs and rejects incomplete or conflicting ties',async()=>{
    await db.pool.query("INSERT INTO rounds(id,season_id,name,stage,number,starts_at,ends_at) VALUES('knockout','ucl','First leg','playoff',9,$1,$2),('final-round','ucl','Final','final',17,$1,$2)",[tomorrow,nextDay]);
    const fixture={homeName:'Home FC',awayName:'Away FC',kickoffAtUtc:tomorrow.toISOString(),roundId:'knockout',stage:'playoff' as const,reason:'Verified knockout draw'};
    await expect(engine.createManualMatch(fixture,user.id)).rejects.toMatchObject({status:400});
    await expect(engine.createManualMatch({...fixture,leg:2},user.id)).rejects.toMatchObject({status:400});
    const first=await engine.createManualMatch({...fixture,leg:1},user.id);
    const tieId=(await db.pool.query('SELECT tie_id FROM matches WHERE id=$1',[first.id])).rows[0].tie_id;
    expect(tieId).toMatch(/^manual-tie-/);
    await expect(engine.createManualMatch({...fixture,kickoffAtUtc:nextDay.toISOString(),leg:2,tieId},user.id)).rejects.toMatchObject({code:'TIE_CONFLICT'});
    await expect(engine.createManualMatch({...fixture,homeName:'Away FC',awayName:'Home FC',leg:2,tieId},user.id)).rejects.toMatchObject({code:'TIE_CONFLICT'});
    const second=await engine.createManualMatch({...fixture,homeName:'Away FC',awayName:'Home FC',kickoffAtUtc:nextDay.toISOString(),leg:2,tieId},user.id);
    expect((await engine.getGame(user)).ties[0].matchIds).toEqual([first.id,second.id]);
    const finalFixture={...fixture,roundId:'final-round',stage:'final' as const,kickoffAtUtc:new Date(+nextDay+86400_000).toISOString()};
    await expect(engine.createManualMatch({...finalFixture,leg:1},user.id)).rejects.toMatchObject({status:400});
    await engine.createManualMatch(finalFixture,user.id);
    expect((await engine.getGame(user)).ties.map(tie=>tie.stage)).toEqual(['playoff','final']);
  });
  it('opens explicit manual odds atomically and permits only new draft side markets afterward',async()=>{
    const {id}=await engine.createManualMatch({homeName:'Real Madrid',awayName:'FC Barcelona',kickoffAtUtc:tomorrow.toISOString(),roundId:'r1',stage:'league',reason:'Official UEFA schedule'},user.id);
    const prices={matchId:id,home:2.1,draw:3.2,away:3.8,reason:'Agreed prices from bookmaker'};
    await expect(engine.setManualOdds({...prices,home:1},user.id)).rejects.toMatchObject({status:400});
    await expect(engine.setManualOdds(prices,other.id)).rejects.toMatchObject({status:403});
    await db.pool.query("UPDATE markets SET required=false WHERE match_id=$1",[id]);
    await engine.setManualOdds(prices,user.id);
    expect((await db.pool.query("SELECT required FROM markets WHERE match_id=$1 AND type='main_1x2'",[id])).rows[0].required).toBe(true);
    await expect(engine.setManualOdds({...prices,home:9},user.id)).rejects.toMatchObject({code:'MARKETS_ALREADY_OPEN'});
    let game=await engine.getGame(user,'r1');const main=game.matches[0].markets.find(market=>market.type==='main_1x2')!;
    const home=main.selections.find(selection=>selection.kind==='home_win')!;
    expect(home.decimalOdds).toBe(2.1);
    await engine.placeBets(user,[{marketId:main.id,selectionId:home.id,oddsSnapshotId:home.oddsSnapshotId,stake:100,requestId:randomUUID()}]);
    await engine.setManualOdds({...prices,home:9,exactScores:[{home:1,away:0,odds:8}],scorers:[{name:'Kylian Mbappé',odds:2.5}]},user.id);
    game=await engine.getGame(user,'r1');expect(game.matches[0].markets.every(market=>market.status==='open')).toBe(true);
    expect(game.matches[0].markets.find(market=>market.type==='main_1x2')!.selections.find(selection=>selection.kind==='home_win')!.decimalOdds).toBe(2.1);
    expect(game.matches[0].markets.find(market=>market.type==='anytime_goalscorer')!.selections[0].playerId).toBe(`player:${id}:kylian-mbappe`);
    await expect(engine.setManualOdds({...prices,exactScores:[{home:1,away:0,odds:9}]},user.id)).rejects.toMatchObject({code:'MARKETS_ALREADY_OPEN'});
    expect((await engine.getAdmin()).audit.filter(a=>a.action==='manual_odds_opened')).toHaveLength(2);
  });
  it('rejects duplicate manual selections and refuses draft markets with any bet history',async()=>{
    await match('a');await engine.placeBets(user,[input('a')]);
    await db.pool.query("UPDATE markets SET status='draft' WHERE id='a-market'");
    const prices={matchId:'a',home:2,draw:3,away:4,reason:'Manual odds review'};
    await expect(engine.setManualOdds(prices,user.id)).rejects.toMatchObject({code:'MARKET_HAS_BETS'});
    await expect(engine.setManualOdds({...prices,exactScores:[{home:1,away:0,odds:9},{home:1,away:0,odds:8}]},user.id)).rejects.toMatchObject({status:400});
    await expect(engine.setManualOdds({...prices,scorers:[{name:'Kylian Mbappé',odds:3},{name:'Kylian Mbappe',odds:4}]},user.id)).rejects.toMatchObject({status:400});
    expect((await db.pool.query("SELECT status FROM markets WHERE id='a-market'")).rows[0].status).toBe('draft');
  });
  it('audits allowed configuration updates and prevents retroactive starting balance edits',async()=>{
    const config={startingBalance:1000,dailyBonus:150,minimumStake:1,recoveryThreshold:500};
    await engine.updateConfig(config,user.id,'Agreed group rules');
    await expect(engine.updateConfig({...config,startingBalance:2000},user.id,'More starting coins')).rejects.toMatchObject({code:'STARTING_BALANCE_LOCKED'});
    await expect(engine.updateConfig(config,other.id,'Unauthorized change')).rejects.toMatchObject({status:403});
    expect((await engine.getAdmin()).audit[0].action).toBe('config_updated');
  });
});
