#!/usr/bin/env bash
# Brings production up to date with LOCK (2026-09-27): a BOM row is a design
# with no code; locking a line rolls it out into pieces with their real codes
# (cf_order_pieces); a change after lock is a new revision of the order.
#
#   1. schema — cf_erp init.sql, guarded and idempotent: the lock columns (§25),
#      cf_order_pieces (§26), order revisions (§27). Only what is missing applies.
#   2. the Lock stage into every process of every cf_erp company
#      (cf_add_lock_stage.mjs — after Cut pieces; a second run changes nothing)
#   3. lines that were NESTED before lock existed are locked, each committed only
#      if every one of its pieces keeps the code it had (cf_lock_nested_lines.mjs)
#   4. rows lose their codes: the top piece rule reads the order number (proved
#      against every existing top code first), the row rules retire, rows of
#      unlocked lines are cleared (cf_rows_no_codes.mjs)
#   5. the KEPL order still reconciles to its BOQ (cf_verify_against_boq.mjs)
#
# Run it from anywhere; it finds its own way:
#
#   multi_app_be/scripts/cf_kepl/update-cf-prod-lock.sh --dry-run   # steps 2-4 rehearsed and rolled back; no schema
#   multi_app_be/scripts/cf_kepl/update-cf-prod-lock.sh --yes       # does it
#
# CREDENTIALS live in TM/.env.tidb, deliberately OUTSIDE this repo and never
# committed. Override with CF_ENV_FILE=/path/to/env.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BE="$(cd "$HERE/../.." && pwd)"                 # multi_app_be
cd "$BE"

MODE="${1:-}"
[[ "$MODE" == "--yes" || "$MODE" == "--dry-run" ]] || { echo "This writes to PRODUCTION. Re-run with --dry-run to rehearse, or --yes to mean it."; exit 1; }
DRY=$([[ "$MODE" == "--dry-run" ]] && echo 1 || echo 0)

ENV_FILE="${CF_ENV_FILE:-$BE/../.env.tidb}"
[[ -f "$ENV_FILE" ]] || { echo "No credentials file at $ENV_FILE (it is not in the repo on purpose; set CF_ENV_FILE)."; exit 1; }
set -a; source "$ENV_FILE"; set +a

MYSQL="${CF_MYSQL:-/c/Program Files/MySQL/MySQL Server 8.0/bin/mysql.exe}"
[[ -x "$MYSQL" ]] || { echo "No mysql client at $MYSQL — set CF_MYSQL."; exit 1; }
mysql_run() {
  "$MYSQL" --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER" --password="$DB_PASSWORD" \
    --ssl-mode=REQUIRED "$DB_NAME" "$@"
}

S=scripts/cf_kepl
for f in apps/cf_erp/models/init.sql $S/cf_add_lock_stage.mjs $S/cf_lock_nested_lines.mjs $S/cf_rows_no_codes.mjs $S/cf_verify_against_boq.mjs; do
  [[ -f "$BE/$f" ]] || { echo "Missing: $f"; exit 1; }
done
step() { echo; echo "== $1 =="; }

if [[ "$DRY" == 1 ]]; then
  step "1. schema — skipped in a dry run (it cannot be rolled back)"
else
  step "1. schema — guarded and idempotent, applies only what is missing"
  mysql_run < apps/cf_erp/models/init.sql
fi

# Every company that runs sales-order processes.
COMPANIES=$(mysql_run -N -e "SELECT DISTINCT company_id FROM cf_processes WHERE deleted_at IS NULL ORDER BY company_id")
echo "companies with order processes: $(echo $COMPANIES | tr '\n' ' ')"

step "2. the Lock stage in every process"
for co in $COMPANIES; do
  echo "-- company $co"
  if [[ "$DRY" == 1 ]]; then CF_BRIDGE_COMPANY=$co node $S/cf_add_lock_stage.mjs --dry-run
  else CF_BRIDGE_COMPANY=$co node $S/cf_add_lock_stage.mjs; fi
done

step "3. lock the lines that were nested before lock existed — only if every code is kept"
for co in $COMPANIES; do
  echo "-- company $co"
  if [[ "$DRY" == 1 ]]; then CF_BRIDGE_COMPANY=$co node $S/cf_lock_nested_lines.mjs
  else CF_BRIDGE_COMPANY=$co node $S/cf_lock_nested_lines.mjs --commit; fi
done

step "4. rows carry no codes"
if [[ "$DRY" == 1 ]]; then node $S/cf_rows_no_codes.mjs
else node $S/cf_rows_no_codes.mjs --commit; fi

step "5. the KEPL order against its BOQ"
CF_BRIDGE_COMPANY=30005 node $S/cf_verify_against_boq.mjs

step "what is there now"
mysql_run -t -e "
SELECT 'locked lines' AS what, COUNT(*) AS n FROM cf_sales_order_lines WHERE locked_at IS NOT NULL AND deleted_at IS NULL
UNION ALL SELECT 'live order pieces', COUNT(*) FROM cf_order_pieces WHERE deleted_at IS NULL
UNION ALL SELECT 'processes with a Lock stage', COUNT(DISTINCT process_id) FROM cf_process_stages WHERE stage_key='lock' AND deleted_at IS NULL
UNION ALL SELECT 'rows of unlocked lines with a code', COUNT(*) FROM cf_master_records m
   JOIN cf_item_details i ON i.master_id=m.id AND i.item_type='temporary'
   JOIN cf_sales_order_lines l ON l.id=i.owner_order_line_id AND l.locked_at IS NULL AND l.deleted_at IS NULL
   LEFT JOIN cf_classification_nodes cp ON cp.company_id=m.company_id AND cp.code='CUT_PLATE' AND cp.deleted_at IS NULL
  WHERE m.deleted_at IS NULL AND m.code IS NOT NULL AND NOT (m.classification_id <=> cp.id) AND m.name NOT LIKE 'Cut plate%'
UNION ALL SELECT 'active item rules still coding rows', COUNT(DISTINCT s.id) FROM cf_code_schemes s
   JOIN cf_code_scheme_conditions k ON k.scheme_id=s.id AND k.deleted_at IS NULL AND k.token_key='kind' AND k.value LIKE '%temporary%'
  WHERE s.entity_type='item' AND s.status='active' AND s.deleted_at IS NULL AND s.code <> 'CFTMP-BLANK';"
echo; echo "done."
