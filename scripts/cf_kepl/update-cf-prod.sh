#!/usr/bin/env bash
# Brings production up to date with local for cf_erp, after the shop-floor,
# flow and drawings work.
#
# Unlike rebuild-cf-bridge-prod.sh this does NOT rebuild the bridge — the order,
# its 208 temporary items and their values stay where they are. It adds the shop
# floor, says how each thing is made, and re-codes what was named badly, all in
# place.
#
# Schema first: init.sql is guarded and idempotent, so it only applies what is
# genuinely missing (the cf_drawings tables and the uq_cofs_operation index swap,
# when this first ran) and does nothing else.
#
# Step 6 exists because this order was first built by a run that was interrupted
# and resumed. A resumed run only writes what is missing, so rows the first pass
# wrote keep their old values and nothing looks at them again. One part kept
# THICKNESS 30 against the BOQ's 25 that way, worth 1,441 kg over the order. The
# reconcile compares every part to the blank it is cut from AND to the BOQ, and
# repairs only where both agree. Step 9 then proves the whole order against the
# customer's document — the only check here that does not compare the model to
# itself.
#
# Step 8 leaves the codes in the RANGE state (user, 2026-09-26): a row of 21
# plain stiffeners and its copied row of 3 drilled ones are IS1-21 and IS22-24,
# and released pieces take their own number, SO-…-SPAN-01-1-G1-1-IS24. Step 7
# already writes CFTMP-PART with {range}; step 8 writes the production-piece
# rules, dry-runs a release of every custom line (nothing is released) and
# rolls itself back if any piece code would repeat. It must stay AFTER step 7.
#
# Run it from anywhere; it finds its own way:
#
#   multi_app_be/scripts/cf_kepl/update-cf-prod.sh --yes
#
# CREDENTIALS live in TM/.env.tidb, which is deliberately OUTSIDE this repo and
# must never be committed. That is why this script reaches one level above the
# repo root for it. Override with CF_ENV_FILE=/path/to/env if yours sits
# elsewhere.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BE="$(cd "$HERE/../.." && pwd)"                 # multi_app_be
cd "$BE"

[[ "${1:-}" == "--yes" ]] || { echo "This writes to PRODUCTION. Re-run with --yes to mean it."; exit 1; }

ENV_FILE="${CF_ENV_FILE:-$BE/../.env.tidb}"
[[ -f "$ENV_FILE" ]] || {
  echo "No credentials file at $ENV_FILE"
  echo "It is not in the repo on purpose. Set CF_ENV_FILE if yours is elsewhere."
  exit 1
}
set -a; source "$ENV_FILE"; set +a
export CF_BRIDGE_COMPANY=30005

MYSQL="${CF_MYSQL:-/c/Program Files/MySQL/MySQL Server 8.0/bin/mysql.exe}"
[[ -x "$MYSQL" ]] || { echo "No mysql client at $MYSQL — set CF_MYSQL."; exit 1; }

S=scripts/cf_kepl
SQL=(apps/cf_erp/modules/parties/models/init.sql
     apps/cf_erp/models/init.sql
     apps/cf_erp/modules/codegen/models/init.sql)
MJS=(cf_shop_import cf_ops_import cf_assembly_flows cf_wire_flows
     cf_reconcile_dims cf_recode_order cf_range_rules cf_verify_against_boq)

# Everything this needs must exist BEFORE anything touches production. A moved
# or renamed file should stop the run at step 0, not half way through a write.
missing=()
for f in "${SQL[@]}"; do [[ -f "$BE/$f" ]] || missing+=("$f"); done
for m in "${MJS[@]}"; do [[ -f "$BE/$S/$m.mjs" ]] || missing+=("$S/$m.mjs"); done
if ((${#missing[@]})); then
  echo "Missing, relative to $BE:"; printf '   %s\n' "${missing[@]}"; exit 1
fi

step() { echo; echo "== $1 =="; }
mysql_run() {
  "$MYSQL" --host="$DB_HOST" --port="$DB_PORT" --user="$DB_USER" --password="$DB_PASSWORD" \
    --ssl-mode=REQUIRED "$DB_NAME" "$@"
}

step "1. schema — guarded and idempotent, applies only what is missing"
for f in "${SQL[@]}"; do
  echo "   -> $f"
  mysql_run < "$f"
done

step "2. the shop floor — machine types and machines"    ; node $S/cf_shop_import.mjs
step "3. operations and flows, all 43 steps"             ; node $S/cf_ops_import.mjs
step "4. the assembly flows"                             ; node $S/cf_assembly_flows.mjs
step "5. say how each thing is made"                     ; node $S/cf_wire_flows.mjs
step "6. reconcile part dimensions against the BOQ"      ; node $S/cf_reconcile_dims.mjs --fix
step "7. re-code and re-name the order's items"          ; node $S/cf_recode_order.mjs
step "8. range codes, and the codes released pieces take"; node $S/cf_range_rules.mjs
step "9. verify the order against the customer's BOQ"    ; node $S/cf_verify_against_boq.mjs

step "what is there now"
mysql_run -t -e "
SELECT 'machine types' AS what, COUNT(*) AS n FROM cf_classification_nodes WHERE company_id=30005 AND scope='machine' AND depth=2 AND deleted_at IS NULL
UNION ALL SELECT 'machines', COUNT(*) FROM cf_machines WHERE company_id=30005 AND deleted_at IS NULL
UNION ALL SELECT 'operations', COUNT(*) FROM cf_operations WHERE company_id=30005 AND deleted_at IS NULL
UNION ALL SELECT 'flows', COUNT(*) FROM cf_operation_flows WHERE company_id=30005 AND deleted_at IS NULL
UNION ALL SELECT 'flow steps', COUNT(*) FROM cf_operation_flow_steps WHERE company_id=30005 AND deleted_at IS NULL
UNION ALL SELECT 'temporary items with no flow', COUNT(*) FROM cf_master_records m
   JOIN cf_item_details i ON i.master_id=m.id AND i.item_type='temporary'
   LEFT JOIN cf_master_records sd ON sd.id=i.source_definition_id
  WHERE m.company_id=30005 AND m.deleted_at IS NULL AND m.default_flow_id IS NULL AND (sd.id IS NULL OR sd.default_flow_id IS NULL)
UNION ALL SELECT 'temporary items with no code', COUNT(*) FROM cf_master_records m
   JOIN cf_item_details i ON i.master_id=m.id AND i.item_type='temporary'
  WHERE m.company_id=30005 AND m.deleted_at IS NULL AND m.code IS NULL
UNION ALL SELECT 'item code rules that print {range}', COUNT(DISTINCT s.id) FROM cf_code_schemes s
   JOIN cf_code_scheme_segments g ON g.scheme_id=s.id AND g.deleted_at IS NULL AND g.token_key='range'
  WHERE s.company_id=30005 AND s.entity_type='item' AND s.status='active' AND s.deleted_at IS NULL
UNION ALL SELECT 'production-piece coding rules', COUNT(*) FROM cf_code_schemes
  WHERE company_id=30005 AND entity_type='production_piece' AND status='active' AND deleted_at IS NULL
UNION ALL SELECT 'names still ending in a number', COUNT(*) FROM cf_master_records m
   JOIN cf_item_details i ON i.master_id=m.id AND i.item_type='temporary'
  WHERE m.company_id=30005 AND m.deleted_at IS NULL AND m.name REGEXP '[[:space:]][0-9]+\$'
UNION ALL SELECT 'the span, in kg', ROUND(v.value_number) FROM cf_sales_order_lines l
   JOIN cf_spec_values v ON v.subject_id=l.item_id AND v.subject_type='master' AND v.deleted_at IS NULL
     AND v.specification_id=(SELECT id FROM cf_specifications WHERE company_id=30005 AND code='WEIGHT')
  WHERE l.company_id=30005 AND l.deleted_at IS NULL;"
echo; echo "done."
