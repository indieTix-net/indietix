# repo-config.sh -- the single authoritative definition of "where does each
# Lambda's real source live, and exactly which files does it need." Sourced
# by both deploy.sh (production/dev-sandbox code pushes) and bootstrap.sh
# (from-scratch environment stand-up) so there is exactly one place this
# ever gets defined. Previously deploy.sh had its own copy of this and
# infrastructure/<stack>/src/ held a second, manually-copied, never-
# resynced copy for SAM to build from -- that's what let QRScanner's
# AWS_REGION/STATIC_WEBSITE_URL bug (and the sms-utils/ticket-pdf-lib
# layer migration) go unnoticed in the SAM-deployed sandbox for weeks.
# Not meant to be run directly -- source it.
#
# Requires the sourcing script to have already set SCRIPT_DIR to its own
# directory before sourcing this file, same convention both deploy.sh and
# bootstrap.sh already use.

ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

ALL_REPOS="getSquareOrders clientSetup-Teardown clientReporting expireQRCodeSquareModifiers DailyPgQueryAndSftp smsOptInOptOut square-queue-forwarder QRScanner marketingEngine"

# ---------------------------------------------------------------------------
# Per-repo config. Sets AWS_FN, SRC_DIR, FILES (newline-separated, relative
# to SRC_DIR), LAYER_NAME (empty if none), LAYER_PKG_DIR (dir containing the
# layer's package.json; empty if LAYER_NAME is empty or has no separate
# package dir to rebuild from).
#
# Every function's file list below was verified by diffing a fresh build
# against the actual live code.zip on 2026-10-13 -- not guessed. If you add
# a new source file to a function, add it here too, or deploys will keep
# working but silently omit it (exactly the failure mode we caught by hand
# with QRScanner's missing crypto-utils.mjs/data-filter-utils.mjs).
# ---------------------------------------------------------------------------
load_config() {
  AWS_FN=""; SRC_DIR=""; FILES=""; LAYER_NAME=""; LAYER_PKG_DIR=""; DEV_FN=""; LAYER_INCLUDE_SELF=""

  case "$1" in
    getSquareOrders)
      AWS_FN="getSquareOrders"
      SRC_DIR="$ROOT/getSquareOrders/src"
      FILES=$'index.mjs\ndatabaseSetup.sql'
      LAYER_NAME="ticketing"
      LAYER_PKG_DIR="$ROOT/getSquareOrders/ticketing"
      DEV_FN="indietix-sandbox-get-square-orders"
      ;;
    clientSetup-Teardown)
      AWS_FN="clientSetup_Teardown"
      SRC_DIR="$ROOT/clientSetup-Teardown/src"
      FILES=$'index.js'
      LAYER_NAME="clientSetup_Teardown"
      LAYER_PKG_DIR="$ROOT/clientSetup-Teardown/nodejs"
      DEV_FN="indietix-sandbox-client-setup-teardown"
      ;;
    clientReporting)
      AWS_FN="clientReporting"
      SRC_DIR="$ROOT/clientReporting/src"
      FILES=$'index.js'
      LAYER_NAME="clientSetup_Teardown"
      LAYER_PKG_DIR="$ROOT/clientSetup-Teardown/nodejs"
      DEV_FN="indietix-sandbox-client-reporting"
      ;;
    expireQRCodeSquareModifiers)
      AWS_FN="expireQRCodeSquareModifiers"
      SRC_DIR="$ROOT/expireQRCodeSquareModifiers/src"
      FILES=$'index.mjs'
      LAYER_NAME="expiredModifiers"
      LAYER_PKG_DIR="$ROOT/expireQRCodeSquareModifiers/src/nodejs"
      DEV_FN="indietix-sandbox-expire-modifiers"
      ;;
    DailyPgQueryAndSftp)
      AWS_FN="DailyPgQueryAndSftp"
      SRC_DIR="$ROOT/DailyPgQueryAndSftp/src"
      FILES=$'index.js'
      LAYER_NAME="dailyPGBdor"
      LAYER_PKG_DIR="$ROOT/DailyPgQueryAndSftp/dependencies"
      DEV_FN="indietix-sandbox-daily-pg-sftp"
      ;;
    smsOptInOptOut)
      AWS_FN="textingOpt_In-Opt_Out"
      SRC_DIR="$ROOT/smsOptInOptOut/src"
      FILES=$'index.mjs'
      LAYER_NAME="smsOptIn_OptOut"
      LAYER_PKG_DIR=""
      DEV_FN="indietix-sandbox-sms-inbound"
      ;;
    square-queue-forwarder)
      AWS_FN="square-queue-forwarder"
      SRC_DIR="$ROOT/square-queue-forwarder/src"
      FILES=$'index.mjs'
      LAYER_NAME=""
      LAYER_PKG_DIR=""
      DEV_FN="indietix-sandbox-square-queue-forwarder"
      ;;
    QRScanner)
      AWS_FN="QRScanner"
      SRC_DIR="$ROOT/QRScanner/src"
      FILES=$'index.mjs\napp.mjs\nmodels/index.mjs\nmodels/client.mjs\nmodels/order.mjs\nmodels/product.mjs\nmodels/user.mjs\nutils/crypto-utils.mjs\nutils/data-filter-utils.mjs'
      LAYER_NAME="qrscannerWebsite"
      LAYER_PKG_DIR="$ROOT/QRScanner/nodePackages"
      DEV_FN="indietix-sandbox-qrscanner"
      ;;
    marketingEngine)
      AWS_FN="marketingEngine"
      SRC_DIR="$ROOT/marketingEngine/src"
      FILES=$'index.mjs\nfonts/Electrolize-Regular.ttf\nfonts/OFL.txt'
      LAYER_NAME="marketingEngine"
      LAYER_PKG_DIR="$ROOT/marketingEngine/src/nodejs"
      DEV_FN="indietix-sandbox-marketing-engine"
      ;;
    sms-utils-get-square-orders)
      # Shared phone/SMS layer -- not a Lambda of its own, so deliberately
      # NOT in ALL_REPOS (same reasoning as ticket-pdf-lib). One entry per
      # consuming function, all sharing LAYER_NAME, matching the existing
      # clientSetup-Teardown/clientReporting shared-layer pattern.
      AWS_FN="getSquareOrders"
      SRC_DIR=""
      FILES=""
      LAYER_NAME="smsUtils"
      LAYER_PKG_DIR="$ROOT/sms-utils"
      LAYER_INCLUDE_SELF="true"
      DEV_FN="indietix-sandbox-get-square-orders"
      ;;
    sms-utils-sms-opt-in-opt-out)
      AWS_FN="textingOpt_In-Opt_Out"
      SRC_DIR=""
      FILES=""
      LAYER_NAME="smsUtils"
      LAYER_PKG_DIR="$ROOT/sms-utils"
      LAYER_INCLUDE_SELF="true"
      DEV_FN="indietix-sandbox-sms-inbound"
      ;;
    sms-utils-qrscanner)
      AWS_FN="QRScanner"
      SRC_DIR=""
      FILES=""
      LAYER_NAME="smsUtils"
      LAYER_PKG_DIR="$ROOT/sms-utils"
      LAYER_INCLUDE_SELF="true"
      DEV_FN="indietix-sandbox-qrscanner"
      ;;
    ticket-pdf-lib)
      # Shared QR/PDF rendering layer -- not a Lambda of its own, so
      # deliberately NOT in ALL_REPOS (cmd_deploy_all/cmd_status loop over
      # ALL_REPOS and would otherwise redeploy QRScanner's function code
      # with this entry's empty FILES list). Only reachable via explicit
      # `deploy-layer ticket-pdf-lib` / `attach-layer ticket-pdf-lib`,
      # which attaches the layer to QRScanner. getSquareOrders is a second
      # consumer now too -- see ticket-pdf-lib-get-square-orders below,
      # since one entry = one attach target in this script's design.
      AWS_FN="QRScanner"
      SRC_DIR=""
      FILES=""
      LAYER_NAME="ticketPdfLib"
      LAYER_PKG_DIR="$ROOT/ticket-pdf-lib"
      LAYER_INCLUDE_SELF="true"
      DEV_FN="indietix-sandbox-qrscanner"
      ;;
    ticket-pdf-lib-get-square-orders)
      AWS_FN="getSquareOrders"
      SRC_DIR=""
      FILES=""
      LAYER_NAME="ticketPdfLib"
      LAYER_PKG_DIR="$ROOT/ticket-pdf-lib"
      LAYER_INCLUDE_SELF="true"
      DEV_FN="indietix-sandbox-get-square-orders"
      ;;
    *)
      echo "Unknown repo: '$1'" >&2
      echo "Known repos: $ALL_REPOS" >&2
      exit 1
      ;;
  esac
}
