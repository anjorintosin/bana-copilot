#!/usr/bin/env bash
# Copy this repo onto an existing EC2 box and rebuild the API.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEY_NAME="${EC2_KEY_NAME:-bana-copilot}"
KEY="${EC2_SSH_KEY_FILE:-$HOME/.ssh/${KEY_NAME}.pem}"
IP="${EC2_HOST:-}"
if [[ -z "$IP" && -f "$ROOT/infra/ec2-host.txt" ]]; then
  IP="$(tr -d '[:space:]' < "$ROOT/infra/ec2-host.txt")"
fi
if [[ -z "$IP" ]]; then
  echo "Set EC2_HOST or write infra/ec2-host.txt"
  exit 1
fi

rsync -az --delete \
  --exclude node_modules --exclude .git --exclude apps/desktop/dist --exclude apps/desktop/release \
  --exclude .env \
  -e "ssh -i $KEY -o StrictHostKeyChecking=accept-new" \
  "$ROOT/" "ubuntu@$IP:~/bana-copilot/"

ssh -i "$KEY" -o StrictHostKeyChecking=accept-new "ubuntu@$IP" bash -s <<EOF
set -euo pipefail
cd ~/bana-copilot
if [[ ! -f .env ]]; then
  echo "Missing ~/bana-copilot/.env on the instance."
  exit 1
fi
sudo docker compose --env-file .env -f infra/docker-compose.prod.yml up -d --build
EOF

echo "API: http://$IP:8787/health"
