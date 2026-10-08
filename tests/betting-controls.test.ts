import { describe, expect, it } from 'vitest';
import type { Bet, Market, Match } from '../shared/contracts';
import { canBet, canCancelBet } from '../src/lib';

const kickoff = Date.parse('2027-02-16T20:00:00Z');
const bet: Bet = { id: 'bet', marketId: 'market', selectionId: 'home', stake: 20, bankrollStake: 20, bonusStake: 0, decimalOdds: 2, status: 'placed', selectionLabel: 'Koti', payout: 0 };
const market: Market = { id: 'market', type: 'main_1x2', status: 'open', required: true, selections: [{ id: 'home', label: 'Koti', oddsSnapshotId: 'price', decimalOdds: 2, kind: 'home_win' }], userBet: bet, revealedBets: [] };
const match: Match = { id: 'match', roundId: 'playoff-1', homeTeam: { id: 'home', name: 'Home', shortName: 'Home', crest: null }, awayTeam: { id: 'away', name: 'Away', shortName: 'Away', crest: null }, kickoffAtUtc: new Date(kickoff).toISOString(), dateFinland: '2027-02-16', stage: 'playoff', status: 'scheduled', leg: 1, tieId: 'tie', homeScore: null, awayScore: null, eligible: true, submittedMainBets: 1, markets: [market], result: { homeScoreFinal: null, awayScoreFinal: null, advancingTeamId: null, scorerPlayerIds: [], appearedPlayerIds: [], registeredPlayerIds: [], scorerDataComplete: false, override: false } };

describe('betting controls at suspension and kickoff', () => {
  it('permits cancelling an existing future bet while new bets are suspended', () => {
    const suspended = { ...market, status: 'locked' as const };
    const postponed = { ...match, status: 'postponed' as const };
    expect(canBet(match, suspended, kickoff - 1)).toBe(false);
    expect(canCancelBet(match, suspended, kickoff - 1)).toBe(true);
    expect(canBet(postponed, suspended, kickoff - 1)).toBe(false);
    expect(canCancelBet(postponed, suspended, kickoff - 1)).toBe(true);
  });

  it('closes both placement and cancellation exactly at kickoff', () => {
    expect(canBet(match, market, kickoff - 1)).toBe(true);
    expect(canCancelBet(match, market, kickoff - 1)).toBe(true);
    for (const now of [kickoff, kickoff + 1]) {
      expect(canBet(match, market, now)).toBe(false);
      expect(canCancelBet(match, market, now)).toBe(false);
    }
  });

  it('never offers cancellation for absent, settled, or already cancelled bets', () => {
    expect(canCancelBet(match, { ...market, userBet: null }, kickoff - 1)).toBe(false);
    for (const status of ['won', 'lost', 'voided', 'cancelled'] as const) {
      expect(canCancelBet(match, { ...market, userBet: { ...bet, status } }, kickoff - 1)).toBe(false);
    }
  });
});
