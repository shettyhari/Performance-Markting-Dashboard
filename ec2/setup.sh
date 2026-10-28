#!/usr/bin/env bash
# Lead Performance — set up (or update) the API server on one EC2 instance (Ubuntu 24.04, x86_64 or arm64).
#
#   1. Copy the repo's db/ and ec2/ folders to the server:   scp -r db ec2 ubuntu@<elastic-ip>:~/lp/
#   2. Run:   sudo APP_URL=https://your-app.vercel.app [API_DOMAIN=api.yourdomain.com] [ADMIN_IP=1.2.3.4] bash ~/lp/ec2/setup.sh
#        APP_URL     the Vercel site (schedules call it; required)
#        API_DOMAIN  a domain pointing at this server's Elastic IP; leave out to use <ip>.sslip.io (free HTTPS, no domain needed)
#        ADMIN_IP    your IP for SSH; leave out to keep SSH open to all (the EC2 security group should still limit it)
#        BACKUP_S3_URI  optional, e.g. s3://my-bucket/lead-performance (needs an instance role with s3:PutObject)
#   3. It prints API_URL, JWT_SECRET and CRON_SECRET once: put them in Vercel › Settings › Environment Variables (never in chat).
#
# What runs here: Postgres 16 (localhost only) · PostgREST (localhost:3000) · Caddy (HTTPS on 443, the only public entry) ·
# nightly backups (14 days) · the schedules that call the site once per workspace. Safe to run again: it keeps the secrets and data,
# re-applies db/*.sql and updates the services.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run with sudo."; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/.." && pwd)"
[ -f "$ROOT/db/00-platform.sql" ] && [ -f "$ROOT/db/10-schema.sql" ] && [ -f "$ROOT/db/20-auth.sql" ] || { echo "db/ folder not found next to ec2/."; exit 1; }
: "${APP_URL:?Set APP_URL=https://your-app.vercel.app}"
APP_URL="${APP_URL%/}"
case "$APP_URL" in *ebg-dashboard.vercel.app*) echo "APP_URL must be this product's own site, not ebg-dashboard.vercel.app."; exit 1;; esac
PGRST_VERSION="v12.2.3"

echo "== packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq postgresql postgresql-contrib curl jq ufw cron xz-utils debian-keyring debian-archive-keyring apt-transport-https gnupg >/dev/null
if ! command -v caddy >/dev/null; then
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq && apt-get install -y -qq caddy >/dev/null
fi

echo "== secrets (kept in /etc/lp.env, readable by root only)"
if [ ! -f /etc/lp.env ]; then
  umask 077
  cat > /etc/lp.env <<EOF
JWT_SECRET=$(head -c 48 /dev/urandom | base64 | tr -d '\n/+=' | cut -c1-64)
CRON_SECRET=$(head -c 48 /dev/urandom | base64 | tr -d '\n/+=' | cut -c1-48)
PG_AUTH_PASS=$(head -c 32 /dev/urandom | base64 | tr -d '\n/+=' | cut -c1-40)
EOF
fi
sed -i "/^APP_URL=/d" /etc/lp.env && echo "APP_URL=$APP_URL" >> /etc/lp.env
# shellcheck disable=SC1091
. /etc/lp.env
if [ -z "${API_DOMAIN:-}" ]; then
  TOKEN=$(curl -s -m 3 -X PUT "http://169.254.169.254/latest/api/token" -H "X-aws-ec2-metadata-token-ttl-seconds: 60" || true)
  IP=$(curl -s -m 3 -H "X-aws-ec2-metadata-token: $TOKEN" http://169.254.169.254/latest/meta-data/public-ipv4 || true)
  [ -n "$IP" ] || IP=$(curl -s -m 5 https://checkip.amazonaws.com | tr -d '\n')
  API_DOMAIN="$(echo "$IP" | tr . -).sslip.io"
fi
sed -i "/^API_DOMAIN=/d" /etc/lp.env && echo "API_DOMAIN=$API_DOMAIN" >> /etc/lp.env

echo "== database (Postgres, localhost only)"
systemctl enable --now postgresql >/dev/null
sudo -u postgres psql -qtAc "select 1 from pg_database where datname = 'lp'" | grep -q 1 || sudo -u postgres createdb lp
sudo -u postgres psql -q -v ON_ERROR_STOP=1 -d lp < "$ROOT/db/00-platform.sql" >/dev/null
sudo -u postgres psql -q -v ON_ERROR_STOP=1 -d lp < "$ROOT/db/10-schema.sql" >/dev/null
sudo -u postgres psql -q -v ON_ERROR_STOP=1 -d lp < "$ROOT/db/20-auth.sql" >/dev/null
sudo -u postgres psql -q -v ON_ERROR_STOP=1 -d lp -c "alter role authenticator with login password '$PG_AUTH_PASS';" >/dev/null
PGCONF=$(sudo -u postgres psql -qtAc "show config_file")
grep -q "^listen_addresses = 'localhost'" "$PGCONF" || echo "listen_addresses = 'localhost'" >> "$PGCONF"
systemctl restart postgresql

echo "== PostgREST $PGRST_VERSION (localhost:3000)"
ARCH=$(uname -m)
case "$ARCH" in
  x86_64) PKG="postgrest-$PGRST_VERSION-linux-static-x64.tar.xz";;
  aarch64) PKG="postgrest-$PGRST_VERSION-ubuntu-aarch64.tar.xz";;
  *) echo "Unsupported CPU: $ARCH"; exit 1;;
esac
if ! /usr/local/bin/postgrest --version 2>/dev/null | grep -q "${PGRST_VERSION#v}"; then
  curl -fsSL -o /tmp/postgrest.tar.xz "https://github.com/PostgREST/postgrest/releases/download/$PGRST_VERSION/$PKG"
  tar -xJf /tmp/postgrest.tar.xz -C /usr/local/bin postgrest && chmod 755 /usr/local/bin/postgrest
fi
id -u postgrest >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin postgrest
umask 077
sed -e "s|__PG_AUTH_PASS__|$PG_AUTH_PASS|" -e "s|__JWT_SECRET__|$JWT_SECRET|" "$HERE/postgrest.conf" > /etc/postgrest.conf
chown postgrest /etc/postgrest.conf && chmod 600 /etc/postgrest.conf
cat > /etc/systemd/system/postgrest.service <<'EOF'
[Unit]
Description=PostgREST (Lead Performance API)
After=postgresql.service
Requires=postgresql.service
[Service]
User=postgrest
ExecStart=/usr/local/bin/postgrest /etc/postgrest.conf
ExecReload=/bin/kill -SIGUSR2 $MAINPID
Restart=always
RestartSec=3
NoNewPrivileges=true
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable --now postgrest >/dev/null && systemctl restart postgrest

echo "== Caddy (HTTPS for $API_DOMAIN)"
umask 022
sed -e "s|__API_DOMAIN__|$API_DOMAIN|" -e "s|__APP_URL__|$APP_URL|" "$HERE/Caddyfile" > /etc/caddy/Caddyfile
systemctl enable --now caddy >/dev/null && systemctl reload caddy || systemctl restart caddy

echo "== firewall (22, 80, 443 only; Postgres and PostgREST stay private)"
ufw --force reset >/dev/null
ufw default deny incoming >/dev/null && ufw default allow outgoing >/dev/null
if [ -n "${ADMIN_IP:-}" ]; then ufw allow from "$ADMIN_IP" to any port 22 proto tcp >/dev/null; else ufw allow 22/tcp >/dev/null; fi
ufw allow 80/tcp >/dev/null && ufw allow 443/tcp >/dev/null
ufw --force enable >/dev/null

echo "== backups (nightly, 14 days in /var/backups/lp${BACKUP_S3_URI:+, copied to $BACKUP_S3_URI})"
mkdir -p /var/backups/lp && chown postgres /var/backups/lp && chmod 700 /var/backups/lp
cat > /etc/cron.daily/lp-backup <<EOF
#!/bin/sh
set -e
F=/var/backups/lp/lp-\$(date -u +%Y%m%d).dump
sudo -u postgres pg_dump -Fc lp > "\$F"
find /var/backups/lp -name 'lp-*.dump' -mtime +14 -delete
${BACKUP_S3_URI:+command -v aws >/dev/null && aws s3 cp "\$F" "$BACKUP_S3_URI/" --only-show-errors || true}
EOF
chmod 755 /etc/cron.daily/lp-backup

echo "== schedules (once per active workspace, UTC)"
install -m 755 "$HERE/fanout.sh" /usr/local/bin/lp-fanout
cat > /etc/cron.d/lp-fanout <<'EOF'
# Lead Performance schedules: each line calls the site once per active workspace (ec2/fanout.sh). Times are UTC.
*/30 * * * *   root  /usr/local/bin/lp-fanout /api/meta-cron
15,45 * * * *  root  /usr/local/bin/lp-fanout /api/google-cron
*/5 * * * *    root  /usr/local/bin/lp-fanout "/api/alerts-cron?mode=activity"
5,35 * * * *   root  /usr/local/bin/lp-fanout "/api/alerts-cron?mode=summary"
10,40 * * * *  root  /usr/local/bin/lp-fanout "/api/suite?op=cron&mode=capi"
0 1 * * *      root  /usr/local/bin/lp-fanout "/api/suite?op=cron&mode=audiences"
45 3 * * *     root  /usr/local/bin/lp-fanout "/api/suite?op=cron&mode=digest"
EOF
chmod 644 /etc/cron.d/lp-fanout
systemctl enable --now cron >/dev/null

echo "== check"
sleep 3
# any HTTP answer counts (the root path is 404 on purpose: the API listing is off)
CODE=$(curl -s -m 10 -o /dev/null -w "%{http_code}" "http://127.0.0.1:3000/" || true)
[ "$CODE" != "000" ] && echo "PostgREST answers on localhost." || { echo "PostgREST isn't answering: journalctl -u postgrest -n 50"; exit 1; }
curl -fsS -m 30 "https://$API_DOMAIN/health" && echo " (HTTPS works)" || echo "HTTPS not ready yet (Caddy may still be getting the certificate): journalctl -u caddy -n 50"

cat <<EOF

============================================================================
Done. Put these in Vercel › performance project › Settings › Environment Variables
(Production), then redeploy. Don't paste them anywhere else.

  API_URL      https://$API_DOMAIN
  JWT_SECRET   $JWT_SECRET
  CRON_SECRET  $CRON_SECRET
  APP_URL      $APP_URL

They stay in /etc/lp.env on this server (root only); this script reuses them.
============================================================================
EOF
