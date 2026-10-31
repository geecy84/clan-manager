import { db, kvGet, kvSet } from './db.js';
import { cr, tagPath, normTag, crDate, CLAN_TAG } from './api.js';
import { getSettings, evaluate } from './grading.js';
import { discord } from './notify.js';

const hourBucket = () => new Date().toISOString().slice(0, 13) + ':00:00Z';
const addEvent = (type, tag, name, detail) =>
  db.prepare('INSERT INTO events(ts,type,tag,name,detail) VALUES(?,?,?,?,?)')
    .run(new Date().toISOString(), type, tag, name, detail || '');

let polling = false;
export async function pollAll() {
  if (polling) return kvGet('last_poll');
  polling = true;
  const status = { at: new Date().toISOString(), errors: [] };
  const step = async (name, fn) => {
    try { await fn(); } catch (e) { status.errors.push(`${name}: ${e.message}`); console.error(name, e.message); }
  };
  try {
    await step('clan+members', pollClanAndMembers);
    await step('current race', pollRace);
    await step('race log', pollLog);
    await step('recommendations', checkNewRecommendations);
  } finally {
    polling = false;
    status.ok = status.errors.length === 0;
    kvSet('last_poll', status);
  }
  return status;
}

export async function pollClanAndMembers() {
  const tag = tagPath(CLAN_TAG);
  const clan = await cr(`/clans/${tag}`);
  const list = (await cr(`/clans/${tag}/members`)).items || [];
  const now = new Date().toISOString();
  const first = db.prepare('SELECT COUNT(*) c FROM members').get().c === 0;
  const notes = [];

  const getM = db.prepare('SELECT * FROM members WHERE tag=?');
  const tx = db.transaction(() => {
    const seen = new Set();
    for (const m of list) {
      const t = normTag(m.tag); seen.add(t);
      const ex = getM.get(t);
      const lastSeen = crDate(m.lastSeen);
      if (!ex) {
        db.prepare(`INSERT INTO members(tag,name,role,first_seen,baseline,active,exp_level,trophies,donations,donations_received,last_seen,clan_rank)
          VALUES(?,?,?,?,?,1,?,?,?,?,?,?)`).run(t, m.name, m.role, first ? '1970-01-01T00:00:00Z' : now, first ? 1 : 0,
          m.expLevel, m.trophies, m.donations, m.donationsReceived, lastSeen, m.clanRank);
        if (!first) { addEvent('join', t, m.name, `joined as ${m.role}`); notes.push(`➕ ${m.name} joined`); }
      } else {
        if (!ex.active) {
          db.prepare('UPDATE members SET active=1,left_at=NULL,first_seen=?,baseline=0 WHERE tag=?').run(now, t);
          addEvent('rejoin', t, m.name, 'returned to the clan'); notes.push(`➕ ${m.name} rejoined`);
        } else if (ex.role !== m.role) {
          addEvent('role', t, m.name, `${ex.role} → ${m.role}`);
        }
        db.prepare(`UPDATE members SET name=?,role=?,exp_level=?,trophies=?,donations=?,donations_received=?,last_seen=?,clan_rank=? WHERE tag=?`)
          .run(m.name, m.role, m.expLevel, m.trophies, m.donations, m.donationsReceived, lastSeen, m.clanRank, t);
      }
      db.prepare('INSERT OR REPLACE INTO member_snaps VALUES(?,?,?,?,?,?,?)')
        .run(hourBucket(), t, m.role, m.trophies, m.donations, m.donationsReceived, lastSeen);
    }
    for (const ex of db.prepare('SELECT * FROM members WHERE active=1').all()) {
      if (!seen.has(ex.tag)) {
        db.prepare('UPDATE members SET active=0,left_at=? WHERE tag=?').run(now, ex.tag);
        addEvent('leave', ex.tag, ex.name, 'left or was removed');
        notes.push(`➖ ${ex.name} left (was ${ex.role})`);
      }
    }
    db.prepare('INSERT OR REPLACE INTO clan_snaps VALUES(?,?,?,?,?)')
      .run(hourBucket(), list.length, clan.clanScore, clan.clanWarTrophies, clan.donationsPerWeek);
  });
  tx();
  kvSet('clan_info', {
    name: clan.name, tag: CLAN_TAG, description: clan.description, badgeId: clan.badgeId, type: clan.type,
    requiredTrophies: clan.requiredTrophies, clanScore: clan.clanScore, clanWarTrophies: clan.clanWarTrophies,
    donationsPerWeek: clan.donationsPerWeek, members: list.length,
  });
  if (notes.length && getSettings().notifications.onJoinLeave) await discord(notes.join('\n'));
}

export async function pollRace() {
  const r = await cr(`/clans/${tagPath(CLAN_TAG)}/currentriverrace`);
  const me = r.clan || {};
  const parts = (me.participants || []).map((p) => ({ ...p, tag: normTag(p.tag) }));
  kvSet('current_race', {
    at: new Date().toISOString(), periodType: r.periodType, periodIndex: r.periodIndex, sectionIndex: r.sectionIndex,
    fame: me.fame, repairPoints: me.repairPoints, periodPoints: me.periodPoints, clanScore: me.clanScore,
    participants: parts,
    clans: (r.clans || []).map((c) => ({ tag: c.tag, name: c.name, fame: c.fame, repairPoints: c.repairPoints,
      periodPoints: c.periodPoints, clanScore: c.clanScore, finishTime: crDate(c.finishTime) })),
  });
  const ins = db.prepare('INSERT OR REPLACE INTO war_snaps VALUES(?,?,?,?,?,?,?,?,?,?)');
  db.transaction(() => {
    for (const p of parts) ins.run(hourBucket(), r.sectionIndex, r.periodIndex, r.periodType, p.tag,
      p.fame, p.repairPoints, p.boatAttacks, p.decksUsed, p.decksUsedToday);
    db.prepare(`DELETE FROM war_snaps WHERE ts < datetime('now','-120 days')`).run();
  })();
}

export async function pollLog() {
  const log = (await cr(`/clans/${tagPath(CLAN_TAG)}/riverracelog`)).items || [];
  const firstRun = db.prepare('SELECT COUNT(*) c FROM wars').get().c === 0;
  const fresh = [];
  const getW = db.prepare('SELECT 1 FROM wars WHERE season_id=? AND section_index=?');
  db.transaction(() => {
    for (const it of log) {
      const mine = (it.standings || []).find((s) => normTag(s.clan?.tag) === CLAN_TAG);
      if (!mine) continue;
      const isNew = !getW.get(it.seasonId, it.sectionIndex);
      const c = mine.clan;
      db.prepare(`INSERT OR REPLACE INTO wars VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        it.seasonId, it.sectionIndex, crDate(it.createdDate), mine.rank, mine.trophyChange, c.fame, c.repairPoints,
        crDate(c.finishTime), c.clanScore, c.periodPoints,
        JSON.stringify((it.standings || []).map((s) => ({ rank: s.rank, trophyChange: s.trophyChange,
          name: s.clan.name, tag: s.clan.tag, fame: s.clan.fame, finishTime: crDate(s.clan.finishTime) }))));
      for (const p of c.participants || []) {
        db.prepare('INSERT OR REPLACE INTO war_players VALUES(?,?,?,?,?,?,?,?)').run(
          it.seasonId, it.sectionIndex, normTag(p.tag), p.name, p.fame, p.repairPoints, p.boatAttacks, p.decksUsed);
      }
      if (isNew) fresh.push({ seasonId: it.seasonId, sectionIndex: it.sectionIndex, rank: mine.rank, fame: c.fame,
        trophyChange: mine.trophyChange, participants: (c.participants || []).filter((p) => p.decksUsed > 0).length });
    }
  })();
  if (!firstRun && fresh.length && getSettings().notifications.onNewWarResult) {
    for (const w of fresh) {
      await discord(`🏁 War finished (season ${w.seasonId}, week ${w.sectionIndex + 1}): rank **${w.rank}**, ` +
        `${w.fame} fame, trophies ${w.trophyChange >= 0 ? '+' : ''}${w.trophyChange}, ${w.participants} members played.`);
    }
  }
}

async function checkNewRecommendations() {
  const prev = new Set(kvGet('last_recs', []));
  const ev = evaluate();
  const cur = ev.members.filter((m) => m.rec && !m.snoozed);
  const keys = cur.map((m) => `${m.tag}:${m.rec.action}`);
  kvSet('last_recs', keys);
  if (prev.size === 0 && db.prepare('SELECT COUNT(*) c FROM wars').get().c === 0) return; // nothing meaningful yet
  const fresh = cur.filter((m) => !prev.has(`${m.tag}:${m.rec.action}`));
  if (fresh.length && getSettings().notifications.onNewRecommendations) {
    await discord('📋 New recommendations:\n' + fresh.map((m) =>
      `• **${m.rec.action.toUpperCase()}** ${m.name} (${m.role}${m.rec.to ? ' → ' + m.rec.to : ''}) — ${m.rec.reasons.join('; ')}`).join('\n'));
  }
}
