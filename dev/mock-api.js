// Fake Clash Royale API with plausible data, for demo/testing without an API key.
import express from 'express';

let seed = 42;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const pad = (n) => String(n).padStart(2, '0');
const crd = (d) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}.000Z`;
const DAY = 86400000;

const names = ['Hogger', 'Unicorn', 'Log Enjoyer', 'MegaKnight', 'Sparky', 'Pekka Pal', 'Goblin Gang', 'Ice Wiz', 'Zappy', 'Balloon Boy',
  'Lava Lord', 'Miner Mike', 'Bandit Bob', 'Royal Ghost', 'Night Witch', 'Prince Pete', 'Tesla Tim', 'Xbow Xena', 'Mortar Max', 'Rascal Ray',
  'Fisherman', 'Skeleton K', 'Dart Dan', 'Golem Greg', 'Wizard Will', 'Giant Gary', 'Valk Vic', 'Cannon Cal', 'Furnace Fay', 'Barb Barry'];
export const MY = '#292GQ80L';

const members = names.map((n, i) => {
  // behaviour archetypes
  let rate = 0.9, seen = rnd() * 1.5, role = 'member', donations = Math.floor(rnd() * 250);
  if (i < 1) role = 'leader'; else if (i < 3) role = 'coLeader'; else if (i < 8) role = 'elder';
  if (i >= 8 && i < 12) rate = 0.99;               // stars
  if (i >= 14 && i < 18) rate = 0.15;              // slackers
  if (i === 18 || i === 19) { rate = 0.0; seen = 20; donations = 0; } // ghosts
  if (i === 20) { rate = 0.5; }
  return { tag: `#P${String(1000 + i)}`, name: n, role, rate, seen, donations, trophies: 5000 + Math.floor(rnd() * 3000), joinedWar: i === 29 ? 7 : 0 };
});

const WARS = 8; // log length
const warPlayers = (w) => members.filter((m) => m.joinedWar <= w).map((m) => {
  const decks = Math.min(16, Math.round(16 * m.rate * (0.6 + rnd() * 0.5)));
  return { tag: m.tag, name: m.name, fame: decks * (95 + Math.floor(rnd() * 90)), repairPoints: 0, boatAttacks: Math.floor(rnd() * 4), decksUsed: decks, decksUsedToday: 0 };
});

const log = [];
for (let w = 0; w < WARS; w++) {
  const ended = new Date(Date.now() - (WARS - w) * 7 * DAY + 3 * DAY);
  const parts = warPlayers(w);
  const fame = parts.reduce((a, p) => a + p.fame, 0);
  const rank = 1 + Math.floor(rnd() * 4);
  log.unshift({
    seasonId: 130 + Math.floor(w / 4), sectionIndex: w % 4, createdDate: crd(ended),
    standings: [{ rank, trophyChange: [20, 10, 0, -10, -20][rank - 1] ?? 0,
      clan: { tag: MY, name: 'Demo Clan', fame, repairPoints: 0, finishTime: '19691231T235959.000Z', participants: parts, periodPoints: 0, clanScore: 3000 + w * 12 } },
    ...[1, 2, 3, 4].map((k) => ({ rank: k >= rank ? k + 1 : k, trophyChange: 0, clan: { tag: `#X${k}`, name: `Rival ${k}`, fame: Math.floor(fame * (0.8 + rnd() * 0.5)), participants: [] } }))],
  });
}

const current = () => {
  const parts = members.map((m) => {
    const used = Math.min(16, Math.round(8 * m.rate * (0.5 + rnd())));
    return { tag: m.tag, name: m.name, fame: used * 120, repairPoints: 0, boatAttacks: 0, decksUsed: used, decksUsedToday: Math.min(4, Math.floor(rnd() * 5 * m.rate)) };
  });
  return {
    state: 'full', sectionIndex: 3, periodIndex: 4, periodType: 'warDay',
    clan: { tag: MY, name: 'Demo Clan', fame: parts.reduce((a, p) => a + p.fame, 0), repairPoints: 0, periodPoints: 0, clanScore: 3090, participants: parts },
    clans: [{ tag: MY, name: 'Demo Clan', fame: 21000, clanScore: 3090 }, ...[1, 2, 3, 4].map((k) => ({ tag: `#X${k}`, name: `Rival ${k}`, fame: 15000 + k * 2500, clanScore: 3000 }))],
  };
};

export function startMock(port = 4010) {
  const app = express();
  const memberList = () => members.map((m, i) => ({
    tag: m.tag, name: m.name, role: m.role, expLevel: 60, trophies: m.trophies, clanRank: i + 1, previousClanRank: i + 1,
    donations: m.donations, donationsReceived: Math.floor(m.donations / 2), lastSeen: crd(new Date(Date.now() - m.seen * DAY)),
  }));
  app.get('/v1/clans/:tag', (req, res) => res.json({ tag: MY, name: 'Demo Clan', type: 'inviteOnly', clanScore: 3090, clanWarTrophies: 2500, requiredTrophies: 5000, donationsPerWeek: 4000, members: members.length, description: 'demo' }));
  app.get('/v1/clans/:tag/members', (req, res) => res.json({ items: memberList() }));
  app.get('/v1/clans/:tag/currentriverrace', (req, res) => res.json(current()));
  app.get('/v1/clans/:tag/riverracelog', (req, res) => res.json({ items: log }));
  return new Promise((r) => { const s = app.listen(port, () => r(s)); });
}
