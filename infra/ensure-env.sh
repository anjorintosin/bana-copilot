#!/usr/bin/env bash
# Runs on the server before `docker compose up`. Makes sure .env has real secrets and an HTTPS
# host, so production never starts on the compose file's old placeholder secrets.
# Usage: bash infra/ensure-env.sh <public-ip>
set -euo pipefail

IP="${1:?Pass the public IP of the server}"
ENV_FILE="${ENV_FILE:-.env}"

umask 077
touch "$ENV_FILE"
# A file without a trailing newline would glue the next line onto its last one.
[[ -s "$ENV_FILE" && -n "$(tail -c1 "$ENV_FILE")" ]] && echo >> "$ENV_FILE"

has() { grep -Eq "^$1=.+" "$ENV_FILE"; }
put() {
  if grep -q "^$1=" "$ENV_FILE"; then
    sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"
  else
    echo "$1=$2" >> "$ENV_FILE"
  fi
}

if ! has JWT_SECRET; then
  put JWT_SECRET "$(openssl rand -hex 32)"
  echo "Generated JWT_SECRET. Desktop apps sign in again on their own."
fi
if ! has CREDENTIALS_SECRET; then
  put CREDENTIALS_SECRET "$(openssl rand -hex 32)"
  echo "Generated CREDENTIALS_SECRET. Model keys saved before this can't be decrypted, so those users fall back to the server's key."
fi
if ! has POSTGRES_PASSWORD; then
  # Postgres only reads its password when the data volume is first created, so a new value
  # here would lock the API out of an existing database. Pin the old default explicitly.
  if sudo docker volume ls --format '{{.Name}}' 2>/dev/null | grep -q 'postgres_data$'; then
    put POSTGRES_PASSWORD copilot
  else
    put POSTGRES_PASSWORD "$(openssl rand -hex 24)"
  fi
fi
if ! has PUBLIC_HOST; then
  # sslip.io resolves 1-2-3-4.sslip.io to 1.2.3.4, which is enough for a Let's Encrypt
  # certificate without buying a domain. Set PUBLIC_HOST to your own domain to replace it.
  put PUBLIC_HOST "${IP//./-}.sslip.io"
fi
HOST="$(grep '^PUBLIC_HOST=' "$ENV_FILE" | cut -d= -f2-)"
put PUBLIC_APP_URL "https://$HOST"
echo "HTTPS host: $HOST"
