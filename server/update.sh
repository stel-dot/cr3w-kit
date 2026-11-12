#!/usr/bin/env bash
# Update n8n to the newest version. Run inside this folder:  bash update.sh
set -e
docker compose exec -T postgres pg_dump -U n8n n8n | gzip > backups/before-update-$(date +%F).sql.gz
docker compose pull
docker compose up -d
echo "Updated. A backup was saved in backups/ first."
