#!/usr/bin/env bash
#
# alert.sh — уведомление о провале реконсиляции.
#
# Стучится напрямую в Telegram Bot API отдельным ботом, МИМО OpenClaw.
# Причина: единственный сценарий, ради которого этот алерт существует, —
# это когда OpenClaw лежит. Слать через него же бессмысленно.
#
# Вызывается из openclaw-reconcile-failure.service по OnFailure=.
set -euo pipefail

STATE_DIR="${STATE_DIR:-/var/lib/openclaw-deploy}"
ENV_FILE="${ENV_FILE:-/run/openclaw/env}"

# Если реконсиль упал ДО расшифровки, env-файла может не быть.
# Тогда расшифровываем сами — иначе алерт молча не уйдёт.
if [[ ! -r "$ENV_FILE" ]]; then
    mkdir -p "$(dirname "$ENV_FILE")"
    umask 077
    SOPS_AGE_KEY_FILE=/root/.config/sops/age/keys.txt \
        sops --decrypt --output-type dotenv \
        /opt/openclaw-glossary/secrets/openclaw.enc.yaml > "$ENV_FILE" 2>/dev/null || {
            logger -t openclaw-alert "не удалось расшифровать секреты, алерт не отправлен"
            exit 1
        }
fi

set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

: "${ALERT_BOT_TOKEN:?ALERT_BOT_TOKEN не задан}"
: "${ALERT_CHAT_ID:?ALERT_CHAT_ID не задан}"

FAILED_SHA="$(cat "${STATE_DIR}/failed-sha" 2>/dev/null || echo 'неизвестен')"
LAST_OK="$(cat "${STATE_DIR}/last-successful-sha" 2>/dev/null || echo 'нет')"
FAILURE_KIND="$(cat "${STATE_DIR}/failure-kind" 2>/dev/null || echo 'reconcile')"
HOSTNAME_S="$(hostname -s)"
JOURNAL="$(journalctl -u openclaw-reconcile.service -n 25 --no-pager -o cat 2>/dev/null | tail -c 2500)"

if [[ "$FAILURE_KIND" == "git-sync" ]]; then
    FETCH_FAILURES="$(cat "${STATE_DIR}/git-fetch-failures" 2>/dev/null || echo '?')"
    FETCH_FAILED_AT="$(cat "${STATE_DIR}/git-fetch-failed-at" 2>/dev/null || echo 'неизвестно')"
    TEXT="$(cat <<EOF
🟡 GitOps source временно недоступен

Хост: ${HOSTNAME_S}
Production работает на SHA: ${LAST_OK:0:12}
Сбойных циклов подряд: ${FETCH_FAILURES}
Первый сбой: ${FETCH_FAILED_AT}
Время проверки: $(date -Is)

Последние строки лога:
$(printf '%s' "$JOURNAL" | tail -n 15)

Новые изменения временно не доставляются. Последнее подтверждённое состояние
продолжает применяться и прошло health-check.
EOF
)"
else
    TEXT="$(cat <<EOF
🔴 Реконсиляция провалена

Хост: ${HOSTNAME_S}
Сломанный SHA: ${FAILED_SHA:0:12}
Последний рабочий: ${LAST_OK:0:12}
Время: $(date -Is)

Последние строки лога:
$(printf '%s' "$JOURNAL" | tail -n 15)

Диагностика:
  journalctl -u openclaw-reconcile -n 100
  docker compose --env-file /run/openclaw/env -f /opt/openclaw-glossary/docker-compose.yml logs --tail 100
EOF
)"
fi

# --data-urlencode корректно переносит многострочный текст и спецсимволы
if curl -fsS --max-time 15 \
    -X POST "https://api.telegram.org/bot${ALERT_BOT_TOKEN}/sendMessage" \
    --data-urlencode "chat_id=${ALERT_CHAT_ID}" \
    --data-urlencode "text=${TEXT}" \
    --data-urlencode "disable_web_page_preview=true" \
    > /dev/null; then
    logger -t openclaw-alert "алерт отправлен по ${FAILED_SHA:0:12}"
    if [[ "$FAILURE_KIND" == "git-sync" ]]; then
        touch "${STATE_DIR}/git-fetch-alerted"
    fi
else
    logger -t openclaw-alert "НЕ УДАЛОСЬ отправить алерт"
    exit 1
fi
