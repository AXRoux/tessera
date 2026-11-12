#!/bin/bash
# Starts (or restarts) Tessera Live on this host: the multi-tenant app behind Caddy, which terminates TLS.
#
# Reads /opt/tessera/config (IMAGE=<ecr image>, HOST=<public hostname>). Secrets come from AWS Secrets Manager
# (tessera/live) through the instance role, are written root-only for `docker run`, and are deleted right after.
# Accounts, sealed keys and ledgers live in /var/lib/tessera (the EBS root volume, snapshotted daily).
set -euo pipefail
source /opt/tessera/config
REGION=us-east-2
REGISTRY="${IMAGE%%/*}"

aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$REGISTRY" >/dev/null
docker pull -q "$IMAGE"

umask 077
SECRETS=$(mktemp)
trap 'rm -f "$SECRETS"' EXIT
aws secretsmanager get-secret-value --secret-id tessera/live --region "$REGION" --query SecretString --output text \
  | python3 -c 'import json,sys; [print(f"{k}={v}") for k, v in json.load(sys.stdin).items()]' > "$SECRETS"

mkdir -p /var/lib/tessera && chown 1000:1000 /var/lib/tessera && chmod 700 /var/lib/tessera
docker network inspect tessera >/dev/null 2>&1 || docker network create tessera >/dev/null
docker rm -f tessera caddy >/dev/null 2>&1 || true

docker run -d --name tessera --network tessera --restart unless-stopped \
  -v /var/lib/tessera:/data --env-file "$SECRETS" \
  -e BETTER_AUTH_URL="https://$HOST" -e TESSERA_ALLOWED_HOSTS="$HOST" \
  --log-opt max-size=10m --log-opt max-file=3 "$IMAGE" >/dev/null

cat > /opt/tessera/Caddyfile <<CADDY
$HOST {
	encode zstd gzip
	reverse_proxy tessera:3100 {
		# Overwrite, never append: the console takes the client address from this header for rate limits.
		header_up X-Forwarded-For {remote_host}
	}
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		-Server
	}
}
CADDY

docker run -d --name caddy --network tessera --restart unless-stopped -p 80:80 -p 443:443 \
  -v /opt/tessera/Caddyfile:/etc/caddy/Caddyfile:ro -v caddy_data:/data -v caddy_config:/config \
  --log-opt max-size=10m --log-opt max-file=3 caddy:2 >/dev/null
echo "tessera live: $IMAGE on https://$HOST"
