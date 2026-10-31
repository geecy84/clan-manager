import { db, kvGet, kvSet } from './db.js';

const DAY = 86400000;
export const ROLE_ORDER = ['member', 'elder', 'coLeader', 'leader'];

export const DEFAULTS = {
  timezone: 'Europe/London',
  pollMinutes: 15,
  grading: {
    windowWars: 4,            // how many most-recent counted wars feed the score
    maxDecksPerWar: 16,       // 4 decks x 4 war days
    joinGraceDays: 4,         // wars ending within this many days of a member's join are not counted
    warLengthDays: 7,         // used to match excused absences to wars
    weights: { decks: 50, fame: 25, donations: 15, activity: 10 }, // relative; set 0 to disable
    fameTarget: 'auto',       // 'auto' = percentile of that war's fame, or a fixed number
    fameTargetPercentile: 75,
    donationsTargetPerWeek: 100,
    activeWithinDays: 2,      // seen within this = full activity score
    inactiveAfterDays: 14,    // not seen for this long = zero activity score
    gradeThresholds: { 'A+': 95, A: 85, B: 70, C: 55, D: 40 }, // below D = F
  },
  rules: {
    minWarsForRecommendation: 2,
    watchBelowScore: 55,
    snoozeDays: 7,
    promote: {
      enabled: true,
      toElderMinScore: 70, toElderMinWars: 3, minTenureDays: 14, maxDaysSinceSeen: 3,
      toCoLeaderEnabled: false, toCoLeaderMinScore: 85, toCoLeaderMinWars: 6, toCoLeaderMinTenureDays: 60,
    },
    demote: { enabled: true, elderBelowScore: 45, coLeaderBelowScore: 40 },
    kick: {
      enabled: true, belowScore: 35, badWarsInRow: 2, badWarDecksPct: 25,
      inactiveDays: 14, neverKickRoles: ['leader', 'coLeader'],
      requireWarningFirst: true, warningValidDays: 21, ignoreNewMemberDays: 7,
    },
  },
  notifications: {
    discordWebhookUrl: '',
    warReminderTimes: ['18:00', '21:00'],   // local time in the timezone above, war days only
    onNewWarResult: true, onJoinLeave: true, onNewRecommendations: true,
  },
};

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
export function deepMerge(base, over) {
  if (!isObj(base) || !isObj(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = isObj(base[k]) ? deepMerge(base[k], over[k]) : over[k];
  return out;
}
export const getSettings = () => deepMerge(DEFAULTS, kvGet('settings', {}));
export const saveSettings = (s) => kvSet('settings', s);

const days = (a, b) => (a - b) / DAY;
const percentile = (arr, p) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
};
export function gradeFor(score, G) {
  if (score == null) return 'N/A';
  const t = Object.entries(G.gradeThresholds).sort((a, b) => b[1] - a[1]);
  for (const [g, min] of t) if (score >= min) return g;
  return 'F';
}
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const warKey = (w) => `${w.season_id}-${w.section_index}`;

export function evaluate(now = new Date()) {
  const S = getSettings();
  const G = S.grading, R = S.rules;
  const wars = db.prepare('SELECT * FROM wars ORDER BY ended_at DESC').all();
  const byWar = new Map();
  for (const p of db.prepare('SELECT * FROM war_players').all()) {
    const k = `${p.season_id}-${p.section_index}`;
    if (!byWar.has(k)) byWar.set(k, new Map());
    byWar.get(k).set(p.tag, p);
  }
  const warTarget = new Map();
  for (const w of wars) {
    const rows = [...(byWar.get(warKey(w))?.values() || [])];
    const t = G.fameTarget === 'auto'
      ? percentile(rows.filter((r) => r.fame > 0).map((r) => r.fame), G.fameTargetPercentile)
      : Number(G.fameTarget) || 0;
    warTarget.set(warKey(w), t);
  }
  const members = db.prepare('SELECT * FROM members WHERE active=1').all();
  const firstApp = new Map(); // earliest war each member appears in (lower bound for time in clan)
  for (const w of wars) for (const tag of byWar.get(warKey(w))?.keys() || []) {
    const cur = firstApp.get(tag);
    if (!cur || w.ended_at < cur) firstApp.set(tag, w.ended_at);
  }
  const excuses = db.prepare('SELECT * FROM excuses').all();
  const actions = db.prepare('SELECT * FROM actions ORDER BY ts DESC').all();
  const weeklyStmt = db.prepare(
    `SELECT strftime('%Y-%W', ts) wk, MAX(donations) d FROM member_snaps WHERE tag=? GROUP BY wk ORDER BY wk DESC LIMIT ?`);

  const excusedOn = (tag, from, to) => excuses.some((e) =>
    e.tag === tag && new Date(e.from_date + 'T00:00:00Z') <= to && new Date(e.to_date + 'T23:59:59Z') >= from);

  const out = members.map((m) => {
    const manual = m.joined_manual ? new Date(m.joined_manual + 'T00:00:00Z') : null;
    const joined = manual || (m.baseline ? null : new Date(m.first_seen));
    let joinedAt = null, tenureSource = 'unknown';
    if (manual) { joinedAt = manual; tenureSource = 'manual'; }
    else if (!m.baseline) { joinedAt = new Date(m.first_seen); tenureSource = 'tracked'; }
    else if (firstApp.get(m.tag)) { joinedAt = new Date(new Date(firstApp.get(m.tag)) - G.warLengthDays * DAY); tenureSource = 'atleast'; }
    const history = [];
    for (const w of wars) {
      const row = byWar.get(warKey(w))?.get(m.tag);
      if (!row) continue;
      const ended = new Date(w.ended_at);
      let excluded = null;
      if (joined && days(ended, joined) < G.joinGraceDays) excluded = 'new';
      else if (excusedOn(m.tag, new Date(ended - G.warLengthDays * DAY), ended)) excluded = 'excused';
      const decksPct = Math.min(100, (row.decks_used / G.maxDecksPerWar) * 100);
      const t = warTarget.get(warKey(w));
      const fameScore = t > 0 ? Math.min(100, (row.fame / t) * 100) : null;
      const wd = G.weights.decks, wf = fameScore == null ? 0 : G.weights.fame;
      const warScore = wd + wf > 0 ? (wd * decksPct + wf * (fameScore ?? 0)) / (wd + wf) : decksPct;
      history.push({
        season_id: w.season_id, section_index: w.section_index, ended_at: w.ended_at,
        decks: row.decks_used, fame: row.fame, repair: row.repair_points, boats: row.boat_attacks,
        decksPct, fameScore, score: warScore, grade: gradeFor(warScore, G), excluded,
      });
    }
    const counted = history.filter((h) => !h.excluded).slice(0, G.windowWars);
    const decksAvg = avg(counted.map((h) => h.decksPct));
    const fameVals = counted.map((h) => h.fameScore).filter((v) => v != null);
    const fameAvg = avg(fameVals);

    const weeks = weeklyStmt.all(m.tag, 8).map((r) => r.d);
    const doneWeeks = weeks.slice(1, 1 + G.windowWars);
    const donAvg = doneWeeks.length ? avg(doneWeeks) : weeks[0] ?? m.donations ?? 0;
    const donScore = G.donationsTargetPerWeek > 0 ? Math.min(100, (donAvg / G.donationsTargetPerWeek) * 100) : null;

    const lastSeen = m.last_seen ? new Date(m.last_seen) : null;
    const daysSinceSeen = lastSeen ? days(now, lastSeen) : null;
    let actScore = null;
    if (daysSinceSeen != null) {
      actScore = daysSinceSeen <= G.activeWithinDays ? 100
        : daysSinceSeen >= G.inactiveAfterDays ? 0
          : 100 * (1 - (daysSinceSeen - G.activeWithinDays) / (G.inactiveAfterDays - G.activeWithinDays));
    }

    let score = null;
    if (counted.length) {
      const comps = [['decks', decksAvg], ['fame', fameAvg], ['donations', donScore], ['activity', actScore]]
        .filter(([k, v]) => v != null && G.weights[k] > 0);
      const wsum = comps.reduce((a, [k]) => a + G.weights[k], 0);
      score = wsum ? comps.reduce((a, [k, v]) => a + G.weights[k] * v, 0) / wsum : null;
    }
    const grade = gradeFor(score, G);

    let badStreak = 0;
    for (const h of history.filter((x) => !x.excluded)) {
      if (h.decksPct < R.kick.badWarDecksPct) badStreak++; else break;
    }
    const tenureDays = joinedAt ? days(now, joinedAt) : null;
    const excusedNow = excusedOn(m.tag, now, now);
    const myActions = actions.filter((a) => a.tag === m.tag);
    const warnings = myActions.filter((a) => a.type === 'warn' && days(now, new Date(a.ts)) <= R.kick.warningValidDays).length;
    const snoozed = myActions.some((a) => a.type === 'snooze' && days(now, new Date(a.ts)) <= R.snoozeDays);

    const rec = recommend({ m, S, R, score, counted: counted.length, badStreak, tenureDays, daysSinceSeen, excusedNow, warnings, snoozed });
    const status = excusedNow ? 'excused'
      : score == null ? 'new'
        : score < R.watchBelowScore ? 'watch' : 'ok';

    return {
      tag: m.tag, name: m.name, role: m.role, trophies: m.trophies, donations: m.donations,
      donationsReceived: m.donations_received, lastSeen: m.last_seen, daysSinceSeen, tenureDays,
      baseline: !!m.baseline, firstSeen: m.first_seen,
      joinedAt: joinedAt ? joinedAt.toISOString().slice(0, 10) : null, tenureSource, joinedManual: m.joined_manual || null,
      countedWars: counted.length, score, grade, decksPct: decksAvg, fameScore: fameAvg,
      donationsAvg: donAvg, donationsScore: donScore, activityScore: actScore,
      lastWar: history[0] || null, badStreak, warnings, excused: excusedNow, status, snoozed, rec, history,
    };
  });

  const gd = {};
  for (const m of out) gd[m.grade] = (gd[m.grade] || 0) + 1;
  const scored = out.filter((m) => m.score != null);
  return {
    settings: S, members: out,
    summary: { avgScore: avg(scored.map((m) => m.score)), gradeDistribution: gd,
      atRisk: out.filter((m) => m.status === 'watch').length,
      recommendations: out.filter((m) => m.rec && !m.snoozed).length },
  };
}

function recommend({ m, S, R, score, counted, badStreak, tenureDays, daysSinceSeen, excusedNow, warnings, snoozed }) {
  if (excusedNow || snoozed) return null;
  const role = m.role;
  const reasons = [];
  const enough = counted >= R.minWarsForRecommendation;
  const fmt = (v) => Math.round(v);
  const newish = tenureDays != null && tenureDays < R.kick.ignoreNewMemberDays;

  // KICK
  if (R.kick.enabled && !R.kick.neverKickRoles.includes(role) && !newish) {
    const inactive = daysSinceSeen != null && daysSinceSeen >= R.kick.inactiveDays;
    const poor = enough && badStreak >= R.kick.badWarsInRow && score != null && score < R.kick.belowScore;
    if (inactive) reasons.push(`not seen for ${fmt(daysSinceSeen)} days`);
    if (poor) reasons.push(`${badStreak} wars in a row under ${R.kick.badWarDecksPct}% decks, score ${fmt(score)}`);
    if (reasons.length) {
      if (R.kick.requireWarningFirst && warnings === 0) {
        return { action: 'warn', reasons: [...reasons, 'warning not yet logged — warn before kicking'] };
      }
      return { action: 'kick', reasons };
    }
  }
  // DEMOTE
  if (R.demote.enabled && enough && score != null) {
    if (role === 'coLeader' && score < R.demote.coLeaderBelowScore)
      return { action: 'demote', to: 'elder', reasons: [`score ${fmt(score)} below ${R.demote.coLeaderBelowScore}`] };
    if (role === 'elder' && score < R.demote.elderBelowScore)
      return { action: 'demote', to: 'member', reasons: [`score ${fmt(score)} below ${R.demote.elderBelowScore}`] };
  }
  // PROMOTE
  const P = R.promote;
  if (P.enabled && score != null && badStreak === 0 && (daysSinceSeen == null || daysSinceSeen <= P.maxDaysSinceSeen)) {
    const tenureOk = (min) => tenureDays == null || tenureDays >= min; // baseline members: tenure unknown, assume ok
    if (role === 'member' && counted >= P.toElderMinWars && score >= P.toElderMinScore && tenureOk(P.minTenureDays))
      return { action: 'promote', to: 'elder', reasons: [`score ${fmt(score)} over ${counted} wars`] };
    if (role === 'elder' && P.toCoLeaderEnabled && counted >= P.toCoLeaderMinWars &&
      score >= P.toCoLeaderMinScore && tenureOk(P.toCoLeaderMinTenureDays))
      return { action: 'promote', to: 'coLeader', reasons: [`score ${fmt(score)} over ${counted} wars`] };
  }
  return null;
}

// ---- per-war breakdown ----
export function warDetail(season, section) {
  const S = getSettings(); const G = S.grading;
  const war = db.prepare('SELECT * FROM wars WHERE season_id=? AND section_index=?').get(season, section);
  if (!war) return null;
  const rows = db.prepare('SELECT * FROM war_players WHERE season_id=? AND section_index=?').all(season, section);
  const target = G.fameTarget === 'auto'
    ? percentile(rows.filter((r) => r.fame > 0).map((r) => r.fame), G.fameTargetPercentile) : Number(G.fameTarget) || 0;
  const roles = Object.fromEntries(db.prepare('SELECT tag, role, active FROM members').all().map((m) => [m.tag, m]));
  const players = rows.map((r) => {
    const decksPct = Math.min(100, (r.decks_used / G.maxDecksPerWar) * 100);
    const fameScore = target > 0 ? Math.min(100, (r.fame / target) * 100) : null;
    const wd = G.weights.decks, wf = fameScore == null ? 0 : G.weights.fame;
    const score = (wd * decksPct + wf * (fameScore ?? 0)) / ((wd + wf) || 1);
    return { tag: r.tag, name: r.name, fame: r.fame, decks: r.decks_used, repair: r.repair_points, boats: r.boat_attacks,
      decksPct, score, grade: gradeFor(score, G), current: !!roles[r.tag]?.active, role: roles[r.tag]?.role || null };
  }).sort((a, b) => b.fame - a.fame);
  return { war, fameTarget: target, players };
}

// ---- live war nudge ----
export function buildNudge() {
  const race = kvGet('current_race');
  if (!race) return null;
  const live = ['warDay', 'colosseum'].includes(race.periodType);
  const parts = new Map((race.participants || []).map((p) => [p.tag, p]));
  const today = new Date();
  const excuses = db.prepare('SELECT * FROM excuses').all();
  const members = db.prepare('SELECT * FROM members WHERE active=1').all();
  const missing = [];
  for (const m of members) {
    if (excuses.some((e) => e.tag === m.tag && new Date(e.from_date + 'T00:00:00Z') <= today && new Date(e.to_date + 'T23:59:59Z') >= today)) continue;
    const p = parts.get(m.tag);
    const used = p?.decksUsedToday ?? 0;
    if (used < 4) missing.push({ tag: m.tag, name: m.name, role: m.role, left: 4 - used, usedTotal: p?.decksUsed ?? 0 });
  }
  missing.sort((a, b) => b.left - a.left || a.name.localeCompare(b.name));
  const totalLeft = missing.reduce((a, x) => a + x.left, 0);
  const text = live
    ? `⚔️ War day — ${totalLeft} decks still unused today. Please play your decks! Still to go: ` +
      missing.map((x) => `${x.name} (${x.left})`).join(', ')
    : 'No war decks to play right now (training days).';
  return { live, periodType: race.periodType, periodIndex: race.periodIndex, totalLeft, missing, text };
}
