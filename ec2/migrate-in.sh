#!/usr/bin/env bash
# Moving the database server, step 2 of 2: run on the NEW server, after ec2/setup.sh and after saving the backup bucket's access key
# (sudo /usr/local/bin/aws configure). It downloads the copy that migrate-out.sh sent to <BACKUP_S3_URI>/migrate/, replaces this
# server's database with it, re-applies db/*.sql, restarts the API and compares every table's row count with the old server's.
#
#   sudo bash migrate-in.sh            only when this server's database is still empty (a fresh setup.sh)
#   sudo bash migrate-in.sh --force    replaces it anyway (the final copy after a rehearsal)
#
# This server keeps its own JWT_SECRET and CRON_SECRET (from setup.sh): put them and its API_URL in Vercel after the move.
# Everyone signs in once more; nothing else changes. Workspace tokens move with the database (the vault and its key are in the copy).
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run with sudo."; exit 1; }
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/.." && pwd)"
# shellcheck disable=SC1091
. /etc/lp.env
U="${BACKUP_S3_URI:-}"; [ -n "$U" ] || { echo "BACKUP_S3_URI isn't set: run setup.sh with BACKUP_S3_URI=... first."; exit 1; }
AWS=/usr/local/bin/aws; [ -x "$AWS" ] || { echo "The AWS CLI isn't installed: run setup.sh with BACKUP_S3_URI=... first."; exit 1; }
q() { sudo -u postgres psql -d lp -qtAX -v ON_ERROR_STOP=1 -c "$1"; }

HAVE=$(q "select count(*) from public.organizations" 2>/dev/null || echo 0)
if [ "$HAVE" != "0" ] && [ "${1:-}" != "--force" ]; then
  echo "This server's database already has $HAVE workspace(s). To replace it with the copy from the old server, run: sudo bash $0 --force"; exit 1
fi

T=$(mktemp -d); trap 'rm -rf "$T"' EXIT
echo "== downloading the copy from $U/migrate/"
"$AWS" s3 cp "$U/migrate/lp-move.dump" "$T/lp.dump" --only-show-errors
"$AWS" s3 cp "$U/migrate/lp-move.counts" "$T/old.counts" --only-show-errors
echo "   $(stat -c %s "$T/lp.dump") bytes, made $(date -u -d "@$(stat -c %Y "$T/lp.dump")" '+%d %b %H:%M UTC' 2>/dev/null || echo "")"

echo "== replacing this server's database"
[ -f /var/backups/lp/lp-before-move.dump ] || sudo -u postgres pg_dump -Fc lp > /var/backups/lp/lp-before-move.dump 2>/dev/null || true
systemctl stop postgrest
sudo -u postgres dropdb --if-exists --force lp
sudo -u postgres createdb lp
# all or nothing: on any error the database is left empty and the reason is printed (run it again after fixing)
if ! sudo -u postgres pg_restore -d lp --single-transaction --exit-on-error < "$T/lp.dump"; then
  echo "The restore failed (nothing was half-copied). The old server is unchanged: run migrate-out.sh --undo there if it's frozen."; exit 1
fi
# the copy carries no database-level settings, so it isn't read-only here; bring the schema up to this repo's version
for f in 00-platform 10-schema 20-auth 30-platform; do sudo -u postgres psql -q -v ON_ERROR_STOP=1 -d lp < "$ROOT/db/$f.sql" >/dev/null; done
systemctl start postgrest

echo "== comparing row counts with the old server"
sudo -u postgres psql -d lp -qtAX -v ON_ERROR_STOP=1 > "$T/new.counts" <<'SQL'
select t.table_schema || '.' || t.table_name || ' ' ||
       (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', t.table_schema, t.table_name), false, true, '')))[1]::text
  from information_schema.tables t
 where t.table_schema in ('public', 'auth', 'vault') and t.table_type = 'BASE TABLE'
   and t.table_name not in ('platform_health', 'platform_events')
 order by 1;
SQL
# a table that exists only here is new in this repo version (and empty); every table the old server had must match exactly
MISMATCH=$(join -a1 -e MISSING -o 0,1.2,2.2 <(sort "$T/old.counts") <(sort "$T/new.counts") | awk '$2 != $3 {print "   " $1 ": old " $2 ", new " $3}')
if [ -n "$MISMATCH" ]; then echo "Row counts differ:"; echo "$MISMATCH"; exit 1; fi
echo "   all $(wc -l < "$T/old.counts") tables match"
sleep 2
CODE=$(curl -s -m 10 -o /dev/null -w "%{http_code}" "http://127.0.0.1:3000/" || true)
[ "$CODE" != "000" ] && echo "PostgREST answers on localhost." || echo "PostgREST isn't answering yet: journalctl -u postgrest -n 50"
logger -t lp-backup "migration copy restored: $(q "select count(*) from public.organizations") workspaces, $(q "select count(*) from auth.users") logins"
echo "Done. Workspaces: $(q "select count(*) from public.organizations"), logins: $(q "select count(*) from auth.users")."
echo "Next: in Vercel set API_URL, JWT_SECRET and CRON_SECRET to this server's values (sudo grep -E '^(API_DOMAIN|JWT_SECRET|CRON_SECRET)=' /etc/lp.env), then redeploy."
