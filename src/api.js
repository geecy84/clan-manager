// Thin Clash Royale API client. Base URL is configurable so the RoyaleAPI proxy can be used.
export const CLAN_TAG = '#' + (process.env.CLAN_TAG || '#292GQ80L').replace(/^#/, '').toUpperCase();
const BASE = (process.env.CR_API_BASE || 'https://api.clashroyale.com/v1').replace(/\/$/, '');

export const normTag = (t) => '#' + String(t || '').replace(/^#/, '').toUpperCase();
export const tagPath = (t) => '%23' + normTag(t).slice(1);

export async function cr(pathname) {
  const key = process.env.CR_API_KEY;
  if (!key) throw new Error('CR_API_KEY is not set');
  const res = await fetch(BASE + pathname, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) {
    let body = '';
    try { body = await res.text(); } catch { /* ignore */ }
    const hint = res.status === 403 ? ' (key invalid, or this server\'s public IP is not whitelisted on the key)' : '';
    throw new Error(`CR API ${res.status} on ${pathname}: ${body.slice(0, 200)}${hint}`);
  }
  return res.json();
}

// Supercell timestamps look like 20261026T094612.000Z
export function crDate(s) {
  if (!s) return null;
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/.exec(s);
  if (!m) return s;
  if (Number(m[1]) < 2000) return null; // 1969-12-31 placeholder = "never finished"
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
}
