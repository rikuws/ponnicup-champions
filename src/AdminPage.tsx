import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { Check, Clock3, Database, RefreshCw, Save, Settings2, ShieldAlert } from 'lucide-react';
import type { AdminSnapshot, Config, GameSnapshot, Match, ResultInput } from '../shared/contracts';
import { api, dateTime, errorMessage, post, roundLabel } from './lib';
import { EmptyState, Notice, Spinner } from './components';
import { ManualTools } from './ManualAdmin';

export function AdminPage({ game, onRefresh }: { game: GameSnapshot; onRefresh: () => Promise<void> }) {
  const [admin, setAdmin] = useState<AdminSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [tab, setTab] = useState<'results' | 'config' | 'audit'>('results');
  const load = useCallback(async () => {
    setLoading(true);
    try { setAdmin(await api<AdminSnapshot>('/api/admin')); setError(''); }
    catch (err) { setError(errorMessage(err)); }
    finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  async function sync() {
    setSyncing(true); setError(''); setMessage('');
    try {
      const response = await post<{ ok: boolean; summary: unknown }>('/api/admin/sync');
      if (!response.ok) throw new Error('Tietojen päivitys ei valmistunut. Tarkista lähteiden tila.');
      setMessage('Päivitysajo valmistui. Tarkista lähteiden tila ja selvitystä odottavat ottelut.');
      await Promise.all([load(), onRefresh()]);
    } catch (err) { setError(errorMessage(err)); }
    finally { setSyncing(false); }
  }
  async function saved(text: string) { setMessage(text); await Promise.all([load(), onRefresh()]); }
  return <div className="admin-page"><div className="page-heading"><div><h1>Liigan ylläpito</h1><p>Tulokset, pelisäännöt ja muutosten jäljet.</p></div><button type="button" className="button primary" onClick={() => void sync()} disabled={syncing}>{syncing ? <Spinner label="Päivitetään" /> : <><RefreshCw size={17} />Päivitä tiedot</>}</button></div>{error && <Notice>{error}<button className="text-button" type="button" disabled={loading} onClick={() => void load()}>Yritä uudelleen</button></Notice>}{message && <Notice tone="success" onDismiss={() => setMessage('')}>{message}</Notice>}<section className="admin-sources" aria-labelledby="source-title"><h2 id="source-title"><Database size={19} />Tietolähteet</h2>{(admin?.sync ?? game.sync).length === 0 && <p className="muted">Tietolähteitä ei ole vielä määritetty.</p>}{(admin?.sync ?? game.sync).map(source => <div className="source-row" key={source.provider}><div><strong>{source.provider}</strong><span>{source.lastSuccessAt ? `Viimeksi onnistui ${dateTime(source.lastSuccessAt)}` : 'Ei vielä onnistunutta päivitystä'}</span>{source.lastError && <p className="error-text">{source.lastError}</p>}</div><span className={`source-status ${source.lastError ? 'failed' : source.enabled ? 'enabled' : ''}`}>{!source.enabled ? 'Ei käytössä' : source.lastError ? 'Tarkista yhteys' : source.lastSuccessAt ? 'Toiminnassa' : 'Odottaa ajoa'}</span></div>)}</section><div className="filter-group section-filter" aria-label="Ylläpidon osa"><button type="button" aria-pressed={tab === 'results'} onClick={() => setTab('results')}>Tuloksen korjaus{Boolean(admin?.pendingMatches.length) && <span>{admin!.pendingMatches.length}</span>}</button><button type="button" aria-pressed={tab === 'config'} onClick={() => setTab('config')}>Pelin asetukset</button><button type="button" aria-pressed={tab === 'audit'} onClick={() => setTab('audit')}>Tapahtumaloki</button></div>
    {tab === 'results' && <><ManualTools game={game} admin={admin} onSaved={saved} /><ResultForm game={game} onSaved={() => saved('Tulos tallennettu ja vedot laskettu uudelleen.')} />{admin && admin.pendingMatches.length > 0 && <section className="pending-matches"><h2>Selvitystä odottavat ottelut</h2><p className="muted small-text">Valitse ottelun kierros yllä, jos haluat korjata tuloksen.</p>{admin.pendingMatches.map(match => <div key={match.id}><Clock3 size={16} /><strong>{match.home} – {match.away}</strong><span>{dateTime(match.kickoffAtUtc)}</span>{match.homeScore !== null && <b>{match.homeScore}–{match.awayScore}</b>}</div>)}</section>}</>}
    {tab === 'config' && <ConfigForm key={JSON.stringify(game.season.config)} initial={game.season.config} onSaved={() => saved('Asetukset tallennettu. Muutos näkyy tapahtumalokissa.')} />}
    {tab === 'audit' && <section className="audit-section"><h2>Mitä liigassa muutettiin</h2>{loading && !admin ? <Spinner /> : !admin?.audit.length ? <EmptyState title="Ei vielä ylläpidon muutoksia."><p>Tulosten korjaukset ja sääntömuutokset kirjataan tänne perusteluineen.</p></EmptyState> : <ol className="audit-list">{admin.audit.map(entry => <li key={entry.id}><div><strong>{auditLabel(entry.action)}</strong><time dateTime={entry.createdAt}>{dateTime(entry.createdAt)}</time></div><p>{entry.reason}</p><span>{entry.actor ?? 'Automaattinen päivitys'}</span></li>)}</ol>}</section>}
  </div>;
}

function ResultForm({ game, onSaved }: { game: GameSnapshot; onSaved: () => Promise<void> }) {
  const [roundId, setRoundId] = useState(game.selectedRoundId ?? '');
  const [matches, setMatches] = useState(game.matches);
  const [matchId, setMatchId] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [home, setHome] = useState('');
  const [away, setAway] = useState('');
  const [finalHome, setFinalHome] = useState('');
  const [finalAway, setFinalAway] = useState('');
  const [status, setStatus] = useState<Match['status']>('final');
  const [advancing, setAdvancing] = useState('');
  const [reason, setReason] = useState('');
  const [scorers, setScorers] = useState<string[]>([]);
  const [appeared, setAppeared] = useState<string[]>([]);
  const [registered, setRegistered] = useState<string[]>([]);
  const [releaseOverride, setReleaseOverride] = useState(false);
  const [complete, setComplete] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const generation = useRef(0);
  const match = matches.find(item => item.id === matchId);
  const playerSelections = [...new Map((match?.markets.filter(market => market.type === 'anytime_goalscorer').flatMap(market => market.selections) ?? []).filter(selection => selection.playerId).map(selection => [selection.playerId, selection])).values()];

  async function loadRound(id: string) {
    const version = ++generation.current;
    setRoundId(id); setLoading(true); setError(''); setMatchId('');
    try { const result = await api<GameSnapshot>(`/api/game?roundId=${encodeURIComponent(id)}`); if (version === generation.current) setMatches(result.matches); }
    catch (err) { if (version === generation.current) { setError(errorMessage(err)); setMatches([]); } }
    finally { if (version === generation.current) setLoading(false); }
  }
  function selectMatch(id: string) {
    setMatchId(id); const next = matches.find(item => item.id === id);
    setHome(next?.homeScore === null || next?.homeScore === undefined ? '' : String(next.homeScore));
    setAway(next?.awayScore === null || next?.awayScore === undefined ? '' : String(next.awayScore));
    setFinalHome(''); setFinalAway(''); setAdvancing(''); setScorers([]); setAppeared([]); setRegistered([]); setReleaseOverride(false); setComplete(false); setReason(''); setConfirmed(false); setError('');
    setStatus(next?.status === 'cancelled' || next?.status === 'postponed' ? next.status : 'final');
  }
  async function save(event: FormEvent) {
    event.preventDefault(); if (!match || !confirmed) return;
    if (scorers.some(id => !appeared.includes(id))) { setError('Merkitse maalintekijät myös kentällä käyneiksi pelaajiksi.'); return; }
    const input: ResultInput = { matchId: match.id, homeScore: home === '' ? null : Number(home), awayScore: away === '' ? null : Number(away), status, releaseOverride, reason: reason.trim(), registeredPlayerIds: complete ? [...new Set([...registered, ...appeared])] : undefined, scorerDataComplete: complete, scorerPlayerIds: complete ? scorers : undefined, appearedPlayerIds: complete ? appeared : undefined, ...(finalHome !== '' ? { homeScoreFinal: Number(finalHome) } : {}), ...(finalAway !== '' ? { awayScoreFinal: Number(finalAway) } : {}), ...(advancing ? { advancingTeamId: advancing } : {}) };
    setBusy(true); setError('');
    try { await post('/api/admin/results', input); setConfirmed(false); await onSaved(); }
    catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  }
  return <form className="admin-form" onSubmit={event => void save(event)}><div className="form-heading"><Settings2 size={20} /><div><h2>Korjaa ottelun tulos</h2><p>Korjaus laskee ottelun vedot ja palautukset uudelleen.</p></div></div><div className="form-two-columns"><label className="field">Kierros<select value={roundId} disabled={busy || loading} onChange={event => void loadRound(event.target.value)}><option value="" disabled>Valitse kierros</option>{game.rounds.map(round => <option key={round.id} value={round.id}>{roundLabel(round)}</option>)}</select></label><label className="field">Ottelu<select value={matchId} disabled={busy || loading} onChange={event => selectMatch(event.target.value)} required><option value="">{loading ? 'Haetaan otteluita…' : 'Valitse ottelu'}</option>{matches.map(item => <option key={item.id} value={item.id}>{item.homeTeam.shortName} – {item.awayTeam.shortName} · {dateTime(item.kickoffAtUtc)}</option>)}</select></label></div>{matches.length === 0 && !loading && <p className="muted small-text">Tällä kierroksella ei ole vielä otteluita.</p>}{match && <><label className="field">Ottelun tila<select value={status} disabled={busy} onChange={event => { setStatus(event.target.value as Match['status']); setConfirmed(false); }}><option value="final">Päättynyt</option><option value="postponed">Siirretty</option><option value="cancelled">Peruttu · palautetaan vedot</option></select></label><fieldset className="score-fields" disabled={busy}><legend>Varsinainen peliaika · 90 min</legend><div><label className="field">{match.homeTeam.shortName}<input type="number" min="0" max="30" step="1" value={home} onChange={event => { setHome(event.target.value); setConfirmed(false); }} required={status === 'final'} /></label><span>–</span><label className="field">{match.awayTeam.shortName}<input type="number" min="0" max="30" step="1" value={away} onChange={event => { setAway(event.target.value); setConfirmed(false); }} required={status === 'final'} /></label></div></fieldset>{match.stage !== 'league' && <details className="advanced-result"><summary>Jatkoaika ja jatkoonmenijä</summary><p className="small-text muted">Jatkoajan sisältävä ottelutulos syötetään ilman rangaistuspotkukilpailun maaleja. Jatkoonmenijä viittaa koko ottelupariin.</p><div className="form-two-columns"><label className="field">Kotimaalit jatkoajan jälkeen<input type="number" min="0" max="30" step="1" value={finalHome} onChange={event => { setFinalHome(event.target.value); setConfirmed(false); }} disabled={busy} /></label><label className="field">Vierasmaalit jatkoajan jälkeen<input type="number" min="0" max="30" step="1" value={finalAway} onChange={event => { setFinalAway(event.target.value); setConfirmed(false); }} disabled={busy} /></label></div><label className="field">Vahvistettu jatkoonmenijä<select value={advancing} onChange={event => { setAdvancing(event.target.value); setConfirmed(false); }} disabled={busy}><option value="">Ei erikseen vahvistettu</option><option value={match.homeTeam.id}>{match.homeTeam.name}</option><option value={match.awayTeam.id}>{match.awayTeam.name}</option></select></label></details>}
      <details className="advanced-result"><summary>Maalintekijät ja osallistuminen</summary><p className="small-text muted">Merkitse kentällä käyneet pelaajat, vahvistetut pelaamatta jääneet ja 90 minuutin maalintekijät. Jos osallistumista ei tiedetä, jätä molemmat ruudut tyhjiksi: veto jää odottamaan.</p>{playerSelections.length === 0 ? <p className="muted small-text">Ottelulle ei ole saatavilla maalintekijävalintoja.</p> : <><div className="scorer-check-heading"><span>Pelaaja</span><span>Kentällä</span><span>Ei pelannut</span><span>Maali</span></div>{playerSelections.map(selection => <div className="scorer-check" key={selection.id}><span>{selection.label}</span><label><span className="sr-only">{selection.label} kävi kentällä</span><input type="checkbox" checked={appeared.includes(selection.playerId!)} disabled={busy} onChange={event => { setAppeared(current => event.target.checked ? [...current, selection.playerId!] : current.filter(id => id !== selection.playerId)); if (event.target.checked) setRegistered(current => current.filter(id => id !== selection.playerId)); setConfirmed(false); }} /></label><label><span className="sr-only">{selection.label} ei pelannut, tieto vahvistettu</span><input type="checkbox" checked={registered.includes(selection.playerId!)} disabled={busy} onChange={event => { setRegistered(current => event.target.checked ? [...current, selection.playerId!] : current.filter(id => id !== selection.playerId)); if (event.target.checked) { setAppeared(current => current.filter(id => id !== selection.playerId)); setScorers(current => current.filter(id => id !== selection.playerId)); } setConfirmed(false); }} /></label><label><span className="sr-only">{selection.label} teki maalin</span><input type="checkbox" checked={scorers.includes(selection.playerId!)} disabled={busy} onChange={event => { setScorers(current => event.target.checked ? [...current, selection.playerId!] : current.filter(id => id !== selection.playerId)); if (event.target.checked) { setAppeared(current => [...new Set([...current, selection.playerId!])]); setRegistered(current => current.filter(id => id !== selection.playerId)); } setConfirmed(false); }} /></label></div>)}<label className="check-label"><input type="checkbox" checked={complete} onChange={event => { setComplete(event.target.checked); setConfirmed(false); }} disabled={busy} />Maalintekijät ja merkitsemäni osallistumistiedot on tarkistettu.</label></>}</details>
      <label className="field">Korjauksen perustelu<textarea minLength={5} value={reason} onChange={event => { setReason(event.target.value); setConfirmed(false); }} placeholder="Esim. tarkistettu UEFA:n otteluraportista, 90 min tulos oli…" required disabled={busy} rows={3} /></label><label className="check-label"><input type="checkbox" checked={releaseOverride} onChange={event => { setReleaseOverride(event.target.checked); setConfirmed(false); }} disabled={busy} />Palauta automaattinen tulospäivitys. Muuten käsin korjattu tulos säilyy suojattuna tietolähteen päivityksiltä.</label><div className="admin-confirmation"><ShieldAlert size={19} /><label className="check-label"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} disabled={busy} />Olen tarkistanut tiedot. Hyväksyn vetojen ja palautusten uudelleenlaskennan.</label></div></>}{error && <Notice>{error}</Notice>}<button type="submit" className="button primary" disabled={busy || !match || !confirmed || reason.trim().length < 5}>{busy ? <Spinner label="Lasketaan vetoja" /> : <><Save size={17} />Tallenna korjaus</>}</button></form>;
}

function ConfigForm({ initial, onSaved }: { initial: Config; onSaved: () => Promise<void> }) {
  const [config, setConfig] = useState(initial);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fields: { key: keyof Config; label: string; help: string }[] = [
    { key: 'startingBalance', label: 'Aloituskassa', help: 'Uuden kausiosallistujan alkukassa.' },
    { key: 'dailyBonus', label: 'Päiväbonus', help: 'Ottelupäivän yhteinen bonuspotti pelaajaa kohti.' },
    { key: 'minimumStake', label: 'Pienin panos', help: 'Kaikkien uusien vetojen vähimmäispanos.' },
    { key: 'recoveryThreshold', label: 'Bonuksen kassaan siirron raja', help: 'Käyttämätön bonus siirtyy kassaan, kun vapaa kassa alittaa tämän rajan.' },
  ];
  async function save(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try { await post('/api/admin/config', { config, reason: reason.trim() }); setReason(''); await onSaved(); }
    catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  }
  return <form className="admin-form" onSubmit={event => void save(event)}><h2>Pelin kolikkosäännöt</h2><p className="muted">Sovi muutokset porukan kanssa. Jo myönnetyt kassasaldot ja päiväbonukset säilyvät; asetukset koskevat uusia myöntöjä ja vetoja.</p><div className="form-two-columns">{fields.map(field => <label className="field" key={field.key}>{field.label}<div className="unit-input"><input type="number" min={field.key === 'minimumStake' ? 1 : 0} step="1" required value={Number.isNaN(config[field.key]) ? '' : config[field.key]} onChange={event => setConfig(current => ({ ...current, [field.key]: event.target.value === '' ? NaN : Number(event.target.value) }))} disabled={busy} /><span>kol.</span></div><span className="field-help">{field.help}</span></label>)}</div><label className="field">Muutoksen perustelu<textarea value={reason} onChange={event => setReason(event.target.value)} minLength={5} required rows={3} disabled={busy} placeholder="Mitä muutetaan ja miksi?" /></label>{error && <Notice>{error}</Notice>}<button type="submit" className="button primary" disabled={busy || reason.trim().length < 5 || Object.values(config).some(value => !Number.isFinite(value)) || JSON.stringify(config) === JSON.stringify(initial)}>{busy ? <Spinner label="Tallennetaan" /> : <><Check size={17} />Tallenna asetukset</>}</button></form>;
}

function auditLabel(action: string) { return ({ match_result: 'Ottelun tulos', result_override: 'Tuloksen korjaus', result_override_enabled: 'Tuloksen käsikorjaus suojattu', result_override_released: 'Automaattinen tulospäivitys palautettu', manual_match: 'Ottelu lisätty käsin', manual_odds: 'Kertoimet syötetty käsin', config_update: 'Pelin asetukset', manual_result: 'Tuloksen korjaus', sync: 'Tietojen päivitys', pin_reset: 'PIN palautettu' } as Record<string, string>)[action] ?? action.replaceAll('_', ' '); }
