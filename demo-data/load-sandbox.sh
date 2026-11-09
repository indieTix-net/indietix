#!/usr/bin/env bash
# load-sandbox.sh -- resets a demo venue in a bootstrap test environment and
# fills it with made-up data (src/generate.mjs). Wipes that venue's orders,
# tickets, customers, staff logins and marketing posts first, so it doubles
# as the demo's reset. Runs the SQL through the environment's sql-runner
# function (bootstrap test environments only; production has none).
#
#   ./load-sandbox.sh <client-id> [size options]
#   ./load-sandbox.sh marquee --kind cinema --customers 2000 --tickets 15000
#   BOOTSTRAP_CONFIG=bootstrap.config.other.sh ./load-sandbox.sh <client-id>
#
# Size options are passed to bin/build-sql.mjs: --kind cinema|live|both,
# --months, --tickets, --tickets-per-movie, --tickets-per-live, --customers,
# --orders-per-customer, --seed. See the README.
#
# Passwords: DEMO_STAFF_PASSWORD / DEMO_GUEST_PASSWORD, or new random ones,
# printed at the end. Refuses an environment marked ENV_IS_PRODUCTION="true".
set -euo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
infra="$here/../infrastructure"
config="$infra/${BOOTSTRAP_CONFIG:-bootstrap.config.sh}"
client="${1:-}"
[ -n "$client" ] || { echo "Usage: $(basename "$0") <client-id> [size options]" >&2; exit 1; }
shift
[ -f "$config" ] || { echo "No $config" >&2; exit 1; }
# shellcheck source=/dev/null
source "$config"
if [ "${ENV_IS_PRODUCTION:-false}" = "true" ]; then
  echo "Refusing: $config marks '$ENV_PREFIX' as production. The demo loader wipes the venue it loads." >&2
  exit 1
fi
aws_args=(--region "$AWS_REGION")
[ -n "${AWS_PROFILE:-}" ] && aws_args+=(--profile "$AWS_PROFILE")
runner="${ENV_PREFIX}-sql-runner"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

run_sql() { # file -> runs it as one statement batch against the venue database
  python3 -c 'import json,sys; print(json.dumps({"database": sys.argv[1], "sql": open(sys.argv[2]).read()}))' "$client" "$1" > "$work/payload.json"
  local err
  err="$(aws lambda invoke --function-name "$runner" --cli-binary-format raw-in-base64-out --cli-read-timeout 120 \
    --payload "fileb://$work/payload.json" "${aws_args[@]}" "$work/out.json" --query FunctionError --output text)"
  if [ "$err" != "None" ] || ! grep -q '"statusCode": *200' "$work/out.json"; then
    echo "Failed on $(basename "$1"):" >&2; head -c 600 "$work/out.json" >&2; echo >&2; exit 1
  fi
}

echo "Checking that $client exists in '$ENV_PREFIX' ($AWS_REGION)..."
printf 'SELECT "clientID" FROM "Client"' > "$work/check.sql"
run_sql "$work/check.sql"
grep -q "\"$client\"" "$work/out.json" || { echo "No venue $client in '$ENV_PREFIX' (onboard it with bootstrap.sh add-client first)." >&2; exit 1; }

site="https://${STATIC_SITE_DOMAIN:-$(aws cloudformation describe-stacks --stack-name "${ENV_PREFIX}-static-site" "${aws_args[@]}" \
  --query "Stacks[0].Outputs[?OutputKey=='DistributionDomainName'].OutputValue" --output text)}"
(cd "$here" && node bin/build-sql.mjs --client "$client" --site "$site" --out "$work/sql" "$@") | tee "$work/summary.txt"
bucket="$(aws cloudformation describe-stacks --stack-name "${ENV_PREFIX}-static-site" "${aws_args[@]}" \
  --query "Stacks[0].Outputs[?OutputKey=='BucketName'].OutputValue" --output text)"
aws s3 cp "$here/assets/marquee-logo.png" "s3://$bucket/venue-logos/$client/demo-logo.png" --content-type image/png "${aws_args[@]}" >/dev/null
echo "  logo uploaded"
for file in "$work"/sql/*.sql; do
  printf '  loading %s\n' "$(basename "$file")"
  run_sql "$file"
done
echo
echo "Demo venue $client is loaded: $site/login.html"
