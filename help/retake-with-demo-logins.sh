#!/usr/bin/env bash
# retake-with-demo-logins.sh -- reload the demo venue and retake help
# screenshots, reading the demo's passwords from the gitignored files
# bootstrap.sh add-client wrote (infrastructure/venues/demo-marquee.*), so
# nobody has to type or paste them. Never prints a password.
#
#   ./retake-with-demo-logins.sh [--no-reload] [shot names ...]
#   (no shot names = every shot)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
venues="$here/../infrastructure/venues"
logins="$venues/demo-marquee.logins.txt"
venue="$venues/demo-marquee.json"
[ -f "$logins" ] && [ -f "$venue" ] || { echo "Missing $logins or $venue" >&2; exit 1; }

value_after() { sed -n "s/^$1[^:]*: *//p" "$logins" | head -1 | sed 's/[[:space:]]*$//'; }
guest="$(value_after 'Guest logins')"
staff="$(value_after 'Staff logins')"
secret="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["clientSecret"])' "$venue")"
[ -n "$guest" ] && [ -n "$staff" ] && [ -n "$secret" ] || { echo "Couldn't read the demo passwords from $logins / $venue" >&2; exit 1; }

reload=true
if [ "${1:-}" = "--no-reload" ]; then reload=false; shift; fi

if $reload; then
  echo "== Reloading the demo venue (keeps its usual staff and guest passwords)"
  (cd "$here/../demo-data" && DEMO_STAFF_PASSWORD="$staff" DEMO_GUEST_PASSWORD="$guest" ./load-sandbox.sh marquee | grep -viE 'password')
fi

echo "== Taking screenshots"
cd "$here"
HELP_GUEST_PASSWORD="$guest" HELP_VENUE_SECRET="$secret" node screenshots.mjs "$@"
