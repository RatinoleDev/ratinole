#!/usr/bin/env bash
# Exit 0 when /api/health says ok, 1 when it reports a problem (engine heartbeat
# stale or missed hours), 2 when it cannot be reached. Prints the reason.
# Run every few minutes from cron; cron mails any output if MAILTO is set.
# Set ALERT_WEBHOOK_URL to also POST {"text": "..."} to a webhook of your choice.
set -uo pipefail

URL="${HEALTH_URL:-http://127.0.0.1:4000/api/health}"

alert() {
  echo "$1"
  if [ -n "${ALERT_WEBHOOK_URL:-}" ]; then
    curl -fsS --max-time 10 -H 'content-type: application/json' \
      --data "$(printf '{"text":%s}' "$(printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")" \
      "$ALERT_WEBHOOK_URL" >/dev/null || echo "alert webhook failed"
  fi
}

if ! body="$(curl -fsS --max-time 10 "$URL")"; then
  alert "Rationale health: cannot reach $URL"
  exit 2
fi
if printf '%s' "$body" | grep -q '"ok":true'; then
  exit 0
fi
alert "Rationale health: problem reported: $body"
exit 1
