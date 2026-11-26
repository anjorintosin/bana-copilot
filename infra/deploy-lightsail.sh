#!/usr/bin/env bash
# Lightsail path used when the AWS org blocks EC2.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
NAME="${LIGHTSAIL_NAME:-bana-copilot-api}"
BUNDLE="${LIGHTSAIL_BUNDLE:-small_3_0}"
AZ="${LIGHTSAIL_AZ:-us-east-1a}"
KEY_NAME="${EC2_KEY_NAME:-bana-copilot}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEY_FILE="$HOME/.ssh/${KEY_NAME}.pem"

if ! aws sts get-caller-identity --region "$REGION" >/dev/null 2>&1; then
  echo "AWS is not logged in. Run: aws login"
  exit 1
fi

mkdir -p "$HOME/.ssh"
if ! aws lightsail get-key-pair --key-pair-name "$KEY_NAME" --region "$REGION" >/dev/null 2>&1; then
  aws lightsail create-key-pair --key-pair-name "$KEY_NAME" --region "$REGION" \
    --query privateKeyBase64 --output text | base64 -d > "$KEY_FILE"
  chmod 600 "$KEY_FILE"
  echo "Created Lightsail key $KEY_FILE"
elif [[ ! -s "$KEY_FILE" ]]; then
  echo "Lightsail key $KEY_NAME exists, but $KEY_FILE is missing."
  echo "Delete that key in the Lightsail console or set EC2_KEY_NAME to a new name."
  exit 1
fi

STATE="$(aws lightsail get-instance --instance-name "$NAME" --region "$REGION" \
  --query 'instance.state.name' --output text 2>/dev/null || true)"
if [[ -z "$STATE" || "$STATE" == "None" ]]; then
  aws lightsail create-instances \
    --region "$REGION" \
    --instance-names "$NAME" \
    --availability-zone "$AZ" \
    --blueprint-id ubuntu_24_04 \
    --bundle-id "$BUNDLE" \
    --key-pair-name "$KEY_NAME" \
    --user-data "file://$ROOT/infra/ec2-user-data.sh" >/dev/null
  echo "Launched Lightsail $NAME ($BUNDLE)"
fi

for _ in $(seq 1 40); do
  STATE="$(aws lightsail get-instance --instance-name "$NAME" --region "$REGION" \
    --query 'instance.state.name' --output text)"
  if [[ "$STATE" == "running" ]]; then
    break
  fi
  sleep 5
done

IP="$(aws lightsail get-instance --instance-name "$NAME" --region "$REGION" \
  --query 'instance.publicIpAddress' --output text)"
aws lightsail open-instance-public-ports --region "$REGION" --instance-name "$NAME" \
  --port-info fromPort=22,toPort=22,protocol=tcp,cidrs=0.0.0.0/0 >/dev/null || true
aws lightsail open-instance-public-ports --region "$REGION" --instance-name "$NAME" \
  --port-info fromPort=8787,toPort=8787,protocol=tcp,cidrs=0.0.0.0/0 >/dev/null
for PORT in 80 443; do
  aws lightsail open-instance-public-ports --region "$REGION" --instance-name "$NAME" \
    --port-info fromPort=$PORT,toPort=$PORT,protocol=tcp,cidrs=0.0.0.0/0 >/dev/null || true
done

echo "Instance $NAME at $IP — waiting for SSH"
for _ in $(seq 1 48); do
  if ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 -i "$KEY_FILE" "ubuntu@$IP" "echo ok" 2>/dev/null; then
    break
  fi
  sleep 5
done

ssh -i "$KEY_FILE" "ubuntu@$IP" "sudo cloud-init status --wait || true"
# Docker may still be installing from user-data.
for _ in $(seq 1 36); do
  if ssh -i "$KEY_FILE" "ubuntu@$IP" "command -v docker >/dev/null && docker compose version >/dev/null"; then
    break
  fi
  sleep 5
done

rsync -az --delete \
  --exclude node_modules --exclude .git --exclude apps/desktop/dist --exclude apps/desktop/release \
  --exclude .env \
  -e "ssh -i $KEY_FILE -o StrictHostKeyChecking=accept-new" \
  "$ROOT/" "ubuntu@$IP:~/bana-copilot/"

ssh -i "$KEY_FILE" "ubuntu@$IP" bash -s <<EOF
set -euo pipefail
cd ~/bana-copilot
bash infra/ensure-env.sh "$IP"
sudo docker compose --env-file .env -f infra/docker-compose.prod.yml up -d --build
EOF

printf '%s\n' "$IP" > "$ROOT/infra/ec2-host.txt"
echo ""
echo "API:  https://${IP//./-}.sslip.io/health"
echo "WS:   wss://${IP//./-}.sslip.io/ws"
echo "Lightsail small_3_0 is about \$12/month. Stop it in the console when testers are done."
