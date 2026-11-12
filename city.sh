#!/usr/bin/env bash
# Installs or updates CR3W City on this server. Run as root:
#   curl -sL https://raw.githubusercontent.com/stel-dot/cr3w-kit/main/city.sh | bash
set -e
cd /root/cr3w
echo "== Downloading CR3W City =="
rm -rf /tmp/cr3w-kit
git clone -q --depth 1 https://github.com/stel-dot/cr3w-kit /tmp/cr3w-kit
mkdir -p city city-data
rm -rf city/* && cp -r /tmp/cr3w-kit/city/. city/
cp /tmp/cr3w-kit/server/docker-compose.yml /tmp/cr3w-kit/server/Caddyfile /tmp/cr3w-kit/server/update.sh .
grep -q '^CITY_HOST=' .env || echo "CITY_HOST=city.cr3winc.com" >> .env
grep -q '^SETUP_CODE=' .env || echo "SETUP_CODE=$(openssl rand -hex 3 | tr a-f A-F)" >> .env
echo "== Starting =="
docker compose up -d
docker compose restart city caddy >/dev/null
CODE=$(grep '^SETUP_CODE=' .env | cut -d= -f2)
echo ""
echo "CR3W City is installed."
echo "Open https://city.cr3winc.com on your phone or laptop."
echo "Your one-time setup code is:   $CODE"
