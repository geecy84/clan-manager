#!/bin/bash
# One-shot installer for a Debian 13 LXC. Run as root inside the container.
set -e
[ "$(id -u)" = 0 ] || { echo "Please run as root."; exit 1; }
APP=/opt/clan-manager

echo "== 1/6 Installing packages (takes a minute or two)"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git nodejs npm build-essential python3 cron curl ca-certificates
MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$MAJOR" -lt 20 ]; then
  echo "Node 20 or newer is needed but found $(node -v). Use a Debian 13 container."; exit 1
fi

echo "== 2/6 Downloading the code"
if [ -d "$APP/.git" ]; then
  git -C "$APP" pull -q
else
  read -rp "Your GitHub username: " GHUSER </dev/tty
  git clone "https://github.com/$GHUSER/clan-manager.git" "$APP"
fi
cd "$APP"
npm install --omit=dev --silent

echo "== 3/6 Settings"
if [ ! -f .env ]; then
  echo
  echo "Your public IP address is: $(curl -s ifconfig.me)"
  echo "Create the Clash Royale API key now using that IP (see the PDF), then paste the key below."
  read -rp "API key: " KEY </dev/tty
  read -rp "Choose a dashboard password (letters and numbers only): " PW </dev/tty
  printf 'CR_API_KEY=%s\nAPP_PASSWORD=%s\n' "$KEY" "$PW" > .env
  chmod 600 .env
else
  echo ".env already exists, keeping it."
fi

echo "== 4/6 Setting up the service"
cat > /etc/systemd/system/clan-manager.service <<EOF
[Unit]
Description=Clan Manager
After=network-online.target

[Service]
WorkingDirectory=$APP
EnvironmentFile=$APP/.env
Environment=DATA_DIR=$APP/data
Environment=TZ=Europe/London
ExecStart=/usr/bin/node src/server.js
Restart=always

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now clan-manager >/dev/null 2>&1
systemctl restart clan-manager

echo "== 5/6 Turning on automatic updates from GitHub (every 5 minutes)"
cat > "$APP/update.sh" <<'EOF'
#!/bin/bash
cd /opt/clan-manager || exit 1
git fetch -q || exit 1
[ "$(git rev-parse HEAD)" = "$(git rev-parse @{u})" ] && exit 0
git pull -q && npm install --omit=dev --silent && systemctl restart clan-manager
EOF
chmod +x "$APP/update.sh"
echo '*/5 * * * * root /opt/clan-manager/update.sh >> /var/log/clan-update.log 2>&1' > /etc/cron.d/clan-manager
systemctl enable --now cron >/dev/null 2>&1 || true

echo "== 6/6 Checking"
sleep 3
if systemctl is-active --quiet clan-manager; then
  echo
  echo "ALL DONE. Open this in your browser:  http://$(hostname -I | awk '{print $1}'):3000"
else
  echo "The service did not start. Run:  journalctl -u clan-manager -n 30 --no-pager"
fi
