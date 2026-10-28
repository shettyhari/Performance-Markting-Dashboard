#!/usr/bin/env bash
# Calls one of the site's scheduled endpoints once for every active workspace, in parallel (installed as /usr/local/bin/lp-fanout).
#   lp-fanout /api/meta-cron      → POST $APP_URL/api/meta-cron?org=<id> with x-cron-secret, for each workspace
# Settings come from /etc/lp.env (APP_URL, CRON_SECRET). Results go to syslog (journalctl -t lp-fanout).
set -uo pipefail
# shellcheck disable=SC1091
. /etc/lp.env
P="${1:?usage: lp-fanout /api/path[?query]}"
case "$P" in *\?*) SEP="&";; *) SEP="?";; esac
ORGS=$(sudo -u postgres psql -d lp -qtAc "select id from public.organizations where active order by created_at") || { logger -t lp-fanout "database not reachable"; exit 1; }
[ -n "$ORGS" ] || exit 0
for ORG in $ORGS; do
  (
    CODE=$(curl -s -o /dev/null -w '%{http_code}' -m 70 -X POST -H "content-type: application/json" -H "x-cron-secret: $CRON_SECRET" \
      --data '{}' "$APP_URL$P${SEP}org=$ORG")
    logger -t lp-fanout "$P org=$ORG → $CODE"
  ) &
done
wait
