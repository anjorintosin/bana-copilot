#!/usr/bin/env bash
# Launch Ubuntu on EC2, copy this repo, and start the API with Docker Compose.
# Requires: aws CLI logged in, docker on the instance (installed by user-data).
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
NAME="${EC2_NAME:-bana-copilot-api}"
TYPE="${EC2_TYPE:-t3.small}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

if ! aws sts get-caller-identity --region "$REGION" >/dev/null 2>&1; then
  echo "AWS is not logged in on this machine."
  echo "Run: aws login   (or aws configure)"
  echo "Then rerun: bash infra/deploy-ec2.sh"
  exit 1
fi

KEY_NAME="${EC2_KEY_NAME:-bana-copilot}"
if ! aws ec2 describe-key-pairs --region "$REGION" --key-names "$KEY_NAME" >/dev/null 2>&1; then
  mkdir -p "$HOME/.ssh"
  aws ec2 create-key-pair --region "$REGION" --key-name "$KEY_NAME" --query KeyMaterial --output text \
    > "$HOME/.ssh/${KEY_NAME}.pem"
  chmod 600 "$HOME/.ssh/${KEY_NAME}.pem"
  echo "Created key $HOME/.ssh/${KEY_NAME}.pem"
fi

SG_ID="$(aws ec2 describe-security-groups --region "$REGION" --filters Name=group-name,Values=bana-copilot-api \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null || true)"
if [[ -z "$SG_ID" || "$SG_ID" == "None" ]]; then
  VPC="$(aws ec2 describe-vpcs --region "$REGION" --filters Name=isDefault,Values=true --query 'Vpcs[0].VpcId' --output text)"
  SG_ID="$(aws ec2 create-security-group --region "$REGION" --group-name bana-copilot-api \
    --description "Bana Copilot API" --vpc-id "$VPC" --query GroupId --output text)"
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" --protocol tcp --port 22 --cidr 0.0.0.0/0
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" --protocol tcp --port 8787 --cidr 0.0.0.0/0
fi
# HTTPS (Caddy). Safe to rerun: a rule that already exists is reported as a duplicate and skipped.
for PORT in 80 443; do
  aws ec2 authorize-security-group-ingress --region "$REGION" --group-id "$SG_ID" --protocol tcp --port "$PORT" --cidr 0.0.0.0/0 >/dev/null 2>&1 || true
done

AMI="$(aws ec2 describe-images --region "$REGION" --owners 099720109477 \
  --filters "Name=name,Values=ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*" "Name=state,Values=available" \
  --query 'sort_by(Images,&CreationDate)[-1].ImageId' --output text)"

INSTANCE="$(aws ec2 describe-instances --region "$REGION" \
  --filters Name=tag:Name,Values="$NAME" Name=instance-state-name,Values=pending,running \
  --query 'Reservations[0].Instances[0].InstanceId' --output text 2>/dev/null || true)"

if [[ -z "$INSTANCE" || "$INSTANCE" == "None" ]]; then
  INSTANCE="$(aws ec2 run-instances --region "$REGION" \
    --image-id "$AMI" --instance-type "$TYPE" --key-name "$KEY_NAME" \
    --security-group-ids "$SG_ID" \
    --user-data "file://$ROOT/infra/ec2-user-data.sh" \
    --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$NAME}]" \
    --query 'Instances[0].InstanceId' --output text)"
  echo "Launched $INSTANCE"
fi

aws ec2 wait instance-running --region "$REGION" --instance-ids "$INSTANCE"
IP="$(aws ec2 describe-instances --region "$REGION" --instance-ids "$INSTANCE" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)"
echo "Instance $INSTANCE at $IP — waiting for SSH"

for _ in $(seq 1 36); do
  if ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=8 -i "$HOME/.ssh/${KEY_NAME}.pem" "ubuntu@$IP" "echo ok" 2>/dev/null; then
    break
  fi
  sleep 5
done

ssh -i "$HOME/.ssh/${KEY_NAME}.pem" "ubuntu@$IP" "sudo cloud-init status --wait || true"
rsync -az --delete --exclude node_modules --exclude .git --exclude apps/desktop/dist --exclude .env \
  -e "ssh -i $HOME/.ssh/${KEY_NAME}.pem -o StrictHostKeyChecking=accept-new" \
  "$ROOT/" "ubuntu@$IP:~/bana-copilot/"

ssh -i "$HOME/.ssh/${KEY_NAME}.pem" "ubuntu@$IP" bash -s <<EOF
set -euo pipefail
cd ~/bana-copilot
bash infra/ensure-env.sh "$IP"
sudo docker compose --env-file .env -f infra/docker-compose.prod.yml up -d --build
EOF

mkdir -p "$ROOT/infra"
printf '%s\n' "$IP" > "$ROOT/infra/ec2-host.txt"
echo ""
echo "API:  https://${IP//./-}.sslip.io/health"
echo "WS:   wss://${IP//./-}.sslip.io/ws"
echo "Put the https URL in apps/desktop/src/remote.ts before you pack the app for GitHub."
