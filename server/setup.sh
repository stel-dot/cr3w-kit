#!/usr/bin/env bash
# One-time setup on a fresh Ubuntu 24.04 server. Run as root:  bash setup.sh n8n.cr3winc.com
set -e
HOST="$1"
if [ -z "$HOST" ]; then echo "Usage: bash setup.sh n8n.yourdomain.com"; exit 1; fi

echo "== Adding 2 GB of swap (extra memory headroom on small servers) =="
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== Installing Docker =="
curl -fsSL https://get.docker.com | sh

echo "== Firewall: allow SSH, HTTP, HTTPS only =="
apt-get install -y ufw >/dev/null
ufw allow OpenSSH && ufw allow 80 && ufw allow 443 && ufw --force enable

echo "== Writing settings (.env) =="
if [ ! -f .env ]; then
  cat > .env <<ENV
N8N_HOST=$HOST
DB_PASSWORD=$(openssl rand -hex 24)
N8N_ENCRYPTION_KEY=$(openssl rand -hex 32)
ENV
  chmod 600 .env
fi
mkdir -p files backups

echo "== Daily database backup at 3 AM (keeps 14 days) =="
DIR="$(pwd)"
( crontab -l 2>/dev/null | grep -v cr3w-backup ; echo "0 3 * * * cd $DIR && docker compose exec -T postgres pg_dump -U n8n n8n | gzip > backups/n8n-\$(date +\%F).sql.gz && find backups -name '*.sql.gz' -mtime +14 -delete # cr3w-backup" ) | crontab -

echo "== Starting n8n =="
docker compose up -d

echo ""
echo "Done. Open https://$HOST in a few minutes and create your owner account."
echo "IMPORTANT: copy the .env file somewhere safe (Google Drive). Without N8N_ENCRYPTION_KEY your saved logins can't be read."
