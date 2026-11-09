#!/bin/bash
# deploy.sh -- unified build/deploy tool for every indieTix Lambda function,
# their layers, and QRScanner's static site. Lives in infrastructure/ but
# operates on the sibling service repos one level up (ROOT, below) --
# it's not itself an infrastructure/SAM concern, it just also knows how to
# ship code to the sandbox stacks infrastructure/ provisions (deploy-dev).
#
# Every function's file list below was verified by diffing a fresh build
# against the actual live code.zip on 2026-10-13 -- not guessed. If you add
# a new source file to a function, add it here too, or deploys will keep
# working but silently omit it (exactly the failure mode we caught by hand
# with QRScanner's missing crypto-utils.mjs/data-filter-utils.mjs).
#
# Requires: aws CLI configured, npm, zip/unzip, curl, and a deploy.config.sh
# in this same directory (copy deploy.config.sh.template and fill in your
# own values -- gitignored, never committed).
# Run with no arguments for usage.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STAGING="/tmp/indietix-deploy"

# shellcheck source=lib/repo-config.sh
source "$SCRIPT_DIR/lib/repo-config.sh"
# shellcheck source=lib/build-helpers.sh
source "$SCRIPT_DIR/lib/build-helpers.sh"

usage() {
  cat <<EOF
indieTix deploy tool

Usage: $(basename "$0") <command> [args]

Targets PRODUCTION (deploy.config.sh: REGION, ACCOUNT_ID), except
deploy-dev, which targets the sandbox (DEV_PROFILE, DEV_REGION).
status, list-repos, lint, lint-static, build, diff and static-diff are
read-only.

  status                       All Lambda functions + layers, and flags any
                                function not on its layer's latest version.
  list-repos                   List every <repo> name this script accepts
                                (they're folder names in this repo).

  lint [repo]                  Syntax-check every JS/MJS file and verify
                                every local import/require resolves within
                                the build. Omit <repo> to lint everything
                                (every function + the static site's local
                                script/css references). Always runs
                                automatically as part of build/deploy too --
                                this is also here to run standalone, on
                                everything, without building/deploying.

  diff <repo>                  Show what would change if you deployed <repo>
                                right now (builds locally, compares vs. live).
  build <repo>                 Build the deploy zip for <repo> only -- no AWS
                                calls, just shows you what would be in it.
  deploy <repo> [--yes]        Build + upload code for <repo>. Shows the
                                diff vs. live, then prompts for confirmation
                                unless --yes is passed.
  deploy-all [--yes]           Diff every repo, show what differs, then
                                deploy whichever actually changed.

  deploy-dev <repo>            Ship the current build to <repo>'s sandbox
                                Lambda in the separate dev/test AWS account
                                (see infrastructure/ repo) instead of
                                production. Same FILES list, same lint, no
                                confirmation prompt -- test freely, then
                                merge your branch and run 'deploy' once
                                you're satisfied.

  deploy-layer <repo>          Rebuild (prod deps, linux/x64/glibc) + publish
                                a new layer version for <repo>. Does NOT
                                attach it -- see attach-layer.
  attach-layer <repo>          Attach the latest published layer version to
                                <repo>'s function, preserving any other
                                attached layers (e.g. LambdaInsightsExtension).

  static-diff                  Show which QRScanner/src/public files differ
                                from what's actually live in S3.
  lint-static                  Just the static-site piece of 'lint' on its
                                own: verify every local script/css link in
                                QRScanner/src/public/*.html actually exists.
  static-push <filename>       Push one specific static file to S3 and
                                invalidate its CloudFront cache. Works for
                                any file under QRScanner/src/public/, not
                                just html/js/css -- includes correct
                                content-type for images (png/jpg/svg/gif/
                                webp/ico), e.g. a logo replacement.
  static-push-legal [--yes]    Publish privacy.html and terms.html for
                                LEGAL_CLIENT_ID (deploy.config.sh), rendered
                                from that venue's Terms & Privacy Client
                                Settings by the live QRScanner API. Shows a
                                diff vs. live and asks. 'static-push' refuses
                                those two files: the repo's copies are
                                placeholders.
  static-push-help             Build the help pages from the guide
                                (support/knowledge, via help/build.mjs) and
                                publish them to /help/ on the static site,
                                replacing what's there. Shows the files and
                                asks first.
  invalidate [path...] [--wait] Clear CloudFront's cache for one or more
                                paths (e.g. /client.html), or everything if
                                no path is given. Doesn't touch S3 -- just
                                the cache. Add --wait to block until the
                                invalidation actually completes.

Known repos: $ALL_REPOS

Examples:
  $(basename "$0") status
  $(basename "$0") diff QRScanner
  $(basename "$0") deploy getSquareOrders
  $(basename "$0") deploy-dev marketingEngine
  $(basename "$0") deploy-layer QRScanner && $(basename "$0") attach-layer QRScanner
  $(basename "$0") static-push header-loader.js
  $(basename "$0") invalidate /client.html /insights.html
  $(basename "$0") invalidate --wait

More: CHEATSHEET.md (every command on one page), DEPLOY.md (details).
EOF
}

# --help answers before any config is loaded (a fresh clone has none yet).
case "${1:-}" in help|-h|--help) usage; exit 0 ;; esac

CONFIG_FILE="$SCRIPT_DIR/deploy.config.sh"
if [ ! -f "$CONFIG_FILE" ]; then
  echo "Missing $CONFIG_FILE." >&2
  echo "Copy deploy.config.sh.template to deploy.config.sh and fill in your own values." >&2
  exit 1
fi
# shellcheck source=/dev/null
source "$CONFIG_FILE"

[ -z "${REGION:-}" ]         && { echo "deploy.config.sh is missing REGION" >&2; exit 1; }
[ -z "${ACCOUNT_ID:-}" ]     && { echo "deploy.config.sh is missing ACCOUNT_ID" >&2; exit 1; }
[ -z "${DISTRIBUTION_ID:-}" ] && { echo "deploy.config.sh is missing DISTRIBUTION_ID" >&2; exit 1; }
[ -z "${STATIC_BUCKET:-}" ]  && { echo "deploy.config.sh is missing STATIC_BUCKET" >&2; exit 1; }
[ -z "${DEV_PROFILE:-}" ]    && { echo "deploy.config.sh is missing DEV_PROFILE" >&2; exit 1; }
[ -z "${DEV_REGION:-}" ]     && { echo "deploy.config.sh is missing DEV_REGION" >&2; exit 1; }

mkdir -p "$STAGING"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

confirm() {
  # confirm "prompt text" "$YES_FLAG"
  local prompt="$1" yes_flag="${2:-}"
  if [ "$yes_flag" = "--yes" ] || [ "$yes_flag" = "-y" ]; then
    return 0
  fi
  read -r -p "$prompt [y/N] " reply
  [ "$reply" = "y" ] || [ "$reply" = "Y" ]
}

# lint_build and build_zip now live in lib/build-helpers.sh (shared with
# bootstrap.sh's SAM builds -- see that file for both).

fetch_live_zip() {
  # fetch_live_zip <aws-function-name> [profile] [region] -- echoes path to
  # downloaded live code.zip. profile/region are optional; omitted means
  # "use whatever the AWS CLI's own default config already is" -- exactly
  # today's behavior for every production call site.
  local fn="$1" profile="${2:-}" region="${3:-}"
  local aws_args=()
  [ -n "$profile" ] && aws_args+=(--profile "$profile")
  [ -n "$region" ] && aws_args+=(--region "$region")
  local url
  url=$(aws lambda get-function --function-name "$fn" ${aws_args[@]+"${aws_args[@]}"} --query 'Code.Location' --output text)
  local out="$STAGING/${fn}-live.zip"
  curl -s -o "$out" "$url"
  echo "$out"
}

poll_update_status() {
  # poll_update_status <aws-function-name> [profile] [region] -- same
  # optional profile/region convention as fetch_live_zip above.
  local fn="$1" profile="${2:-}" region="${3:-}"
  local aws_args=()
  [ -n "$profile" ] && aws_args+=(--profile "$profile")
  [ -n "$region" ] && aws_args+=(--region "$region")
  for _ in $(seq 1 20); do
    local status
    status=$(aws lambda get-function-configuration --function-name "$fn" ${aws_args[@]+"${aws_args[@]}"} --query 'LastUpdateStatus' --output text)
    if [ "$status" = "Successful" ]; then
      echo "Update successful."
      return 0
    fi
    if [ "$status" = "Failed" ]; then
      echo "ERROR: Lambda reported LastUpdateStatus=Failed for $fn" >&2
      return 1
    fi
    sleep 3
  done
  echo "WARNING: update still not 'Successful' after ~60s; check manually." >&2
  return 1
}

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

cmd_list_repos() {
  echo "$ALL_REPOS" | tr ' ' '\n'
}

cmd_build() {
  local repo="$1"
  local zip_path
  zip_path=$(build_zip "$repo")
  echo "Built: $zip_path"
  echo
  unzip -l "$zip_path"
}

cmd_diff() {
  local repo="$1"
  load_config "$repo"
  local new_zip live_zip
  new_zip=$(build_zip "$repo")
  echo "Fetching live code for '$AWS_FN'..."
  live_zip=$(fetch_live_zip "$AWS_FN")

  local new_ex="$STAGING/diff-new-$repo" live_ex="$STAGING/diff-live-$repo"
  rm -rf "$new_ex" "$live_ex"
  mkdir -p "$new_ex" "$live_ex"
  unzip -q -o "$new_zip" -d "$new_ex"
  unzip -q -o "$live_zip" -d "$live_ex"

  echo
  echo "=== $repo: live (left) vs. about-to-build (right) ==="
  if diff -rq "$live_ex" "$new_ex"; then
    echo "IDENTICAL -- nothing to deploy."
  fi
}

cmd_deploy() {
  local repo="$1" yes_flag="${2:-}"
  load_config "$repo"
  local zip_path
  zip_path=$(build_zip "$repo")

  echo "=== Deploying $repo -> Lambda function '$AWS_FN' ==="

  # Show what's actually changing vs. live, not just the zip's raw
  # contents -- so you're never confirming a deploy you haven't seen
  # the diff for.
  local live_zip new_ex live_ex
  live_zip=$(fetch_live_zip "$AWS_FN")
  new_ex="$STAGING/deploy-new-$repo"; live_ex="$STAGING/deploy-live-$repo"
  rm -rf "$new_ex" "$live_ex"; mkdir -p "$new_ex" "$live_ex"
  unzip -q -o "$zip_path" -d "$new_ex"
  unzip -q -o "$live_zip" -d "$live_ex"
  echo "--- diff vs. live ---"
  diff -rq "$live_ex" "$new_ex" || true
  echo

  confirm "Proceed with deploy of $AWS_FN?" "$yes_flag" || { echo "Aborted."; return 1; }

  aws lambda update-function-code \
    --function-name "$AWS_FN" \
    --zip-file "fileb://$zip_path" \
    --query '{CodeSize:CodeSize,LastModified:LastModified,LastUpdateStatus:LastUpdateStatus}' \
    --output table

  poll_update_status "$AWS_FN"

  echo
  echo "=== Config sanity check ($AWS_FN) ==="
  aws lambda get-function-configuration --function-name "$AWS_FN" \
    --query '{Layers:Layers[].Arn,Handler:Handler,Runtime:Runtime,MemorySize:MemorySize,Timeout:Timeout}' \
    --output json
}

cmd_deploy_dev() {
  # cmd_deploy_dev <repo> -- ships the exact same build as cmd_deploy (same
  # FILES list, same lint-before-build) to the sandbox Lambda in the
  # separate dev/test AWS account instead of production's. No
  # confirmation prompt -- the whole point of the dev loop is fast
  # iteration, and production remains the only place that pauses to ask.
  # The diff vs. what's currently deployed in the sandbox is still shown,
  # purely for visibility.
  local repo="$1"
  load_config "$repo"
  if [ -z "$DEV_FN" ]; then
    echo "$repo has no sandbox/dev Lambda configured yet (see infrastructure/ repo)." >&2
    return 1
  fi

  local zip_path
  zip_path=$(build_zip "$repo")

  echo "=== Deploying $repo -> DEV Lambda '$DEV_FN' (sandbox account, $DEV_REGION) ==="

  local live_zip new_ex live_ex
  live_zip=$(fetch_live_zip "$DEV_FN" "$DEV_PROFILE" "$DEV_REGION")
  new_ex="$STAGING/deploy-dev-new-$repo"; live_ex="$STAGING/deploy-dev-live-$repo"
  rm -rf "$new_ex" "$live_ex"; mkdir -p "$new_ex" "$live_ex"
  unzip -q -o "$zip_path" -d "$new_ex"
  unzip -q -o "$live_zip" -d "$live_ex"
  echo "--- diff vs. current dev deployment ---"
  diff -rq "$live_ex" "$new_ex" || true
  echo

  aws lambda update-function-code \
    --function-name "$DEV_FN" \
    --profile "$DEV_PROFILE" --region "$DEV_REGION" \
    --zip-file "fileb://$zip_path" \
    --query '{CodeSize:CodeSize,LastModified:LastModified,LastUpdateStatus:LastUpdateStatus}' \
    --output table

  poll_update_status "$DEV_FN" "$DEV_PROFILE" "$DEV_REGION"

  echo
  echo "Deployed to dev. Test against the sandbox Lambda directly, then once"
  echo "satisfied, merge your branch and run: $0 deploy $repo"
}

cmd_deploy_all() {
  local yes_flag="${1:-}"
  local to_deploy=""

  for repo in $ALL_REPOS; do
    echo
    echo "################ $repo ################"
    load_config "$repo"
    local new_zip live_zip new_ex live_ex
    new_zip=$(build_zip "$repo")
    live_zip=$(fetch_live_zip "$AWS_FN")
    new_ex="$STAGING/diff-new-$repo"; live_ex="$STAGING/diff-live-$repo"
    rm -rf "$new_ex" "$live_ex"; mkdir -p "$new_ex" "$live_ex"
    unzip -q -o "$new_zip" -d "$new_ex"
    unzip -q -o "$live_zip" -d "$live_ex"
    if diff -rq "$live_ex" "$new_ex" > /dev/null; then
      echo "No changes."
    else
      echo "Changes found:"
      diff -rq "$live_ex" "$new_ex" || true
      to_deploy="$to_deploy $repo"
    fi
  done

  echo
  if [ -z "$to_deploy" ]; then
    echo "Nothing differs from live -- nothing to deploy."
    return 0
  fi
  echo "Repos with pending changes:$to_deploy"
  confirm "Deploy all of the above?" "$yes_flag" || { echo "Aborted."; return 1; }

  for repo in $to_deploy; do
    echo
    echo "################ deploying $repo ################"
    cmd_deploy "$repo" --yes
  done
}

cmd_deploy_layer() {
  local repo="$1"
  load_config "$repo"
  if [ -z "$LAYER_NAME" ]; then
    echo "$repo has no associated layer." >&2; return 1
  fi

  local layer_zip
  layer_zip=$(build_layer_zip "$repo")

  echo
  confirm "Publish new version of layer '$LAYER_NAME'?" "" || { echo "Aborted (nothing published)."; return 1; }

  local new_arn
  new_arn=$(aws lambda publish-layer-version \
    --layer-name "$LAYER_NAME" \
    --zip-file "fileb://$layer_zip" \
    --compatible-runtimes nodejs22.x \
    --compatible-architectures x86_64 \
    --query 'LayerVersionArn' --output text)
  echo "Published: $new_arn"
  echo
  echo "NOTE: this does NOT attach the new version to '$AWS_FN'."
  echo "Run: $0 attach-layer $repo"
}

cmd_attach_layer() {
  local repo="$1"
  load_config "$repo"
  if [ -z "$LAYER_NAME" ]; then
    echo "$repo has no associated layer." >&2; return 1
  fi

  local latest_version
  latest_version=$(aws lambda list-layer-versions --layer-name "$LAYER_NAME" --no-paginate \
    --query 'LayerVersions[0].Version' --output text)
  local layer_arn="arn:aws:lambda:$REGION:$ACCOUNT_ID:layer:$LAYER_NAME:$latest_version"

  # Preserve any other layers already attached (e.g. LambdaInsightsExtension)
  # that don't match this layer name.
  local other_layers
  other_layers=$(aws lambda get-function-configuration --function-name "$AWS_FN" \
    --query "Layers[?!contains(Arn, ':layer:${LAYER_NAME}:')].Arn" --output text)

  echo "Attaching $layer_arn to $AWS_FN"
  [ -n "$other_layers" ] && echo "Preserving other layer(s): $other_layers"

  aws lambda update-function-configuration \
    --function-name "$AWS_FN" \
    --layers $layer_arn $other_layers \
    --query '{Layers:Layers[].Arn,LastUpdateStatus:LastUpdateStatus}' \
    --output json

  poll_update_status "$AWS_FN"
}

cmd_status() {
  echo "=== Lambda Functions ==="
  aws lambda list-functions \
    --query 'Functions[].{Name:FunctionName,Runtime:Runtime,LastModified:LastModified,CodeSize:CodeSize,State:State}' \
    --output table

  echo
  echo "=== Lambda Layers (latest version) ==="
  aws lambda list-layers \
    --query 'Layers[].{Name:LayerName,LatestVersion:LatestMatchingVersion.Version,Created:LatestMatchingVersion.CreatedDate}' \
    --output table

  echo
  echo "=== Layer attachment check ==="
  echo "(flags any function not running its layer's latest published version --"
  echo " this is exactly the mistake we caught by hand with QRScanner v13 vs v14)"
  echo
  for repo in $ALL_REPOS; do
    load_config "$repo"
    [ -z "$LAYER_NAME" ] && continue
    local attached_arn attached_version latest_version
    attached_arn=$(aws lambda get-function-configuration --function-name "$AWS_FN" \
      --query "Layers[?contains(Arn, ':layer:${LAYER_NAME}:')].Arn | [0]" --output text)
    attached_version="${attached_arn##*:}"
    latest_version=$(aws lambda list-layer-versions --layer-name "$LAYER_NAME" --no-paginate \
      --query 'LayerVersions[0].Version' --output text)
    if [ "$attached_version" = "$latest_version" ]; then
      echo "OK    $AWS_FN -- layer '$LAYER_NAME' v$attached_version (latest)"
    else
      echo "STALE $AWS_FN -- running '$LAYER_NAME' v$attached_version, but v$latest_version exists and is NOT attached"
    fi
  done
}

cmd_static_diff() {
  local bucket="$STATIC_BUCKET"
  local local_dir="$ROOT/QRScanner/src/public"
  echo "=== Diffing $local_dir against live s3://$bucket ==="
  local f name live_tmp
  for f in "$local_dir"/*.html "$local_dir"/*.js "$local_dir"/*.css; do
    [ -f "$f" ] || continue
    name=$(basename "$f")
    live_tmp="$STAGING/static-live-$name"
    if aws s3api head-object --bucket "$bucket" --key "$name" > /dev/null 2>&1; then
      aws s3 cp "s3://$bucket/$name" "$live_tmp" --quiet
      if diff -q "$f" "$live_tmp" > /dev/null 2>&1; then
        echo "match   $name"
      else
        echo "DIFFERS $name"
      fi
    else
      echo "NOT-LIVE $name (exists locally, not in bucket)"
    fi
  done
}

cmd_lint_static() {
  # Checks every local <script src="..."> / <link href="...css"> reference
  # in QRScanner/src/public/*.html actually exists in that same folder.
  # External (http(s):// or //cdn...) references are skipped.
  local dir="$ROOT/QRScanner/src/public"
  local had_error=0
  for f in "$dir"/*.html; do
    [ -f "$f" ] || continue
    local base ref
    base=$(basename "$f")
    while IFS= read -r ref; do
      [ -z "$ref" ] && continue
      case "$ref" in
        http://*|https://*|//*) continue ;;
      esac
      # A per-deployment, gitignored file (config.js) counts as present when
      # its checked-in template is -- a fresh clone has only the template.
      if [ ! -f "$dir/$ref" ] && [ ! -f "$dir/$ref.template" ]; then
        echo "MISSING: $base references '$ref' -- not found in $dir"
        had_error=1
      fi
    done < <(grep -oE '(src|href)="[^"]+\.(js|css)"' "$f" | sed -E 's/.*="(.+)"/\1/')
  done
  if [ "$had_error" != "0" ]; then
    echo "Static lint found missing references." >&2
    return 1
  fi
  echo "All local script/css references in $dir resolve."
  return 0
}

cmd_lint() {
  # cmd_lint [repo] -- repo omitted lints every repo plus the static site.
  local target="${1:-}"
  local had_error=0

  if [ -n "$target" ]; then
    echo "### $target ###"
    build_zip "$target" > /dev/null || had_error=1
  else
    for repo in $ALL_REPOS; do
      echo "### $repo ###"
      build_zip "$repo" > /dev/null || had_error=1
      echo
    done
    echo "### QRScanner static site ###"
    cmd_lint_static || had_error=1
  fi

  if [ "$had_error" != "0" ]; then
    echo
    echo "Lint found problems -- see above." >&2
    return 1
  fi
  echo
  echo "All clear."
}

cmd_static_push() {
  local filename="$1"
  local bucket="$STATIC_BUCKET"
  local local_path="$ROOT/QRScanner/src/public/$filename"

  # The repo's terms.html / privacy.html are the "Your Venue" placeholder
  # versions; pushing one would replace the live venue's real legal pages
  # (which a 10DLC campaign registers). Those go through static-push-legal.
  case "$filename" in
    terms.html|privacy.html)
      echo "Refusing to push the placeholder $filename -- use: $(basename "$0") static-push-legal" >&2
      return 1 ;;
  esac

  [ -f "$local_path" ] || { echo "File not found: $local_path" >&2; return 1; }

  local content_type="application/octet-stream"
  case "$filename" in
    *.html) content_type="text/html" ;;
    *.js) content_type="application/javascript" ;;
    *.css) content_type="text/css" ;;
    *.png) content_type="image/png" ;;
    *.jpg|*.jpeg) content_type="image/jpeg" ;;
    *.svg) content_type="image/svg+xml" ;;
    *.gif) content_type="image/gif" ;;
    *.webp) content_type="image/webp" ;;
    *.ico) content_type="image/x-icon" ;;
  esac

  echo "Pushing $filename (content-type: $content_type)..."
  aws s3 cp "$local_path" "s3://$bucket/$filename" --content-type "$content_type"

  echo "Invalidating CloudFront cache for /$filename..."
  aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths "/$filename" \
    --query '{Id:Invalidation.Id,Status:Invalidation.Status}' --output table
}

# ---- LEGAL PAGES ----
# static-push-help -- builds the public help pages from the guide in
# support/knowledge (one source with the support inbox's knowledge) and
# syncs them to /help/ in the static bucket, removing pages that no longer
# exist. WebP screenshots get their content type set explicitly.
cmd_static_push_help() {
  local out="$ROOT/QRScanner/src/public/help" reply
  (cd "$ROOT/help" && npm install --silent --omit=dev && node build.mjs) || { echo "Help build failed." >&2; return 1; }
  echo "Will publish $(find "$out" -type f | wc -l | tr -d ' ') files to s3://$STATIC_BUCKET/help/ (replacing what's there)."
  read -r -p "Continue? [y/N] " reply
  [ "$reply" = "y" ] || [ "$reply" = "Y" ] || { echo "Cancelled."; return 1; }
  aws s3 sync "$out/" "s3://$STATIC_BUCKET/help/" --delete --exclude "*.webp"
  aws s3 sync "$out/" "s3://$STATIC_BUCKET/help/" --delete --exclude "*" --include "*.webp" --content-type image/webp
  aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths "/help/*" \
    --query '{Id:Invalidation.Id,Status:Invalidation.Status}' --output table
}

# static-push-legal [--yes] -- publishes privacy.html and terms.html for
# LEGAL_CLIENT_ID (deploy.config.sh): fetches each page from the live
# QRScanner API (GET /legal/<page>?client=<id>&links=static, rendered from
# that venue's LEGAL_* Client Settings), diffs it against what's live in S3,
# confirms, uploads and invalidates. Refuses a page that still shows the
# "Your Venue" placeholders, so an unconfigured venue can't blank out real
# legal pages. The API URL is read from QRScanner/src/public/config.js.
cmd_static_push_legal() {
  local yes_flag="${1:-}"
  [ -n "${LEGAL_CLIENT_ID:-}" ] || { echo "Set LEGAL_CLIENT_ID in deploy.config.sh (the venue whose details the plain privacy.html/terms.html show)." >&2; return 1; }
  local config_js="$ROOT/QRScanner/src/public/config.js" api
  api="$(sed -n "s/^[[:space:]]*window\.INDIETIX_API_URL[[:space:]]*=[[:space:]]*['\"]\([^'\"]*\)['\"].*/\1/p" "$config_js" 2>/dev/null | head -1)"
  api="${api%/}"
  [ -n "$api" ] || { echo "Couldn't read window.INDIETIX_API_URL from $config_js." >&2; return 1; }

  local page staged live changed=""
  mkdir -p "$STAGING/legal"
  for page in privacy terms; do
    staged="$STAGING/legal/$page.html"; live="$STAGING/legal/$page.live.html"
    curl -fsS "$api/legal/$page?client=$LEGAL_CLIENT_ID&links=static" -o "$staged" \
      || { echo "Couldn't fetch $page from $api for client $LEGAL_CLIENT_ID (is the /legal route deployed?)." >&2; return 1; }
    if grep -q 'Your Venue\|111 Your Address\|111-Your-Phone' "$staged"; then
      echo "Refusing: $LEGAL_CLIENT_ID's $page page still shows placeholders -- fill in its Terms & Privacy fields in Client Settings first." >&2
      return 1
    fi
    aws s3 cp "s3://$STATIC_BUCKET/$page.html" "$live" --only-show-errors 2>/dev/null || : > "$live"
    echo "=== $page.html: live (left) vs. $LEGAL_CLIENT_ID's settings (right) ==="
    if diff "$live" "$staged"; then
      echo "(no change)"
    else
      changed="$changed $page"
    fi
    echo
  done
  [ -n "$changed" ] || { echo "Both pages already match. Nothing to push."; return 0; }
  if [ "$yes_flag" != "--yes" ]; then
    read -r -p "Push$changed to production (s3://$STATIC_BUCKET)? [y/N] " reply
    [ "$reply" = "y" ] || [ "$reply" = "Y" ] || { echo "Aborted."; return 1; }
  fi
  local paths=()
  for page in $changed; do
    aws s3 cp "$STAGING/legal/$page.html" "s3://$STATIC_BUCKET/$page.html" --content-type "text/html" --only-show-errors
    paths+=("/$page.html")
  done
  aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" --paths "${paths[@]}" \
    --query '{Id:Invalidation.Id,Status:Invalidation.Status}' --output table
}
# ---- END LEGAL PAGES ----

cmd_invalidate() {
  # cmd_invalidate [--wait] [path...] -- defaults to "/*" (everything) if no
  # paths given. Doesn't touch S3 at all -- just clears CloudFront's cache,
  # same distribution static-push already invalidates for a single file.
  local wait_flag=""
  local paths=()
  for arg in "$@"; do
    if [ "$arg" = "--wait" ]; then
      wait_flag="--wait"
    else
      paths+=("$arg")
    fi
  done
  [ ${#paths[@]} -eq 0 ] && paths=("/*")

  echo "Invalidating CloudFront distribution $DISTRIBUTION_ID for: ${paths[*]}"
  local invalidation_id
  invalidation_id=$(aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION_ID" \
    --paths "${paths[@]}" --query 'Invalidation.Id' --output text)
  echo "Invalidation ID: $invalidation_id"

  if [ "$wait_flag" != "--wait" ]; then
    aws cloudfront get-invalidation --distribution-id "$DISTRIBUTION_ID" --id "$invalidation_id" \
      --query '{Id:Invalidation.Id,Status:Invalidation.Status}' --output table
    return 0
  fi

  echo "Waiting for completion..."
  for _ in $(seq 1 30); do
    local status
    status=$(aws cloudfront get-invalidation --distribution-id "$DISTRIBUTION_ID" --id "$invalidation_id" \
      --query 'Invalidation.Status' --output text)
    if [ "$status" = "Completed" ]; then
      echo "Completed."
      return 0
    fi
    sleep 5
  done
  echo "WARNING: still not 'Completed' after ~150s; check manually." >&2
  return 1
}


case "${1:-}" in
  help|-h|--help) usage; exit 0 ;;
  status) cmd_status ;;
  list-repos) cmd_list_repos ;;
  lint) cmd_lint "${2:-}" ;;
  lint-static) cmd_lint_static ;;
  diff) [ -n "${2:-}" ] || { usage; exit 1; }; cmd_diff "$2" ;;
  build) [ -n "${2:-}" ] || { usage; exit 1; }; cmd_build "$2" ;;
  deploy) [ -n "${2:-}" ] || { usage; exit 1; }; cmd_deploy "$2" "${3:-}" ;;
  deploy-all) cmd_deploy_all "${2:-}" ;;
  deploy-dev) [ -n "${2:-}" ] || { usage; exit 1; }; cmd_deploy_dev "$2" ;;
  deploy-layer) [ -n "${2:-}" ] || { usage; exit 1; }; cmd_deploy_layer "$2" ;;
  attach-layer) [ -n "${2:-}" ] || { usage; exit 1; }; cmd_attach_layer "$2" ;;
  static-diff) cmd_static_diff ;;
  static-push) [ -n "${2:-}" ] || { usage; exit 1; }; cmd_static_push "$2" ;;
  invalidate) cmd_invalidate "${@:2}" ;;
  static-push-legal) cmd_static_push_legal "${2:-}" ;;
  static-push-help) cmd_static_push_help ;;
  *) usage; exit 1 ;;
esac
