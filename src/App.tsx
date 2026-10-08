import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { ArrowRight, CalendarDays, Check, ChevronDown, CircleHelp, LogOut, RefreshCw, Settings2, Shield, Trophy, UserRound } from 'lucide-react';
import type { GameSnapshot, User } from '../shared/contracts';
import { api, ApiError, errorMessage, post } from './lib';
import { Drawer, LoadingPage, Notice, Spinner } from './components';
import { RoundPage } from './RoundPage';
import { ChampionsLeaguePage, LeaderboardPage, RulesPage } from './LeaguePages';
import { AdminPage } from './AdminPage';

const pages = [
  { path: '/today', label: 'Kierros', icon: CalendarDays },
  { path: '/leaderboard', label: 'Pörssi', icon: Trophy },
  { path: '/champions-league', label: 'Kilpailu', icon: Shield },
  { path: '/rules', label: 'Säännöt', icon: CircleHelp },
] as const;
type Page = (typeof pages)[number]['path'] | '/admin';
function currentPage(): Page { return [...pages.map(page => page.path), '/admin'].includes(window.location.pathname) ? window.location.pathname as Page : '/today'; }

export function App() {
  const [user, setUser] = useState<User | null>(null);
  const [players, setPlayers] = useState<User[]>([]);
  const [initializing, setInitializing] = useState(true);
  const [sessionError, setSessionError] = useState('');
  const [game, setGame] = useState<GameSnapshot | null>(null);
  const [gameError, setGameError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [roundId, setRoundId] = useState<string | null>(null);
  const [page, setPage] = useState<Page>(currentPage);
  const [profile, setProfile] = useState(false);
  const [changePin, setChangePin] = useState(false);
  const [initialPin, setInitialPin] = useState('');
  const [profileError, setProfileError] = useState('');
  const [signingOut, setSigningOut] = useState(false);
  const [now, setNow] = useState(Date.now());
  const serverOffset = useRef(0);
  const requestVersion = useRef(0);
  const heading = useRef<HTMLElement>(null);

  const initialize = useCallback(async () => {
    setInitializing(true); setSessionError('');
    const results = await Promise.allSettled([api<{ user: User | null }>('/api/session'), api<{ players: User[] }>('/api/players')]);
    if (results[0].status === 'fulfilled') setUser(results[0].value.user);
    else setSessionError(errorMessage(results[0].reason));
    if (results[1].status === 'fulfilled') setPlayers(results[1].value.players);
    else setSessionError(errorMessage(results[1].reason));
    setInitializing(false);
  }, []);
  useEffect(() => { void initialize(); }, [initialize]);
  useEffect(() => {
    const onPop = () => setPage(currentPage());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now() + serverOffset.current), 10_000);
    return () => window.clearInterval(id);
  }, []);

  const refresh = useCallback(async () => {
    if (!user || user.pinResetRequired) return;
    const version = ++requestVersion.current;
    setRefreshing(true);
    try {
      const snapshot = await api<GameSnapshot>(`/api/game${roundId ? `?roundId=${encodeURIComponent(roundId)}` : ''}`);
      if (version !== requestVersion.current) return;
      serverOffset.current = Date.parse(snapshot.serverTime) - Date.now();
      setNow(Date.now() + serverOffset.current);
      setGame(snapshot); setGameError('');
      if (snapshot.user.pinResetRequired) setUser(snapshot.user);
    } catch (error) {
      if (version !== requestVersion.current) return;
      if (error instanceof ApiError && error.status === 401) { setUser(null); setGame(null); setSessionError('Istunto päättyi. Kirjaudu uudelleen.'); }
      else setGameError(errorMessage(error));
    } finally { if (version === requestVersion.current) setRefreshing(false); }
  }, [user?.id, user?.pinResetRequired, roundId]);
  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, 45_000);
    const onFocus = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => { window.clearInterval(interval); window.removeEventListener('focus', onFocus); requestVersion.current++; };
  }, [refresh]);

  function navigate(next: Page) {
    if (next === page) return;
    window.history.pushState({}, '', next); setPage(next);
    window.scrollTo({ top: 0, behavior: 'instant' });
    window.setTimeout(() => heading.current?.focus(), 0);
  }
  function signedIn(nextUser: User, pin: string) { setUser(nextUser); setInitialPin(pin); setSessionError(''); setGame(null); }
  function pinChanged(nextUser: User) { setUser(nextUser); setInitialPin(''); setChangePin(false); setProfile(false); }
  async function logout() {
    setSigningOut(true); setProfileError('');
    try { await post('/api/logout'); requestVersion.current++; setUser(null); setGame(null); setRoundId(null); setProfile(false); setInitialPin(''); }
    catch (error) { setProfileError(errorMessage(error)); }
    finally { setSigningOut(false); }
  }

  if (initializing) return <div className="auth-page"><Brand /><LoadingPage /></div>;
  if (!user) return <Login players={players} error={sessionError} onRetry={initialize} onLogin={signedIn} />;
  if (user.pinResetRequired) return <div className="auth-page"><Brand /><div className="auth-panel"><PinForm user={user} initialPin={initialPin} onDone={pinChanged} required /><button type="button" className="text-button" disabled={signingOut} onClick={() => void logout()}><LogOut size={16} />Kirjaudu ulos</button>{profileError && <Notice>{profileError}</Notice>}</div></div>;

  return <>
    <a className="skip-link" href="#main">Siirry sisältöön</a>
    <header className="topbar"><div className="topbar-inner"><a href="/today" className="brand-link" onClick={event => { if (!event.metaKey && !event.ctrlKey) { event.preventDefault(); navigate('/today'); } }}><Brand compact /></a><div className="season-label">Kausi <strong>2026–27</strong></div><button type="button" className="profile-button" onClick={() => { setProfile(true); setProfileError(''); }} aria-label={`Oma tili: ${user.displayName}`}><span className="avatar">{user.displayName.slice(0, 1)}</span><span>{user.displayName}</span><ChevronDown size={14} /></button></div></header>
    <div className="app-layout">
      <nav className="main-nav" aria-label="Päänavigaatio">{pages.map(item => <a href={item.path} key={item.path} aria-current={page === item.path ? 'page' : undefined} onClick={event => { if (!event.metaKey && !event.ctrlKey) { event.preventDefault(); navigate(item.path); } }}><item.icon size={21} strokeWidth={1.8} /><span>{item.label}</span></a>)}{user.role === 'admin' && <a className="admin-nav" href="/admin" aria-current={page === '/admin' ? 'page' : undefined} onClick={event => { event.preventDefault(); navigate('/admin'); }}><Settings2 size={21} strokeWidth={1.8} /><span>Ylläpito</span></a>}</nav>
      <main id="main" tabIndex={-1} ref={heading} className="main-content">
        {gameError && <Notice><strong>{game ? 'Tiedot eivät päivittyneet.' : 'Tietoja ei voitu ladata.'}</strong> {gameError} {game && <span> Näytetään edellinen onnistunut haku. Vedonlyönti jatkuu yhteyden palattua.</span>}<button type="button" className="text-button" disabled={refreshing} onClick={() => void refresh()}><RefreshCw size={15} />Yritä uudelleen</button></Notice>}
        {!game ? (refreshing || !gameError ? <LoadingPage /> : null) : <>
          {page === '/today' && <RoundPage game={game} now={now} refreshing={refreshing} offline={Boolean(gameError)} onRoundChange={id => setRoundId(id)} onRefresh={refresh} />}
          {page === '/leaderboard' && <LeaderboardPage game={game} />}
          {page === '/champions-league' && <ChampionsLeaguePage game={game} />}
          {page === '/rules' && <RulesPage game={game} onChangePin={() => setChangePin(true)} />}
          {page === '/admin' && (user.role === 'admin' ? <AdminPage game={game} onRefresh={refresh} /> : <Notice>Ylläpito on vain liigan ylläpitäjälle.</Notice>)}
        </>}
        {game && <footer className="page-footer"><span>Pönnicup · Champions League 2026–27</span><span>Kaikki ajat Suomen aikaa</span><button className="text-button" type="button" onClick={() => void refresh()} disabled={refreshing} aria-label="Päivitä tiedot"><RefreshCw size={13} className={refreshing ? 'spin' : ''} />{refreshing ? 'Päivitetään' : 'Päivitä'}</button></footer>}
      </main>
    </div>
    {profile && !changePin && <Drawer title={user.displayName} onClose={() => setProfile(false)} busy={signingOut}><div className="profile-info"><UserRound size={24} /><p><span className="muted">{user.role === 'admin' ? 'Pelaaja ja ylläpitäjä' : 'Pelaaja'}</span></p></div>{profileError && <Notice>{profileError}</Notice>}<div className="stack"><button className="button secondary" type="button" onClick={() => setChangePin(true)}>Vaihda PIN</button>{user.role === 'admin' && <button className="button secondary" type="button" onClick={() => { setProfile(false); navigate('/admin'); }}><Settings2 size={18} />Avaa ylläpito</button>}<button className="button danger-outline" type="button" disabled={signingOut} onClick={() => void logout()}>{signingOut ? <Spinner label="Kirjaudutaan ulos" /> : <><LogOut size={18} />Kirjaudu ulos</>}</button></div></Drawer>}
    {changePin && <Drawer title="Vaihda PIN" onClose={() => setChangePin(false)}><PinForm user={user} onDone={pinChanged} /></Drawer>}
  </>;
}

function Brand({ compact = false }: { compact?: boolean }) { return <div className={`brand ${compact ? 'compact' : ''}`}><img className="brand-mark" src="/champions-league.svg" alt="UEFA Champions League" width="80" height="82" /><div><span className="brand-title">Pönnicup</span>{!compact && <small>2026–27</small>}</div></div>; }

function Login({ players, error, onRetry, onLogin }: { players: User[]; error: string; onRetry: () => Promise<void>; onLogin: (user: User, pin: string) => void }) {
  const [userId, setUserId] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const selected = userId || players[0]?.id || '';
  async function login(event: FormEvent) {
    event.preventDefault(); setBusy(true); setFormError('');
    try { const session = await post<{ user: User }>('/api/login', { userId: selected, pin }); onLogin(session.user, pin); }
    catch (err) { setFormError(errorMessage(err)); }
    finally { setBusy(false); }
  }
  return <div className="auth-page"><Brand /><div className="auth-panel"><h1>Kirjaudu sisään</h1><p className="auth-intro">Valitse pelaaja ja syötä PIN.</p>{error && <Notice>{error}<button type="button" className="text-button" onClick={() => void onRetry()}>Yritä uudelleen</button></Notice>}<form onSubmit={event => void login(event)} className="stack"><fieldset className="player-picker" disabled={busy || players.length === 0}><legend>Pelaaja</legend><div className="player-options">{players.map(player => <label key={player.id} className={selected === player.id ? 'selected' : ''}><input type="radio" name="player" value={player.id} checked={selected === player.id} onChange={() => setUserId(player.id)} /><span className="player-initial">{player.displayName.slice(0, 1)}</span><span>{player.displayName}</span>{selected === player.id && <Check size={14} />}</label>)}</div></fieldset><label className="field">PIN<input type="password" inputMode="numeric" pattern="[0-9]{6,32}" minLength={6} maxLength={32} autoComplete="current-password" value={pin} onChange={event => setPin(event.target.value)} disabled={busy} required aria-describedby="pin-login-help" /></label><p id="pin-login-help" className="field-help">Oma 6–32 numeron PIN. Ensimmäisellä kerralla käytä saamaasi aloitus-PINiä.</p>{formError && <Notice>{formError}</Notice>}<button className="button primary wide" type="submit" disabled={busy || !selected || pin.length < 6}>{busy ? <Spinner label="Kirjaudutaan" /> : <>Kirjaudu sisään<ArrowRight size={19} /></>}</button></form><details className="login-help"><summary>PIN unohtui?</summary><p>Pyydä liigan ylläpitäjää palauttamaan PIN. Pelaajatunnuksesi ja vetosi säilyvät.</p></details></div></div>;
}

function PinForm({ user, initialPin = '', onDone, required = false }: { user: User; initialPin?: string; onDone: (user: User) => void; required?: boolean }) {
  const [currentPin, setCurrentPin] = useState(initialPin);
  const [newPin, setNewPin] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(event: FormEvent) {
    event.preventDefault(); setError('');
    if (newPin !== confirmation) { setError('Uudet PINit eivät täsmää. Tarkista molemmat kentät.'); return; }
    if (newPin === currentPin) { setError('Valitse eri PIN kuin nykyinen.'); return; }
    setBusy(true);
    try { const response = await post<{ user: User }>('/api/pin', { currentPin, newPin }); onDone(response.user); }
    catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  }
  return <form className="stack" onSubmit={event => void save(event)}>{required && <><h1>Oma PIN, {user.displayName}.</h1><p>Vaihda aloitus-PIN ennen ensimmäistä vetoa. Valitse 6–32 numeroa, jotka muistat itse.</p></>}<label className="field">Nykyinen PIN<input type="password" autoComplete="current-password" inputMode="numeric" pattern="[0-9]{6,32}" minLength={6} maxLength={32} value={currentPin} onChange={event => setCurrentPin(event.target.value)} disabled={busy} required /></label><label className="field">Uusi PIN<input type="password" autoComplete="new-password" inputMode="numeric" pattern="[0-9]{6,32}" minLength={6} maxLength={32} value={newPin} onChange={event => setNewPin(event.target.value)} disabled={busy} required /></label><label className="field">Uusi PIN uudelleen<input type="password" autoComplete="new-password" inputMode="numeric" pattern="[0-9]{6,32}" minLength={6} maxLength={32} value={confirmation} onChange={event => setConfirmation(event.target.value)} disabled={busy} required /></label>{error && <Notice>{error}</Notice>}<button className="button primary" type="submit" disabled={busy || newPin.length < 6 || currentPin.length < 6 || confirmation.length < 6}>{busy ? <Spinner label="Tallennetaan" /> : required ? 'Tallenna PIN ja pelaa' : 'Tallenna uusi PIN'}</button></form>;
}
