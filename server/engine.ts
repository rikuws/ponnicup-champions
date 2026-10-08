import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { pool, transaction, type Db } from './db';
import { playerIdentity } from './providers';
import type { AdminSnapshot, Award, Bet, BetInput, ClubStanding, Config, GameSnapshot, LeaderboardEntry, Match, ManualMatchInput, ManualOddsInput, ResultInput, Round, Season, Selection, SyncStatus, Team, Tie, User } from '../shared/contracts';

export class GameError extends Error {
  constructor(message: string, public status = 400, public code = 'INVALID_REQUEST') { super(message); }
}
const money = (value: unknown) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const iso = (value: string | Date) => new Date(value).toISOString();
export const helsinkiDate = (value: Date = new Date()) => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
const day = (value: string | Date) => typeof value === 'string' ? value.slice(0, 10) : `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
// A five-player league benefits from a single, short transaction queue. It keeps
// settlement, bonus allocation, and bet replacement in a consistent lock order.
async function lockGame(db: Db) { await db.query("SELECT pg_advisory_xact_lock(hashtext('ponnicup:game'))"); }
async function lockUser(db: Db, userId: string) {
  const row = (await db.query('SELECT id,pin_reset_required FROM users WHERE id=$1 FOR UPDATE', [userId])).rows[0];
  if (!row) throw new GameError('Pelaajaa ei löydy.', 401, 'UNAUTHORIZED');
  return row;
}
async function seasonRow(db: Db) {
  const row = process.env.SEASON_ID
    ? (await db.query('SELECT * FROM seasons WHERE id=$1', [process.env.SEASON_ID])).rows[0]
    : (await db.query('SELECT * FROM seasons ORDER BY game_start_at DESC LIMIT 1')).rows[0];
  if (!row) throw new GameError('Kautta ei ole vielä alustettu.', 503, 'NOT_INITIALIZED');
  return row;
}
async function bankroll(db: Db, userId: string, seasonId: string): Promise<number> {
  return money((await db.query('SELECT COALESCE(sum(amount),0) AS balance FROM ledger WHERE user_id=$1 AND season_id=$2', [userId, seasonId])).rows[0].balance);
}
async function ledger(db: Db, userId: string, seasonId: string, amount: number, type: string, betId: string | null = null) {
  if (amount === 0) return;
  await db.query('INSERT INTO ledger(user_id,season_id,amount,type,bet_id) VALUES ($1,$2,$3,$4,$5)', [userId, seasonId, money(amount), type, betId]);
}
function mapBet(row: Record<string, any>): Bet {
  return { id: row.id, marketId: row.market_id, selectionId: row.selection_id, stake: money(row.stake), bankrollStake: money(row.bankroll_stake), bonusStake: money(row.bonus_stake), decimalOdds: Number(row.decimal_odds), status: row.status, selectionLabel: row.label, payout: money(row.payout), userId: row.user_id, displayName: row.display_name };
}
const betSelect = `SELECT b.*,s.label,s.kind,s.score_home,s.score_away,s.player_id,o.decimal_odds,u.display_name,m.type,mt.date_finland,mt.kickoff_at
  FROM bets b JOIN selections s ON s.id=b.selection_id JOIN odds_snapshots o ON o.id=b.odds_snapshot_id
  JOIN users u ON u.id=b.user_id JOIN markets m ON m.id=b.market_id JOIN matches mt ON mt.id=m.match_id`;

async function bonusRow(db: Db, userId: string, seasonId: string, date: string) {
  return (await db.query('SELECT * FROM bonuses WHERE user_id=$1 AND season_id=$2 AND date=$3 FOR UPDATE', [userId, seasonId, date])).rows[0];
}
async function processBonusesInTransaction(db: Db, now: Date) {
  const today = helsinkiDate(now);
  const seasons = (await db.query('SELECT * FROM seasons ORDER BY game_start_at')).rows;
  const users = (await db.query('SELECT id FROM users ORDER BY id FOR UPDATE')).rows;
  for (const season of seasons) {
    const dates = (await db.query(`SELECT DISTINCT date_finland::text AS date FROM matches WHERE season_id=$1 AND kickoff_at >= $2
      AND date_finland <= $3 AND status NOT IN ('postponed','cancelled') ORDER BY date`, [season.id, season.game_start_at, today])).rows;
    for (const { date } of dates) {
      for (const user of users) {
        const granted = money(season.config.dailyBonus);
        const inserted = await db.query(`INSERT INTO bonuses(user_id,season_id,date,granted,available) VALUES ($1,$2,$3,$4,$4)
          ON CONFLICT DO NOTHING RETURNING user_id`, [user.id, season.id, date, granted]);
        if (inserted.rowCount) {
          let remaining = granted;
          const preplaced = (await db.query(`${betSelect} WHERE b.user_id=$1 AND b.season_id=$2 AND mt.date_finland=$3
            AND b.status IN ('placed','won','lost') AND b.bankroll_stake>0 ORDER BY b.created_at,b.id FOR UPDATE OF b`, [user.id, season.id, date])).rows;
          for (const bet of preplaced) {
            const allocation = Math.min(remaining, money(bet.bankroll_stake));
            if (allocation <= 0) break;
            await db.query('UPDATE bets SET bankroll_stake=bankroll_stake-$2,bonus_stake=bonus_stake+$2 WHERE id=$1', [bet.id, allocation]);
            await db.query('UPDATE bonuses SET available=available-$4,used=used+$4 WHERE user_id=$1 AND season_id=$2 AND date=$3', [user.id, season.id, date, allocation]);
            await ledger(db, user.id, season.id, allocation, 'bonus_funding_refund', bet.id);
            remaining = money(remaining - allocation);
          }
        }
      }
    }
    // Process outstanding earlier dates even if their fixtures were later cancelled.
    const oldPools = (await db.query('SELECT * FROM bonuses WHERE season_id=$1 AND date<$2 AND processed_at IS NULL ORDER BY date,user_id FOR UPDATE', [season.id, today])).rows;
    for (const bonus of oldPools) {
      const amount = money(bonus.available);
      const convert = (await bankroll(db, bonus.user_id, season.id)) < Number(season.config.recoveryThreshold);
      await db.query(`UPDATE bonuses SET available=0,converted=converted+$4,expired=expired+$5,processed_at=$6
        WHERE user_id=$1 AND season_id=$2 AND date=$3`, [bonus.user_id, season.id, day(bonus.date), convert ? amount : 0, convert ? 0 : amount, now]);
      if (convert) await ledger(db, bonus.user_id, season.id, amount, 'bonus_bankroll_conversion');
    }
  }
}
export async function processBonuses(now: Date = new Date()) {
  if (!Number.isFinite(+now)) throw new GameError('Virheellinen ajankohta.');
  await transaction(async (db) => { await lockGame(db); await processBonusesInTransaction(db, now); });
}

async function refundStake(db: Db, bet: Record<string, any>, cancellation: boolean) {
  const normal = money(bet.bankroll_stake);
  const bonus = money(bet.bonus_stake);
  await ledger(db, bet.user_id, bet.season_id, normal, cancellation ? 'bet_cancel_refund' : 'bet_void_refund', bet.id);
  let kind: string | null = null;
  if (bonus > 0) {
    const pool = await bonusRow(db, bet.user_id, bet.season_id, day(bet.date_finland));
    if (!pool) throw new Error(`Missing bonus funding for bet ${bet.id}`);
    kind = pool.processed_at ? 'expired' : 'available';
    await db.query(`UPDATE bonuses SET used=used-$4,${kind}=${kind}+$4 WHERE user_id=$1 AND season_id=$2 AND date=$3`, [bet.user_id, bet.season_id, day(bet.date_finland), bonus]);
  }
  return { normal, bonus, kind };
}

function validateRequestId(value: unknown) {
  if (typeof value !== 'string' || value.length < 8 || value.length > 128) throw new GameError('Pyynnön tunniste puuttuu.', 400, 'INVALID_REQUEST_ID');
}
export async function placeBets(user: User, inputs: BetInput[]): Promise<Bet[]> {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 100) throw new GameError('Valitse 1–100 vetoa.');
  const marketIds = new Set<string>(); const requestIds = new Set<string>();
  for (const input of inputs) {
    if (!input || typeof input.marketId !== 'string' || typeof input.selectionId !== 'string' || typeof input.oddsSnapshotId !== 'string') throw new GameError('Vedon tiedot puuttuvat.');
    validateRequestId(input.requestId);
    if (marketIds.has(input.marketId) || requestIds.has(input.requestId)) throw new GameError('Sama kohde tai pyyntö on mukana kahdesti.');
    if (!Number.isFinite(input.stake) || input.stake <= 0 || input.stake > 100_000_000 || Math.abs(input.stake * 100 - Math.round(input.stake * 100)) > 0.000001) throw new GameError('Panos pitää antaa enintään kahden desimaalin tarkkuudella.', 400, 'INVALID_STAKE');
    marketIds.add(input.marketId); requestIds.add(input.requestId);
  }
  return transaction(async (db) => {
    await lockGame(db);
    const actualUser = await lockUser(db, user.id);
    if (actualUser.pin_reset_required) throw new GameError('Vaihda ensin aloitus-PIN.', 403, 'PIN_RESET_REQUIRED');
    await processBonusesInTransaction(db, new Date());
    const season = await seasonRow(db);
    const output: Bet[] = new Array(inputs.length);
    const prepared: { input: BetInput; target: Record<string, any>; requestHash: string; index: number }[] = [];
    for (const [index, input] of inputs.entries()) {
      const requestHash = fingerprint({ operation: 'place', marketId: input.marketId, selectionId: input.selectionId, oddsSnapshotId: input.oddsSnapshotId, stake: input.stake });
      const previous = (await db.query('SELECT * FROM idempotency WHERE user_id=$1 AND request_id=$2', [user.id, input.requestId])).rows[0];
      if (previous) {
        if (previous.request_hash !== requestHash) throw new GameError('Pyynnön tunnistetta on jo käytetty eri vedolle.', 409, 'IDEMPOTENCY_CONFLICT');
        output[index] = previous.response as Bet; continue;
      }
      const target = (await db.query(`SELECT m.*,mt.kickoff_at,mt.date_finland,mt.status AS match_status,mt.season_id,s.id AS selection_id,
        o.id AS odds_id,o.decimal_odds FROM markets m JOIN matches mt ON mt.id=m.match_id
        JOIN selections s ON s.market_id=m.id AND s.id=$2 JOIN odds_snapshots o ON o.selection_id=s.id AND o.id=$3
        WHERE m.id=$1 FOR UPDATE OF m,mt`, [input.marketId, input.selectionId, input.oddsSnapshotId])).rows[0];
      if (!target) throw new GameError('Kohdetta tai kerrointa ei löydy.', 404, 'MARKET_NOT_FOUND');
      if (target.season_id !== season.id || +new Date(target.kickoff_at) < +new Date(season.game_start_at)) throw new GameError('Ottelu ei kuulu pelattavaan kauteen.', 409, 'INELIGIBLE_MATCH');
      if (target.status !== 'open' || target.match_status !== 'scheduled' || +new Date(target.kickoff_at) <= Date.now()) throw new GameError('Ottelu on jo lukittu.', 409, 'MARKET_LOCKED');
      const latest = (await db.query('SELECT id FROM odds_snapshots WHERE selection_id=$1 ORDER BY captured_at DESC,id DESC LIMIT 1', [input.selectionId])).rows[0];
      if (latest.id !== input.oddsSnapshotId) throw new GameError('Kerroin muuttui. Päivitä kohteet ja tarkista vetosi.', 409, 'ODDS_CHANGED');
      if (input.stake < Number(season.config.minimumStake)) throw new GameError(`Minimipanos on ${season.config.minimumStake}.`, 400, 'MINIMUM_STAKE');
      const existing = (await db.query(`${betSelect} WHERE b.user_id=$1 AND b.market_id=$2 AND b.status<>'cancelled' FOR UPDATE OF b`, [user.id, input.marketId])).rows[0];
      if (existing) {
        if (existing.status !== 'placed') throw new GameError('Ratkennutta vetoa ei voi vaihtaa.', 409, 'MARKET_LOCKED');
        await refundStake(db, existing, true);
        await db.query("UPDATE bets SET status='cancelled',settled_at=now() WHERE id=$1", [existing.id]);
      }
      prepared.push({input,target,requestHash,index});
    }
    // Release every replaced stake first, so a valid batch can redistribute its
    // own existing funds without depending on the order of the selected matches.
    for (const {input,target,requestHash,index} of prepared) {
      if (+new Date(target.kickoff_at) <= Date.now()) throw new GameError('Ottelu on jo lukittu.',409,'MARKET_LOCKED');
      const bonus = await bonusRow(db, user.id, season.id, day(target.date_finland));
      const bonusStake = bonus && !bonus.processed_at ? Math.min(input.stake, money(bonus.available)) : 0;
      const normalStake = money(input.stake - bonusStake);
      if (normalStake > Math.max(0, await bankroll(db, user.id, season.id))) throw new GameError('Kolikot eivät riitä. Yhtään tämän lähetyksen vetoa ei muutettu.', 409, 'INSUFFICIENT_FUNDS');
      const id = randomUUID();
      await db.query('INSERT INTO bets(id,user_id,season_id,market_id,selection_id,odds_snapshot_id,stake,bankroll_stake,bonus_stake) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id,user.id,season.id,input.marketId,input.selectionId,input.oddsSnapshotId,input.stake,normalStake,bonusStake]);
      await ledger(db,user.id,season.id,-normalStake,'bet_stake',id);
      if (bonusStake) await db.query('UPDATE bonuses SET available=available-$4,used=used+$4 WHERE user_id=$1 AND season_id=$2 AND date=$3',[user.id,season.id,day(target.date_finland),bonusStake]);
      const created = mapBet((await db.query(`${betSelect} WHERE b.id=$1`, [id])).rows[0]);
      await db.query('INSERT INTO idempotency(user_id,request_id,request_hash,response) VALUES ($1,$2,$3,$4)', [user.id,input.requestId,requestHash,JSON.stringify(created)]);
      output[index] = created;
    }
    return output;
  });
}
export async function cancelBet(user: User, betId: string, requestId: string): Promise<void> {
  validateRequestId(requestId);
  await transaction(async (db) => {
    await lockGame(db); await lockUser(db,user.id);
    const requestHash = fingerprint({ operation:'cancel',betId });
    const previous = (await db.query('SELECT request_hash FROM idempotency WHERE user_id=$1 AND request_id=$2',[user.id,requestId])).rows[0];
    if (previous) { if (previous.request_hash !== requestHash) throw new GameError('Pyynnön tunniste on jo käytetty.',409,'IDEMPOTENCY_CONFLICT'); return; }
    const bet = (await db.query(`${betSelect} WHERE b.id=$1 AND b.user_id=$2 FOR UPDATE OF b,mt,m`,[betId,user.id])).rows[0];
    if (!bet) throw new GameError('Vetoa ei löydy.',404,'BET_NOT_FOUND');
    if (+new Date(bet.kickoff_at)<=Date.now() || bet.status!=='placed') throw new GameError('Veto on jo lukittu.',409,'MARKET_LOCKED');
    await refundStake(db,bet,true);
    await db.query("UPDATE bets SET status='cancelled',settled_at=now() WHERE id=$1",[betId]);
    await db.query('INSERT INTO idempotency(user_id,request_id,request_hash,response) VALUES ($1,$2,$3,$4)',[user.id,requestId,requestHash,'{}']);
  });
}

// Reclaim a refunded bonus during a result correction. If that refund was
// already reused, move the newer funded bets back to ordinary bankroll. A
// correction may legitimately create a negative balance; it must never mint money.
async function retractBonusRefund(db: Db, bet: Record<string, any>) {
  let remaining = money(bet.settlement_bonus);
  if (remaining <= 0) return;
  const bonus = await bonusRow(db,bet.user_id,bet.season_id,day(bet.date_finland));
  if (!bonus) throw new Error('Missing bonus during settlement correction');
  const deductions = { available:0, expired:0, converted:0 };
  for (const key of ['available','expired','converted'] as const) {
    deductions[key] = Math.min(remaining,money(bonus[key]));
    remaining = money(remaining-deductions[key]);
  }
  if (deductions.converted) await ledger(db,bet.user_id,bet.season_id,-deductions.converted,'bonus_conversion_correction',bet.id);
  let reclassified = 0;
  if (remaining > 0) {
    const funded = (await db.query(`${betSelect} WHERE b.user_id=$1 AND b.season_id=$2 AND mt.date_finland=$3 AND b.id<>$4
      AND b.status IN ('placed','won','lost') AND b.bonus_stake>0 ORDER BY b.created_at DESC,b.id DESC FOR UPDATE OF b`,[bet.user_id,bet.season_id,day(bet.date_finland),bet.id])).rows;
    for (const other of funded) {
      const amount = Math.min(remaining,money(other.bonus_stake));
      await db.query('UPDATE bets SET bonus_stake=bonus_stake-$2,bankroll_stake=bankroll_stake+$2 WHERE id=$1',[other.id,amount]);
      await ledger(db,bet.user_id,bet.season_id,-amount,'bonus_funding_correction',other.id);
      remaining=money(remaining-amount); reclassified=money(reclassified+amount);
      if (!remaining) break;
    }
  }
  if (remaining > 0) throw new Error('Cannot reconcile refunded bonus funding');
  await db.query(`UPDATE bonuses SET available=available-$4,expired=expired-$5,converted=converted-$6,used=used+$7
    WHERE user_id=$1 AND season_id=$2 AND date=$3`,[bet.user_id,bet.season_id,day(bet.date_finland),deductions.available,deductions.expired,deductions.converted,money(bet.settlement_bonus)-reclassified]);
}
async function undoSettlement(db: Db, bet: Record<string, any>) {
  if (bet.status==='placed') return;
  await ledger(db,bet.user_id,bet.season_id,-money(bet.settlement_bankroll),'result_correction',bet.id);
  await retractBonusRefund(db,bet);
  await db.query("UPDATE bets SET status='placed',payout=0,settlement_bankroll=0,settlement_bonus=0,settlement_bonus_kind=NULL,settled_at=NULL WHERE id=$1",[bet.id]);
}
function validateResult(input: ResultInput) {
  if (!input || typeof input.matchId!=='string' || !['scheduled','live','final','postponed','cancelled'].includes(input.status)) throw new GameError('Virheellinen ottelutulos.');
  reasonInput(input.reason);
  if (input.matchId.length<1 || input.matchId.length>200 || input.matchId.includes('\u0000')) throw new GameError('Virheellinen ottelun tunniste.');
  if ((input.scorerDataComplete!==undefined && typeof input.scorerDataComplete!=='boolean') || (input.releaseOverride!==undefined && typeof input.releaseOverride!=='boolean')) throw new GameError('Tuloksen vahvistuksen pitää olla kyllä tai ei.');
  for (const score of [input.homeScore,input.awayScore,input.homeScoreFinal,input.awayScoreFinal]) {
    if (score!==null && score!==undefined && (!Number.isInteger(score) || score<0 || score>100)) throw new GameError('Maalimäärän pitää olla kokonaisluku 0–100.');
  }
  if (input.status==='final' && (input.homeScore===null || input.homeScore===undefined || input.awayScore===null || input.awayScore===undefined)) throw new GameError('Lopputulos tarvitsee molempien joukkueiden 90 minuutin maalimäärät.');
  for (const ids of [input.scorerPlayerIds,input.appearedPlayerIds,input.registeredPlayerIds]) {
    if (ids!==undefined && (!Array.isArray(ids) || ids.length>200 || ids.some(id=>typeof id!=='string' || id.length<1 || id.length>200 || id.includes('\u0000')))) throw new GameError('Virheelliset maalintekijätiedot.');
  }
  if (input.scorerDataComplete && (input.appearedPlayerIds===undefined || input.scorerPlayerIds===undefined)) throw new GameError('Valmis maalintekijätieto vaatii myös pelanneiden listan.');
  if ((input.homeScoreFinal!=null)!==(input.awayScoreFinal!=null)) throw new GameError('Anna jatkoajan tulokseen molempien joukkueiden maalimäärät.');
  if (input.status==='final' && input.homeScoreFinal!=null && input.awayScoreFinal!=null && (input.homeScoreFinal<input.homeScore! || input.awayScoreFinal<input.awayScore!)) throw new GameError('Jatkoajan tulos ei voi olla pienempi kuin 90 minuutin tulos.');
  if (input.scorerDataComplete && input.scorerPlayerIds!.some(id=>!input.appearedPlayerIds!.includes(id))) throw new GameError('Maalintekijän pitää olla myös pelanneiden listalla.');
  if (input.scorerDataComplete && input.status==='final' && new Set(input.scorerPlayerIds).size>input.homeScore!+input.awayScore!) throw new GameError('Maalintekijöitä on enemmän kuin varsinaisen peliajan maaleja.');
}
export async function applyResult(input: ResultInput, actorId?: string): Promise<void> {
  validateResult(input);
  const final=input.status==='final';const scored=final||input.status==='live';
  const normalized = { status:input.status,homeScore:scored?input.homeScore:null,awayScore:scored?input.awayScore:null,homeScoreFinal:final?(input.homeScoreFinal??null):null,awayScoreFinal:final?(input.awayScoreFinal??null):null,
    advancingTeamId:final?(input.advancingTeamId??null):null,scorerPlayerIds:final?[...new Set(input.scorerPlayerIds??[])].sort():[],appearedPlayerIds:final?[...new Set(input.appearedPlayerIds??[])].sort():[],registeredPlayerIds:final?[...new Set(input.registeredPlayerIds??[])].sort():[],scorerDataComplete:final&&(input.scorerDataComplete??false) };
  const hash=fingerprint(normalized);
  await transaction(async (db)=>{
    await lockGame(db);
    const match=(await db.query('SELECT * FROM matches WHERE id=$1 FOR UPDATE',[input.matchId])).rows[0];
    if (!match) throw new GameError('Ottelua ei löydy.',404,'MATCH_NOT_FOUND');
    if (input.advancingTeamId && ![match.home_team_id,match.away_team_id].includes(input.advancingTeamId)) throw new GameError('Jatkoon menijän pitää pelata tässä ottelussa.');
    if (actorId) {
      const actor=(await db.query('SELECT role FROM users WHERE id=$1',[actorId])).rows[0];
      if(actor?.role!=='admin')throw new GameError('Vain ylläpitäjälle.',403,'FORBIDDEN');
    } else if (match.result_override) return;
    const override=!!actorId && !input.releaseOverride;
    if (match.result_fingerprint===hash) {
      // Repair a scheduled market left locked by an older result import without
      // requiring a made-up score change or rewriting its immutable prices.
      if(normalized.status==='scheduled'&&+new Date(match.kickoff_at)>Date.now())await db.query(`UPDATE markets m SET status=CASE WHEN EXISTS(SELECT 1 FROM selections s JOIN odds_snapshots o ON o.selection_id=s.id WHERE s.market_id=m.id) THEN 'open' ELSE 'draft' END WHERE m.match_id=$1 AND m.status='locked'`,[input.matchId]);
      if(match.result_override!==override) {
        await db.query('UPDATE matches SET result_override=$2 WHERE id=$1',[input.matchId,override]);
        await db.query('INSERT INTO audit_log(actor_id,action,reason,detail) VALUES ($1,$2,$3,$4)',[actorId??null,override?'result_override_enabled':'result_override_released',input.reason.trim(),JSON.stringify({matchId:input.matchId})]);
      }
      return;
    }
    // Bonus grants precede results, including a delayed importer after an outage.
    await processBonusesInTransaction(db,new Date());
    await db.query(`UPDATE matches SET status=$2,home_score=$3,away_score=$4,home_score_final=$5,away_score_final=$6,
      advancing_team_id=$7,scorer_player_ids=$8,appeared_player_ids=$9,registered_player_ids=$10,scorer_data_complete=$11,result_fingerprint=$12,result_override=$13 WHERE id=$1`,
      [input.matchId,normalized.status,normalized.homeScore,normalized.awayScore,normalized.homeScoreFinal,normalized.awayScoreFinal,normalized.advancingTeamId,normalized.scorerPlayerIds,normalized.appearedPlayerIds,normalized.registeredPlayerIds,normalized.scorerDataComplete,hash,override]);
    // A winner verified against the old first-leg result is no longer evidence
    // of progression after that result changes. Re-importing the deciding leg
    // can establish it again, including when its own score did not change.
    if (match.tie_id && match.leg===1 && (match.status!==normalized.status || match.home_score!==normalized.homeScore || match.away_score!==normalized.awayScore || match.home_score_final!==normalized.homeScoreFinal || match.away_score_final!==normalized.awayScoreFinal)) {
      await db.query('UPDATE matches SET advancing_team_id=NULL,result_fingerprint=NULL WHERE season_id=$1 AND tie_id=$2 AND id<>$3 AND advancing_team_id IS NOT NULL',[match.season_id,match.tie_id,match.id]);
    }
    const markets=(await db.query('SELECT * FROM markets WHERE match_id=$1 ORDER BY id FOR UPDATE',[input.matchId])).rows;
    for (const market of markets) {
      const bets=(await db.query(`${betSelect} WHERE b.market_id=$1 AND b.status<>'cancelled' ORDER BY b.user_id,b.id FOR UPDATE OF b`,[market.id])).rows;
      let pending=false;
      for (const original of bets) {
        await lockUser(db,original.user_id);
        await undoSettlement(db,original);
        // A preceding correction can reclassify funding on another bet.
        const bet=(await db.query(`${betSelect} WHERE b.id=$1`,[original.id])).rows[0];
        let outcome:'won'|'lost'|'voided'|null=null;
        if (input.status==='cancelled') outcome='voided';
        else if (input.status==='final') {
          if (market.type==='main_1x2') outcome=(bet.kind==='home_win' && input.homeScore!>input.awayScore!) || (bet.kind==='away_win' && input.awayScore!>input.homeScore!) || (bet.kind==='draw' && input.homeScore===input.awayScore) ? 'won':'lost';
          else if (market.type==='exact_score') outcome=bet.score_home===input.homeScore && bet.score_away===input.awayScore ? 'won':'lost';
          else if (normalized.scorerDataComplete) {
            if (normalized.scorerPlayerIds.includes(bet.player_id)) outcome='won';
            else if (normalized.appearedPlayerIds.includes(bet.player_id)) outcome='lost';
            else if (normalized.registeredPlayerIds.includes(bet.player_id)) outcome='voided';
          }
        }
        if (!outcome) { pending=true; continue; }
        let payout=0, credited=0, refundedBonus=0; let refundKind:string|null=null;
        if (outcome==='won') {
          payout=money(Number(bet.stake)*Number(bet.decimal_odds)); credited=payout;
          await ledger(db,bet.user_id,bet.season_id,payout,'bet_payout',bet.id);
        } else if (outcome==='voided') {
          const refund=await refundStake(db,bet,false);
          credited=refund.normal; refundedBonus=refund.bonus; refundKind=refund.kind;
          payout=money(credited+(refund.kind==='available'?refundedBonus:0));
        }
        await db.query('UPDATE bets SET status=$2,payout=$3,settlement_bankroll=$4,settlement_bonus=$5,settlement_bonus_kind=$6,settled_at=now() WHERE id=$1',[bet.id,outcome,payout,credited,refundedBonus,refundKind]);
      }
      // Even a market with no bets stays pending when its data is incomplete.
      if (market.type==='anytime_goalscorer' && input.status==='final' && !normalized.scorerDataComplete) pending=true;
      const hasPrices=(await db.query('SELECT EXISTS(SELECT 1 FROM selections s JOIN odds_snapshots o ON o.selection_id=s.id WHERE s.market_id=$1) AS present',[market.id])).rows[0].present;
      const marketStatus=input.status==='cancelled'?'voided':input.status==='final' && !pending?'settled':input.status==='scheduled'&&+new Date(match.kickoff_at)>Date.now()?(hasPrices?'open':'draft'):market.status==='draft'?'draft':'locked';
      await db.query('UPDATE markets SET status=$2 WHERE id=$1',[market.id,marketStatus]);
    }
    await db.query('INSERT INTO audit_log(actor_id,action,reason,detail) VALUES ($1,$2,$3,$4)',[actorId??null,'match_result',input.reason.trim(),JSON.stringify({matchId:input.matchId,before:{status:match.status,homeScore:match.home_score,awayScore:match.away_score},after:normalized,resultOverride:override})]);
  });
}
export async function updateConfig(config: Config, actorId: string, reason: string) {
  if (typeof reason!=='string' || reason.trim().length<3 || reason.length>2000) throw new GameError('Anna sääntömuutokselle perustelu.');
  const keys=['startingBalance','dailyBonus','minimumStake','recoveryThreshold'] as const;
  if (!config || keys.some(key=>!Number.isFinite(config[key]) || config[key]<0 || config[key]>100_000_000 || money(config[key])!==config[key]) || config.minimumStake<0.01) throw new GameError('Sääntöjen summat eivät kelpaa.');
  const clean:Config={startingBalance:config.startingBalance,dailyBonus:config.dailyBonus,minimumStake:config.minimumStake,recoveryThreshold:config.recoveryThreshold};
  await transaction(async db=>{
    await lockGame(db);
    const actor=(await db.query('SELECT role FROM users WHERE id=$1',[actorId])).rows[0];
    if (actor?.role!=='admin') throw new GameError('Vain ylläpitäjälle.',403,'FORBIDDEN');
    const season=await seasonRow(db);
    if (clean.startingBalance!==Number(season.config.startingBalance)) throw new GameError('Aloituskassaa ei voi muuttaa kesken kauden. Aloita tarvittaessa uusi kausi.',409,'STARTING_BALANCE_LOCKED');
    await db.query('UPDATE seasons SET config=$2 WHERE id=$1',[season.id,JSON.stringify(clean)]);
    await db.query('INSERT INTO audit_log(actor_id,action,reason,detail) VALUES ($1,$2,$3,$4)',[actorId,'config_updated',reason.trim(),JSON.stringify({before:season.config,after:clean})]);
  });
}
export async function getPlayers():Promise<User[]> {
  return (await pool.query('SELECT id,display_name,role,pin_reset_required FROM users ORDER BY created_at,id')).rows.map(row=>({id:row.id,displayName:row.display_name,role:row.role,pinResetRequired:row.pin_reset_required}));
}
function mapSync(rows:Record<string,any>[]):SyncStatus[] {
  return rows.map(row=>({provider:row.provider,lastSuccessAt:row.last_success_at?iso(row.last_success_at):null,lastError:row.last_error,enabled:row.enabled}));
}
export async function getAdmin():Promise<AdminSnapshot> {
  const season=await seasonRow(pool);
  const sync=(await pool.query('SELECT * FROM sync_status ORDER BY provider')).rows;
  const audit=(await pool.query('SELECT a.*,u.display_name FROM audit_log a LEFT JOIN users u ON u.id=a.actor_id ORDER BY a.created_at DESC,a.id DESC LIMIT 100')).rows;
  const fixtures=(await pool.query(`SELECT m.*,h.name AS home,a.name AS away FROM matches m JOIN teams h ON h.id=m.home_team_id JOIN teams a ON a.id=m.away_team_id
    WHERE m.season_id=$1 ORDER BY m.kickoff_at,m.id LIMIT 250`,[season.id])).rows;
  const pending=(await pool.query(`SELECT m.*,h.name AS home,a.name AS away FROM matches m JOIN teams h ON h.id=m.home_team_id JOIN teams a ON a.id=m.away_team_id
    JOIN seasons s ON s.id=m.season_id WHERE m.season_id=$1 AND m.kickoff_at<=now() AND m.kickoff_at>=s.game_start_at AND m.status<>'cancelled'
    AND (m.status<>'final' OR EXISTS (SELECT 1 FROM markets mk WHERE mk.match_id=m.id AND mk.status='locked')) ORDER BY m.kickoff_at DESC LIMIT 100`,[season.id])).rows;
  const mapMatch=(row:Record<string,any>)=>({id:row.id,home:row.home,away:row.away,kickoffAtUtc:iso(row.kickoff_at),homeScore:row.home_score as number|null,awayScore:row.away_score as number|null});
  return {fixtures:fixtures.map(row=>({...mapMatch(row),status:row.status,roundId:row.round_id})),sync:mapSync(sync),audit:audit.map(row=>({id:row.id,actor:row.display_name??null,action:row.action,reason:row.reason,createdAt:iso(row.created_at)})),pendingMatches:pending.map(mapMatch)};
}

function mapTeam(row:Record<string,any>):Team { return {id:row.id,name:row.name,shortName:row.short_name,crest:row.crest??null}; }
function awardRows(bets:Record<string,any>[],matches:Record<string,any>[],markets:Record<string,any>[],users:User[],season:Season):Award[] {
  const names=new Map(users.map(user=>[user.id,user.displayName]));
  const settled=bets.filter(bet=>bet.status==='won'||bet.status==='lost');
  function countBy(rows:Record<string,any>[],weight:(bet:Record<string,any>)=>number=()=>1) {
    const counts=new Map<string,number>(); for(const row of rows) counts.set(row.user_id,(counts.get(row.user_id)??0)+weight(row));
    return [...counts].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0]));
  }
  function make(id:string,title:string,description:string,winner:[string,number]|undefined,unit=''):Award {
    return {id,title,description,playerName:winner?names.get(winner[0])??null:null,value:winner?`${money(winner[1])}${unit}`:'—'};
  }
  const exact=settled.filter(bet=>bet.type==='exact_score');
  const matchMap=new Map(matches.map(match=>[match.id,match]));
  const marketMatch=new Map(markets.map(market=>[market.id,matchMap.get(market.match_id)]));
  const close=exact.filter(bet=>{const match=marketMatch.get(bet.market_id);return bet.status==='lost' && match && Math.abs(bet.score_home-match.home_score)+Math.abs(bet.score_away-match.away_score)===1;});
  const deadline=settled.filter(bet=>bet.status==='won').map(bet=>[bet.user_id,Math.max(0,Math.round((+new Date(bet.kickoff_at)-+new Date(bet.created_at))/1000))] as [string,number]).sort((a,b)=>a[1]-b[1]);
  const panic=bets.filter(bet=>bet.status!=='cancelled' && +new Date(bet.kickoff_at)<=Date.now() && +new Date(bet.kickoff_at)-+new Date(bet.created_at)<=15*60_000);
  const largest=(rows:Record<string,any>[])=>rows.map(row=>[row.user_id,Number(row.stake)] as [string,number]).sort((a,b)=>b[1]-a[1])[0];
  const teamReturns=new Map<string,{userId:string;stake:number;payout:number}>();
  for(const bet of settled.filter(b=>b.type==='main_1x2' && b.kind!=='draw')) {
    const match=marketMatch.get(bet.market_id);if(!match)continue;
    const teamId=bet.kind==='home_win'?match.home_team_id:match.away_team_id;
    const key=`${bet.user_id}:${teamId}`;
    const record=teamReturns.get(key)??{userId:bet.user_id,stake:0,payout:0};
    record.stake+=Number(bet.stake);record.payout+=Number(bet.payout);teamReturns.set(key,record);
  }
  const worst=[...teamReturns.values()].map(row=>[row.userId,(row.payout/row.stake-1)*100] as [string,number]).sort((a,b)=>a[1]-b[1])[0];
  const forgotten=new Map<string,number>();
  const dates=[...new Set(matches.filter(match=>+new Date(match.kickoff_at)>=+new Date(season.gameStartAt)).map(match=>day(match.date_finland)))];
  for(const date of dates) {
    const playing=matches.filter(match=>day(match.date_finland)===date && +new Date(match.kickoff_at)>=+new Date(season.gameStartAt) && match.status!=='cancelled' && match.status!=='postponed');
    if(!playing.length || playing.some(match=>match.status!=='final'))continue;
    const ids=new Set(playing.map(match=>match.id));
    const required=markets.filter(market=>ids.has(market.match_id) && market.required && market.status!=='draft');
    for(const user of users) if(required.some(market=>!bets.some(bet=>bet.user_id===user.id && bet.market_id===market.id && bet.status!=='cancelled'))) forgotten.set(user.id,(forgotten.get(user.id)??0)+1);
  }
  return [
    make('prophet','Group Chat Prophet','Eniten oikein veikattuja tarkkoja tuloksia.',countBy(exact.filter(b=>b.status==='won'))[0],' osumaa'),
    make('almost','Almost Had It FC','Tarkka tulos jäi yhden maalin päähän.',countBy(close)[0],' kertaa'),
    make('deadline','Deadline Merchant','Voittava veto lähimpänä aloituspotkua.',deadline[0],' s ennen'),
    make('panic','Panic Button Merchant','Vetoja viimeisen 15 minuutin aikana.',countBy(panic)[0],' vetoa'),
    make('allin','All-In Regret','Suurin hävitty panos.',largest(settled.filter(b=>b.status==='lost')),' kolikkoa'),
    make('diamond','Diamond Hands','Suurin voittava panos vähintään kertoimella 3.',largest(settled.filter(b=>b.status==='won' && Number(b.decimal_odds)>=3)),' kolikkoa'),
    make('heart','Heart Over Head FC','Heikoin tuotto yhden seuran voittoveikkauksissa.',worst,'%'),
    make('forgot','Forgot The Assignment','Valmiita peli-iltoja, joista puuttui pääveto.',[...forgotten].sort((a,b)=>b[1]-a[1])[0],' iltaa'),
  ];
}
export async function getGame(user:User,roundId?:string):Promise<GameSnapshot> {
  await processBonuses();
  return transaction(async db=>{
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const row=await seasonRow(db);
    const season:Season={id:row.id,name:row.name,competition:row.competition,gameStartAt:iso(row.game_start_at),config:row.config};
    const serverTime=new Date().toISOString(); const now=+new Date(serverTime);
    const rounds:Round[]=(await db.query('SELECT * FROM rounds WHERE season_id=$1 ORDER BY starts_at,number,id',[season.id])).rows.map(round=>({id:round.id,name:round.name,stage:round.stage,number:round.number,startsAt:iso(round.starts_at),endsAt:iso(round.ends_at)}));
    const eligibleRounds=rounds.filter(round=>+new Date(round.endsAt)>=+new Date(season.gameStartAt));
    const selectedRoundId=rounds.some(round=>round.id===roundId)?roundId!:(eligibleRounds.find(round=>+new Date(round.endsAt)+6*60*60_000>=now)??eligibleRounds.at(-1)??rounds[0])?.id??null;
    const teams=new Map((await db.query('SELECT * FROM teams')).rows.map(team=>[team.id,mapTeam(team)]));
    const matchRows=(await db.query('SELECT * FROM matches WHERE season_id=$1 ORDER BY kickoff_at,id',[season.id])).rows;
    const marketRows=(await db.query('SELECT m.* FROM markets m JOIN matches mt ON mt.id=m.match_id WHERE mt.season_id=$1 ORDER BY m.required DESC,m.type,m.id',[season.id])).rows;
    const selectionRows=(await db.query(`SELECT s.*,o.id AS odds_id,o.decimal_odds FROM selections s JOIN markets m ON m.id=s.market_id JOIN matches mt ON mt.id=m.match_id
      JOIN LATERAL(SELECT * FROM odds_snapshots WHERE selection_id=s.id ORDER BY captured_at DESC,id DESC LIMIT 1)o ON true WHERE mt.season_id=$1 ORDER BY s.id`,[season.id])).rows;
    const betRows=(await db.query(`${betSelect} WHERE b.season_id=$1 ORDER BY b.created_at,b.id`,[season.id])).rows;
    const users:User[]=(await db.query('SELECT id,display_name,role,pin_reset_required FROM users ORDER BY created_at,id')).rows.map(u=>({id:u.id,displayName:u.display_name,role:u.role,pinResetRequired:u.pin_reset_required}));
    const actualUser=users.find(u=>u.id===user.id);
    if(!actualUser)throw new GameError('Pelaajaa ei löydy.',401,'UNAUTHORIZED');
    const balances=new Map((await db.query('SELECT user_id,COALESCE(sum(amount),0) AS amount FROM ledger WHERE season_id=$1 GROUP BY user_id',[season.id])).rows.map(balance=>[balance.user_id,money(balance.amount)]));
    const settledNets=new Map((await db.query(`SELECT l.user_id,COALESCE(sum(l.amount),0) AS amount FROM ledger l JOIN bets b ON b.id=l.bet_id
      WHERE l.season_id=$1 AND b.status IN ('won','lost','voided') GROUP BY l.user_id`,[season.id])).rows.map(net=>[net.user_id,money(net.amount)]));
    const leaderboard:LeaderboardEntry[]=users.map(u=>{
      const bets=betRows.filter(b=>b.user_id===u.id);
      const bankroll=balances.get(u.id)??0;const openStake=money(bets.filter(b=>b.status==='placed').reduce((sum,b)=>sum+Number(b.bankroll_stake),0));
      return {userId:u.id,displayName:u.displayName,rank:0,bankroll,openStake,total:money(bankroll+openStake),won:bets.filter(b=>b.status==='won').length,lost:bets.filter(b=>b.status==='lost').length,
        settledNet:settledNets.get(u.id)??0,scorerHits:bets.filter(b=>b.type==='anytime_goalscorer'&&b.status==='won').length,
        recent:bets.filter(b=>['won','lost','voided'].includes(b.status)).sort((a,b)=>+new Date(b.settled_at)-+new Date(a.settled_at)||b.id.localeCompare(a.id)).slice(0,8).map(b=>b.status)};
    }).sort((a,b)=>b.total-a.total||a.displayName.localeCompare(b.displayName));
    leaderboard.forEach((entry,index)=>{entry.rank=index>0&&entry.total===leaderboard[index-1].total?leaderboard[index-1].rank:index+1;});
    const own=leaderboard.find(entry=>entry.userId===user.id)!;
    const bonusRows=(await db.query('SELECT * FROM bonuses WHERE user_id=$1 AND season_id=$2 ORDER BY date DESC',[user.id,season.id])).rows;
    const matches:Match[]=matchRows.filter(match=>match.round_id===selectedRoundId).map(match=>{
      const locked=+new Date(match.kickoff_at)<=now;
      const markets=marketRows.filter(market=>market.match_id===match.id).map(market=>{
        const bets=betRows.filter(bet=>bet.market_id===market.id&&bet.status!=='cancelled');
        const current=bets.find(bet=>bet.user_id===user.id);
        const selections:Selection[]=selectionRows.filter(selection=>selection.market_id===market.id).map(s=>({id:s.id,label:s.label,oddsSnapshotId:s.odds_id,decimalOdds:Number(s.decimal_odds),kind:s.kind,
          ...(s.score_home!==null?{scoreHome:s.score_home}:{}),...(s.score_away!==null?{scoreAway:s.score_away}:{}),...(s.player_id?{playerId:s.player_id}:{})}));
        return {id:market.id,type:market.type,status:locked&&market.status==='open'?'locked':market.status,required:market.required,selections,userBet:current?mapBet(current):null,revealedBets:locked?bets.map(mapBet):[]};
      });
      return {id:match.id,roundId:match.round_id,homeTeam:teams.get(match.home_team_id)!,awayTeam:teams.get(match.away_team_id)!,kickoffAtUtc:iso(match.kickoff_at),dateFinland:day(match.date_finland),stage:match.stage,status:match.status,leg:match.leg,tieId:match.tie_id,homeScore:match.home_score,awayScore:match.away_score,
        eligible:+new Date(match.kickoff_at)>=+new Date(season.gameStartAt),submittedMainBets:betRows.filter(bet=>bet.type==='main_1x2'&&bet.status!=='cancelled'&&markets.some(m=>m.id===bet.market_id)).length,markets,
        result:{homeScoreFinal:match.home_score_final,awayScoreFinal:match.away_score_final,advancingTeamId:match.advancing_team_id,scorerPlayerIds:match.scorer_player_ids,appearedPlayerIds:match.appeared_player_ids,registeredPlayerIds:match.registered_player_ids,scorerDataComplete:match.scorer_data_complete,override:match.result_override}};
    });
    let standings:ClubStanding[]=(await db.query('SELECT * FROM club_standings WHERE season_id=$1 ORDER BY position',[season.id])).rows.map(s=>({team:teams.get(s.team_id)!,position:s.position,played:s.played,won:s.won,drawn:s.drawn,lost:s.lost,goalsFor:s.goals_for,goalsAgainst:s.goals_against,points:s.points}));
    if(!standings.length) {
      // The official UCL table includes the whole league phase, even rounds that
      // precede this group's betting start. Only confirmed final scores count.
      const league=matchRows.filter(match=>match.stage==='league');
      const table=new Map<string,ClubStanding>();
      for(const match of league)for(const teamId of [match.home_team_id,match.away_team_id])if(!table.has(teamId))table.set(teamId,{team:teams.get(teamId)!,position:0,played:0,won:0,drawn:0,lost:0,goalsFor:0,goalsAgainst:0,points:0});
      for(const match of league.filter(match=>match.status==='final' && match.home_score!==null && match.away_score!==null)) {
        const home=table.get(match.home_team_id)!,away=table.get(match.away_team_id)!;
        home.played++;away.played++;home.goalsFor+=match.home_score;home.goalsAgainst+=match.away_score;away.goalsFor+=match.away_score;away.goalsAgainst+=match.home_score;
        if(match.home_score>match.away_score){home.won++;home.points+=3;away.lost++;}
        else if(match.home_score<match.away_score){away.won++;away.points+=3;home.lost++;}
        else{home.drawn++;away.drawn++;home.points++;away.points++;}
      }
      const compare=(a:ClubStanding,b:ClubStanding)=>b.points-a.points||(b.goalsFor-b.goalsAgainst)-(a.goalsFor-a.goalsAgainst)||b.goalsFor-a.goalsFor;
      standings=[...table.values()].sort((a,b)=>compare(a,b)||a.team.name.localeCompare(b.team.name));
      standings.forEach((entry,index)=>{entry.position=index>0&&compare(entry,standings[index-1])===0?standings[index-1].position:index+1;});
    }
    const ties:Tie[]=[];
    const tieKey=(match:Record<string,any>)=>match.stage==='final'?(match.tie_id??`final:${match.id}`):match.tie_id;
    for(const tieId of new Set(matchRows.map(tieKey).filter(Boolean))) {
      const legs=matchRows.filter(match=>tieKey(match)===tieId).sort((a,b)=>(a.leg??1)-(b.leg??1)||+new Date(a.kickoff_at)-+new Date(b.kickoff_at));
      const first=legs[0];const completed=legs.filter(leg=>leg.status==='final'&&leg.home_score!==null&&leg.away_score!==null);
      const aggregate=(teamId:string)=>completed.reduce((sum,leg)=>sum+Number(leg.home_team_id===teamId?(leg.home_score_final??leg.home_score):(leg.away_score_final??leg.away_score)),0);
      const homeAggregate=completed.length?aggregate(first.home_team_id):null,awayAggregate=completed.length?aggregate(first.away_team_id):null;
      const expectedLegs=first.stage==='final'?1:2;
      const coherent=legs.length===expectedLegs&&(expectedLegs===1||(legs[0].leg===1&&legs[1].leg===2&&legs[0].home_team_id===legs[1].away_team_id&&legs[0].away_team_id===legs[1].home_team_id));
      let advancingTeamId:string|null=null;
      if(coherent&&completed.length===expectedLegs) advancingTeamId=homeAggregate!==awayAggregate?(homeAggregate!>awayAggregate!?first.home_team_id:first.away_team_id):legs.at(-1)!.advancing_team_id??null;
      ties.push({id:tieId,stage:first.stage,homeTeam:teams.get(first.home_team_id)!,awayTeam:teams.get(first.away_team_id)!,homeAggregate,awayAggregate,advancingTeamId,matchIds:legs.map(leg=>leg.id),legs:legs.map(leg=>({id:leg.id,roundId:leg.round_id,kickoffAtUtc:iso(leg.kickoff_at),leg:leg.leg,homeTeam:teams.get(leg.home_team_id)!,awayTeam:teams.get(leg.away_team_id)!,status:leg.status,homeScore:leg.home_score,awayScore:leg.away_score,homeScoreFinal:leg.home_score_final,awayScoreFinal:leg.away_score_final}))});
    }
    return {season,user:actualUser,rounds,selectedRoundId,matches,wallet:{bankroll:own.bankroll,openStake:own.openStake,total:own.total,bonuses:bonusRows.map(b=>({date:day(b.date),granted:money(b.granted),available:money(b.available),used:money(b.used),expired:money(b.expired),converted:money(b.converted)}))},leaderboard,standings,ties,
      awards:awardRows(betRows,matchRows,marketRows,users,season),sync:mapSync((await db.query('SELECT * FROM sync_status ORDER BY provider')).rows),serverTime};
  });
}

function normalizedName(name:string) {
  return name.normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim().replace(/\s+/g,' ');
}
function nameInput(value:unknown):string {
  if(typeof value!=='string' || value.trim().length<2 || value.length>120 || /[\u0000-\u001f]/.test(value) || normalizedName(value).length<2) throw new GameError('Nimen pitää olla 2–120 merkkiä.');
  return value.trim().replace(/\s+/g,' ');
}
function reasonInput(value:unknown):string {
  if(typeof value!=='string' || value.trim().length<3 || value.length>2000 || value.includes('\u0000'))throw new GameError('Anna muutokselle vähintään kolmen merkin perustelu.');
  return value.trim();
}
async function requireAdmin(db:Db,actorId:string) {
  if((await db.query('SELECT role FROM users WHERE id=$1',[actorId])).rows[0]?.role!=='admin')throw new GameError('Vain ylläpitäjälle.',403,'FORBIDDEN');
}
export async function createManualMatch(input:ManualMatchInput,actorId:string):Promise<{id:string}> {
  if(!input || typeof input!=='object')throw new GameError('Ottelun tiedot puuttuvat.');
  const home=nameInput(input.homeName),away=nameInput(input.awayName),reason=reasonInput(input.reason);
  if(normalizedName(home)===normalizedName(away))throw new GameError('Otteluun tarvitaan kaksi eri seuraa.');
  if(typeof input.kickoffAtUtc!=='string' || !/(?:Z|[+-]\d{2}:\d{2})$/.test(input.kickoffAtUtc) || !Number.isFinite(Date.parse(input.kickoffAtUtc)) || Date.parse(input.kickoffAtUtc)<=Date.now())throw new GameError('Anna tuleva aloitusaika aikavyöhykkeineen.');
  if(typeof input.roundId!=='string' || input.roundId.length>200)throw new GameError('Valitse kierros.');
  if(input.leg!==undefined && input.leg!==null && input.leg!==1 && input.leg!==2)throw new GameError('Osaottelun numero on 1 tai 2.');
  if(input.tieId!==undefined && input.tieId!==null && (typeof input.tieId!=='string' || input.tieId.trim().length<3 || input.tieId.length>200))throw new GameError('Virheellinen otteluparin tunniste.');
  if(input.stage==='league' && (input.leg || input.tieId))throw new GameError('Liigavaiheessa ei ole kaksiosaisia ottelupareja.');
  if(input.stage==='final' && input.leg)throw new GameError('Finaali pelataan yhtenä otteluna.');
  if(input.stage!=='league' && input.stage!=='final' && !input.leg)throw new GameError('Valitse pudotuspeliin osaottelu.');
  if(input.leg===2 && !input.tieId)throw new GameError('Valitse toiselle osaottelulle aiempi ottelupari.');
  return transaction(async db=>{
    await lockGame(db);await requireAdmin(db,actorId);
    const season=await seasonRow(db);
    const round=(await db.query('SELECT * FROM rounds WHERE id=$1 AND season_id=$2 FOR UPDATE',[input.roundId,season.id])).rows[0];
    if(!round || input.stage!==round.stage)throw new GameError('Kierros ja kilpailun vaihe eivät täsmää.');
    const existingTeams=(await db.query('SELECT id,name FROM teams')).rows;
    const teamId=async(name:string)=>{
      const normalized=normalizedName(name);
      const existing=existingTeams.find(team=>normalizedName(team.name)===normalized);
      if(existing)return existing.id as string;
      const id=`manual-team-${fingerprint(normalized).slice(0,20)}`;
      await db.query('INSERT INTO teams(id,name,short_name) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',[id,name,Array.from(name).slice(0,18).join('')]);
      return id;
    };
    const homeId=await teamId(home),awayId=await teamId(away);
    const duplicate=await db.query('SELECT id FROM matches WHERE season_id=$1 AND home_team_id=$2 AND away_team_id=$3 AND kickoff_at=$4',[season.id,homeId,awayId,input.kickoffAtUtc]);
    if(duplicate.rowCount)throw new GameError('Sama ottelu on jo lisätty.',409,'MATCH_EXISTS');
    const tieId=input.tieId?.trim()??(input.stage!=='league'?`manual-tie-${randomUUID()}`:null);
    if(tieId){
      const legs=(await db.query('SELECT * FROM matches WHERE season_id=$1 AND tie_id=$2',[season.id,tieId])).rows;
      if(legs.some(leg=>leg.stage!==input.stage || ![homeId,awayId].includes(leg.home_team_id) || ![homeId,awayId].includes(leg.away_team_id) || (input.leg && leg.leg===input.leg)))throw new GameError('Otteluparin seurat, vaihe tai osaottelu eivät täsmää.',409,'TIE_CONFLICT');
      if((input.stage==='final'&&legs.length)||(input.leg===2&&(!legs.length||legs[0].leg!==1||legs[0].home_team_id!==awayId||legs[0].away_team_id!==homeId||+new Date(legs[0].kickoff_at)>=Date.parse(input.kickoffAtUtc))))throw new GameError('Toinen osaottelu pelataan ensimmäisen jälkeen vastakkaisilla kotijoukkueilla.',409,'TIE_CONFLICT');
    }
    const id=`manual-match-${randomUUID()}`;
    await db.query(`INSERT INTO matches(id,season_id,round_id,home_team_id,away_team_id,kickoff_at,date_finland,stage,status,leg,tie_id)
      VALUES($1,$2,$3,$4,$5,$6,($6::timestamptz AT TIME ZONE 'Europe/Helsinki')::date,$7,'scheduled',$8,$9)`,[id,season.id,input.roundId,homeId,awayId,input.kickoffAtUtc,input.stage,input.leg??null,tieId]);
    for(const type of ['main_1x2','exact_score','anytime_goalscorer'])await db.query("INSERT INTO markets(id,match_id,type,status,required) VALUES($1,$2,$3,'draft',$4)",[`${id}:${type}`,id,type,type==='main_1x2']);
    await db.query('UPDATE rounds SET starts_at=LEAST(starts_at,$2),ends_at=GREATEST(ends_at,$2) WHERE id=$1',[input.roundId,input.kickoffAtUtc]);
    await db.query('INSERT INTO audit_log(actor_id,action,reason,detail) VALUES($1,$2,$3,$4)',[actorId,'manual_match_created',reason,JSON.stringify({matchId:id,home,away,kickoffAtUtc:iso(input.kickoffAtUtc),roundId:input.roundId,stage:input.stage,leg:input.leg??null,tieId})]);
    return {id};
  });
}
export async function setManualOdds(input:ManualOddsInput,actorId:string):Promise<void> {
  if(!input || typeof input!=='object' || typeof input.matchId!=='string')throw new GameError('Ottelun tunniste puuttuu.');
  const reason=reasonInput(input.reason);
  const validOdds=(value:unknown)=>typeof value==='number' && Number.isFinite(value) && value>1 && value<=10000 && Math.abs(value*10000-Math.round(value*10000))<0.000001;
  if(![input.home,input.draw,input.away].every(validOdds))throw new GameError('Kertoimien pitää olla yli 1 ja enintään 10 000, enintään neljällä desimaalilla.');
  if(input.exactScores!==undefined && (!Array.isArray(input.exactScores) || input.exactScores.length>100))throw new GameError('Tarkkoja tuloksia voi olla enintään 100.');
  if(input.scorers!==undefined && (!Array.isArray(input.scorers) || input.scorers.length>100))throw new GameError('Maalintekijöitä voi olla enintään 100.');
  const exact=input.exactScores??[];const scoreKeys=new Set<string>();
  for(const score of exact){
    if(!score || !Number.isInteger(score.home) || !Number.isInteger(score.away) || score.home<0 || score.away<0 || score.home>100 || score.away>100 || !validOdds(score.odds))throw new GameError('Tulos tai sen kerroin ei kelpaa.');
    const key=`${score.home}-${score.away}`;if(scoreKeys.has(key))throw new GameError('Sama tarkka tulos on mukana kahdesti.');scoreKeys.add(key);
  }
  const names=new Set<string>();const scorers=(input.scorers??[]).map(scorer=>{
    if(!scorer || !validOdds(scorer.odds))throw new GameError('Maalintekijän kerroin ei kelpaa.');
    const name=nameInput(scorer.name),key=playerIdentity(input.matchId,name);
    if(names.has(key))throw new GameError('Sama maalintekijä on mukana kahdesti.');names.add(key);
    return {...scorer,name,key};
  });
  await transaction(async db=>{
    await lockGame(db);await requireAdmin(db,actorId);
    const season=await seasonRow(db);
    const match=(await db.query('SELECT * FROM matches WHERE id=$1 AND season_id=$2 FOR UPDATE',[input.matchId,season.id])).rows[0];
    if(!match)throw new GameError('Ottelua ei löydy tältä kaudelta.',404,'MATCH_NOT_FOUND');
    if(match.status!=='scheduled' || +new Date(match.kickoff_at)<=Date.now())throw new GameError('Ottelu on jo lukittu.',409,'MARKET_LOCKED');
    const markets=(await db.query('SELECT * FROM markets WHERE match_id=$1 FOR UPDATE',[input.matchId])).rows;
    const main=markets.find(market=>market.type==='main_1x2');
    if(main && !['draft','open'].includes(main.status))throw new GameError('Päämarkkina on jo lukittu.',409,'MARKET_LOCKED');
    type Price={key:string;label:string;kind:Selection['kind'];odds:number;scoreHome?:number;scoreAway?:number;playerId?:string};
    const requests:{type:string;prices:Price[]}[]=[];
    if(!main || main.status==='draft')requests.push({type:'main_1x2',prices:[{key:'home_win',label:'1',kind:'home_win',odds:input.home},{key:'draw',label:'X',kind:'draw',odds:input.draw},{key:'away_win',label:'2',kind:'away_win',odds:input.away}]});
    if(exact.length)requests.push({type:'exact_score',prices:exact.map(score=>({key:`${score.home}-${score.away}`,label:`${score.home}–${score.away}`,kind:'exact_score',odds:score.odds,scoreHome:score.home,scoreAway:score.away}))});
    if(scorers.length)requests.push({type:'anytime_goalscorer',prices:scorers.map(scorer=>({key:scorer.key,label:scorer.name,kind:'player_anytime_goalscorer',odds:scorer.odds,playerId:scorer.key}))});
    if(!requests.length)throw new GameError('Pääkertoimet on jo avattu. Lisää halutessasi uusi sivumarkkina.',409,'MARKETS_ALREADY_OPEN');
    for(const request of requests){
      let market=markets.find(m=>m.type===request.type);
      if(market && market.status!=='draft')throw new GameError('Avatun markkinan kertoimia ei voi korvata.',409,'MARKETS_ALREADY_OPEN');
      if(market && (await db.query('SELECT id FROM bets WHERE market_id=$1 LIMIT 1',[market.id])).rowCount)throw new GameError('Markkinassa on vetoja; sitä ei voi muuttaa.',409,'MARKET_HAS_BETS');
      if(!market){market={id:`${input.matchId}:${request.type}`};await db.query("INSERT INTO markets(id,match_id,type,status,required) VALUES($1,$2,$3,'draft',$4)",[market.id,input.matchId,request.type,request.type==='main_1x2']);}
      // Draft data has never been offered for betting, and no bet may reference
      // this market. Replace incomplete draft selections atomically before opening.
      await db.query('DELETE FROM odds_snapshots WHERE selection_id IN (SELECT id FROM selections WHERE market_id=$1)',[market.id]);
      await db.query('DELETE FROM selections WHERE market_id=$1',[market.id]);
      for(const price of request.prices){
        const selectionId=`${market.id}:${price.key}`;
        await db.query('INSERT INTO selections(id,market_id,label,kind,score_home,score_away,player_id) VALUES($1,$2,$3,$4,$5,$6,$7)',[selectionId,market.id,price.label,price.kind,price.scoreHome??null,price.scoreAway??null,price.playerId??null]);
        await db.query("INSERT INTO odds_snapshots(selection_id,decimal_odds,source) VALUES($1,$2,'manual')",[selectionId,price.odds]);
      }
      await db.query("UPDATE markets SET status='open',required=(type='main_1x2') WHERE id=$1",[market.id]);
    }
    await db.query('INSERT INTO audit_log(actor_id,action,reason,detail) VALUES($1,$2,$3,$4)',[actorId,'manual_odds_opened',reason,JSON.stringify({matchId:input.matchId,markets:requests})]);
  });
}
