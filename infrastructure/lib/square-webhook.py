#!/usr/bin/env python3
"""Manage this environment's Square webhook subscription for bootstrap.sh.

  square-webhook.py sync    -- create or update the named subscription so it
                               points at WEBHOOK_URL with payment.updated only.
                               Prints {"signature_key", "location_id",
                               "subscription_id"} as JSON on stdout.
  square-webhook.py remove  -- delete the named subscription, but only if it
                               still points at WEBHOOK_URL (this environment's
                               own endpoint).

Reads everything from the environment, never from argv, so the token never
shows up in `ps`: SQUARE_ACCESS_TOKEN, SQUARE_EXPECTED_MERCHANT_ID,
SQUARE_WEBHOOK_NAME, WEBHOOK_URL, and optionally SQUARE_LOCATION_ID.
Progress goes to stderr; the token and signature key are never printed there.

Webhook subscriptions belong to the Square *application*, so the token has to
be the application's own access token (an OAuth token a merchant granted the
app can't manage them). Before touching anything this checks the token's
merchant against SQUARE_EXPECTED_MERCHANT_ID, and it only ever touches the one
subscription named SQUARE_WEBHOOK_NAME -- every other subscription on the app
is left alone.
"""
import json
import os
import sys
import urllib.error
import urllib.request
import uuid

SQUARE_API = "https://connect.squareup.com/v2"
SQUARE_VERSION = "2025-08-20"
# The only event IndieTix's pipeline consumes. payment.created fires before a
# payment completes and must never be subscribed (it double-processes orders).
EVENT_TYPES = ["payment.updated"]


def log(message):
    print(message, file=sys.stderr)


def fail(message):
    log(f"ERROR: {message}")
    sys.exit(1)


def square(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(f"{SQUARE_API}{path}", data=data, method=method, headers={
        "Authorization": f"Bearer {os.environ['SQUARE_ACCESS_TOKEN']}",
        "Square-Version": SQUARE_VERSION,
        "Content-Type": "application/json",
    })
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.loads(response.read() or b"{}")
    except urllib.error.HTTPError as error:
        try:
            details = [e.get("detail") or e.get("code") for e in json.loads(error.read()).get("errors", [])]
        except ValueError:
            details = []
        fail(f"Square {method} {path} returned {error.code}: {'; '.join(filter(None, details)) or error.reason}")


def check_merchant():
    expected = os.environ.get("SQUARE_EXPECTED_MERCHANT_ID", "").strip()
    if not expected:
        fail("SQUARE_EXPECTED_MERCHANT_ID is blank -- set it to the merchant ID this token belongs to.")
    merchant = square("GET", "/merchants/me").get("merchant", {})
    if merchant.get("id") != expected:
        fail(f"this Square token belongs to merchant {merchant.get('id')} ({merchant.get('business_name')}), "
             f"not SQUARE_EXPECTED_MERCHANT_ID {expected}. Nothing was changed.")
    log(f"Square merchant verified: {merchant.get('id')} ({merchant.get('business_name')})")


def find_subscription(name):
    matches, cursor = [], None
    while True:
        path = "/webhooks/subscriptions?include_disabled=true" + (f"&cursor={cursor}" if cursor else "")
        page = square("GET", path)
        matches += [s for s in page.get("subscriptions", []) if s.get("name") == name]
        cursor = page.get("cursor")
        if not cursor:
            break
    if len(matches) > 1:
        fail(f"{len(matches)} Square webhook subscriptions are named '{name}' -- delete the extras in the "
             "Square Developer Dashboard so there's exactly one, then re-run.")
    return matches[0] if matches else None


def pick_location():
    configured = os.environ.get("SQUARE_LOCATION_ID", "").strip()
    if configured:
        return configured
    active = [l for l in square("GET", "/locations").get("locations", []) if l.get("status") == "ACTIVE"]
    if len(active) == 1:
        log(f"Square location: {active[0]['id']} ({active[0].get('name')}), the only active one")
        return active[0]["id"]
    log(f"Square location: {len(active)} active locations, leaving SQUARE_LOCATION_ID blank -- "
        "set FIRST_CLIENT_SQUARE_LOCATION_ID to pick one")
    return ""


def sync(name, url):
    check_merchant()
    existing = find_subscription(name)
    if existing is None:
        created = square("POST", "/webhooks/subscriptions", {
            "idempotency_key": str(uuid.uuid4()),
            "subscription": {
                "name": name,
                "enabled": True,
                "event_types": EVENT_TYPES,
                "notification_url": url,
                "api_version": SQUARE_VERSION,
            },
        })["subscription"]
        log(f"Square webhook '{name}': created -> {url} ({', '.join(EVENT_TYPES)})")
        subscription_id, signature_key = created["id"], created.get("signature_key", "")
    else:
        subscription_id = existing["id"]
        up_to_date = (existing.get("notification_url") == url
                      and existing.get("event_types") == EVENT_TYPES
                      and existing.get("enabled") is True)
        if up_to_date:
            log(f"Square webhook '{name}': already points at {url} ({', '.join(EVENT_TYPES)})")
        else:
            square("PUT", f"/webhooks/subscriptions/{subscription_id}", {
                "subscription": {"enabled": True, "event_types": EVENT_TYPES, "notification_url": url},
            })
            log(f"Square webhook '{name}': updated -> {url} ({', '.join(EVENT_TYPES)}), "
                f"was {existing.get('notification_url')} {existing.get('event_types')} "
                f"enabled={existing.get('enabled')}")
        signature_key = square("GET", f"/webhooks/subscriptions/{subscription_id}")["subscription"].get("signature_key", "")
    if not signature_key:
        fail(f"Square returned no signature key for subscription {subscription_id}.")
    print(json.dumps({
        "signature_key": signature_key,
        "location_id": pick_location(),
        "subscription_id": subscription_id,
    }))


def remove(name, url):
    check_merchant()
    existing = find_subscription(name)
    if existing is None:
        log(f"Square webhook '{name}': none found, nothing to remove")
        return
    if existing.get("notification_url") != url:
        log(f"Square webhook '{name}': points at {existing.get('notification_url')}, not this environment's "
            f"{url} -- leaving it alone")
        return
    square("DELETE", f"/webhooks/subscriptions/{existing['id']}")
    log(f"Square webhook '{name}': deleted ({url})")


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in ("sync", "remove"):
        fail("usage: square-webhook.py sync|remove")
    for var in ("SQUARE_ACCESS_TOKEN", "SQUARE_WEBHOOK_NAME", "WEBHOOK_URL"):
        if not os.environ.get(var, "").strip():
            fail(f"{var} is blank")
    name, url = os.environ["SQUARE_WEBHOOK_NAME"].strip(), os.environ["WEBHOOK_URL"].strip()
    if sys.argv[1] == "sync":
        sync(name, url)
    else:
        remove(name, url)


if __name__ == "__main__":
    main()
