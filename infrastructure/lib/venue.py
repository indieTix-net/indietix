#!/usr/bin/env python3
"""Venue files for bootstrap.sh add-client / remove-client.

A venue file is one JSON object per venue (see venue.json.template): the
client-setup-teardown onboarding fields, an optional "settings" object of
initial Client Settings, and an optional "square_webhook" object telling
bootstrap.sh to manage that venue's Square webhook subscription.

  venue.py check <file>          -- validate; prints the venue's username
  venue.py field <file> <key>    -- print one value ("square_webhook.name"
                                    style paths ok; blank if unset). Used to
                                    load secrets into shell variables, so the
                                    output must be captured, never echoed.
  venue.py payload <file> <out>  -- write the onboarding payload to <out>
                                    (which the caller created private)

Keys starting with "_" are comments, and blank values ("", {}, null) mean
"not filled in", so the template can be copied as-is.
"""
import json
import re
import sys

REQUIRED = ["username", "clientSecret", "contactName", "clientEmail", "square_access_token"]
# Becomes the database name and (lowercased, as onboarding does) the S3
# bucket suffix, so S3 bucket naming rules apply.
USERNAME_RE = re.compile(r"^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$")
# Fields bootstrap.sh fills in itself, never taken from the file.
MANAGED = {"s3_bucket_prefix", "square_webhook_url", "delete_flag"}


def fail(message):
    print(f"ERROR: {message}", file=sys.stderr)
    sys.exit(1)


def clean(obj):
    return {k: v for k, v in obj.items() if not k.startswith("_") and v not in ("", {}, None)}


def load(path):
    try:
        with open(path) as f:
            data = json.load(f)
    except OSError as error:
        fail(f"can't read venue file {path}: {error.strerror}")
    except ValueError as error:
        fail(f"venue file {path} isn't valid JSON: {error}")
    if not isinstance(data, dict):
        fail(f"venue file {path} must be a JSON object")
    venue = clean(data)
    for key in ("settings", "square_webhook"):
        if key in venue:
            if not isinstance(venue[key], dict):
                fail(f'"{key}" in {path} must be an object')
            venue[key] = clean(venue[key])
    return venue


def check(path):
    venue = load(path)
    missing = [k for k in REQUIRED if k not in venue]
    if missing:
        fail(f"{path} is missing {', '.join(missing)}")
    if not USERNAME_RE.match(venue["username"].lower()):
        fail(f'username "{venue["username"]}" must be 3-63 letters, numbers, dots or hyphens, '
             "starting and ending with a letter or number")
    webhook = venue.get("square_webhook", {})
    if webhook.get("auto") is True:
        if not webhook.get("expected_merchant_id"):
            fail(f'{path}: square_webhook.auto needs square_webhook.expected_merchant_id '
                 "(the merchant ID the Square token belongs to)")
    elif "square_signature_key" not in venue:
        fail(f'{path}: set square_signature_key, or set square_webhook.auto to true so it is created for you')
    if bool(venue.get("admin_username")) != bool(venue.get("admin_password")):
        fail(f"{path}: admin_username and admin_password go together (both or neither)")
    print(venue["username"])


def field(path, key):
    value = load(path)
    for part in key.split("."):
        value = value.get(part, "") if isinstance(value, dict) else ""
    print("true" if value is True else "false" if value is False else value)


def payload(path, out, env):
    venue = load(path)
    body = {k: v for k, v in venue.items() if k not in MANAGED and k != "square_webhook"}
    body["s3_bucket_prefix"] = env["ENV_PREFIX"] + "-"
    body["square_webhook_url"] = env.get("SQUARE_WEBHOOK_URL", "")
    # A managed webhook's signature key and location win over the file.
    for key, var in (("square_signature_key", "SQUARE_SIGNATURE_KEY"), ("square_location_id", "SQUARE_LOCATION_ID")):
        if env.get(var):
            body[key] = env[var]
    body.setdefault("settings", {}).setdefault("STATIC_WEBSITE_URL", env["STATIC_WEBSITE_URL"])
    with open(out, "w") as f:
        json.dump(body, f)


def main():
    import os
    args = sys.argv[1:]
    if args[:1] == ["check"] and len(args) == 2:
        check(args[1])
    elif args[:1] == ["field"] and len(args) == 3:
        field(args[1], args[2])
    elif args[:1] == ["payload"] and len(args) == 3:
        payload(args[1], args[2], os.environ)
    else:
        fail("usage: venue.py check <file> | field <file> <key> | payload <file> <out>")


if __name__ == "__main__":
    main()
