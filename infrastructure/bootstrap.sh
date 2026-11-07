#!/bin/bash
# bootstrap.sh -- stands up (or tears down) the ENTIRE indieTix platform
# from scratch in a fresh AWS account/region: all 12 SAM stacks, in
# dependency order, parameterized by EnvPrefix so multiple environments
# can coexist in the same account without colliding. Also onboards the
# first client. Does NOT configure any third-party integration (Square,
# Google Calendar, social media, SMS/10DLC) -- those need real
# accounts/approvals on the other end; `up` prints the exact manual
# checklist for them at the end.
#
# Requires: aws CLI, sam CLI (AWS SAM), and a bootstrap.config.sh in this
# same directory (copy bootstrap.config.sh.template and fill in your own
# values -- gitignored, never committed).
# Run with no arguments for usage.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAGING="/tmp/indietix-bootstrap"
mkdir -p "$STAGING"

# shellcheck source=lib/repo-config.sh
source "$SCRIPT_DIR/lib/repo-config.sh"
# shellcheck source=lib/build-helpers.sh
source "$SCRIPT_DIR/lib/build-helpers.sh"

usage() {
  cat <<EOF
Usage: $(basename "$0") <command> [args]

  up [--yes]     Deploy all 12 stacks in dependency order and onboard the
                  first client. Prompts for confirmation unless --yes is
                  given. With SQUARE_WEBHOOK_AUTO="true", also creates or
                  updates this environment's Square webhook subscription
                  (payment.updated only) and uses its signature key; with
                  FIRST_CLIENT_SETTINGS_FILE, applies that JSON file's
                  Client Settings to the first client. Safe to re-run
                  (CloudFormation only applies the diff; the webhook is
                  left alone if already correct; onboarding fails cleanly
                  once the client exists).
  down [--yes] [--production]
                 Delete every stack for this EnvPrefix, in reverse order.
                  Destructive and not reversible: never run it against
                  production. Removes this environment's Square webhook
                  subscription (only if it points at this environment),
                  offboards every client (DB, secret, S3 buckets), empties
                  buckets so stacks can delete, and removes the
                  ticket-templates bucket and published shared layers.
  add-client <venue-file>
                 Add another venue to this environment from a venue JSON
                  file (copy venue.json.template into venues/, gitignored).
                  With square_webhook.auto, creates/updates that venue's own
                  Square webhook subscription first. Safe to re-run.
  remove-client <venue-file | client-id> [--yes] [--production]
                 Remove one venue: its database, secret and S3 buckets
                  (and, given its venue file, its Square webhook). Only
                  touches a client that lives in this environment.
                  Not reversible.
  list-clients   Show the client IDs in this environment.
  block [--yes]  Reject every request to this environment (reserved
                  concurrency 0 on each of its Lambdas) -- what the optional
                  cost-guard breaker does when the daily budget is exceeded.
  unblock        Reverse 'block' or a tripped breaker.
  breaker-status Show each of this environment's Lambdas as open or BLOCKED.

Config: bootstrap.config.sh in this directory (copy from
bootstrap.config.sh.template). ENV_PREFIX namespaces everything, so
multiple environments can coexist in the same AWS account/region.
Check ENV_PREFIX, AWS_REGION and AWS_PROFILE there before 'up' or 'down'.
With ENV_IS_PRODUCTION="true", down and remove-client refuse to run
without --production and make you type the name to confirm.

Examples:
  $(basename "$0") up
  $(basename "$0") up --yes
  $(basename "$0") down
  $(basename "$0") breaker-status
  $(basename "$0") add-client venues/newvenue.json
  $(basename "$0") remove-client venues/newvenue.json

More: CHEATSHEET.md (every command on one page), README.md (setup),
CLIENT_SETUP.md (adding venues).
EOF
}

# --help answers before any config is loaded (a fresh clone has none yet).
case "${1:-}" in help|-h|--help) usage; exit 0 ;; esac

# BOOTSTRAP_CONFIG=<file> picks another config, for a second environment
# (e.g. BOOTSTRAP_CONFIG=bootstrap.config.square-sandbox.sh ./bootstrap.sh up).
# A relative path is relative to this directory.
CONFIG_FILE="${BOOTSTRAP_CONFIG:-bootstrap.config.sh}"
case "$CONFIG_FILE" in /*) ;; *) CONFIG_FILE="$SCRIPT_DIR/$CONFIG_FILE" ;; esac
echo "Config: $CONFIG_FILE" >&2
if [ ! -f "$CONFIG_FILE" ]; then
  echo "Missing $CONFIG_FILE." >&2
  echo "Copy bootstrap.config.sh.template to bootstrap.config.sh and fill in your own values." >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$CONFIG_FILE"

[ -z "${ENV_PREFIX:-}" ]               && { echo "bootstrap.config.sh is missing ENV_PREFIX" >&2; exit 1; }
[ -z "${AWS_REGION:-}" ]               && { echo "bootstrap.config.sh is missing AWS_REGION" >&2; exit 1; }
[ -z "${FIRST_CLIENT_USERNAME:-}" ]    && { echo "bootstrap.config.sh is missing FIRST_CLIENT_USERNAME" >&2; exit 1; }
[ -z "${FIRST_CLIENT_SECRET:-}" ]      && { echo "bootstrap.config.sh is missing FIRST_CLIENT_SECRET" >&2; exit 1; }
[ -z "${FIRST_CLIENT_CONTACT_NAME:-}" ] && { echo "bootstrap.config.sh is missing FIRST_CLIENT_CONTACT_NAME" >&2; exit 1; }
[ -z "${FIRST_CLIENT_CONTACT_EMAIL:-}" ] && { echo "bootstrap.config.sh is missing FIRST_CLIENT_CONTACT_EMAIL" >&2; exit 1; }
[ -z "${FIRST_CLIENT_THEATER_NAME:-}" ] && { echo "bootstrap.config.sh is missing FIRST_CLIENT_THEATER_NAME" >&2; exit 1; }
STATIC_SITE_DOMAIN="${STATIC_SITE_DOMAIN:-}"
ENABLE_MARKETING_POLLER="${ENABLE_MARKETING_POLLER:-false}"
FIRST_CLIENT_SQUARE_ACCESS_TOKEN="${FIRST_CLIENT_SQUARE_ACCESS_TOKEN:-}"
FIRST_CLIENT_SQUARE_SIGNATURE_KEY="${FIRST_CLIENT_SQUARE_SIGNATURE_KEY:-}"
FIRST_CLIENT_SQUARE_LOCATION_ID="${FIRST_CLIENT_SQUARE_LOCATION_ID:-}"
# Optional Square webhook automation -- see bootstrap.config.sh.template's
# "Square webhook" section. When on, `up` creates/updates the subscription
# and fills in the signature key itself, and `down` removes it.
SQUARE_WEBHOOK_AUTO="${SQUARE_WEBHOOK_AUTO:-false}"
# "true" marks this environment as production: down and remove-client then
# refuse to run without --production, and make you type the name to confirm.
ENV_IS_PRODUCTION="${ENV_IS_PRODUCTION:-false}"
SQUARE_EXPECTED_MERCHANT_ID="${SQUARE_EXPECTED_MERCHANT_ID:-}"
SQUARE_WEBHOOK_NAME="${SQUARE_WEBHOOK_NAME:-$ENV_PREFIX}"
# Which Square this environment talks to: "production" (default) or
# "sandbox" (Square's test environment, fake sellers and money). Sets
# SQUARE_API_BASE for the Square-calling Lambdas and square-webhook.py.
SQUARE_ENVIRONMENT="${SQUARE_ENVIRONMENT:-production}"
# Connect Square (OAuth): the Square app's Application ID and Application
# Secret for SQUARE_ENVIRONMENT. Blank SQUARE_APP_ID leaves it off.
SQUARE_APP_ID="${SQUARE_APP_ID:-}"
SQUARE_APP_SECRET="${SQUARE_APP_SECRET:-}"
if [ -n "$SQUARE_APP_ID" ] && [ -z "$SQUARE_APP_SECRET" ]; then
  echo "SQUARE_APP_ID is set, so SQUARE_APP_SECRET (the app's Application Secret) is needed too" >&2; exit 1
fi
# Hosted signup (QRScanner's HOSTED SIGNUP section): public self-serve
# venue creation through Connect Square.
HOSTED_SIGNUP="${HOSTED_SIGNUP:-false}"
# API edge: CloudFront + WAF in front of the QRScanner API (set_api_edge).
API_EDGE="${API_EDGE:-false}"
HOSTED_SENDER_EMAIL="${HOSTED_SENDER_EMAIL:-}"
HOSTED_TERMS_URL="${HOSTED_TERMS_URL:-}"
HOSTED_PRIVACY_URL="${HOSTED_PRIVACY_URL:-}"
HOSTED_SUPPORT_EMAIL="${HOSTED_SUPPORT_EMAIL:-}"
if [ "$HOSTED_SIGNUP" = "true" ]; then
  [ -z "$SQUARE_APP_ID" ] && { echo "HOSTED_SIGNUP=true needs Connect Square (SQUARE_APP_ID/SQUARE_APP_SECRET)" >&2; exit 1; }
  [ -z "$HOSTED_SENDER_EMAIL" ] && { echo "HOSTED_SIGNUP=true needs HOSTED_SENDER_EMAIL (an SES-verified From address)" >&2; exit 1; }
  [ "${SQUARE_WEBHOOK_AUTO:-false}" != "true" ] && { echo "HOSTED_SIGNUP=true needs SQUARE_WEBHOOK_AUTO=true (new venues share this environment's subscription)" >&2; exit 1; }
  # Signing up means agreeing to them, so a real (Square production)
  # environment needs both published; only a Square-sandbox one may skip.
  if [ "$SQUARE_ENVIRONMENT" != "sandbox" ]; then
    for legal_var in HOSTED_TERMS_URL HOSTED_PRIVACY_URL; do
      case "${!legal_var}" in
        https://*) ;;
        *) echo "HOSTED_SIGNUP=true needs $legal_var (an https:// link to your hosted service's published page); only SQUARE_ENVIRONMENT=\"sandbox\" may leave it blank" >&2; exit 1 ;;
      esac
    done
  fi
fi
case "$SQUARE_ENVIRONMENT" in
  production) SQUARE_API_BASE="https://connect.squareup.com" ;;
  sandbox) SQUARE_API_BASE="https://connect.squareupsandbox.com" ;;
  *) echo "SQUARE_ENVIRONMENT must be \"production\" or \"sandbox\" (got \"$SQUARE_ENVIRONMENT\")" >&2; exit 1 ;;
esac
# Optional JSON file of initial Client Settings for the first client (OMDB,
# Google Calendar, FTP, API keys...) -- see first-client-settings.json.template.
# A relative path is relative to this directory. Checked here, before
# anything deploys, so a typo'd path or broken JSON fails fast.
FIRST_CLIENT_SETTINGS_FILE="${FIRST_CLIENT_SETTINGS_FILE:-}"
if [ -n "$FIRST_CLIENT_SETTINGS_FILE" ]; then
  case "$FIRST_CLIENT_SETTINGS_FILE" in /*) ;; *) FIRST_CLIENT_SETTINGS_FILE="$SCRIPT_DIR/$FIRST_CLIENT_SETTINGS_FILE" ;; esac
  [ -f "$FIRST_CLIENT_SETTINGS_FILE" ] || { echo "FIRST_CLIENT_SETTINGS_FILE not found: $FIRST_CLIENT_SETTINGS_FILE" >&2; exit 1; }
  python3 -c 'import json, sys; d = json.load(open(sys.argv[1])); sys.exit(0 if isinstance(d, dict) else 1)' "$FIRST_CLIENT_SETTINGS_FILE" 2>/dev/null \
    || { echo "FIRST_CLIENT_SETTINGS_FILE must be a JSON object of Client Settings keys: $FIRST_CLIENT_SETTINGS_FILE" >&2; exit 1; }
fi
# Optional -- see CLIENT_SETUP.md's "After onboarding" section for why
# this is a nicety (a named account instead of sharing the client-level
# credential) and not required to log in at all.
FIRST_CLIENT_ADMIN_USERNAME="${FIRST_CLIENT_ADMIN_USERNAME:-}"
FIRST_CLIENT_ADMIN_PASSWORD="${FIRST_CLIENT_ADMIN_PASSWORD:-}"
FIRST_CLIENT_ADMIN_EMAIL="${FIRST_CLIENT_ADMIN_EMAIL:-}"
# Optional cost guard -- see bootstrap.config.sh.template's "Cost guard"
# section. Blank BUDGET_ALERT_EMAIL skips it entirely.
BUDGET_ALERT_EMAIL="${BUDGET_ALERT_EMAIL:-}"
BUDGET_DAILY_USD="${BUDGET_DAILY_USD:-5}"
BUDGET_MONTHLY_USD="${BUDGET_MONTHLY_USD:-120}"
BUDGET_BREAKER="${BUDGET_BREAKER:-false}"
# Error alarms (alarms/template.yaml): where they email. Blank falls back to
# OPERATOR_ALERT_EMAIL, then BUDGET_ALERT_EMAIL; all blank skips the stack.
ALARM_EMAIL="${ALARM_EMAIL:-${OPERATOR_ALERT_EMAIL:-$BUDGET_ALERT_EMAIL}}"

# Every Lambda an environment has (as ${ENV_PREFIX}-<suffix>). block/
# unblock/breaker-status act on exactly these -- never a ${ENV_PREFIX}-*
# wildcard, since one environment's prefix can start another's name. Keep
# in step with cost-guard/template.yaml's FUNCTION_SUFFIXES.
ENV_FUNCTIONS="client-reporting client-setup-teardown daily-pg-sftp expire-modifiers get-square-orders marketing-engine qrscanner sms-inbound sql-runner square-queue-forwarder square-token-refresher"
if [ "$SQUARE_WEBHOOK_AUTO" = "true" ]; then
  [ -z "$FIRST_CLIENT_SQUARE_ACCESS_TOKEN" ] && { echo "SQUARE_WEBHOOK_AUTO=true needs FIRST_CLIENT_SQUARE_ACCESS_TOKEN (the Square application's own access token)" >&2; exit 1; }
  [ -z "$SQUARE_EXPECTED_MERCHANT_ID" ] && { echo "SQUARE_WEBHOOK_AUTO=true needs SQUARE_EXPECTED_MERCHANT_ID (the merchant that token belongs to)" >&2; exit 1; }
elif [ -z "$FIRST_CLIENT_SQUARE_ACCESS_TOKEN" ] || [ -z "$FIRST_CLIENT_SQUARE_SIGNATURE_KEY" ]; then
  echo "NOTE: FIRST_CLIENT_SQUARE_ACCESS_TOKEN/SIGNATURE_KEY are blank -- the" >&2
  echo "client-onboarding step will fail (client-setup-teardown requires" >&2
  echo "them). That's fine for a first pass: 'up' will still deploy all 12" >&2
  echo "stacks and print the webhook endpoint you need to register in" >&2
  echo "Square to get these values, then fill them in and re-run 'up'." >&2
  echo >&2
fi

AWS_ARGS=()
if [ -n "${AWS_PROFILE:-}" ]; then
  AWS_ARGS+=(--profile "$AWS_PROFILE")
fi
SAM_ARGS=("${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION")

# ---- SQUARE WEBHOOK ----
# square_webhook <sync|remove> <webhook-url> -- runs lib/square-webhook.py
# against this environment's named subscription (SQUARE_WEBHOOK_NAME). The
# token goes in through the environment, never argv. sync prints JSON
# (signature_key, location_id, subscription_id) on stdout for the caller to
# capture -- never echo it.
square_webhook() {
  SQUARE_OAUTH_EVENTS="$([ -n "$SQUARE_APP_ID" ] && echo true || echo false)" \
  square_webhook_for "$1" "$2" "$FIRST_CLIENT_SQUARE_ACCESS_TOKEN" "$SQUARE_EXPECTED_MERCHANT_ID" \
    "$SQUARE_WEBHOOK_NAME" "$FIRST_CLIENT_SQUARE_LOCATION_ID"
}

# square_webhook_for <sync|remove> <url> <token> <merchant-id> <name> <location>
# -- the same for any venue (add-client / remove-client). Function arguments
# never reach a process listing; the token goes to python via the environment.
square_webhook_for() {
  SQUARE_ACCESS_TOKEN="$3" \
  SQUARE_EXPECTED_MERCHANT_ID="$4" \
  SQUARE_WEBHOOK_NAME="$5" \
  SQUARE_LOCATION_ID="$6" \
  WEBHOOK_URL="$2" \
  SQUARE_API_BASE="$SQUARE_API_BASE" \
  SQUARE_OAUTH_EVENTS="${SQUARE_OAUTH_EVENTS:-false}" \
    python3 "$SCRIPT_DIR/lib/square-webhook.py" "$1"
}

# merge_lambda_env <function> <set-json> [key-to-remove ...] -- sets the
# variables in <set-json> (a JSON object) and removes the listed keys on one
# Lambda, keeping every other variable. Not in the SAM templates, because
# CloudFormation would wipe anything set outside them (TICKET_SIGNER_*).
# The values go through the environment and a 0600 temp file, never argv.
merge_lambda_env() {
  local fn="$1" set_json="$2" env_file result
  shift 2
  env_file="$(umask 077; mktemp "$STAGING/lambda-env.XXXXXX")"
  result=$(aws lambda get-function-configuration --function-name "$fn" \
      "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" \
      --query 'Environment.Variables' --output json \
    | MERGE_SET_JSON="$set_json" python3 -c '
import json, os, sys
current = json.load(sys.stdin) or {}
out, sets, removes = sys.argv[1], json.loads(os.environ["MERGE_SET_JSON"]), sys.argv[2:]
wanted = {k: v for k, v in current.items() if k not in removes}
wanted.update(sets)
if wanted == current:
    print("unchanged")
else:
    with open(out, "w") as f:
        json.dump({"Variables": wanted}, f)
    print("changed")
' "$env_file" "$@")
  if [ "$result" = "changed" ]; then
    aws lambda update-function-configuration --function-name "$fn" \
      --environment "file://$env_file" \
      "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" >/dev/null
    aws lambda wait function-updated --function-name "$fn" \
      "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION"
  fi
  rm -f "$env_file"
  echo "$result"
}

# ---- ACCOUNT SECURITY ----
# deploy_security -- security/template.yaml: GuardDuty, a CloudTrail trail
# (kept TRAIL_RETENTION_DAYS, default 365) and an email for medium/high
# findings to ALARM_EMAIL. GuardDuty and a multi-region trail are one per
# account, so either is skipped when the account already has one (another
# environment in the same account, or production's own).
deploy_security() {
  if [ -z "$ALARM_EMAIL" ]; then
    echo "(ALARM_EMAIL is blank -- skipping GuardDuty and CloudTrail)"
    echo
    return 0
  fi
  local stack="${ENV_PREFIX}-security" guardduty="true" trail="true" mine
  mine=$(aws cloudformation describe-stack-resources --stack-name "$stack" \
    --query "StackResources[?ResourceType=='AWS::GuardDuty::Detector' || ResourceType=='AWS::CloudTrail::Trail'].ResourceType" \
    --output text "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" 2>/dev/null || true)
  if [[ "$mine" != *GuardDuty* ]] && [ -n "$(aws guardduty list-detectors --query 'DetectorIds[0]' --output text \
      "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" 2>/dev/null | grep -v None)" ]; then
    guardduty="false"
    echo "(This account already has GuardDuty in ${AWS_REGION} -- using it.)"
  fi
  if [[ "$mine" != *CloudTrail* ]] && [ -n "$(aws cloudtrail describe-trails --query 'trailList[?IsMultiRegionTrail].Name' --output text \
      "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" 2>/dev/null)" ]; then
    trail="false"
    echo "(This account already has a multi-region CloudTrail trail -- using it.)"
  fi
  deploy_stack "security" "security" \
    "AlertEmail=${ALARM_EMAIL}" \
    "EnableGuardDuty=${guardduty}" \
    "EnableTrail=${trail}" \
    "TrailRetentionDays=${TRAIL_RETENTION_DAYS:-365}"
  echo "GuardDuty findings email ${ALARM_EMAIL} (confirm AWS's subscription email first)."
  echo
}
# ---- END ACCOUNT SECURITY ----

# ---- ERROR ALARMS ----
# deploy_alarms -- the same alarms/template.yaml production uses, with this
# environment's function names, emailed to ALARM_EMAIL. Then points
# QRScanner's public status page (status.html) at them via
# STATUS_ALARM_PREFIX. Skipped, with the status page left off, when no
# alarm email is configured.
deploy_alarms() {
  local qrscanner="${ENV_PREFIX}-qrscanner"
  if [ -z "$ALARM_EMAIL" ]; then
    echo "(ALARM_EMAIL, OPERATOR_ALERT_EMAIL and BUDGET_ALERT_EMAIL are all blank -- skipping the error alarms and status page)"
    echo
    merge_lambda_env "$qrscanner" '{}' STATUS_ALARM_PREFIX >/dev/null
    return 0
  fi
  # The order-error metric filter needs getSquareOrders' log group, which
  # Lambda only creates on the first invocation.
  aws logs create-log-group --log-group-name "/aws/lambda/${ENV_PREFIX}-get-square-orders" \
    "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" 2>/dev/null || true
  # The webhook is an HTTP API here (production's is a REST API); its ID
  # is the first label of the endpoint's host name.
  local api_id
  api_id="$(stack_output square-queue-forwarder ApiEndpoint | sed -E 's#^https://([^.]+)\..*#\1#')"
  deploy_stack "alarms" "alarms" \
    "AlertEmail=${ALARM_EMAIL}" \
    "GetSquareOrdersFunction=${ENV_PREFIX}-get-square-orders" \
    "QueueForwarderFunction=${ENV_PREFIX}-square-queue-forwarder" \
    "QRScannerFunction=${qrscanner}" \
    "InboundSmsFunction=${ENV_PREFIX}-sms-inbound" \
    "ExpireModifiersFunction=${ENV_PREFIX}-expire-modifiers" \
    "DailyReportFunction=${ENV_PREFIX}-daily-pg-sftp" \
    "MarketingEngineFunction=${ENV_PREFIX}-marketing-engine" \
    "MailForwarderFunction=none" \
    "TokenRefresherFunction=${ENV_PREFIX}-square-token-refresher" \
    "WebhookQueueName=${ENV_PREFIX}-square-webhook-queue.fifo" \
    "WebhookApiName=none" \
    "WebhookHttpApiId=${api_id:-none}"
  merge_lambda_env "$qrscanner" "{\"STATUS_ALARM_PREFIX\": \"${ENV_PREFIX}\"}" >/dev/null
  echo "Error alarms email ${ALARM_EMAIL} (confirm AWS's subscription email first)."
  echo "Status page: https://${STATIC_SITE_DOMAIN:-$(stack_output static-site DistributionDomainName)}/status.html"
  echo
}
# ---- END ERROR ALARMS ----

# set_square_api_base -- points each Square-calling Lambda at this
# environment's Square (SQUARE_ENVIRONMENT): sets SQUARE_API_BASE for
# "sandbox", removes it for "production" (the code's default).
set_square_api_base() {
  local suffix
  for suffix in get-square-orders qrscanner expire-modifiers marketing-engine square-token-refresher; do
    if [ "$SQUARE_ENVIRONMENT" = "sandbox" ]; then
      [ "$(merge_lambda_env "${ENV_PREFIX}-${suffix}" "{\"SQUARE_API_BASE\": \"$SQUARE_API_BASE\"}")" = "changed" ] \
        && echo "  ${ENV_PREFIX}-${suffix}: Square API set to $SQUARE_API_BASE"
    else
      [ "$(merge_lambda_env "${ENV_PREFIX}-${suffix}" '{}' SQUARE_API_BASE)" = "changed" ] \
        && echo "  ${ENV_PREFIX}-${suffix}: Square API set to $SQUARE_API_BASE"
    fi
  done
  return 0
}

# set_static_site_bucket -- tells QRScanner and client-setup-teardown this
# environment's static site bucket (STATIC_SITE_BUCKET): QRScanner's Client
# Settings logo upload writes venue-logos/<clientId>/, and removing a venue
# deletes that folder. Both roles can already write ${ENV_PREFIX}-* buckets.
set_static_site_bucket() {
  local bucket suffix
  bucket="$(stack_output static-site BucketName)"
  [ -n "$bucket" ] || return 0
  for suffix in qrscanner client-setup-teardown; do
    [ "$(merge_lambda_env "${ENV_PREFIX}-${suffix}" "{\"STATIC_SITE_BUCKET\": \"$bucket\"}")" = "changed" ] \
      && echo "  ${ENV_PREFIX}-${suffix}: venue logos in $bucket"
  done
  # Venues' own web addresses (QRScanner's VENUE WEB ADDRESS) live in the same bucket
  if [ -n "${VENUE_SITE_DOMAIN:-}" ]; then
    [ "$(merge_lambda_env "${ENV_PREFIX}-qrscanner" "{\"VENUE_SITE_DOMAIN\": \"$VENUE_SITE_DOMAIN\"}")" = "changed" ] \
      && echo "  ${ENV_PREFIX}-qrscanner: venue web addresses under $VENUE_SITE_DOMAIN"
  fi
  return 0
}

# set_log_retention -- makes every log group this environment writes to
# expire after LOG_RETENTION_DAYS (default 30) instead of AWS's default of
# never; logs can hold customers' emails and phone numbers. A function's log
# group only appears on its first run, so each one is created here first.
# Groups named for the environment (the Aurora cluster's, API logs) get the
# same policy. Safe to re-run; costs nothing (shorter retention stores less).
set_log_retention() {
  local days="${LOG_RETENTION_DAYS:-30}" fn group count=0
  case " 1 3 5 7 14 30 60 90 120 150 180 365 400 545 731 1096 1827 2192 2557 2922 3288 3653 " in
    *" $days "*) ;;
    *) echo "  LOG_RETENTION_DAYS=$days isn't a value CloudWatch accepts (1, 3, 5, 7, 14, 30, 60, 90, 180, 365, ...); logs left as they are" >&2; return 0 ;;
  esac
  for fn in $(aws lambda list-functions "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" \
      --query "Functions[?starts_with(FunctionName, \`${ENV_PREFIX}-\`)].FunctionName" --output text); do
    aws logs create-log-group --log-group-name "/aws/lambda/$fn" \
      "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" 2>/dev/null || true
  done
  for group in $(aws logs describe-log-groups "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" \
      --query "logGroups[?contains(logGroupName, \`${ENV_PREFIX}\`)].logGroupName" --output text); do
    aws logs put-retention-policy --log-group-name "$group" --retention-in-days "$days" \
      "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" && count=$((count + 1))
  done
  echo "  Logs: $count log group(s) expire after $days days"
  return 0
}

# set_square_oauth <webhook-url> -- Connect Square (QRScanner's SQUARE
# OAUTH section). With SQUARE_APP_ID set: stores, via a 0600 temp file, the
# Secrets Manager secret indieTix/square/app/<ENV_PREFIX> = {"client_secret":
# SQUARE_APP_SECRET, "webhook_signature_key": this environment's
# subscription key, "webhook_url": <webhook-url>} (each connected venue
# gets the last two, to verify that subscription's events), and gives the
# QRScanner Lambda the app ID, that secret's name and its callback URL.
# Without it: removes those, which turns the feature off. Venues' own
# tokens are never touched here.
set_square_oauth() {
  local webhook_url="$1"
  local fn="${ENV_PREFIX}-qrscanner" refresher="${ENV_PREFIX}-square-token-refresher"
  local secret_name="indieTix/square/app/${ENV_PREFIX}" secret_file redirect_url
  if [ -z "$SQUARE_APP_ID" ]; then
    merge_lambda_env "$refresher" '{}' SQUARE_APP_ID SQUARE_APP_SECRET_ID OPERATOR_ALERT_EMAIL >/dev/null
    [ "$(merge_lambda_env "$fn" '{}' SQUARE_APP_ID SQUARE_APP_SECRET_ID SQUARE_OAUTH_REDIRECT_URL)" = "changed" ] \
      && echo "  Connect Square turned off (SQUARE_APP_ID is blank)"
    return 0
  fi
  secret_file="$(umask 077; mktemp "$STAGING/square-app-secret.XXXXXX")"
  SQUARE_APP_SECRET="$SQUARE_APP_SECRET" WEBHOOK_KEY="$FIRST_CLIENT_SQUARE_SIGNATURE_KEY" WEBHOOK_URL="$webhook_url" python3 -c '
import json, os, sys
secret = {"client_secret": os.environ["SQUARE_APP_SECRET"]}
if os.environ["WEBHOOK_KEY"] and os.environ["WEBHOOK_URL"]:
    secret["webhook_signature_key"] = os.environ["WEBHOOK_KEY"]
    secret["webhook_url"] = os.environ["WEBHOOK_URL"]
json.dump(secret, open(sys.argv[1], "w"))
' "$secret_file"
  if aws secretsmanager describe-secret --secret-id "$secret_name" \
      "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" >/dev/null 2>&1; then
    aws secretsmanager put-secret-value --secret-id "$secret_name" --secret-string "file://$secret_file" \
      "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" >/dev/null
  else
    aws secretsmanager create-secret --name "$secret_name" --secret-string "file://$secret_file" \
      --description "IndieTix Square app secret for $ENV_PREFIX (Connect Square)" \
      "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" >/dev/null
  fi
  rm -f "$secret_file"
  redirect_url="$(api_url)/square/oauth/callback"
  merge_lambda_env "$fn" "$(python3 -c 'import json, sys; print(json.dumps({"SQUARE_APP_ID": sys.argv[1], "SQUARE_APP_SECRET_ID": sys.argv[2], "SQUARE_OAUTH_REDIRECT_URL": sys.argv[3]}))' \
    "$SQUARE_APP_ID" "$secret_name" "$redirect_url")" >/dev/null
  # The daily token refresher: the same app, plus who to copy on its
  # failure emails (OPERATOR_ALERT_EMAIL, else BUDGET_ALERT_EMAIL).
  merge_lambda_env "$refresher" "$(python3 -c 'import json, sys; print(json.dumps({k: v for k, v in {"SQUARE_APP_ID": sys.argv[1], "SQUARE_APP_SECRET_ID": sys.argv[2], "OPERATOR_ALERT_EMAIL": sys.argv[3]}.items() if v}))' \
    "$SQUARE_APP_ID" "$secret_name" "${OPERATOR_ALERT_EMAIL:-$BUDGET_ALERT_EMAIL}")" >/dev/null
  # Hosted signup: on with HOSTED_SIGNUP="true", otherwise its variables
  # are removed, which turns it off.
  local signup_vars="HOSTED_SIGNUP_ENABLED CLIENT_SETUP_FUNCTION HOSTED_STATIC_SITE_URL HOSTED_SENDER_EMAIL VENUE_BUCKET_PREFIX HOSTED_TERMS_URL HOSTED_PRIVACY_URL HOSTED_SUPPORT_EMAIL"
  if [ "$HOSTED_SIGNUP" = "true" ]; then
    local site_url="https://${STATIC_SITE_DOMAIN:-$(stack_output static-site DistributionDomainName)}"
    # shellcheck disable=SC2086
    merge_lambda_env "$fn" "$(python3 -c '
import json, sys
names = ["HOSTED_SIGNUP_ENABLED", "CLIENT_SETUP_FUNCTION", "HOSTED_STATIC_SITE_URL", "HOSTED_SENDER_EMAIL", "VENUE_BUCKET_PREFIX", "HOSTED_TERMS_URL", "HOSTED_PRIVACY_URL", "HOSTED_SUPPORT_EMAIL"]
print(json.dumps({k: v for k, v in zip(names, sys.argv[1:]) if v}))
' "true" "${ENV_PREFIX}-client-setup-teardown" "$site_url" "$HOSTED_SENDER_EMAIL" "${ENV_PREFIX}-" "$HOSTED_TERMS_URL" "$HOSTED_PRIVACY_URL" "$HOSTED_SUPPORT_EMAIL")" $signup_vars >/dev/null
    echo "  Hosted signup is open: ${site_url}/signup.html"
  else
    # shellcheck disable=SC2086
    merge_lambda_env "$fn" '{}' $signup_vars >/dev/null
  fi
  echo "  Connect Square is on. Register this OAuth redirect URL in the Square"
  echo "  Developer Dashboard (app > OAuth, $SQUARE_ENVIRONMENT):"
  echo "    $redirect_url"
}

# api_url -- this environment's API address, no trailing slash: the API
# edge's CloudFront URL with API_EDGE="true", else QRScanner's Function URL.
api_url() {
  local url
  if [ "$API_EDGE" = "true" ]; then
    url="$(AWS_REGION=us-east-1 stack_output api-edge ApiUrl)"
  else
    url="$(stack_output qrscanner FunctionUrl)"
  fi
  echo "${url%/}"
}

# set_api_edge -- API_EDGE="true": CloudFront + WAF in front of QRScanner
# (api-edge stack, always us-east-1: CloudFront web ACLs only exist there).
# The shared X-IndieTix-Edge secret lives in Secrets Manager in us-east-1
# (indieTix/edge/<ENV_PREFIX>, kept across runs); the template reads it by
# dynamic reference and QRScanner gets it as EDGE_ORIGIN_SECRET, after the
# edge exists, so the API is never locked out. API_EDGE="false": QRScanner
# stops requiring the header (the stack is left for `down` to remove).
set_api_edge() {
  local fn="${ENV_PREFIX}-qrscanner" secret_name="indieTix/edge/${ENV_PREFIX}" secret_file origin secret_value
  if [ "$API_EDGE" != "true" ]; then
    [ "$(merge_lambda_env "$fn" '{}' EDGE_ORIGIN_SECRET)" = "changed" ] \
      && echo "  API edge off: QRScanner no longer requires the edge header"
    return 0
  fi
  echo "=== API edge (CloudFront + WAF, us-east-1) ==="
  if ! aws secretsmanager describe-secret --secret-id "$secret_name" \
      "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region us-east-1 >/dev/null 2>&1; then
    secret_file="$(umask 077; mktemp "$STAGING/edge-secret.XXXXXX")"
    python3 -c 'import json, secrets, sys; json.dump({"secret": secrets.token_urlsafe(32)}, open(sys.argv[1], "w"))' "$secret_file"
    aws secretsmanager create-secret --name "$secret_name" --secret-string "file://$secret_file" \
      --description "IndieTix API edge header for $ENV_PREFIX" \
      "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region us-east-1 >/dev/null
    rm -f "$secret_file"
  fi
  origin="$(stack_output qrscanner FunctionUrl)"
  origin="${origin#https://}"; origin="${origin%%/*}"
  ( AWS_REGION=us-east-1
    SAM_ARGS=("${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region us-east-1)
    deploy_stack "api-edge" "api-edge" "ApiOriginDomain=${origin}" ) || exit 1
  secret_value="$(aws secretsmanager get-secret-value --secret-id "$secret_name" \
    "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region us-east-1 --query SecretString --output text)"
  merge_lambda_env "$fn" "$(EDGE_SECRET_JSON="$secret_value" python3 -c 'import json, os; print(json.dumps({"EDGE_ORIGIN_SECRET": json.loads(os.environ["EDGE_SECRET_JSON"])["secret"]}))')" >/dev/null
  unset secret_value
  echo "  API address (put this in config.js): $(api_url)"
  echo
}

# json_field <key> -- prints one top-level field of the JSON object on stdin.
json_field() {
  python3 -c 'import json, sys; print(json.load(sys.stdin)[sys.argv[1]])' "$1"
}
# ---- END SQUARE WEBHOOK ----

confirm() {
  local prompt="$1" yes_flag="${2:-}"
  if [ "$yes_flag" = "--yes" ] || [ "$yes_flag" = "-y" ]; then
    return 0
  fi
  read -r -p "$prompt [y/N] " reply
  [ "$reply" = "y" ] || [ "$reply" = "Y" ]
}

# sync_stack_source <stack-dir> <repo-config-key> -- populates
# <stack-dir>/src fresh from the real repo, via the same FILES list
# deploy.sh's production/dev pushes use (see lib/repo-config.sh). Always
# wipes and rebuilds, so this directory is never a stale manual copy --
# it's gitignored and regenerated on every `up`, the same way the static
# site assets and layer zips already were. Run this immediately before
# the matching deploy_stack call so `sam build` picks up what it just
# wrote.
sync_stack_source() {
  local stack_dir="$1" repo_key="$2"
  echo "--- Syncing $stack_dir/src from the real $repo_key repo ---"
  stage_source_files "$repo_key" "$SCRIPT_DIR/$stack_dir/src"
}

# publish_layer_sandbox <repo-config-key> -- builds and publishes a new
# version of a shared layer (sms-utils, ticket-pdf-lib) into THIS
# environment's own AWS account/region, under an EnvPrefix-namespaced
# layer name so it can't collide with production's layer of the same
# base name, or with another bootstrap environment's. Echoes the new
# LayerVersionArn. Several repo-config.sh keys share one underlying
# LAYER_NAME (e.g. sms-utils-qrscanner and sms-utils-sms-opt-in-opt-out
# are both "smsUtils") -- call this once per distinct layer, not once per
# consumer, and reuse the returned ARN across every consuming
# deploy_stack call.
publish_layer_sandbox() {
  local repo_key="$1"
  load_config "$repo_key"
  local layer_zip
  layer_zip=$(build_layer_zip "$repo_key")
  local env_layer_name="${ENV_PREFIX}-${LAYER_NAME}"
  echo "Publishing layer '$env_layer_name'..." >&2
  aws lambda publish-layer-version \
    --layer-name "$env_layer_name" \
    --zip-file "fileb://$layer_zip" \
    --compatible-runtimes nodejs22.x \
    --compatible-architectures x86_64 \
    "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" \
    --query 'LayerVersionArn' --output text
}

# seed_ticket_templates_bucket -- creates (if needed) and seeds THIS
# environment's own ticket-template bucket, so client-setup-teardown's
# onboarding copy step has something real to copy from. The real code's
# default bucket ("indietix-ticket-templates") is production's own, in a
# different AWS account -- a fresh environment has no access to it at all
# (confirmed directly: AccessDenied cross-account), so every environment
# needs its own, seeded with its own copy. Uploads the two generic
# defaults checked into clientSetup-Teardown/assets/ (dashed-border
# placeholder, explicitly NOT any one venue's real branding -- replace
# them for a real venue via Client Settings' TICKET_FILENAME /
# TICKET_SMS_FILENAME, same as production's venue-specific templates
# always worked). Echoes the bucket name.
seed_ticket_templates_bucket() {
  local bucket="${ENV_PREFIX}-ticket-templates"
  if ! aws s3api head-bucket --bucket "$bucket" "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" 2>/dev/null; then
    echo "Creating ticket-templates bucket: $bucket" >&2
    if [ "$AWS_REGION" = "us-east-1" ]; then
      aws s3api create-bucket --bucket "$bucket" "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" >&2
    else
      aws s3api create-bucket --bucket "$bucket" "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" \
        --create-bucket-configuration "LocationConstraint=$AWS_REGION" >&2
    fi
  fi
  aws s3 cp "$ROOT/clientSetup-Teardown/assets/default_ticket_horizontal.pdf" \
    "s3://$bucket/ticket_horizontal.pdf" "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" >&2
  aws s3 cp "$ROOT/clientSetup-Teardown/assets/default_ticket_vertical.pdf" \
    "s3://$bucket/ticket_vertical.pdf" "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" >&2
  echo "$bucket"
}

# deploy_stack <dir> <stack-name-suffix> [extra --parameter-overrides key=value ...]
deploy_stack() {
  local dir="$1" suffix="$2"; shift 2
  local stack_name="${ENV_PREFIX}-${suffix}"

  # A stack whose first deploy attempt failed sits in ROLLBACK_COMPLETE
  # forever -- CloudFormation refuses to create a changeset against it
  # ("can not be updated"), so a naive retry of `up` fails confusingly on
  # every later run too, not just the one that actually hit the error.
  # Confirmed this is real, not theoretical: hit it directly on this
  # stack's own CIDR-conflict failure. Clean it up automatically so "safe
  # to re-run" in this script's usage text is actually true.
  local existing_status
  existing_status=$(aws cloudformation describe-stacks --stack-name "$stack_name" \
    --query 'Stacks[0].StackStatus' --output text \
    "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" 2>/dev/null || echo "")
  if [ "$existing_status" = "ROLLBACK_COMPLETE" ]; then
    echo "$stack_name is in ROLLBACK_COMPLETE from a previous failed attempt -- deleting it before retrying."
    aws cloudformation delete-stack --stack-name "$stack_name" "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION"
    aws cloudformation wait stack-delete-complete --stack-name "$stack_name" "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION"
    echo "Deleted. Proceeding with a fresh deploy."
  fi

  echo "=== Deploying $stack_name ($dir) ==="

  # ---- STACK LAYER DEPENDENCIES ----
  # A stack's layer/nodejs/ has only package.json + package-lock.json in git
  # (node_modules is gitignored), and sam deploy uploads the folder as-is --
  # so without this, a fresh clone deploys EMPTY layers ("Cannot find module
  # 'pg'"). Install from the lockfile every time, prod deps only, with the
  # same linux/x64/glibc flags and sharp pruning as build_layer_zip.
  local layer_pkg="$SCRIPT_DIR/$dir/layer/nodejs"
  if [ -f "$layer_pkg/package.json" ]; then
    echo "Installing $dir layer dependencies (npm ci, prod only, linux/x64/glibc)..."
    ( cd "$layer_pkg" && npm ci --omit=dev --os=linux --cpu=x64 --libc=glibc --no-audit --no-fund >/dev/null ) \
      || { echo "npm ci failed in $layer_pkg -- not deploying $stack_name." >&2; exit 1; }
    rm -rf "$layer_pkg/node_modules/@img/sharp-libvips-linuxmusl-x64" \
           "$layer_pkg/node_modules/@img/sharp-linuxmusl-x64" \
           "$layer_pkg/node_modules/@img/sharp-wasm32"
  fi

  # SAM CLI's --parameter-overrides can't parse a key with an empty value
  # (confirmed directly: "StaticSiteDomain=" errors out as an invalid
  # format, not as an empty string) -- so any blank override has to be
  # dropped entirely rather than passed through, letting the template's
  # own Default: apply instead (every optional param here has one).
  local overrides=()
  for kv in "EnvPrefix=${ENV_PREFIX}" "$@"; do
    case "$kv" in
      *=) ;; # trailing "=" with nothing after it -- skip
      *) overrides+=("$kv") ;;
    esac
  done

  sam deploy \
    --template-file "$SCRIPT_DIR/$dir/template.yaml" \
    --stack-name "$stack_name" \
    --capabilities CAPABILITY_IAM \
    --resolve-s3 \
    --no-confirm-changeset \
    --no-fail-on-empty-changeset \
    --parameter-overrides "${overrides[@]}" \
    "${SAM_ARGS[@]}"
  echo
}

delete_stack() {
  local suffix="$1"
  local stack_name="${ENV_PREFIX}-${suffix}"
  echo "=== Deleting $stack_name ==="
  sam delete --stack-name "$stack_name" --no-prompts "${SAM_ARGS[@]}" 2>&1 || \
    echo "  (already gone or failed to delete -- check manually if this persists)"
  echo
}

stack_output() {
  # stack_output <stack-name-suffix> <OutputKey>
  aws cloudformation describe-stacks \
    --stack-name "${ENV_PREFIX}-$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" \
    --output text \
    "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" 2>/dev/null
}

cmd_up() {
  echo "=== Bootstrapping environment '$ENV_PREFIX' in $AWS_REGION ==="
  echo

  if [ -z "${DEFAULT_VPC_ID:-}" ] || [ -z "${SUBNET_ID_A:-}" ] || [ -z "${SUBNET_ID_B:-}" ]; then
    echo "bootstrap.config.sh is missing DEFAULT_VPC_ID/SUBNET_ID_A/SUBNET_ID_B." >&2
    echo "Find them with: aws ec2 describe-vpcs --filters Name=isDefault,Values=true" >&2
    echo "            and: aws ec2 describe-subnets --filters Name=vpc-id,Values=<that-vpc-id>" >&2
    exit 1
  fi

  # Preflight the subnets before any stack deploys. Confirmed the hard way:
  # a config whose SUBNET_ID_B pointed at ANOTHER environment's private
  # subnet (created by that environment's aurora-poc stack) worked until
  # that environment was torn down, then failed aurora-poc 2 minutes in.
  # The two subnets must exist, be in DEFAULT_VPC_ID, sit in different
  # AZs, and not be owned by any CloudFormation stack.
  local subnet_info
  subnet_info=$(aws ec2 describe-subnets --subnet-ids "$SUBNET_ID_A" "$SUBNET_ID_B" \
    --query 'Subnets[].[SubnetId,VpcId,AvailabilityZone,length(Tags[?Key==`aws:cloudformation:stack-name`] || `[]`)]' \
    --output text "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" 2>&1) || {
    echo "SUBNET_ID_A/SUBNET_ID_B check failed: $subnet_info" >&2
    echo "Find valid ones with: aws ec2 describe-subnets --filters Name=vpc-id,Values=$DEFAULT_VPC_ID" >&2
    exit 1
  }
  local sid vpc az owned azs=""
  while read -r sid vpc az owned; do
    [ "$vpc" = "$DEFAULT_VPC_ID" ] || { echo "$sid is in $vpc, not DEFAULT_VPC_ID ($DEFAULT_VPC_ID)" >&2; exit 1; }
    [ "$owned" = "0" ] || { echo "$sid belongs to a CloudFormation stack (another environment's private subnet?) -- use one of the VPC's own subnets" >&2; exit 1; }
    azs="$azs $az"
  done <<< "$subnet_info"
  if [ "$(echo $azs | tr ' ' '\n' | sort -u | wc -l | tr -d ' ')" != "2" ]; then
    echo "SUBNET_ID_A and SUBNET_ID_B must be in two different availability zones (got:$azs)" >&2
    exit 1
  fi

  confirm "About to deploy 12 CloudFormation stacks (Aurora, S3, CloudFront, 9 Lambdas) into AWS region $AWS_REGION. This creates real, billable resources. Proceed?" "${1:-}" || { echo "Aborted."; exit 1; }

  # 1. Foundation: VPC/Aurora. Everything else imports its exports.
  # PrivateSubnetACidr/BCidr MUST NOT overlap any existing subnet already
  # in DEFAULT_VPC_ID -- confirmed the hard way: deploying a second
  # environment into the same VPC as an existing one with the template's
  # old hardcoded 172.31.32.0/20 + 172.31.48.0/20 defaults fails outright
  # (AWS rejects the overlapping CIDR, CloudFormation rolls back cleanly
  # but the stack never comes up). Set PRIVATE_SUBNET_A_CIDR/B_CIDR in
  # bootstrap.config.sh to non-overlapping ranges for any environment
  # after your first one in a given VPC.
  deploy_stack "aurora-poc" "aurora-poc" \
    "DefaultVpcId=${DEFAULT_VPC_ID}" "SubnetIdA=${SUBNET_ID_A}" "SubnetIdB=${SUBNET_ID_B}" \
    "PrivateSubnetACidr=${PRIVATE_SUBNET_A_CIDR:-172.31.32.0/20}" \
    "PrivateSubnetBCidr=${PRIVATE_SUBNET_B_CIDR:-172.31.48.0/20}" \
    "AuroraMinCapacity=${AURORA_MIN_CAPACITY:-0.5}"

  # 2. Storage -- no VPC dependency, can happen anytime after step 1.
  # S3 bucket names can't contain uppercase characters, but client IDs can
  # (Square's own merchant IDs, e.g. Liberty Hall's M5E5N7KAHZA7Q, are
  # uppercase) -- CloudFormation has no native lowercase intrinsic, so this
  # has to happen here, not in the template. Confirmed the hard way: a real
  # Square-ID-cased FIRST_CLIENT_USERNAME fails client-buckets outright
  # ("Bucket name should not contain uppercase characters") while a
  # lowercase one never would have caught this. client-setup-teardown's own
  # createS3Buckets() already lowercases independently for the same reason,
  # so this just makes the two consistent.
  local client_id_lower
  client_id_lower="$(echo "$FIRST_CLIENT_USERNAME" | tr '[:upper:]' '[:lower:]')"
  deploy_stack "client-buckets" "client-buckets" \
    "ClientId=${client_id_lower}" "StaticSiteDomain=${STATIC_SITE_DOMAIN}"
  deploy_stack "static-site" "static-site"

  # 3. Square webhook ingestion -- no VPC dependency.
  sync_stack_source "square-queue-forwarder" "square-queue-forwarder"
  deploy_stack "square-queue-forwarder" "square-queue-forwarder"

  # 3a. Square webhook subscription (SQUARE_WEBHOOK_AUTO=true). Has to come
  # after the forwarder (that's where the URL comes from) and before
  # onboarding (which needs the signature key the subscription generates).
  local webhook_url square_location_id="$FIRST_CLIENT_SQUARE_LOCATION_ID"
  webhook_url="$(stack_output square-queue-forwarder ApiEndpoint)"
  if [ "$SQUARE_WEBHOOK_AUTO" = "true" ]; then
    echo "=== Square webhook subscription '$SQUARE_WEBHOOK_NAME' ==="
    local webhook_json
    webhook_json="$(square_webhook sync "$webhook_url")"
    FIRST_CLIENT_SQUARE_SIGNATURE_KEY="$(printf %s "$webhook_json" | json_field signature_key)"
    square_location_id="$(printf %s "$webhook_json" | json_field location_id)"
    unset webhook_json
    echo
  fi

  # 3b. Shared layers (sms-utils, ticket-pdf-lib) -- built and published
  # fresh into THIS environment, before any of their 3 consumers deploy.
  # Several repo-config.sh keys share one underlying LAYER_NAME (e.g.
  # sms-utils-qrscanner / sms-utils-sms-opt-in-opt-out / sms-utils-
  # get-square-orders are all "smsUtils") -- publish each distinct layer
  # exactly once and reuse the ARN, rather than rebuilding/republishing
  # per consumer.
  echo "=== Publishing shared layers for this environment ==="
  local sms_utils_layer_arn ticket_pdf_lib_layer_arn
  sms_utils_layer_arn=$(publish_layer_sandbox "sms-utils-qrscanner")
  echo "sms-utils: $sms_utils_layer_arn"
  ticket_pdf_lib_layer_arn=$(publish_layer_sandbox "ticket-pdf-lib")
  echo "ticket-pdf-lib: $ticket_pdf_lib_layer_arn"
  echo

  # 4. The 7 VPC-attached Lambdas (need step 1's exports). Each one's
  # source is synced fresh from its real repo immediately before its
  # deploy_stack call, per lib/repo-config.sh's FILES list -- see
  # sync_stack_source's own comment for why this isn't a one-time copy.
  echo "=== Seeding this environment's ticket-templates bucket ==="
  local ticket_templates_bucket
  ticket_templates_bucket=$(seed_ticket_templates_bucket)
  echo "ticket-templates bucket: $ticket_templates_bucket"
  echo

  sync_stack_source "client-setup-teardown" "clientSetup-Teardown"
  deploy_stack "client-setup-teardown" "client-setup-teardown" \
    "TicketTemplatesBucket=${ticket_templates_bucket}"

  sync_stack_source "get-square-orders" "getSquareOrders"
  deploy_stack "get-square-orders" "get-square-orders" \
    "SmsUtilsLayerArn=${sms_utils_layer_arn}" "TicketPdfLibLayerArn=${ticket_pdf_lib_layer_arn}"

  sync_stack_source "qrscanner" "QRScanner"
  deploy_stack "qrscanner" "qrscanner" \
    "SmsUtilsLayerArn=${sms_utils_layer_arn}" "TicketPdfLibLayerArn=${ticket_pdf_lib_layer_arn}"

  sync_stack_source "client-reporting" "clientReporting"
  deploy_stack "client-reporting" "client-reporting"

  sync_stack_source "daily-pg-sftp" "DailyPgQueryAndSftp"
  deploy_stack "daily-pg-sftp" "daily-pg-sftp"

  sync_stack_source "expire-modifiers" "expireQRCodeSquareModifiers"
  deploy_stack "expire-modifiers" "expire-modifiers"

  sync_stack_source "square-token-refresher" "squareTokenRefresher"
  deploy_stack "square-token-refresher" "square-token-refresher"

  sync_stack_source "marketing-engine" "marketingEngine"
  deploy_stack "marketing-engine" "marketing-engine" \
    "EnablePollerSchedule=${ENABLE_MARKETING_POLLER}"

  # 5. Inbound SMS.
  sync_stack_source "sms-inbound" "smsOptInOptOut"
  deploy_stack "sms-inbound" "sms-inbound" \
    "SmsUtilsLayerArn=${sms_utils_layer_arn}"

  # 5a. Which Square the Lambdas call (SQUARE_ENVIRONMENT).
  echo "Square API for this environment: $SQUARE_API_BASE"
  set_square_api_base
  set_static_site_bucket
  set_api_edge
  set_square_oauth "$webhook_url"
  set_log_retention
  echo

  # 5b. Optional cost guard: budgets that email BUDGET_ALERT_EMAIL, plus
  # (BUDGET_BREAKER=true) a breaker that blocks every Lambda here when the
  # daily budget is exceeded. `unblock` reverses it.
  if [ -n "$BUDGET_ALERT_EMAIL" ]; then
    deploy_stack "cost-guard" "cost-guard" \
      "AlertEmail=${BUDGET_ALERT_EMAIL}" \
      "DailyLimitUsd=${BUDGET_DAILY_USD}" \
      "MonthlyLimitUsd=${BUDGET_MONTHLY_USD}" \
      "EnableBreaker=${BUDGET_BREAKER}"
  else
    echo "(BUDGET_ALERT_EMAIL is blank -- skipping the optional cost-guard stack)"
    echo
  fi

  # 5c. Error alarms, emailed to ALARM_EMAIL, and the status page that
  # reads them.
  deploy_alarms

  # 5d. GuardDuty, CloudTrail and their alert email.
  deploy_security

  # 6. Onboard the first client. Payload shape is client-setup-teardown's
  # real handler input (clientSetup-Teardown/src/index.js's exports.handler
  # -- username/clientSecret/contactName/clientEmail/square_access_token/
  # square_signature_key are all hard-required there, theater_name is
  # optional). Built with python3 (not raw string interpolation) so a
  # value containing a quote or backslash (e.g. a theater name like
  # "Joe's Cinema") can't produce malformed JSON.
  echo "=== Onboarding first client: $FIRST_CLIENT_USERNAME ==="
  local fn_name="${ENV_PREFIX}-client-setup-teardown"
  # The payload carries every secret onboarding needs, so it goes to the
  # Lambda from a file only this user can read, never on the command line
  # (where any process listing would show it).
  local payload_file static_website_url
  payload_file="$(umask 077; mktemp "$STAGING/onboard-payload.XXXXXX")"
  # The venue's web address -- password reset links, logout, marketing and
  # SMS opt-in links are all built from STATIC_WEBSITE_URL, and onboarding
  # has no other way to know it. The settings file can still override it.
  static_website_url="https://${STATIC_SITE_DOMAIN:-$(stack_output static-site DistributionDomainName)}"
  PAYLOAD_FILE="$payload_file" \
    STATIC_WEBSITE_URL="$static_website_url" \
    FIRST_CLIENT_SETTINGS_FILE="$FIRST_CLIENT_SETTINGS_FILE" \
    ENV_PREFIX="$ENV_PREFIX" \
    FIRST_CLIENT_USERNAME="$FIRST_CLIENT_USERNAME" \
    FIRST_CLIENT_SECRET="$FIRST_CLIENT_SECRET" \
    FIRST_CLIENT_CONTACT_NAME="$FIRST_CLIENT_CONTACT_NAME" \
    FIRST_CLIENT_CONTACT_EMAIL="$FIRST_CLIENT_CONTACT_EMAIL" \
    FIRST_CLIENT_THEATER_NAME="$FIRST_CLIENT_THEATER_NAME" \
    FIRST_CLIENT_SQUARE_ACCESS_TOKEN="$FIRST_CLIENT_SQUARE_ACCESS_TOKEN" \
    FIRST_CLIENT_SQUARE_SIGNATURE_KEY="$FIRST_CLIENT_SQUARE_SIGNATURE_KEY" \
    SQUARE_WEBHOOK_URL="$webhook_url" \
    SQUARE_LOCATION_ID="$square_location_id" \
    FIRST_CLIENT_ADMIN_USERNAME="$FIRST_CLIENT_ADMIN_USERNAME" \
    FIRST_CLIENT_ADMIN_PASSWORD="$FIRST_CLIENT_ADMIN_PASSWORD" \
    FIRST_CLIENT_ADMIN_EMAIL="$FIRST_CLIENT_ADMIN_EMAIL" \
    python3 -c '
import json, os
payload = {
    "username": os.environ["FIRST_CLIENT_USERNAME"],
    "clientSecret": os.environ["FIRST_CLIENT_SECRET"],
    "contactName": os.environ["FIRST_CLIENT_CONTACT_NAME"],
    "clientEmail": os.environ["FIRST_CLIENT_CONTACT_EMAIL"],
    "square_access_token": os.environ["FIRST_CLIENT_SQUARE_ACCESS_TOKEN"],
    "square_signature_key": os.environ["FIRST_CLIENT_SQUARE_SIGNATURE_KEY"],
    "theater_name": os.environ["FIRST_CLIENT_THEATER_NAME"],
    "s3_bucket_prefix": os.environ["ENV_PREFIX"] + "-",
    # The webhook endpoint of this environment (getSquareOrders signs against
    # it) and the Square location, when known -- both optional to the handler.
    # (No apostrophes in here: this whole block is a single-quoted string.)
    "square_webhook_url": os.environ.get("SQUARE_WEBHOOK_URL", ""),
    "square_location_id": os.environ.get("SQUARE_LOCATION_ID", ""),
}
# Optional named admin account -- both-or-neither, matching the
# handler validation. Omit entirely rather than send blank strings
# so the handler takes its normal "not provided" path.
admin_user = os.environ.get("FIRST_CLIENT_ADMIN_USERNAME", "")
admin_pass = os.environ.get("FIRST_CLIENT_ADMIN_PASSWORD", "")
if admin_user and admin_pass:
    payload["admin_username"] = admin_user
    payload["admin_password"] = admin_pass
    admin_email = os.environ.get("FIRST_CLIENT_ADMIN_EMAIL", "")
    if admin_email:
        payload["admin_email"] = admin_email
# Optional initial Client Settings (FIRST_CLIENT_SETTINGS_FILE). The handler
# keeps only user-definable keys and logs key names, never values.
settings_file = os.environ.get("FIRST_CLIENT_SETTINGS_FILE", "")
if settings_file:
    with open(settings_file) as f:
        # Blank values ("" or {}) mean "not filled in" -- skipped, so the
        # template can be copied as-is without blanking out good defaults.
        payload["settings"] = {k: v for k, v in json.load(f).items()
                               if not k.startswith("_") and v not in ("", {}, None)}
payload.setdefault("settings", {}).setdefault("STATIC_WEBSITE_URL", os.environ["STATIC_WEBSITE_URL"])
with open(os.environ["PAYLOAD_FILE"], "w") as f:
    json.dump(payload, f)
'
  local invoke_ok=true
  aws lambda invoke \
    --function-name "$fn_name" \
    --cli-binary-format raw-in-base64-out \
    --payload "fileb://$payload_file" \
    "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" \
    "$SCRIPT_DIR/.bootstrap-client-invoke-result.json" || invoke_ok=false
  rm -f "$payload_file"
  [ "$invoke_ok" = true ] || { echo "Client onboarding invoke failed." >&2; exit 1; }
  echo "Client onboarding invoke result:"
  cat "$SCRIPT_DIR/.bootstrap-client-invoke-result.json"
  echo
  # A crash inside the function (errorType) means the deploy itself is
  # broken -- finish the static push and summary, then exit non-zero. A
  # handled failure (e.g. "role already exists" on a re-run) is expected.
  local onboarding_crashed=false
  if python3 -c 'import json, sys; sys.exit(0 if "errorType" in json.load(open(sys.argv[1])) else 1)' \
      "$SCRIPT_DIR/.bootstrap-client-invoke-result.json" 2>/dev/null; then
    onboarding_crashed=true
    echo "ERROR: $fn_name crashed during onboarding (see errorType above). The" >&2
    echo "first client was NOT onboarded. Check CloudWatch logs for $fn_name." >&2
  else
    echo "If this doesn't look like success, check CloudWatch logs for $fn_name"
    echo "before continuing -- the rest of this summary assumes it worked."
  fi
  rm -f "$SCRIPT_DIR/.bootstrap-client-invoke-result.json"
  echo

  # 7. Push static assets.
  local bucket
  bucket="$(stack_output static-site BucketName)"
  if [ -n "$bucket" ]; then
    echo "=== Pushing static assets to s3://$bucket ==="
    aws s3 sync "$SCRIPT_DIR/../QRScanner/src/public/" "s3://$bucket/" \
      --exclude "config.js" --exclude "*.template" \
      "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION"
    # A re-run's new files sit behind CloudFront's cached copies until
    # invalidated (found when a redeploy kept serving yesterday's pages).
    local distribution_id
    distribution_id="$(stack_output static-site DistributionId)"
    if [ -n "$distribution_id" ] && [ "$distribution_id" != "None" ]; then
      aws cloudfront create-invalidation --distribution-id "$distribution_id" --paths "/*" \
        --query 'Invalidation.Id' --output text \
        "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" >/dev/null \
        && echo "CloudFront cache cleared for the static site."
    fi
    echo
    echo "Remember: QRScanner/src/public/config.js is gitignored and per-"
    echo "deployment -- copy config.js.template, fill in this environment's"
    echo "real values (below), and run this sync again (or use deploy.sh"
    echo "static-push config.js once deploy.config.sh points at this"
    echo "environment)."
    echo
  fi

  print_summary
  if [ "$onboarding_crashed" = true ]; then
    echo "up finished, but onboarding crashed -- see the ERROR above." >&2
    exit 1
  fi
}

print_summary() {
  echo "============================================================"
  echo " Environment '$ENV_PREFIX' is up. Live resources:"
  echo "============================================================"
  echo "  QRScanner Function URL:  $(stack_output qrscanner FunctionUrl)"
  [ "$API_EDGE" = "true" ] && echo "  API address (edge):      $(api_url)  <- use this in config.js"
  echo "  Static site domain:      $(stack_output static-site DistributionDomainName)"
  echo "  Static site bucket:      $(stack_output static-site BucketName)"
  echo "  Webhook endpoint:        $(stack_output square-queue-forwarder ApiEndpoint)"
  echo "  Aurora endpoint:         $(stack_output aurora-poc AuroraEndpoint)"
  echo
  echo "============================================================"
  echo " Manual steps -- nothing above can script these for you:"
  echo "============================================================"
  echo "  1. If STATIC_SITE_DOMAIN was blank in bootstrap.config.sh, fill"
  echo "     it in with the domain printed above and re-run './bootstrap.sh"
  echo "     up' to tighten client-buckets' CORS policy to that exact origin."
  echo "  2. Copy QRScanner/src/public/config.js.template to config.js, set"
  echo "     window.INDIETIX_API_URL to the Function URL above, then push it"
  echo "     (aws s3 cp, or deploy.sh static-push once deploy.config.sh points"
  echo "     at this environment)."
  if [ "$SQUARE_WEBHOOK_AUTO" = "true" ]; then
  echo "  3. Square: the webhook subscription '$SQUARE_WEBHOOK_NAME' was set up"
  echo "     above (payment.updated only), and the first client already has"
  echo "     its signature key, webhook URL, and location. Nothing to do here"
  echo "     unless the location line above said it was left blank."
  else
  echo "  3. Create a Square application, register its webhook subscription"
  echo "     against the webhook endpoint above (payment.updated only), and"
  echo "     set SQUARE_SIGNATURE_KEY/SQUARE_LOCATION_ID on the first client's"
  echo "     configuration (see README.md's 'Connecting Square' section) --"
  echo "     or set SQUARE_WEBHOOK_AUTO=true and let 'up' do it."
  fi
  echo "  4. (Optional) Google Calendar service account, social media app"
  echo "     credentials, SMS 10DLC campaign registration -- see root"
  echo "     README.md's matching setup sections. None of these block"
  echo "     ticket sales working; they're additive."
  echo "  5. Verify SES is out of sandbox mode (or your sender address is"
  echo "     verified) in $AWS_REGION, or confirmation/ticket emails won't"
  echo "     send."
}

# empty_bucket <bucket> -- deletes every object in a bucket (if it exists)
# so CloudFormation / delete-bucket can actually remove it. CloudFormation
# refuses to delete a non-empty bucket, and sam delete just reports a
# failure -- confirmed: a plain stack delete left static-site stuck on its
# uploaded web assets. Only ever called on buckets named ${ENV_PREFIX}-*.
empty_bucket() {
  local b="$1"
  case "$b" in "${ENV_PREFIX}"-*) ;; *) echo "  refusing to empty $b (not ${ENV_PREFIX}-*)" >&2; return 1 ;; esac
  if aws s3api head-bucket --bucket "$b" "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" 2>/dev/null; then
    echo "Emptying s3://$b"
    aws s3 rm "s3://$b" --recursive --only-show-errors "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION"
  fi
}

# stack_buckets <stack-name-suffix> -- echoes the physical names of every
# S3 bucket a stack owns, so they can be emptied before the stack goes.
stack_buckets() {
  aws cloudformation describe-stack-resources --stack-name "${ENV_PREFIX}-$1" \
    --query "StackResources[?ResourceType=='AWS::S3::Bucket'].PhysicalResourceId" \
    --output text "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" 2>/dev/null | tr '\t' '\n'
}

# cleanup_lambda_enis -- deleted VPC Lambdas leave their network interfaces
# behind for up to ~45 minutes, and those block aurora-poc's private subnets
# from deleting ("has dependencies and cannot be deleted"). Confirmed live
# on the first full sandbox teardown. Waits for this environment's Lambda
# ENIs to detach, then deletes them. Only ENIs AWS labels
# "AWS Lambda VPC ENI-${ENV_PREFIX}-..." are touched.
cleanup_lambda_enis() {
  echo "=== Cleaning up leftover Lambda network interfaces ==="
  local waited=0 enis in_use eni
  while :; do
    enis=$(aws ec2 describe-network-interfaces \
      --filters "Name=description,Values=AWS Lambda VPC ENI-${ENV_PREFIX}-*" \
      --query 'NetworkInterfaces[].[NetworkInterfaceId,Status]' --output text \
      "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" 2>/dev/null || true)
    [ -z "$enis" ] && { echo "  none left"; break; }
    in_use=0
    while read -r eni status; do
      [ -z "$eni" ] && continue
      if [ "$status" = "available" ]; then
        # A failed delete counts as still attached, so the 45-minute cap
        # below applies instead of looping forever.
        if aws ec2 delete-network-interface --network-interface-id "$eni" \
            "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION"; then
          echo "  deleted $eni"
        else
          in_use=$((in_use + 1))
        fi
      else
        in_use=$((in_use + 1))
      fi
    done <<< "$enis"
    [ "$in_use" -eq 0 ] && continue
    if [ "$waited" -ge 2700 ]; then
      echo "  $in_use interface(s) still attached after 45 min -- aurora-poc may fail; re-run 'down' later" >&2
      break
    fi
    echo "  $in_use interface(s) still detaching, waiting..."
    sleep 30; waited=$((waited + 30))
  done
  echo
}

# env_client_ids -- prints the client IDs that live in THIS environment, one
# per line. Client secrets (indieTix/rds/clients/<id>/credentials) aren't
# namespaced by EnvPrefix, so match on the database host each one points
# at, which is always this environment's own aurora-poc cluster. Same
# auto-discovery pattern the inbound-SMS Lambda uses.
env_client_ids() {
  local cluster_host_prefix secret_name host
  cluster_host_prefix="$(echo "${ENV_PREFIX}-aurora-poc" | tr '[:upper:]' '[:lower:]')"
  for secret_name in $(aws secretsmanager list-secrets \
      --filters Key=name,Values=indieTix/rds/clients/ \
      --query 'SecretList[].Name' --output text \
      "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" 2>/dev/null); do
    host=$(aws secretsmanager get-secret-value --secret-id "$secret_name" \
      --query SecretString --output text \
      "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" 2>/dev/null \
      | python3 -c 'import json,sys; print(json.load(sys.stdin).get("host",""))' 2>/dev/null || true)
    case "$host" in
      "$cluster_host_prefix"*)
        secret_name="${secret_name#indieTix/rds/clients/}"
        echo "${secret_name%/credentials}"
        ;;
    esac
  done
}

# confirm_destructive <what> <word> <yes_flag> <production_flag> -- the gate
# for down and remove-client. In an environment marked ENV_IS_PRODUCTION it
# refuses without --production, and then always makes you type <word>
# (--yes is ignored there). Elsewhere it is the usual y/N (or --yes).
# production_gate <what> <production_flag> -- in an environment marked
# ENV_IS_PRODUCTION, refuse up front (before any AWS call) without --production.
production_gate() {
  if [ "$ENV_IS_PRODUCTION" = "true" ] && [ "$2" != "--production" ]; then
    echo "Refusing: bootstrap.config.sh marks '$ENV_PREFIX' as production (ENV_IS_PRODUCTION=\"true\")." >&2
    echo "If you really mean to $1 in production, re-run with --production." >&2
    exit 1
  fi
}

confirm_destructive() {
  local what="$1" word="$2" yes_flag="$3" production_flag="$4" reply
  production_gate "$what" "$production_flag"
  if [ "$ENV_IS_PRODUCTION" = "true" ]; then
    echo "PRODUCTION: about to $what in '$ENV_PREFIX' ($AWS_REGION). This is NOT reversible."
    read -r -p "Type '$word' to confirm: " reply
    [ "$reply" = "$word" ] || { echo "Aborted."; exit 1; }
    return 0
  fi
  confirm "About to $what in '$ENV_PREFIX' ($AWS_REGION). This is NOT reversible. Proceed?" "$yes_flag" \
    || { echo "Aborted."; exit 1; }
}

cmd_down() {
  local yes_flag="" production_flag="" arg
  for arg in "$@"; do
    case "$arg" in
      --yes|-y) yes_flag="--yes" ;;
      --production) production_flag="--production" ;;
      *) echo "down: unknown option $arg" >&2; exit 1 ;;
    esac
  done
  confirm_destructive "DELETE every stack, including the Aurora cluster and every client database, secret and S3 bucket" \
    "$ENV_PREFIX" "$yes_flag" "$production_flag"

  # 0. This environment's Square webhook subscription (SQUARE_WEBHOOK_AUTO),
  # while the forwarder stack still exists to say which URL is ours. Only
  # deleted if it still points at this environment -- otherwise Square
  # would keep retrying events at an endpoint that's about to disappear.
  if [ "$SQUARE_WEBHOOK_AUTO" = "true" ]; then
    local webhook_url
    webhook_url="$(stack_output square-queue-forwarder ApiEndpoint 2>/dev/null || true)"
    if [ -n "$webhook_url" ] && [ "$webhook_url" != "None" ]; then
      echo "=== Removing Square webhook subscription '$SQUARE_WEBHOOK_NAME' ==="
      square_webhook remove "$webhook_url" || echo "  (couldn't remove it -- delete it in the Square Developer Dashboard)"
      echo
    fi
  fi

  # 0a. Connect Square's app secret for this environment, if any. Venues'
  # own refresh-token secrets go with each venue's teardown below.
  if aws secretsmanager describe-secret --secret-id "indieTix/square/app/${ENV_PREFIX}" \
      "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" >/dev/null 2>&1; then
    aws secretsmanager delete-secret --secret-id "indieTix/square/app/${ENV_PREFIX}" --force-delete-without-recovery \
      "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" >/dev/null \
      && echo "Deleted the Connect Square app secret (indieTix/square/app/${ENV_PREFIX})."
  fi

  # 1. Find every client that lives in THIS environment.
  local env_clients
  env_clients="$(env_client_ids | tr '\n' ' ')"
  env_clients="${env_clients% }"
  echo "Clients in this environment: ${env_clients:-(none found)}"
  local other
  for other in $env_clients; do
    if [ "$other" != "$FIRST_CLIENT_USERNAME" ]; then
      echo "  Note: $other's Square webhook subscription (if add-client made one) is not"
      echo "  removed by down -- run 'remove-client <its venue file>' first, or delete it"
      echo "  in that venue's Square Developer Dashboard afterwards."
    fi
  done
  echo

  # 2. Offboard each client through client-setup-teardown's own delete path
  # (drops its DB + DB user, deletes its secret, empties/deletes its S3
  # buckets) while the cluster and function still exist. Best-effort:
  # anything it misses is cleaned up directly in step 5.
  local fn_name="${ENV_PREFIX}-client-setup-teardown" client
  for client in $env_clients; do
    echo "=== Offboarding client $client ==="
    aws lambda invoke --function-name "$fn_name" \
      --cli-binary-format raw-in-base64-out \
      --payload "{\"username\": \"$client\", \"delete_flag\": true}" \
      "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" \
      "$STAGING/offboard-result.json" >/dev/null 2>&1 \
      && cat "$STAGING/offboard-result.json" && echo \
      || echo "  (offboarding invoke failed -- continuing, step 5 cleans up)"
  done
  echo

  # 3. Empty every bucket a stack owns, so the stack deletes don't fail.
  local suffix b
  for suffix in static-site client-buckets; do
    for b in $(stack_buckets "$suffix"); do
      empty_bucket "$b"
    done
  done

  # 4. Reverse dependency order. cost-guard first, so its breaker can't
  # fire mid-teardown.
  delete_stack "cost-guard"
  delete_stack "alarms"
  # The trail keeps writing to its bucket until it stops.
  aws cloudtrail stop-logging --name "${ENV_PREFIX}-trail" \
    "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" >/dev/null 2>&1 || true
  for b in $(stack_buckets security); do
    empty_bucket "$b"
  done
  delete_stack "security"
  # The API edge lives in us-east-1 whatever the environment's region.
  if AWS_REGION=us-east-1 stack_output api-edge ApiUrl | grep -q .; then
    ( AWS_REGION=us-east-1; SAM_ARGS=("${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region us-east-1); delete_stack "api-edge" )
  fi
  aws secretsmanager delete-secret --secret-id "indieTix/edge/${ENV_PREFIX}" --force-delete-without-recovery \
    "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region us-east-1 >/dev/null 2>&1 \
    && echo "Deleted the API edge secret (indieTix/edge/${ENV_PREFIX})."
  delete_stack "sms-inbound"
  delete_stack "marketing-engine"
  delete_stack "square-token-refresher"
  delete_stack "expire-modifiers"
  delete_stack "daily-pg-sftp"
  delete_stack "client-reporting"
  delete_stack "qrscanner"
  delete_stack "client-setup-teardown"
  # get-square-orders must go before square-queue-forwarder: it imports
  # that stack's SquareWebhookQueueArn export, and CloudFormation refuses
  # to delete a stack while another stack still imports its export.
  # Confirmed the hard way -- an earlier version of this list omitted
  # get-square-orders entirely, which left square-queue-forwarder stuck
  # in "Delete canceled" indefinitely with no indication anything was
  # actually wrong (sam delete just sits there silently).
  delete_stack "get-square-orders"
  delete_stack "square-queue-forwarder"
  delete_stack "static-site"
  delete_stack "client-buckets"
  cleanup_lambda_enis
  delete_stack "aurora-poc"

  # 5. Things bootstrap/onboarding created outside CloudFormation.

  # Client secrets step 2 didn't get to (e.g. offboarding failed).
  for client in $env_clients; do
    if aws secretsmanager describe-secret --secret-id "indieTix/rds/clients/$client/credentials" \
        "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" >/dev/null 2>&1; then
      echo "Deleting leftover secret indieTix/rds/clients/$client/credentials"
      aws secretsmanager delete-secret --secret-id "indieTix/rds/clients/$client/credentials" \
        --force-delete-without-recovery \
        "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" >/dev/null
    fi
  done

  # This environment's ticket-templates bucket (created by
  # seed_ticket_templates_bucket), plus each client's buckets in case
  # offboarding didn't get them. Exact names only -- never a wildcard
  # match on ${ENV_PREFIX}-*, since one environment's prefix can be the
  # start of another's name (e.g. "indietix" vs "indietix-boottest").
  local leftover_buckets="${ENV_PREFIX}-ticket-templates" client_lower
  for client in $env_clients; do
    client_lower="$(echo "$client" | tr '[:upper:]' '[:lower:]')"
    leftover_buckets="$leftover_buckets ${ENV_PREFIX}-${client_lower} ${ENV_PREFIX}-${client_lower}-bdor"
  done
  for b in $leftover_buckets; do
    if aws s3api head-bucket --bucket "$b" "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" 2>/dev/null; then
      empty_bucket "$b" && \
        aws s3api delete-bucket --bucket "$b" "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" && \
        echo "Deleted bucket $b"
    fi
  done

  # Lambda log groups outlive their functions' stacks. Delete this
  # environment's (exact names only), so old logs -- which have included
  # onboarding credentials before that log line was redacted -- don't
  # linger after the environment is gone.
  local suffix_lg
  for suffix_lg in $ENV_FUNCTIONS cost-breaker; do
    if aws logs delete-log-group --log-group-name "/aws/lambda/${ENV_PREFIX}-${suffix_lg}" \
        "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" 2>/dev/null; then
      echo "Deleted log group /aws/lambda/${ENV_PREFIX}-${suffix_lg}"
    fi
  done

  # Shared layers published by publish_layer_sandbox (every version).
  local layer v
  for layer in "${ENV_PREFIX}-smsUtils" "${ENV_PREFIX}-ticketPdfLib"; do
    for v in $(aws lambda list-layer-versions --layer-name "$layer" \
        --query 'LayerVersions[].Version' --output text \
        "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" 2>/dev/null); do
      aws lambda delete-layer-version --layer-name "$layer" --version-number "$v" \
        "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" && echo "Deleted layer $layer:$v"
    done
  done

  echo
  echo "Done. Environment '$ENV_PREFIX' is gone. (The account-wide"
  echo "aws-sam-cli-managed-default stack/bucket is left alone on purpose --"
  echo "sam reuses it for every environment in this account.)"
}

# ---- COST BREAKER CONTROLS ----
# block: reject every request to this environment (reserved concurrency 0 on
# each of its Lambdas) -- the same thing the cost-guard breaker does when the
# daily budget is exceeded. unblock: remove those limits (no function here
# sets a reserved concurrency of its own, so there's nothing to restore).
# Square retries rejected webhooks for up to 72h and queued orders wait in
# SQS, so nothing is lost while blocked.
for_each_env_function() {
  local action="$1" suffix fn
  for suffix in $ENV_FUNCTIONS; do
    fn="${ENV_PREFIX}-${suffix}"
    if ! aws lambda get-function --function-name "$fn" \
        "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" >/dev/null 2>&1; then
      printf "  %-45s not deployed\n" "$fn"; continue
    fi
    case "$action" in
      block)
        aws lambda put-function-concurrency --function-name "$fn" --reserved-concurrent-executions 0 \
          "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" >/dev/null && printf "  %-45s BLOCKED\n" "$fn" ;;
      unblock)
        aws lambda delete-function-concurrency --function-name "$fn" \
          "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" && printf "  %-45s open\n" "$fn" ;;
      status)
        local limit
        limit=$(aws lambda get-function-concurrency --function-name "$fn" \
          --query 'ReservedConcurrentExecutions' --output text \
          "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" 2>/dev/null)
        if [ "$limit" = "0" ]; then printf "  %-45s BLOCKED\n" "$fn"; else printf "  %-45s open\n" "$fn"; fi ;;
    esac
  done
}

cmd_block() {
  confirm "Block EVERY request to environment '$ENV_PREFIX' (webhooks, operator app, API, scheduled jobs) until 'unblock'?" "${1:-}" || { echo "Aborted."; exit 1; }
  echo "=== Blocking $ENV_PREFIX ==="
  for_each_env_function block
}

cmd_unblock() {
  echo "=== Unblocking $ENV_PREFIX ==="
  for_each_env_function unblock
  echo
  echo "Note: if the daily budget is still over its limit, AWS Budgets won't"
  echo "re-trigger the breaker today (it alerts once per period) -- but it will"
  echo "again on a future day if spend stays high."
}

cmd_breaker_status() {
  echo "=== Breaker status for $ENV_PREFIX ==="
  for_each_env_function status
}
# ---- END COST BREAKER CONTROLS ----


# ---- VENUES (add-client / remove-client / list-clients) ----
# Every venue after the first one `up` onboards. A venue file is one JSON
# object (venue.json.template; keep real ones in venues/, gitignored);
# lib/venue.py reads it, so secrets go from the file into shell variables
# and the Lambda payload file, never onto a command line.

venue() { python3 "$SCRIPT_DIR/lib/venue.py" "$@"; }

# resolve_venue_file <path> -- relative paths are relative to this directory
# (like FIRST_CLIENT_SETTINGS_FILE); prints the absolute path.
resolve_venue_file() {
  case "$1" in /*) echo "$1" ;; *) echo "$SCRIPT_DIR/$1" ;; esac
}

# forwarder_webhook_url -- this environment's Square webhook endpoint, or
# fails if the environment isn't up.
forwarder_webhook_url() {
  local url
  url="$(stack_output square-queue-forwarder ApiEndpoint 2>/dev/null || true)"
  if [ -z "$url" ] || [ "$url" = "None" ]; then
    echo "Environment '$ENV_PREFIX' has no square-queue-forwarder stack in $AWS_REGION -- run 'up' first." >&2
    exit 1
  fi
  echo "$url"
}

# client_in_env <id> -- whether that client lives in this environment. (Not
# `env_client_ids | grep -q`: with pipefail, grep exiting early can make a
# match look like a failure.)
client_in_env() {
  local id
  for id in $(env_client_ids); do
    [ "$id" = "$1" ] && return 0
  done
  return 1
}

cmd_list_clients() {
  echo "Clients in environment '$ENV_PREFIX' ($AWS_REGION):"
  local ids
  ids="$(env_client_ids)"
  if [ -n "$ids" ]; then
    printf '  %s\n' $ids
  else
    echo "  (none)"
  fi
}

cmd_add_client() {
  [ -n "${1:-}" ] || { echo "Usage: $(basename "$0") add-client <venue-file>" >&2; exit 1; }
  local file client
  file="$(resolve_venue_file "$1")"
  client="$(venue check "$file")" || exit 1
  mkdir -p "$STAGING"

  local webhook_url signature_key="" location_id="" already=false
  webhook_url="$(forwarder_webhook_url)"
  if client_in_env "$client"; then
    already=true
    echo "Client $client already exists in '$ENV_PREFIX' -- re-checking its webhook only."
  fi

  echo "=== Adding venue $client to '$ENV_PREFIX' ($AWS_REGION) ==="
  if [ "$(venue field "$file" square_webhook.auto)" = "true" ]; then
    local token merchant name location webhook_json
    token="$(venue field "$file" square_access_token)"
    merchant="$(venue field "$file" square_webhook.expected_merchant_id)"
    name="$(venue field "$file" square_webhook.name)"
    name="${name:-${ENV_PREFIX}-${client}}"
    location="$(venue field "$file" square_location_id)"
    echo "--- Square webhook subscription '$name' ---"
    webhook_json="$(square_webhook_for sync "$webhook_url" "$token" "$merchant" "$name" "$location")" \
      || { echo "Square webhook setup failed -- nothing was onboarded." >&2; exit 1; }
    signature_key="$(printf %s "$webhook_json" | json_field signature_key)"
    location_id="$(printf %s "$webhook_json" | json_field location_id)"
    unset token webhook_json
  fi
  if [ "$already" = true ]; then
    echo "Venue $client was already onboarded; nothing else to do. (To change its settings, use Client Settings.)"
    return 0
  fi

  local payload_file static_website_url fn_name="${ENV_PREFIX}-client-setup-teardown"
  static_website_url="https://${STATIC_SITE_DOMAIN:-$(stack_output static-site DistributionDomainName)}"
  payload_file="$(umask 077; mktemp "$STAGING/venue-payload.XXXXXX")"
  ENV_PREFIX="$ENV_PREFIX" SQUARE_WEBHOOK_URL="$webhook_url" \
    SQUARE_SIGNATURE_KEY="$signature_key" SQUARE_LOCATION_ID="$location_id" \
    STATIC_WEBSITE_URL="$static_website_url" \
    venue payload "$file" "$payload_file" || { rm -f "$payload_file"; exit 1; }
  unset signature_key

  echo "--- Onboarding ---"
  local result="$STAGING/venue-result.json" invoke_ok=true
  aws lambda invoke --function-name "$fn_name" \
    --cli-binary-format raw-in-base64-out \
    --payload "fileb://$payload_file" \
    "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" \
    "$result" >/dev/null || invoke_ok=false
  rm -f "$payload_file"
  [ "$invoke_ok" = true ] || { echo "Onboarding invoke failed." >&2; exit 1; }
  cat "$result"; echo
  if ! python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1])).get("statusCode") == 200 else 1)' "$result" 2>/dev/null; then
    rm -f "$result"
    echo "Onboarding did not succeed (see the message above, and CloudWatch logs for $fn_name)." >&2
    exit 1
  fi
  rm -f "$result"
  echo
  echo "Venue $client is ready."
  echo "  Site:   $static_website_url"
  echo "  Log in: username and client ID '$client', password = clientSecret from $(basename "$file")"
}

cmd_remove_client() {
  local target="" confirm_id="" yes_flag="" production_flag=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --confirm) confirm_id="${2:-}"; shift ;;
      --yes|-y) yes_flag="--yes" ;;
      --production) production_flag="--production" ;;
      -*) echo "remove-client: unknown option $1" >&2; exit 1 ;;
      *) target="$1" ;;
    esac
    shift
  done
  [ -n "$target" ] || { echo "Usage: $(basename "$0") remove-client <venue-file | client-id> [--yes] [--production]" >&2; exit 1; }
  production_gate "remove a venue" "$production_flag"

  # A venue file also lets us remove the venue's Square webhook (it needs the
  # venue's own token); a bare client ID only offboards.
  local file="" client
  if [ -f "$(resolve_venue_file "$target")" ]; then
    file="$(resolve_venue_file "$target")"
    client="$(venue check "$file")" || exit 1
  else
    client="$target"
  fi

  client_in_env "$client" || {
    echo "No client '$client' in environment '$ENV_PREFIX' ($AWS_REGION). Nothing was changed." >&2
    echo "('$(basename "$0") list-clients' shows the ones that are.)" >&2
    exit 1
  }
  # --confirm <id> is the non-interactive way to say yes outside production,
  # and must name the same client.
  if [ -n "$confirm_id" ]; then
    [ "$confirm_id" = "$client" ] || { echo "--confirm $confirm_id doesn't match client $client. Nothing was changed." >&2; exit 1; }
    yes_flag="--yes"
  fi
  confirm_destructive "remove venue $client (its database, secret and S3 buckets)" "$client" "$yes_flag" "$production_flag"

  if [ -n "$file" ] && [ "$(venue field "$file" square_webhook.auto)" = "true" ]; then
    local token merchant name webhook_url
    webhook_url="$(forwarder_webhook_url)"
    token="$(venue field "$file" square_access_token)"
    merchant="$(venue field "$file" square_webhook.expected_merchant_id)"
    name="$(venue field "$file" square_webhook.name)"
    name="${name:-${ENV_PREFIX}-${client}}"
    echo "=== Removing Square webhook subscription '$name' ==="
    square_webhook_for remove "$webhook_url" "$token" "$merchant" "$name" "" \
      || echo "  (couldn't remove it -- delete it in the Square Developer Dashboard)"
    unset token
  fi

  echo "=== Offboarding client $client ==="
  mkdir -p "$STAGING"
  local result="$STAGING/offboard-result.json"
  aws lambda invoke --function-name "${ENV_PREFIX}-client-setup-teardown" \
    --cli-binary-format raw-in-base64-out \
    --payload "{\"username\": \"$client\", \"delete_flag\": true}" \
    "${AWS_ARGS[@]+"${AWS_ARGS[@]}"}" --region "$AWS_REGION" \
    "$result" >/dev/null || { echo "Offboarding invoke failed." >&2; exit 1; }
  cat "$result"; echo
  rm -f "$result"
  if [ -z "$file" ]; then
    echo
    echo "No venue file given, so this venue's Square webhook subscription (if any)"
    echo "was left alone -- delete it in the Square Developer Dashboard, or re-run"
    echo "with the venue file next time."
  fi
}
# ---- END VENUES ----

case "${1:-}" in
  help|-h|--help) usage; exit 0 ;;
  up) cmd_up "${2:-}" ;;
  down) shift; cmd_down "$@" ;;
  add-client) cmd_add_client "${2:-}" ;;
  remove-client) shift; cmd_remove_client "$@" ;;
  list-clients) cmd_list_clients ;;
  block) cmd_block "${2:-}" ;;
  unblock) cmd_unblock ;;
  breaker-status) cmd_breaker_status ;;
  *) usage; exit 1 ;;
esac
