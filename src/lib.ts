import type { Match, Market, Round, Stage } from '../shared/contracts';

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 45_000);
  try {
    const response = await fetch(path, {
      ...options,
      credentials: 'same-origin',
      signal: options.signal ?? controller.signal,
      headers: { Accept: 'application/json', ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    });
    const payload = await response.json().catch(() => null) as (T & { error?: string }) | null;
    if (!response.ok) throw new ApiError(payload?.error ?? `Pyyntö epäonnistui (${response.status}). Yritä uudelleen.`, response.status);
    if (!payload) throw new Error('Palvelin ei palauttanut tietoja. Yritä uudelleen.');
    return payload;
  } catch (error) {
    if (error instanceof TypeError) throw new Error('Yhteys katkesi. Tarkista verkkoyhteys ja yritä uudelleen.');
    if (error instanceof DOMException && error.name === 'AbortError') throw new Error('Palvelin ei vastannut ajoissa. Yritä uudelleen.');
    throw error;
  } finally { window.clearTimeout(timeout); }
}

export function post<T>(path: string, body: unknown = {}): Promise<T> {
  return api<T>(path, { method: 'POST', body: JSON.stringify(body) });
}

export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'Jokin meni pieleen. Yritä uudelleen.'; }
export const coins = (value: number) => new Intl.NumberFormat('fi-FI', { maximumFractionDigits: 2 }).format(value);
export const odds = (value: number) => value.toFixed(2).replace('.', ',');
export const time = (value: string) => new Intl.DateTimeFormat('fi-FI', { timeZone: 'Europe/Helsinki', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
export const date = (value: string, weekday = true) => new Intl.DateTimeFormat('fi-FI', { timeZone: 'Europe/Helsinki', ...(weekday ? { weekday: 'long' as const } : {}), day: 'numeric', month: 'numeric' }).format(new Date(value.length === 10 ? `${value}T12:00:00Z` : value));
export const dateTime = (value: string) => `${date(value, false)} klo ${time(value)}`;
export function finlandDate(value: number | Date = Date.now()): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Helsinki', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
}
export const stageLabel: Record<Stage, string> = { league: 'Liigavaihe', playoff: 'Pudotuspelikarsinta', round_of_16: 'Neljännesvälierät', quarter_final: 'Puolivälierät', semi_final: 'Välierät', final: 'Finaali' };
export const roundLabel = (round: Round) => round.stage === 'league' ? `Kierros ${round.number}` : round.name;
export function canBet(match: Match, market: Market, now: number): boolean {
  return match.eligible && match.status === 'scheduled' && Date.parse(match.kickoffAtUtc) > now && market.status === 'open' && market.selections.length > 0;
}
export const marketLabel = (market: Market) => ({ main_1x2: 'Ottelun voittaja · 90 min', exact_score: 'Tarkka tulos · 90 min', anytime_goalscorer: 'Maalintekijä · 90 min' })[market.type];
export const resultLabel = { placed: 'Jätetty', won: 'Voitto', lost: 'Ohi', voided: 'Palautettu', cancelled: 'Peruttu' };
