import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, Check, ChevronDown, ChevronRight, Clock3, Coins, ListChecks, LockKeyhole, Minus, Plus, ReceiptText, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react';
import type { BetInput, GameSnapshot, Market, Match, Selection } from '../shared/contracts';
import { api, canBet, canCancelBet, coins, date, errorMessage, finlandDate, marketLabel, odds, post, resultLabel, roundLabel, time } from './lib';
import { Drawer, EmptyState, Notice, Spinner, TeamMark } from './components';

type Pick = { matchId: string; marketId: string; selectionId: string };
type ResolvedPick = { match: Match; market: Market; selection: Selection };
type Filter = 'all' | 'tonight' | 'missing';

export function RoundPage({ game, now, refreshing, offline, onRoundChange, onRefresh }: { game: GameSnapshot; now: number; refreshing: boolean; offline: boolean; onRoundChange: (id: string) => void; onRefresh: () => Promise<void> }) {
  const [filter, setFilter] = useState<Filter>('all');
  const [picks, setPicks] = useState<Pick[]>([]);
  const [review, setReview] = useState(false);
  const [individual, setIndividual] = useState<Pick | null>(null);
  const [message, setMessage] = useState('');
  const round = game.rounds.find(item => item.id === game.selectedRoundId);
  const eligibleMatches = game.matches.filter(match => match.eligible);
  const today = finlandDate(now);
  const openMatches = eligibleMatches.filter(match => match.markets.some(market => market.type === 'main_1x2' && canBet(match, market, now)));
  const missing = openMatches.filter(match => !match.markets.find(market => market.type === 'main_1x2')?.userBet);
  const submitted = eligibleMatches.filter(match => Boolean(match.markets.find(market => market.type === 'main_1x2')?.userBet)).length;
  const bonusAvailable = game.wallet.bonuses.reduce((sum, bonus) => sum + bonus.available, 0);
  const visibleMatches = eligibleMatches.filter(match => filter === 'tonight' ? match.dateFinland === today : filter === 'missing' ? missing.some(item => item.id === match.id) : true);
  const groups = useMemo(() => {
    const result = new Map<string, Match[]>();
    for (const match of [...visibleMatches].sort((a, b) => Date.parse(a.kickoffAtUtc) - Date.parse(b.kickoffAtUtc))) result.set(match.dateFinland, [...(result.get(match.dateFinland) ?? []), match]);
    return [...result];
  }, [visibleMatches]);
  const resolvedIndividual = individual ? resolvePick(game, individual) : null;
  useEffect(() => { setPicks([]); setReview(false); setIndividual(null); setFilter('all'); }, [game.selectedRoundId]);

  function select(match: Match, market: Market, selection: Selection) {
    if (offline || !canBet(match, market, now)) return;
    setMessage('');
    setPicks(current => current.some(pick => pick.marketId === market.id && pick.selectionId === selection.id)
      ? current.filter(pick => pick.marketId !== market.id)
      : [...current.filter(pick => pick.marketId !== market.id), { matchId: match.id, marketId: market.id, selectionId: selection.id }]);
  }
  async function saved(text: string) { setMessage(text); await onRefresh(); }
  return <div className={`round-page ${picks.length ? 'has-slip' : ''}`}>
    <div className="page-heading"><div><h1>{round ? roundLabel(round) : 'Oma kierros'}</h1><p>{round ? `${date(round.startsAt, false)}–${date(round.endsAt, false)} · ${eligibleMatches.length} ottelua` : 'Mestarien liiga 2026–27'}</p></div><label className="round-select"><span className="sr-only">Valitse kierros</span><select value={game.selectedRoundId ?? ''} onChange={event => onRoundChange(event.target.value)} disabled={refreshing || picks.length > 0}><option value="" disabled>Valitse kierros</option>{game.rounds.map(item => <option key={item.id} value={item.id}>{roundLabel(item)} · {date(item.startsAt, false)}</option>)}</select><ChevronDown size={16} aria-hidden="true" /></label></div>
    {picks.length > 0 && <p className="round-switch-help">Jätä tai tyhjennä valinnat ennen kierroksen vaihtamista.</p>}
    <section className="wallet-strip" aria-label="Oma pelitili"><div className="wallet-main"><Coins size={22} strokeWidth={1.6} /><div><span>Oma pelikassa</span><strong>{coins(game.wallet.bankroll)}<small>kolikkoa</small></strong></div></div><div className="wallet-item"><span>Päiväbonuksia käytössä</span><strong>{coins(bonusAvailable)}<span className="coin-unit">kol.</span></strong></div><div className="wallet-item"><span>Oma panos avoinna</span><strong>{coins(game.wallet.openStake)}<span className="coin-unit">kol.</span></strong></div><div className="wallet-progress"><span>Omat 1X2-vedot</span><strong>{submitted}<span> / {eligibleMatches.length}</span></strong></div></section>
    {message && <Notice tone="success" onDismiss={() => setMessage('')}>{message}</Notice>}
    <div className="round-toolbar"><div className="filter-group" aria-label="Suodata otteluita">{([{ id: 'all', label: 'Kaikki', count: eligibleMatches.length }, { id: 'tonight', label: 'Tänä iltana', count: eligibleMatches.filter(match => match.dateFinland === today).length }, { id: 'missing', label: 'Puuttuvat', count: missing.length }] as const).map(item => <button type="button" key={item.id} aria-pressed={filter === item.id} onClick={() => setFilter(item.id)}>{item.label}<span>{item.count}</span></button>)}</div><span className="market-guide"><ShieldCheck size={15} />1X2 = normaali peliaika</span></div>
    {eligibleMatches.length > 0 && openMatches.length > 0 && <div className="quick-pick-help"><ListChecks size={18} /><span>Napauta 1, X tai 2. Tarkista valinnat ja panos ennen jättämistä.</span></div>}
    {groups.length === 0 && <EmptyState title={filter === 'missing' ? 'Kaikki valmiina.' : filter === 'tonight' ? 'Tänään hengähdetään.' : 'Ottelut saapuvat pian.'} icon={filter === 'missing' ? <Check size={30} /> : <CalendarIcon />}><p>{filter === 'missing' ? 'Avoimista otteluista ei puutu omaa 1X2-vetoa.' : filter === 'tonight' ? 'Tälle Suomen kalenteripäivälle ei ole otteluita tällä kierroksella.' : 'Kierroksen otteluita ei ole vielä saatavilla. Ne tulevat näkyviin ottelutietojen päivittyessä.'}</p>{filter !== 'all' ? <button className="button secondary" type="button" onClick={() => setFilter('all')}>Näytä koko kierros</button> : <button className="button secondary" type="button" disabled={refreshing} onClick={() => void onRefresh()}><RefreshCw size={16} />Päivitä ottelut</button>}</EmptyState>}
    {groups.map(([day, matches]) => {
      const bonus = game.wallet.bonuses.find(item => item.date === day);
      return <section className="matchday-group" key={day} aria-labelledby={`day-${day}`}><div className="day-heading"><h2 id={`day-${day}`}>{day === today ? 'Tänään' : date(day)}<span>{matches.length} ottelua</span></h2>{bonus && <div className="daily-bonus"><Coins size={15} />{bonus.available > 0 ? <><strong>{coins(bonus.available)}</strong> / {coins(bonus.granted)} bonuskolikkoa</> : bonus.converted > 0 ? <>{coins(bonus.converted)} kol. siirretty kassaan</> : bonus.expired > 0 ? <>{coins(bonus.expired)} kol. vanhentunut</> : <>Päiväbonus käytetty</>}</div>}</div><div className="match-grid">{matches.map(match => <MatchCard key={match.id} match={match} now={now} offline={offline} picked={picks.find(pick => pick.matchId === match.id)} onPick={select} onIndividual={(market, selection) => setIndividual({ matchId: match.id, marketId: market.id, selectionId: selection.id })} />)}</div></section>;
    })}
    {game.matches.some(match => !match.eligible) && <p className="quiet-note">Ennen {date(game.season.gameStartAt, false)} pelatut ottelut eivät kuulu tähän Ponnicupiin.</p>}
    <div className="round-note"><LockKeyhole size={16} /><p>Muiden valinnat paljastuvat ottelun alkaessa. Vedot lukitaan avauspotkuun.</p></div>
    {picks.length > 0 && <div className="slip-bar"><div><strong>{picks.length} {picks.length === 1 ? 'valinta' : 'valintaa'}</strong><span>20 kol. / veto · tarkista ennen jättämistä</span></div><button type="button" className="button gold" onClick={() => setReview(true)}>Tarkista vedot<ArrowRight size={18} /></button><button type="button" className="icon-button" aria-label="Tyhjennä valinnat" onClick={() => setPicks([])}><X size={18} /></button></div>}
    {review && <BulkSlip game={game} picks={picks} now={now} offline={offline} onRemove={marketId => setPicks(current => current.filter(pick => pick.marketId !== marketId))} onClose={() => setReview(false)} onSaved={async count => { setReview(false); setPicks([]); await saved(`${count} ${count === 1 ? 'veto jätetty' : 'vetoa jätetty'}. Onnea matkaan.`); }} />}
    {resolvedIndividual && <IndividualSlip game={game} item={resolvedIndividual} now={now} offline={offline} onClose={() => setIndividual(null)} onSaved={async text => { setIndividual(null); setPicks(current => current.filter(pick => pick.marketId !== resolvedIndividual.market.id)); await saved(text); }} />}
  </div>;
}

function CalendarIcon() { return <Clock3 size={30} strokeWidth={1.6} />; }

function MatchCard({ match, now, picked, offline, onPick, onIndividual }: { match: Match; now: number; picked?: Pick; offline: boolean; onPick: (match: Match, market: Market, selection: Selection) => void; onIndividual: (market: Market, selection: Selection) => void }) {
  const [expanded, setExpanded] = useState(false);
  const main = match.markets.find(market => market.type === 'main_1x2');
  const isOpen = main ? canBet(match, main, now) : false;
  const started = Date.parse(match.kickoffAtUtc) <= now;
  const bet = main?.userBet;
  const cancellable = main ? canCancelBet(match, main, now) : false;
  const status = match.status === 'postponed' ? 'Siirretty' : match.status === 'cancelled' ? 'Peruttu' : match.status === 'live' ? 'Käynnissä' : match.status === 'final' ? 'Päättynyt' : started ? 'Lukittu' : !main || main.status === 'draft' || !main.selections.length ? 'Kertoimet tulossa' : main.status === 'voided' ? 'Palautettu' : !isOpen ? 'Lukittu' : picked ? 'Odottaa jättämistä' : bet ? 'Jätetty' : 'Puuttuu';
  const pendingSelection = picked && main?.selections.find(selection => selection.id === picked.selectionId);
  const secondary = match.markets.filter(market => market.type !== 'main_1x2');
  const showScore = match.homeScore !== null && match.awayScore !== null;
  return <article className={`match-card ${picked ? 'is-picked' : ''}`}>
    <div className="match-meta"><span><Clock3 size={13} />{time(match.kickoffAtUtc)}{match.leg && <span>· {match.leg}. osa</span>}</span><span className={`match-status ${status === 'Puuttuu' ? 'missing' : status === 'Jätetty' ? 'submitted' : match.status === 'live' ? 'live' : ''}`}>{status === 'Jätetty' && <Check size={12} />}{status}</span></div>
    <div className="fixture"><div className="fixture-team"><TeamMark team={match.homeTeam} /><strong title={match.homeTeam.name}>{match.homeTeam.shortName || match.homeTeam.name}</strong></div><div className={`fixture-score ${showScore ? 'has-score' : ''}`}>{showScore ? <>{match.homeScore}<span>–</span>{match.awayScore}</> : <span>–</span>}</div><div className="fixture-team away"><TeamMark team={match.awayTeam} /><strong title={match.awayTeam.name}>{match.awayTeam.shortName || match.awayTeam.name}</strong></div></div>
    {main && main.selections.length > 0 ? <div className="odds-row" aria-label={`${match.homeTeam.shortName} vastaan ${match.awayTeam.shortName}, 1X2`}>{['home_win', 'draw', 'away_win'].map((kind, index) => {
      const selection = main.selections.find(item => item.kind === kind);
      const selected = selection && (picked ? picked.selectionId === selection.id : bet?.selectionId === selection.id);
      return <button key={kind} type="button" aria-pressed={Boolean(selected)} className={selected ? 'selected' : ''} disabled={!selection || !isOpen || offline} aria-label={`${index === 0 ? match.homeTeam.shortName : index === 1 ? 'Tasapeli' : match.awayTeam.shortName}, kerroin ${selection ? odds(selection.decimalOdds) : 'ei saatavilla'}`} onClick={() => selection && onPick(match, main, selection)}><span>{index === 0 ? '1' : index === 1 ? 'X' : '2'}</span><strong>{selection ? odds(selection.decimalOdds) : '–'}</strong>{selected && <Check size={13} />}</button>;
    })}</div> : <div className="market-pending"><Clock3 size={15} />Kertoimet tulossa</div>}
    {bet && <div className={`own-bet ${bet.status === 'won' ? 'bet-won' : ''}`}><span><Check size={13} />{picked && <span>Jätetty:</span>}<strong>{bet.selectionLabel}</strong><span>· {coins(bet.stake)} kol.</span></span>{isOpen || cancellable ? <button className="text-button" type="button" disabled={offline} onClick={() => { const selection = main?.selections.find(item => item.id === bet.selectionId); if (main && selection) onIndividual(main, selection); }}>{isOpen ? 'Muokkaa' : 'Peru veto'}</button> : <strong>{bet.status === 'won' ? `+${coins(bet.payout)}` : resultLabel[bet.status]}</strong>}</div>}
    {picked && <div className="own-bet draft"><span>{bet ? 'Uusi valinta:' : 'Valittu:'} <strong>{pendingSelection?.label ?? '1X2'}</strong><span>· odottaa jättämistä</span></span><button type="button" className="text-button" onClick={() => { if (main && pendingSelection) onIndividual(main, pendingSelection); }}>Oma panos</button></div>}
    {picked && bet && <p className="pending-bet-note">Jätetty veto pysyy voimassa, kunnes jätät muutoksen.</p>}
    <div className="match-card-footer"><span>{started ? <><LockKeyhole size={13} />Vedot lukittu</> : <><ShieldCheck size={13} />{match.submittedMainBets} 1X2-vetoa jätetty</>}</span><button className="text-button" type="button" aria-expanded={expanded} aria-controls={`more-${match.id}`} onClick={() => setExpanded(value => !value)}>{started ? 'Näytä vedot' : 'Lisävedot'}{expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}</button></div>
    {expanded && <div className="match-expanded" id={`more-${match.id}`}>
      {secondary.length === 0 && <p className="muted small-text">Lisävetoja ei ole vielä saatavilla.</p>}
      {secondary.map(market => <OptionalMarket key={market.id} match={match} market={market} now={now} offline={offline} onSelect={selection => onIndividual(market, selection)} />)}
      {started && <div className="revealed-bets"><h3>Porukan vedot</h3>{match.markets.every(market => market.revealedBets.length === 0) ? <p className="muted small-text">Ei jätettyjä vetoja.</p> : match.markets.map(market => market.revealedBets.length > 0 && <div key={market.id} className="reveal-market"><h4>{marketLabel(market)}</h4>{market.revealedBets.map(revealed => <div className="revealed-row" key={revealed.id}><strong>{revealed.displayName ?? 'Pelaaja'}</strong><span>{revealed.selectionLabel}<small>{coins(revealed.stake)} kol. · {odds(revealed.decimalOdds)}</small></span><span className={`bet-outcome ${revealed.status}`}>{resultLabel[revealed.status]}</span></div>)}</div>)}</div>}
      {!started && <p className="secrecy-note"><LockKeyhole size={13} />Porukan valinnat näkyvät avauspotkun jälkeen.</p>}
    </div>}
  </article>;
}

function OptionalMarket({ match, market, now, offline, onSelect }: { match: Match; market: Market; now: number; offline: boolean; onSelect: (selection: Selection) => void }) {
  const [search, setSearch] = useState('');
  const open = canBet(match, market, now);
  const cancellable = canCancelBet(match, market, now);
  const visible = market.selections.filter(selection => selection.label.toLocaleLowerCase('fi').includes(search.toLocaleLowerCase('fi')));
  return <section className="optional-market"><h3>{marketLabel(market)}</h3>{market.userBet && <p className="optional-current"><Check size={13} />Oma veto: <strong>{market.userBet.selectionLabel}</strong> · {coins(market.userBet.stake)} kol. {(open || cancellable) && <button type="button" className="text-button" disabled={offline} onClick={() => { const selection = market.selections.find(item => item.id === market.userBet?.selectionId); if (selection) onSelect(selection); }}>{open ? 'Muokkaa' : 'Peru veto'}</button>}</p>}{!market.selections.length ? <p className="small-text muted">Kertoimet tulossa.</p> : <>{market.type === 'anytime_goalscorer' && market.selections.length > 8 && <label className="field compact-field"><span className="sr-only">Etsi maalintekijää</span><input type="search" placeholder="Etsi pelaajaa" value={search} onChange={event => setSearch(event.target.value)} /></label>}<div className={`optional-selections ${market.type === 'exact_score' ? 'score-selections' : ''}`}>{visible.map(selection => <button type="button" key={selection.id} disabled={!open || offline} className={market.userBet?.selectionId === selection.id ? 'selected' : ''} onClick={() => onSelect(selection)}><span>{selection.label}</span><strong>{odds(selection.decimalOdds)}</strong></button>)}</div>{visible.length === 0 && <p className="small-text muted">Pelaajaa ei löytynyt.</p>}</>}</section>;
}

function resolvePick(game: GameSnapshot, pick: Pick): ResolvedPick | null {
  const match = game.matches.find(item => item.id === pick.matchId);
  const market = match?.markets.find(item => item.id === pick.marketId);
  const selection = market?.selections.find(item => item.id === pick.selectionId);
  return match && market && selection ? { match, market, selection } : null;
}

function estimateFunding(game: GameSnapshot, items: ResolvedPick[], stake: number) {
  const amount = Number.isFinite(stake) && stake > 0 ? stake : 0;
  const daily = new Map<string, { needed: number; refund: number }>();
  let bankrollRefund = 0;
  for (const item of items) {
    const current = daily.get(item.match.dateFinland) ?? { needed: 0, refund: 0 };
    current.needed += amount; current.refund += item.market.userBet?.bonusStake ?? 0;
    bankrollRefund += item.market.userBet?.bankrollStake ?? 0;
    daily.set(item.match.dateFinland, current);
  }
  let bonus = 0;
  for (const [day, value] of daily) bonus += Math.min(value.needed, (game.wallet.bonuses.find(item => item.date === day)?.available ?? 0) + value.refund);
  const total = amount * items.length;
  return { total, bonus, bankroll: total - bonus, availableBankroll: game.wallet.bankroll + bankrollRefund };
}

function BulkSlip({ game, picks, now, offline, onRemove, onClose, onSaved }: { game: GameSnapshot; picks: Pick[]; now: number; offline: boolean; onRemove: (marketId: string) => void; onClose: () => void; onSaved: (count: number) => Promise<void> }) {
  const [stake, setStake] = useState('20');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const payloadRef = useRef<{ key: string; bets: BetInput[] } | null>(null);
  const items = picks.map(pick => resolvePick(game, pick)).filter((item): item is ResolvedPick => Boolean(item));
  const funding = estimateFunding(game, items, Number(stake));
  const locked = items.some(item => !canBet(item.match, item.market, now)) || items.length !== picks.length;
  const insufficient = funding.bankroll > funding.availableBankroll + .001;
  const valid = Number.isFinite(Number(stake)) && Number(stake) >= game.season.config.minimumStake && items.length > 0;
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!valid || insufficient || locked || offline) return;
    const base = items.map(item => ({ marketId: item.market.id, selectionId: item.selection.id, oddsSnapshotId: item.selection.oddsSnapshotId, stake: Number(stake) }));
    const key = JSON.stringify(base);
    if (payloadRef.current?.key !== key) payloadRef.current = { key, bets: base.map(bet => ({ ...bet, requestId: crypto.randomUUID() })) };
    setBusy(true); setError('');
    try { await post('/api/bets', { bets: payloadRef.current.bets }); await onSaved(items.length); }
    catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  }
  return <Drawer title="Tarkista vedot" onClose={onClose} busy={busy}><form className="stack" onSubmit={event => void submit(event)}><p className="muted">Jokainen valinta on oma vetonsa. Sama panos koskee kaikkia alla olevia vetoja.</p><div className="slip-picks">{items.map(item => <div className="slip-pick" key={item.market.id}><div><strong>{item.match.homeTeam.shortName} – {item.match.awayTeam.shortName}</strong><span>{item.selection.label} <b>{odds(item.selection.decimalOdds)}</b>{item.market.userBet && <small>Korvaa nykyisen {coins(item.market.userBet.stake)} kol. vedon</small>}{!canBet(item.match, item.market, now) && <small className="error-text">Ottelu on lukittu</small>}</span></div><button type="button" className="icon-button" aria-label={`Poista ${item.match.homeTeam.shortName} – ${item.match.awayTeam.shortName}`} onClick={() => onRemove(item.market.id)} disabled={busy}><X size={17} /></button></div>)}</div>{picks.length === 0 && <p>Valintoja ei ole. Sulje ja valitse otteluita.</p>}<StakeField value={stake} onChange={setStake} minimum={game.season.config.minimumStake} disabled={busy} label="Panos jokaiselle vedolle" /><FundingSummary {...funding} count={items.length} />{locked && <Notice>Osa valinnoista ei ole enää avoinna. Poista lukitut valinnat ennen jättämistä.</Notice>}{insufficient && <Notice>Kolikot eivät riitä tähän panokseen. Pienennä panosta tai poista valintoja.</Notice>}{offline && <Notice>Yhteys palvelimeen katkesi. Päivitä kierroksen tiedot ennen jättämistä.</Notice>}{error && <Notice>{error}</Notice>}<button className="button primary wide" type="submit" disabled={busy || !valid || insufficient || locked || offline}>{busy ? <Spinner label="Jätetään vetoja" /> : <>Jätä {items.length} {items.length === 1 ? 'veto' : 'vetoa'} · {coins(funding.total)} kol.<ArrowRight size={18} /></>}</button><p className="field-help">Päiväbonus käytetään ensin. Valinnat tallentuvat vasta painikkeesta.</p></form></Drawer>;
}

function IndividualSlip({ game, item, now, offline, onClose, onSaved }: { game: GameSnapshot; item: ResolvedPick; now: number; offline: boolean; onClose: () => void; onSaved: (message: string) => Promise<void> }) {
  const [stake, setStake] = useState(String(item.market.userBet?.stake ?? 20));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmCancel, setConfirmCancel] = useState(false);
  const payload = useRef<{ key: string; input: BetInput } | null>(null);
  const cancelId = useRef(crypto.randomUUID());
  const funding = estimateFunding(game, [item], Number(stake));
  const open = canBet(item.match, item.market, now);
  const cancellable = canCancelBet(item.match, item.market, now);
  const valid = Number.isFinite(Number(stake)) && Number(stake) >= game.season.config.minimumStake;
  const insufficient = funding.bankroll > funding.availableBankroll + .001;
  async function submit(event: FormEvent) {
    event.preventDefault(); if (!open || offline || insufficient || !valid) return;
    const base = { marketId: item.market.id, selectionId: item.selection.id, oddsSnapshotId: item.selection.oddsSnapshotId, stake: Number(stake) };
    const key = JSON.stringify(base);
    if (payload.current?.key !== key) payload.current = { key, input: { ...base, requestId: crypto.randomUUID() } };
    setBusy(true); setError('');
    try { await post('/api/bets', { bets: [payload.current.input] }); await onSaved(item.market.userBet ? 'Veto päivitetty.' : 'Veto jätetty. Onnea matkaan.'); }
    catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  }
  async function cancel() {
    if (!item.market.userBet || !cancellable || offline) return;
    setBusy(true); setError('');
    try { await api(`/api/bets/${encodeURIComponent(item.market.userBet.id)}`, { method: 'DELETE', body: JSON.stringify({ requestId: cancelId.current }) }); await onSaved('Veto peruttu ja panos palautettu.'); }
    catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  }
  return <Drawer title={item.market.userBet ? open ? 'Muokkaa vetoa' : 'Oma veto' : 'Jätä veto'} onClose={onClose} busy={busy}><form className="stack" onSubmit={event => void submit(event)}><div className="slip-fixture"><div><TeamMark team={item.match.homeTeam} small /><TeamMark team={item.match.awayTeam} small /></div><strong>{item.match.homeTeam.shortName} – {item.match.awayTeam.shortName}</strong><span>{date(item.match.kickoffAtUtc)} klo {time(item.match.kickoffAtUtc)}</span></div><div className="selection-summary"><div><span>{marketLabel(item.market)}</span><strong>{item.selection.label}</strong></div><strong>{odds(item.selection.decimalOdds)}</strong></div>{item.market.userBet && <p className="small-text muted">Nykyinen veto: {item.market.userBet.selectionLabel} · {coins(item.market.userBet.stake)} kol. {open && 'Uusi veto korvaa sen.'}</p>}<StakeField value={stake} onChange={setStake} minimum={game.season.config.minimumStake} disabled={busy || !open} /><FundingSummary {...funding} count={1} /><div className="potential-return"><span>Mahdollinen palautus</span><strong>{valid ? coins(Number(stake) * item.selection.decimalOdds) : '–'} kol.</strong></div><p className="field-help">Palautus sisältää panoksen. Päiväbonus käytetään ensin.</p>{!open && <Notice>{cancellable ? 'Kohde ei ole avoinna uusille vedoille. Voit vielä perua nykyisen vedon ennen avauspotkua.' : 'Ottelu tai vetokohde on lukittu. Vetoa ei voi enää muuttaa.'}</Notice>}{insufficient && <Notice>Kolikot eivät riitä tähän panokseen. Valitse pienempi panos.</Notice>}{offline && <Notice>Yhteys palvelimeen katkesi. Päivitä tiedot ennen jättämistä.</Notice>}{error && <Notice>{error}</Notice>}<button className="button primary wide" type="submit" disabled={busy || !open || !valid || insufficient || offline}>{busy ? <Spinner label="Tallennetaan" /> : <>{item.market.userBet ? 'Päivitä veto' : 'Jätä veto'} · {coins(funding.total)} kol.<ArrowRight size={18} /></>}</button>{item.market.userBet && cancellable && <div className="cancel-bet">{confirmCancel ? <><p>Perutaanko veto? Panos palautuu samaan kassaan ja voimassa olevaan päiväbonukseen.</p><div className="button-row"><button className="button danger" type="button" disabled={busy || offline} onClick={() => void cancel()}>Peru veto</button><button className="button secondary" type="button" disabled={busy} onClick={() => setConfirmCancel(false)}>Pidä veto</button></div></> : <button className="text-button destructive" type="button" disabled={busy || offline} onClick={() => setConfirmCancel(true)}><Trash2 size={15} />Peru tämä veto</button>}</div>}</form></Drawer>;
}

function StakeField({ value, onChange, minimum, disabled, label = 'Oma panos' }: { value: string; onChange: (value: string) => void; minimum: number; disabled: boolean; label?: string }) {
  return <div className="stake-field"><label className="field">{label}<div className="stake-input"><button type="button" aria-label="Pienennä panosta viidellä" disabled={disabled || Number(value) <= minimum} onClick={() => onChange(String(Math.max(minimum, (Number(value) || 0) - 5)))}><Minus size={18} /></button><input type="number" inputMode="decimal" min={minimum} step="0.01" value={value} onChange={event => onChange(event.target.value)} disabled={disabled} required aria-label={label} /><span>kol.</span><button type="button" aria-label="Kasvata panosta viidellä" disabled={disabled} onClick={() => onChange(String((Number(value) || 0) + 5))}><Plus size={18} /></button></div></label><div className="stake-chips" aria-label="Valitse panos">{[5, 20, 50, 100].filter(amount => amount >= minimum).map(amount => <button type="button" disabled={disabled} aria-pressed={Number(value) === amount} key={amount} onClick={() => onChange(String(amount))}>{amount}</button>)}</div><p className="field-help">Pienin panos {coins(minimum)} kolikkoa.</p></div>;
}

function FundingSummary({ total, bonus, bankroll, count }: { total: number; bonus: number; bankroll: number; count: number; availableBankroll?: number }) {
  return <dl className="funding-summary"><div><dt><ReceiptText size={15} />{count > 1 ? `${count} vedon panokset` : 'Panos yhteensä'}</dt><dd>{coins(total)} kol.</dd></div><div><dt>Päiväbonuksesta</dt><dd>{coins(bonus)} kol.</dd></div><div><dt>Omasta kassasta</dt><dd>{coins(bankroll)} kol.</dd></div></dl>;
}
