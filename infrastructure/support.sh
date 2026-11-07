#!/usr/bin/env bash
# support.sh -- opens the IndieTix support inbox (support/inbox/server.mjs)
# in your browser. It runs only on this computer (127.0.0.1, behind a
# random key) with your own AWS credentials. Settings come from
# deploy.config.sh: SUPPORT_FUNCTION, SUPPORT_DB_CLUSTER_ARN,
# SUPPORT_DB_SECRET_ARN, optional SUPPORT_BCC (a copy of every reply) and
# REGION. Ctrl+C stops it.
set -euo pipefail
cd "$(dirname "$0")"
[ -f deploy.config.sh ] && source deploy.config.sh
export SUPPORT_REGION="${REGION:-us-east-2}"
export SUPPORT_FUNCTION="${SUPPORT_FUNCTION:-}" SUPPORT_DB_CLUSTER_ARN="${SUPPORT_DB_CLUSTER_ARN:-}" \
  SUPPORT_DB_SECRET_ARN="${SUPPORT_DB_SECRET_ARN:-}" SUPPORT_BCC="${SUPPORT_BCC:-}"
[ -d ../support/node_modules ] || (cd ../support && npm install --omit=dev --silent)
exec node ../support/inbox/server.mjs
