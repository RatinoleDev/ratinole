#!/usr/bin/env bash
# Checks /api/health. Exit 0 = ok, 1 = problem reported, 2 = cannot reach it.
# Run every few minutes from cron. A problem is any of: the engine's heartbeat
# is stale; agents missed hours; agents decided without fresh price data (no
# stop is acted on meanwhile); with live trading on, the agent's key is low on
# ETH for network fees. The message carries the numbers.
#
# Alerts are sent only when the state changes (problem starts, problem clears),
# so a long outage does not send a message every run. Channels, all optional:
#   TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID   message to a Telegram chat
#   ALERT_WEBHOOK_URL                       POST {"text": "..."} to any webhook
# They can be set in the environment or in the app's .env (ENV_FILE).
set -uo pipefail

URL="${HEALTH_URL:-http://127.0.0.1:4000/api/health}"
ENV_FILE="${ENV_FILE:-$(dirname "$0")/../.env}"
STATE_FILE="${HEALTH_STATE_FILE:-$HOME/.ratinole-health-state}"

from_env_file() {
  [ -f "$ENV_FILE" ] && grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true
}
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-$(from_env_file TELEGRAM_BOT_TOKEN)}"
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-$(from_env_file TELEGRAM_CHAT_ID)}"
ALERT_WEBHOOK_URL="${ALERT_WEBHOOK_URL:-$(from_env_file ALERT_WEBHOOK_URL)}"

json_string() {
  python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
}

send() {
  local text="$1"
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $text"
  if [ -n "$TELEGRAM_BOT_TOKEN" ] && [ -n "$TELEGRAM_CHAT_ID" ]; then
    curl -fsS --max-time 10 -H 'content-type: application/json' \
      --data "{\"chat_id\":$(printf '%s' "$TELEGRAM_CHAT_ID" | json_string),\"text\":$(printf '%s' "$text" | json_string)}" \
      "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage" >/dev/null || echo "telegram alert failed"
  fi
  if [ -n "$ALERT_WEBHOOK_URL" ]; then
    curl -fsS --max-time 10 -H 'content-type: application/json' \
      --data "{\"text\":$(printf '%s' "$text" | json_string)}" "$ALERT_WEBHOOK_URL" >/dev/null || echo "webhook alert failed"
  fi
}

previous="$(cat "$STATE_FILE" 2>/dev/null || echo ok)"

if ! body="$(curl -fsS --max-time 10 "$URL")"; then
  state="down"
  detail="cannot reach $URL"
  code=2
elif printf '%s' "$body" | grep -q '"ok":true'; then
  state="ok"
  detail=""
  code=0
else
  state="problem"
  detail="$body"
  code=1
fi

if [ "$state" != "$previous" ]; then
  if [ "$state" = "ok" ]; then
    send "Ratinole health: back to normal."
  else
    send "Ratinole health: ${state}. ${detail}"
  fi
  printf '%s' "$state" > "$STATE_FILE"
fi
exit "$code"
