import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, Check, CircleHelp, LoaderCircle, Shield, X } from 'lucide-react';
import type { Team } from '../shared/contracts';

export function Spinner({ label = 'Ladataan' }: { label?: string }) {
  return <span className="spinner-label"><LoaderCircle className="spin" size={18} aria-hidden="true" />{label}</span>;
}

export function Notice({ children, tone = 'error', onDismiss }: { children: ReactNode; tone?: 'error' | 'success' | 'info'; onDismiss?: () => void }) {
  const Icon = tone === 'success' ? Check : tone === 'info' ? CircleHelp : AlertCircle;
  return <div className={`notice notice-${tone}`} role={tone === 'error' ? 'alert' : 'status'}><Icon size={19} aria-hidden="true" /><div>{children}</div>{onDismiss && <button type="button" className="icon-button" aria-label="Sulje ilmoitus" onClick={onDismiss}><X size={18} /></button>}</div>;
}

export function EmptyState({ title, children, icon }: { title: string; children: ReactNode; icon?: ReactNode }) {
  return <div className="empty-state">{icon && <div className="empty-icon" aria-hidden="true">{icon}</div>}<h2>{title}</h2><div>{children}</div></div>;
}

export function TeamMark({ team, small = false }: { team: Team; small?: boolean }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [team.crest]);
  const src = team.crest && (/^https:\/\//.test(team.crest) || /^\/(?!\/)/.test(team.crest)) ? team.crest : null;
  return <span className={`team-mark ${small ? 'small' : ''}`} aria-hidden="true">{src && !failed ? <img src={src} onError={() => setFailed(true)} alt="" loading="lazy" /> : <Shield strokeWidth={1.5} />}</span>;
}

export function Drawer({ title, children, onClose, busy = false }: { title: string; children: ReactNode; onClose: () => void; busy?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const element = dialog.current;
    const trigger = document.activeElement as HTMLElement | null;
    element?.showModal();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { element?.close(); document.body.style.overflow = previousOverflow; trigger?.focus(); };
  }, []);
  return <dialog ref={dialog} className="drawer" aria-labelledby="drawer-title" onCancel={event => { event.preventDefault(); if (!busy) onCloseRef.current(); }} onClick={event => { if (event.target === event.currentTarget && !busy) { const rect = event.currentTarget.getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose(); } }}>
    <div className="drawer-header"><h2 id="drawer-title">{title}</h2><button type="button" className="icon-button" onClick={onClose} disabled={busy} aria-label="Sulje"><X /></button></div>
    <div className="drawer-content">{children}</div>
  </dialog>;
}

export function LoadingPage() { return <div className="loading-page" aria-busy="true"><Spinner label="Haetaan kierroksen tiedot" /><div className="loading-lines" aria-hidden="true"><span /><span /><span /></div></div>; }
