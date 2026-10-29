#!/usr/bin/env bash
# Server health snapshot for the CEO console (installed as /usr/local/bin/lp-health, run every 5 minutes from /etc/cron.d/lp-health).
# Writes one row to public.platform_health: disk, memory, load, uptime, services, backups, the S3 copy, schedule results over
# 24 hours and the HTTPS certificate's expiry. Counts and sizes only. Old rows are pruned (7 days of snapshots, 30 days of events).
set -uo pipefail
# shellcheck disable=SC1091
. /etc/lp.env

read -r DISK_TOTAL DISK_USED DISK_FREE < <(df -B1 --output=size,used,avail / | tail -1)
MEM_TOTAL=$(awk '/^MemTotal:/{print $2*1024}' /proc/meminfo)
MEM_AVAIL=$(awk '/^MemAvailable:/{print $2*1024}' /proc/meminfo)
SWAP_TOTAL=$(awk '/^SwapTotal:/{print $2*1024}' /proc/meminfo)
SWAP_FREE=$(awk '/^SwapFree:/{print $2*1024}' /proc/meminfo)
read -r LOAD1 LOAD5 LOAD15 _ < /proc/loadavg
UPTIME=$(cut -d. -f1 /proc/uptime)
CPUS=$(nproc)

svc() { systemctl is-active "$1" 2>/dev/null | head -1; }
S_PG=$(svc postgresql); S_REST=$(svc postgrest); S_CADDY=$(svc caddy); S_CRON=$(svc cron)

# newest local backup
LAST=$(ls -1t /var/backups/lp/lp-*.dump 2>/dev/null | head -1)
B_FILE=""; B_SIZE=0; B_AT=""; B_COUNT=$(ls -1 /var/backups/lp/lp-*.dump 2>/dev/null | wc -l)
if [ -n "$LAST" ]; then B_FILE=$(basename "$LAST"); B_SIZE=$(stat -c %s "$LAST"); B_AT=$(date -u -d "@$(stat -c %Y "$LAST")" +%FT%TZ); fi
# the last off-server copy result (journalctl -t lp-backup)
S3_LINE=$(journalctl -t lp-backup --since "-3 days" -o cat --no-pager 2>/dev/null | grep -E "copied|FAILED" | tail -1)
S3_STATE="none"; case "$S3_LINE" in *FAILED*) S3_STATE="failed";; *copied*) S3_STATE="ok";; esac
[ -n "${BACKUP_S3_URI:-}" ] || S3_STATE="off"

# scheduled jobs over 24 hours: lp-fanout logs "→ <http code>" per workspace and job
FAN=$(journalctl -t lp-fanout --since "-24 hours" -o cat --no-pager 2>/dev/null)
F_OK=$(printf '%s\n' "$FAN" | grep -cE "→ 2[0-9][0-9]$" || true)
F_BAD=$(printf '%s\n' "$FAN" | grep -E "→ [0-9]{3}$" | grep -cvE "→ 2[0-9][0-9]$" || true)
F_LAST_BAD=$(printf '%s\n' "$FAN" | grep -E "→ [0-9]{3}$" | grep -vE "→ 2[0-9][0-9]$" | tail -1 | cut -c1-200)

# HTTPS certificate on the API address
CERT_END=""
if [ -n "${API_DOMAIN:-}" ]; then
  E=$(echo | timeout 8 openssl s_client -connect "$API_DOMAIN:443" -servername "$API_DOMAIN" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)
  [ -n "$E" ] && CERT_END=$(date -u -d "$E" +%FT%TZ 2>/dev/null || true)
fi

sudo -u postgres psql -d lp -qtA -v ON_ERROR_STOP=1 \
  -v disk_total="$DISK_TOTAL" -v disk_used="$DISK_USED" -v disk_free="$DISK_FREE" \
  -v mem_total="$MEM_TOTAL" -v mem_avail="$MEM_AVAIL" -v swap_total="$SWAP_TOTAL" -v swap_free="$SWAP_FREE" \
  -v load1="$LOAD1" -v load5="$LOAD5" -v load15="$LOAD15" -v uptime="$UPTIME" -v cpus="$CPUS" \
  -v s_pg="$S_PG" -v s_rest="$S_REST" -v s_caddy="$S_CADDY" -v s_cron="$S_CRON" \
  -v b_file="$B_FILE" -v b_size="$B_SIZE" -v b_at="$B_AT" -v b_count="$B_COUNT" -v s3_state="$S3_STATE" -v s3_line="$S3_LINE" \
  -v f_ok="$F_OK" -v f_bad="$F_BAD" -v f_last_bad="$F_LAST_BAD" -v cert_end="$CERT_END" \
  -v host="$(hostname)" -v kernel="$(uname -r)" >/dev/null <<'SQL'
insert into public.platform_health (data) values (jsonb_build_object(
  'host', :'host', 'kernel', :'kernel', 'cpus', :'cpus'::int, 'uptime_s', :'uptime'::bigint,
  'load', jsonb_build_array(:'load1'::numeric, :'load5'::numeric, :'load15'::numeric),
  'disk', jsonb_build_object('total', :'disk_total'::bigint, 'used', :'disk_used'::bigint, 'free', :'disk_free'::bigint),
  'memory', jsonb_build_object('total', :'mem_total'::bigint, 'available', :'mem_avail'::bigint, 'swap_total', :'swap_total'::bigint, 'swap_free', :'swap_free'::bigint),
  'services', jsonb_build_object('postgresql', :'s_pg', 'postgrest', :'s_rest', 'caddy', :'s_caddy', 'cron', :'s_cron'),
  'backup', jsonb_build_object('file', :'b_file', 'bytes', :'b_size'::bigint, 'at', nullif(:'b_at', ''), 'count', :'b_count'::int,
                               's3', :'s3_state', 's3_last', :'s3_line'),
  'schedules', jsonb_build_object('ok_24h', :'f_ok'::int, 'failed_24h', :'f_bad'::int, 'last_failure', :'f_last_bad'),
  'cert_expires', nullif(:'cert_end', ''),
  'db_bytes', pg_database_size('lp')));
select public.platform_prune();
SQL
