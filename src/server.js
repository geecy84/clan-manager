import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, kvGet, kvSet } from './db.js';
import { CLAN_TAG, normTag } from './api.js';
import { pollAll, pollRace } from './collector.js';
import { evaluate, warDetail, buildNudge, getSettings, saveSettings, DEFAULTS, deepMerge } from './grading.js';
import { discord } from './notify.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '1mb' }));

// Optional password (HTTP basic auth, any username)
app.use((req, res, next) => {
  const pw = process.env.APP_PASSWORD;
  if (!pw) return next();
  const h = req.headers.authorization || '';
  if (h.startsWith('Basic ')) {
    const given = Buffer.from(h.slice(6), 'base64').toString().split(':').slice(1).join(':');
    if (given === pw) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Clan Manager"').status(401).send('Authentication required');
});

app.use('/vendor', express.static(path.join(__dirname, '../node_modules/chart.js/dist')));
app.use(express.static(path.join(__dirname, '../public')));

const wrap = (fn) => (req, res) => {
  try { res.json(fn(req, res)); } catch (e) { console.error(e); res.status(500).json({ error: e.message }); }
};

app.get('/api/overview', wrap(() => {
  const ev = evaluate();
  const wars = db.prepare('SELECT * FROM wars ORDER BY ended_at ASC').all();
  const plays = db.prepare('SELECT season_id s, section_index i, SUM(decks_used>0) played, COUNT(*) total, SUM(decks_used) decks FROM war_players GROUP BY s,i').all();
  const pm = new Map(plays.map((p) => [`${p.s}-${p.i}`, p]));
  const clanSeries = db.prepare(`SELECT substr(ts,1,10) day, MAX(members) members, MAX(clan_score) clan_score, MAX(war_trophies) war_trophies
    FROM clan_snaps GROUP BY day ORDER BY day`).all();
  const last = wars[wars.length - 1];
  return {
    clan: kvGet('clan_info'), lastPoll: kvGet('last_poll'), tag: CLAN_TAG,
    summary: ev.summary,
    lastWar: last ? { ...last, standings_json: undefined } : null,
    warSeries: wars.map((w) => {
      const p = pm.get(`${w.season_id}-${w.section_index}`) || {};
      return { label: `S${w.season_id} W${w.section_index + 1}`, ended_at: w.ended_at, rank: w.rank, fame: w.fame,
        trophyChange: w.trophy_change, played: p.played || 0, total: p.total || 0, decks: p.decks || 0 };
    }),
    clanSeries,
    pendingRecs: ev.members.filter((m) => m.rec && !m.snoozed).length,
  };
}));

app.get('/api/members', wrap(() => {
  const ev = evaluate();
  return ev.members.map(({ history, ...m }) => m);
}));

app.get('/api/member/:tag', wrap((req) => {
  const tag = normTag(req.params.tag);
  const ev = evaluate();
  const m = ev.members.find((x) => x.tag === tag);
  const base = db.prepare('SELECT * FROM members WHERE tag=?').get(tag);
  if (!base) throw new Error('Unknown member');
  const trophies = db.prepare(`SELECT substr(ts,1,10) day, MAX(trophies) v FROM member_snaps WHERE tag=? GROUP BY day ORDER BY day`).all(tag);
  const donations = db.prepare(`SELECT strftime('%Y-%W', ts) wk, MIN(substr(ts,1,10)) start, MAX(donations) v FROM member_snaps WHERE tag=? GROUP BY wk ORDER BY wk`).all(tag);
  // history for people no longer active (or not evaluated) still comes from war_players
  const hist = m ? m.history : db.prepare(`SELECT w.ended_at, p.* FROM war_players p JOIN wars w USING(season_id,section_index)
    WHERE p.tag=? ORDER BY w.ended_at DESC`).all(tag).map((r) => ({ season_id: r.season_id, section_index: r.section_index,
    ended_at: r.ended_at, decks: r.decks_used, fame: r.fame, decksPct: Math.min(100, r.decks_used / getSettings().grading.maxDecksPerWar * 100) }));
  return {
    member: m || { ...base, status: 'left' }, history: hist, trophies, donations,
    actions: db.prepare('SELECT * FROM actions WHERE tag=? ORDER BY ts DESC').all(tag),
    excuses: db.prepare('SELECT * FROM excuses WHERE tag=? ORDER BY from_date DESC').all(tag),
    events: db.prepare('SELECT * FROM events WHERE tag=? ORDER BY ts DESC').all(tag),
  };
}));

app.get('/api/wars', wrap(() => db.prepare('SELECT season_id,section_index,ended_at,rank,trophy_change,fame,repair_points,finish_time,clan_score FROM wars ORDER BY ended_at DESC').all()));
app.get('/api/war/:season/:section', wrap((req) => {
  const d = warDetail(Number(req.params.season), Number(req.params.section));
  if (!d) throw new Error('War not found');
  d.war.standings = JSON.parse(d.war.standings_json || '[]'); delete d.war.standings_json;
  return d;
}));
app.get('/api/war-current', wrap(() => {
  const race = kvGet('current_race');
  const nudge = buildNudge();
  const snaps = race ? db.prepare(`SELECT ts, SUM(fame) fame, SUM(decks_used) decks FROM war_snaps WHERE section_index=? GROUP BY ts ORDER BY ts`).all(race.sectionIndex) : [];
  return { race: race && { ...race, participants: undefined }, participants: race?.participants || [], nudge, snaps };
}));

app.get('/api/recommendations', wrap(() => {
  const ev = evaluate();
  return ev.members.filter((m) => m.rec).map(({ history, ...m }) => m)
    .sort((a, b) => ['kick', 'warn', 'demote', 'promote'].indexOf(a.rec.action) - ['kick', 'warn', 'demote', 'promote'].indexOf(b.rec.action));
}));

app.get('/api/settings', wrap(() => ({ settings: getSettings(), defaults: DEFAULTS })));
app.put('/api/settings', wrap((req) => {
  const merged = deepMerge(DEFAULTS, req.body || {});
  saveSettings(merged);
  return { ok: true, settings: getSettings() };
}));

app.post('/api/actions', wrap((req) => {
  const { tag, type, note } = req.body || {};
  if (!['warn', 'promote', 'demote', 'kick', 'note', 'snooze'].includes(type)) throw new Error('Bad action type');
  const m = db.prepare('SELECT name FROM members WHERE tag=?').get(normTag(tag));
  db.prepare('INSERT INTO actions(ts,tag,name,type,note) VALUES(?,?,?,?,?)')
    .run(new Date().toISOString(), normTag(tag), m?.name || '', type, note || '');
  return { ok: true };
}));
app.get('/api/actions', wrap(() => db.prepare('SELECT * FROM actions ORDER BY ts DESC LIMIT 300').all()));
app.get('/api/events', wrap(() => db.prepare('SELECT * FROM events ORDER BY ts DESC LIMIT 300').all()));

app.get('/api/excuses', wrap(() => db.prepare(`SELECT e.*, m.name FROM excuses e LEFT JOIN members m USING(tag) ORDER BY from_date DESC`).all()));
app.post('/api/excuses', wrap((req) => {
  const { tag, from_date, to_date, reason } = req.body || {};
  if (!tag || !from_date || !to_date) throw new Error('tag, from_date and to_date required');
  db.prepare('INSERT INTO excuses(tag,from_date,to_date,reason) VALUES(?,?,?,?)').run(normTag(tag), from_date, to_date, reason || '');
  return { ok: true };
}));
app.delete('/api/excuses/:id', wrap((req) => { db.prepare('DELETE FROM excuses WHERE id=?').run(req.params.id); return { ok: true }; }));

app.post('/api/poll', async (req, res) => res.json(await pollAll()));
app.post('/api/test-discord', async (req, res) => res.json({ sent: await discord('✅ Clan Manager test message') }));

app.get('/api/export/members.csv', (req, res) => {
  const rows = evaluate().members;
  const head = ['tag', 'name', 'role', 'grade', 'score', 'countedWars', 'decksPct', 'medalsScore', 'donationsAvg', 'daysSinceSeen', 'recommendation'];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = [head.join(',')].concat(rows.map((m) => [m.tag, m.name, m.role, m.grade, m.score?.toFixed(1), m.countedWars,
    m.decksPct?.toFixed(1), m.fameScore?.toFixed(1), m.donationsAvg, m.daysSinceSeen?.toFixed(1), m.rec ? m.rec.action : ''].map(esc).join(','))).join('\n');
  res.type('text/csv').attachment('members.csv').send(csv);
});

// ---- scheduler: polling + war-day reminders ----
function localParts(tz) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const p = Object.fromEntries(f.formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hm: `${p.hour === '24' ? '00' : p.hour}:${p.minute}` };
}
async function tick() {
  const S = getSettings();
  const last = kvGet('last_poll');
  if (!last || Date.now() - new Date(last.at) >= S.pollMinutes * 60000) await pollAll();
  const { date, hm } = localParts(S.timezone);
  for (const t of S.notifications.warReminderTimes) {
    const key = `reminder:${date}:${t}`;
    if (t === hm && !kvGet(key)) {
      kvSet(key, true);
      try { await pollRace(); } catch (e) { console.error(e.message); }
      const n = buildNudge();
      if (n?.live && n.totalLeft > 0) await discord(n.text);
    }
  }
}

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Clan Manager for ${CLAN_TAG} on http://localhost:${port}`);
  if (!process.env.CR_API_KEY) console.warn('WARNING: CR_API_KEY not set — no data will be collected.');
  tick().catch((e) => console.error(e));
  setInterval(() => tick().catch((e) => console.error(e)), 60000);
});
