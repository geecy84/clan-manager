# Clan Manager — #292GQ80L

Polls the Clash Royale API every 15 min, stores history in SQLite, grades members, recommends promote/demote/warn/kick, nudges war-day slackers.

## Run (homelab)
```
cp .env.example .env   # add CR_API_KEY, whitelist your public IP on the key
docker compose up -d --build   # http://<host>:3000
```
No Docker: `npm install && node --env-file=.env src/server.js`. Try without a key: `npm run demo` (port 3000, fake data).

## Notes
- The official API is read-only: promote/demote/kick happen in-game; press **Done** in the Actions tab to log it.
- Kick recommendations require a logged **warn** first (setting `rules.kick.requireWarningFirst`).
- History builds from the day you start it (race log gives the last ~10 wars immediately). Members present at first run are treated as long-standing; later joiners get a grace period.
- Weekly donation history is approximated by calendar week (Mon–Sun UTC) from hourly snapshots.
- Everything tunable is in the Settings tab: weights, grade cut-offs, medals target, rules, Discord webhook, reminder times.

## Proxmox LXC (no Docker)
In a Debian 13 container as root: `bash <(curl -fsSL https://raw.githubusercontent.com/<you>/clan-manager/main/scripts/install-lxc.sh)` — installs everything, asks for the API key, and auto-pulls GitHub changes every 5 minutes (repo must be public, or use a deploy key).
