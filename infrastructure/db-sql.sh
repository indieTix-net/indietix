#!/usr/bin/env bash
# db-sql.sh -- run one SQL statement against a venue database from your
# own machine through the RDS Data API (no server, no psql, no VPN).
# Read-only unless you pass --write: the statement runs inside a READ ONLY
# transaction that is always rolled back.
#
#   ./db-sql.sh "SELECT count(*) FROM \"Order\""
#   ./db-sql.sh --write "UPDATE ..."            # commits
#   ./db-sql.sh --db <database> --login <secret-name> "SELECT ..."
#   ./db-sql.sh --json "SELECT ..."             # raw JSON rows
#   ./db-sql.sh -f query.sql                    # statement from a file
#
# Defaults come from deploy.config.sh: DB_CLUSTER (cluster identifier),
# DB_NAME (database), DB_SECRET (Secrets Manager name of the login) and
# REGION. The cluster needs the Data API on (aws rds enable-http-endpoint).
# One statement per call; results are capped at 1 MB, statements at 45 s.
set -euo pipefail
cd "$(dirname "$0")"
[ -f deploy.config.sh ] && source deploy.config.sh

write=false json=false sql="" db="${DB_NAME:-}" login="${DB_SECRET:-}"
while [ $# -gt 0 ]; do
  case "$1" in
    --write) write=true ;;
    --json) json=true ;;
    --db) db="$2"; shift ;;
    --login) login="$2"; shift ;;
    -f) sql="$(cat "$2")"; shift ;;
    -h|--help) sed -n '2,17p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) sql="$1" ;;
  esac
  shift
done
if [ -z "$sql" ] || [ -z "$db" ] || [ -z "$login" ] || [ -z "${DB_CLUSTER:-}" ]; then
  echo "Usage: ./db-sql.sh [--write] [--json] [--db <database>] [--login <secret>] \"<SQL>\" | -f <file>" >&2
  echo "(DB_CLUSTER, DB_NAME and DB_SECRET come from deploy.config.sh)" >&2
  exit 2
fi

region="${REGION:-us-east-2}"
cluster_arn="$(aws rds describe-db-clusters --region "$region" --db-cluster-identifier "$DB_CLUSTER" \
  --query 'DBClusters[0].DBClusterArn' --output text)"
secret_arn="$(aws secretsmanager describe-secret --region "$region" --secret-id "$login" --query ARN --output text)"
data() { aws rds-data "$@" --region "$region" --resource-arn "$cluster_arn" --secret-arn "$secret_arn"; }

tx="$(data begin-transaction --database "$db" --query transactionId --output text)"
trap '[ -n "$tx" ] && data rollback-transaction --transaction-id "$tx" >/dev/null 2>&1 || true' EXIT
if [ "$write" = false ]; then
  data execute-statement --database "$db" --transaction-id "$tx" --sql "SET TRANSACTION READ ONLY" >/dev/null
fi
result="$(data execute-statement --database "$db" --transaction-id "$tx" --sql "$sql" \
  --format-records-as JSON --output json)"
if [ "$write" = true ]; then
  data commit-transaction --transaction-id "$tx" >/dev/null
  tx=""
fi

RESULT="$result" JSON_OUT="$json" python3 - <<'EOF'
import json, os
r = json.loads(os.environ["RESULT"])
rows = json.loads(r["formattedRecords"]) if r.get("formattedRecords") else []
if os.environ["JSON_OUT"] == "true":
    print(json.dumps(rows, indent=2, default=str))
elif rows:
    cols = list(rows[0].keys())
    cell = lambda v: "" if v is None else (json.dumps(v) if isinstance(v, (dict, list)) else str(v))
    width = {c: min(60, max(len(c), *(len(cell(row.get(c))) for row in rows))) for c in cols}
    print(" | ".join(c.ljust(width[c]) for c in cols))
    print("-+-".join("-" * width[c] for c in cols))
    for row in rows:
        print(" | ".join(cell(row.get(c))[:60].ljust(width[c]) for c in cols))
    print(f"({len(rows)} row{'s' if len(rows) != 1 else ''})")
else:
    print(f"OK, {r.get('numberOfRecordsUpdated', 0)} row(s) affected")
EOF
