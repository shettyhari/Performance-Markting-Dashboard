#!/usr/bin/env bash
# Moving the database server, step 1 of 2: run on the OLD server. It copies the whole database (accounts, workspaces, data,
# the vault and its key) to the backup bucket, under <BACKUP_S3_URI>/migrate/, with a row count per table for checking.
# Then run ec2/migrate-in.sh on the new server (README › Moving the server).
#
#   sudo bash migrate-out.sh            rehearsal: copies the live database; the site keeps working as normal
#   sudo bash migrate-out.sh --final    freezes the database first (read-only: people can view, nothing can be saved), then copies
#   sudo bash migrate-out.sh --undo     unfreezes it (if the move is called off; the site works on this server again)
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Run with sudo."; exit 1; }
# shellcheck disable=SC1091
. /etc/lp.env
MODE="${1:-}"
q() { sudo -u postgres psql -d lp -qtAX -v ON_ERROR_STOP=1 -c "$1"; }

if [ "$MODE" = "--undo" ]; then
  q "alter database lp reset default_transaction_read_only"
  q "select pg_terminate_backend(pid) from pg_stat_activity where datname = 'lp' and pid <> pg_backend_pid()" >/dev/null
  echo "The database on this server is writable again."; exit 0
fi
[ -z "$MODE" ] || [ "$MODE" = "--final" ] || { echo "Unknown option: $MODE (use --final or --undo, or nothing for a rehearsal)"; exit 1; }
U="${BACKUP_S3_URI:-}"; [ -n "$U" ] || { echo "BACKUP_S3_URI isn't set in /etc/lp.env, so there's nowhere to copy to."; exit 1; }

if [ "$MODE" = "--final" ]; then
  q "alter database lp set default_transaction_read_only = on"
  # open connections keep the old setting: end them (PostgREST reconnects at once, read-only)
  q "select pg_terminate_backend(pid) from pg_stat_activity where datname = 'lp' and pid <> pg_backend_pid()" >/dev/null
  echo "== database frozen: read-only from now on (undo: sudo bash $0 --undo)"
fi

STAMP=$(date -u +%Y%m%d-%H%M)
F="/var/backups/lp/lp-move-$STAMP.dump"; C="/var/backups/lp/lp-move-$STAMP.counts"
echo "== copying the database"
sudo -u postgres pg_dump -Fc lp > "$F"
# exact rows per table (accounts, workspaces, data, vault): migrate-in.sh compares the new server against this
sudo -u postgres psql -d lp -qtAX -v ON_ERROR_STOP=1 > "$C" <<'SQL'
select t.table_schema || '.' || t.table_name || ' ' ||
       (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from %I.%I', t.table_schema, t.table_name), false, true, '')))[1]::text
  from information_schema.tables t
 where t.table_schema in ('public', 'auth', 'vault') and t.table_type = 'BASE TABLE'
   and t.table_name not in ('platform_health', 'platform_events')   -- these keep growing every few minutes
 order by 1;
SQL
echo "   $(basename "$F"): $(stat -c %s "$F") bytes, $(wc -l < "$C") tables"
echo "== sending it to $U/migrate/"
/usr/local/bin/aws s3 cp "$F" "$U/migrate/lp-move.dump" --only-show-errors
/usr/local/bin/aws s3 cp "$C" "$U/migrate/lp-move.counts" --only-show-errors
logger -t lp-backup "migration copy $(basename "$F") sent to $U/migrate/ (${MODE:-rehearsal})"
echo "Done. Workspaces: $(q "select count(*) from public.organizations"), logins: $(q "select count(*) from auth.users")."
if [ "$MODE" = "--final" ]; then
  echo "Now run migrate-in.sh --force on the new server. This server stays read-only until you run: sudo bash $0 --undo"
else
  echo "Rehearsal copy sent. Now run migrate-in.sh on the new server to try the restore."
fi
