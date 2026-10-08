import { useState, type FormEvent } from 'react';
import { CalendarPlus, ChevronDown, Coins, Plus, Save } from 'lucide-react';
import type { AdminSnapshot, GameSnapshot, ManualMatchInput, ManualOddsInput } from '../shared/contracts';
import { dateTime, errorMessage, post, roundLabel } from './lib';
import { Notice, Spinner } from './components';

export function ManualTools({ game, admin, onSaved }: { game: GameSnapshot; admin: AdminSnapshot | null; onSaved: (message: string) => Promise<void> }) {
  const manual = game.sync.every(source => !source.enabled);
  return <section className="manual-tools" aria-labelledby="manual-title"><div className="manual-heading"><h2 id="manual-title">Ottelut ja kertoimet</h2><p>{manual ? 'Automaattiset tietolähteet eivät ole käytössä. Lisää vahvistetut ottelut ja kertoimet käsin.' : 'Voit täydentää tai korjata ottelutarjontaa myös käsin.'}</p></div><details className="manual-disclosure"><summary><CalendarPlus size={19} /><span>Lisää ottelu</span><ChevronDown size={17} /></summary><ManualFixture game={game} onSaved={onSaved} /></details><details className="manual-disclosure"><summary><Coins size={19} /><span>Syötä kertoimet</span><ChevronDown size={17} /></summary><ManualOdds game={game} admin={admin} onSaved={onSaved} /></details></section>;
}

function ManualFixture({ game, onSaved }: { game: GameSnapshot; onSaved: (message: string) => Promise<void> }) {
  const [homeName, setHomeName] = useState('');
  const [awayName, setAwayName] = useState('');
  const [kickoff, setKickoff] = useState('');
  const [roundId, setRoundId] = useState(game.selectedRoundId ?? '');
  const [leg, setLeg] = useState('');
  const [tieId, setTieId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const round = game.rounds.find(item => item.id === roundId);
  const knockout = round && round.stage !== 'league' && round.stage !== 'final';
  const ties = game.ties.filter(tie => tie.stage === round?.stage);

  async function save(event: FormEvent) {
    event.preventDefault(); if (!round) return;
    setBusy(true); setError('');
    try {
      const input: ManualMatchInput = { homeName: homeName.trim(), awayName: awayName.trim(), kickoffAtUtc: helsinkiInputToUtc(kickoff), roundId, stage: round.stage, reason: reason.trim(), ...(knockout ? { leg: leg ? Number(leg) : null, tieId: tieId || null } : {}) };
      await post('/api/admin/matches', input);
      setHomeName(''); setAwayName(''); setKickoff(''); setReason('');
      await onSaved('Ottelu lisätty. Syötä sille kertoimet, niin porukka pääsee jättämään vetoja.');
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  }
  return <form className="manual-form" onSubmit={event => void save(event)}><p className="small-text muted">Käytä vahvistettua otteluohjelmaa. Uusi ottelu näkyy porukalle ilman kertoimia, kunnes syötät ne erikseen.</p><div className="form-two-columns"><label className="field">Kotijoukkue<input value={homeName} onChange={event => setHomeName(event.target.value)} required maxLength={100} disabled={busy} autoComplete="off" /></label><label className="field">Vierasjoukkue<input value={awayName} onChange={event => setAwayName(event.target.value)} required maxLength={100} disabled={busy} autoComplete="off" /></label></div><div className="form-two-columns"><label className="field">Kierros<select value={roundId} required disabled={busy} onChange={event => { setRoundId(event.target.value); setLeg(''); setTieId(''); }}><option value="" disabled>Valitse kierros</option>{game.rounds.map(item => <option key={item.id} value={item.id}>{roundLabel(item)}</option>)}</select></label><label className="field">Avauspotku · Suomen aikaa<input type="datetime-local" value={kickoff} onChange={event => setKickoff(event.target.value)} required disabled={busy} /></label></div>{knockout && <div className="form-two-columns"><label className="field">Osaottelu<select value={leg} onChange={event => setLeg(event.target.value)} required disabled={busy}><option value="">Valitse osaottelu</option><option value="1">1. osaottelu</option><option value="2">2. osaottelu</option></select></label><label className="field">Ottelupari<select value={tieId} onChange={event => setTieId(event.target.value)} disabled={busy}><option value="">Uusi ottelupari</option>{ties.map(tie => <option key={tie.id} value={tie.id}>{tie.homeTeam.shortName} – {tie.awayTeam.shortName}</option>)}</select><span className="field-help">Valitse toiselle osalle sama ottelupari kuin ensimmäiselle.</span></label></div>}<label className="field">Lähde ja perustelu<textarea rows={2} value={reason} onChange={event => setReason(event.target.value)} required minLength={5} disabled={busy} placeholder="Mistä ottelu ja avauspotkun aika on tarkistettu?" /></label>{error && <Notice>{error}</Notice>}<button className="button primary" type="submit" disabled={busy || !round || !homeName.trim() || !awayName.trim() || !kickoff || reason.trim().length < 5}>{busy ? <Spinner label="Lisätään ottelua" /> : <><Plus size={17} />Lisää ottelu</>}</button></form>;
}

function ManualOdds({ game, admin, onSaved }: { game: GameSnapshot; admin: AdminSnapshot | null; onSaved: (message: string) => Promise<void> }) {
  const [matchId, setMatchId] = useState('');
  const [home, setHome] = useState('');
  const [draw, setDraw] = useState('');
  const [away, setAway] = useState('');
  const [scores, setScores] = useState('');
  const [scorers, setScorers] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fixtures = admin?.fixtures ?? game.matches.map(match => ({ id: match.id, home: match.homeTeam.name, away: match.awayTeam.name, kickoffAtUtc: match.kickoffAtUtc, status: match.status }));
  const future = fixtures.filter(match => match.status === 'scheduled' && Date.parse(match.kickoffAtUtc) > Date.parse(game.serverTime));

  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const exactScores = scores.trim() ? scores.trim().split('\n').filter(row => row.trim()).map((row, index) => {
        const match = row.trim().match(/^(\d{1,2})\s*[-–:]\s*(\d{1,2})\s*;\s*(\d+(?:[.,]\d+)?)$/);
        if (!match) throw new Error(`Tarkan tuloksen rivi ${index + 1}: käytä muotoa kotimaalit-vierasmaalit;kerroin.`);
        return { home: Number(match[1]), away: Number(match[2]), odds: parseOdds(match[3]) };
      }) : undefined;
      const scorerList = scorers.trim() ? scorers.trim().split('\n').filter(row => row.trim()).map((row, index) => {
        const parts = row.split(';');
        if (parts.length !== 2 || !parts[0].trim()) throw new Error(`Maalintekijän rivi ${index + 1}: käytä muotoa pelaajan nimi;kerroin.`);
        return { name: parts[0].trim(), odds: parseOdds(parts[1]) };
      }) : undefined;
      const input: ManualOddsInput = { matchId, home: parseOdds(home), draw: parseOdds(draw), away: parseOdds(away), exactScores, scorers: scorerList, reason: reason.trim() };
      await post('/api/admin/odds', input);
      setHome(''); setDraw(''); setAway(''); setScores(''); setScorers(''); setReason('');
      await onSaved('Kertoimet tallennettu. Avoimiin kohteisiin voi nyt jättää vetoja.');
    } catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  }
  return <form className="manual-form" onSubmit={event => void save(event)}><p className="small-text muted">Syötä porukan käyttämät vahvistetut kertoimet. Kohteen kertoimet lukitaan avattaessa. Voit vielä lisätä avaamattomat lisävedot.</p><label className="field">Ottelu<select value={matchId} onChange={event => { setMatchId(event.target.value); setHome(''); setDraw(''); setAway(''); setScores(''); setScorers(''); }} disabled={busy} required><option value="">Valitse tuleva ottelu</option>{future.map(match => <option key={match.id} value={match.id}>{match.home} – {match.away} · {dateTime(match.kickoffAtUtc)}</option>)}</select></label>{future.length === 0 && <p className="small-text muted">Ei tulevia otteluita. Lisää ensin ottelu yllä.</p>}<fieldset disabled={busy} className="manual-1x2"><legend>1X2 · normaali peliaika</legend><div>{[{ key: 'home', label: '1 · Koti', value: home, update: setHome }, { key: 'draw', label: 'X · Tasapeli', value: draw, update: setDraw }, { key: 'away', label: '2 · Vieras', value: away, update: setAway }].map(field => <label className="field" key={field.key}>{field.label}<input inputMode="decimal" value={field.value} onChange={event => field.update(event.target.value)} required pattern="[0-9]+([.,][0-9]+)?" /></label>)}</div></fieldset><details className="advanced-result"><summary>Tarkat tulokset ja maalintekijät</summary><label className="field">Tarkat tulokset<textarea rows={4} value={scores} disabled={busy} onChange={event => setScores(event.target.value)} spellCheck={false} /><span className="field-help">Yksi tulos per rivi: kotimaalit-vierasmaalit;kerroin. Erota tulos ja kerroin puolipisteellä. Jätä tyhjäksi, jos kohdetta ei avata.</span></label><label className="field">Maalintekijät<textarea rows={4} value={scorers} disabled={busy} onChange={event => setScorers(event.target.value)} spellCheck={false} /><span className="field-help">Yksi pelaaja per rivi: pelaajan nimi;kerroin. Käytä pelaajan koko nimeä. Jätä tyhjäksi, jos kohdetta ei avata.</span></label></details><label className="field">Lähde ja perustelu<textarea rows={2} value={reason} onChange={event => setReason(event.target.value)} required minLength={5} disabled={busy} placeholder="Mistä kertoimet on tarkistettu tai miten porukka sopi ne?" /></label>{error && <Notice>{error}</Notice>}<button className="button primary" type="submit" disabled={busy || !matchId || !home || !draw || !away || reason.trim().length < 5}>{busy ? <Spinner label="Tallennetaan kertoimia" /> : <><Save size={17} />Tallenna kertoimet</>}</button></form>;
}

function parseOdds(value: string): number {
  const result = Number(value.trim().replace(',', '.'));
  if (!Number.isFinite(result) || result <= 1) throw new Error('Jokaisen desimaalikertoimen pitää olla suurempi kuin 1.');
  return result;
}

function helsinkiInputToUtc(value: string): string {
  const components = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!components) throw new Error('Anna kelvollinen avauspotkun päivämäärä ja aika.');
  const [, year, month, day, hour, minute] = components.map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  const formatter = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  let guess = wall;
  for (let step = 0; step < 3; step++) {
    const parts = Object.fromEntries(formatter.formatToParts(new Date(guess)).map(part => [part.type, part.value]));
    const rendered = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
    if (rendered === wall) return new Date(guess).toISOString();
    guess += wall - rendered;
  }
  throw new Error('Kellonaikaa ei ole Suomen aikavyöhykkeellä kellonsiirron vuoksi. Tarkista avauspotkun aika.');
}
