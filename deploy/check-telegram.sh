#!/usr/bin/env bash
# Проверяет не только HTTP-гейтвей, но и живой Telegram-канал.
# /healthz и /readyz остаются зелёными, даже если Telegram-плагин не
# загрузился, поэтому без отдельного probe деплой выглядит успешным,
# а бот молчит.
set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/openclaw-glossary}"
ENV_FILE="${ENV_FILE:-/run/openclaw/env}"
PROBE_RETRIES="${TELEGRAM_PROBE_RETRIES:-4}"
PROBE_DELAY="${TELEGRAM_PROBE_DELAY:-3}"

COMPOSE=(
    docker compose
    --env-file "$ENV_FILE"
    -f "${REPO_DIR}/docker-compose.yml"
)

INSPECT_OUTPUT="$("${COMPOSE[@]}" run --rm -T cli \
    plugins inspect telegram 2>&1)" || {
    printf '%s\n' "$INSPECT_OUTPUT" >&2
    echo "ERROR: не удалось проверить Telegram-плагин" >&2
    exit 1
}

if ! grep -Eq 'Status:[[:space:]]*loaded' <<< "$INSPECT_OUTPUT"; then
    printf '%s\n' "$INSPECT_OUTPUT" >&2
    echo "ERROR: Telegram-плагин не загружен" >&2
    exit 1
fi

STATUS_OUTPUT=""
for ((attempt = 1; attempt <= PROBE_RETRIES; attempt++)); do
    if STATUS_OUTPUT="$("${COMPOSE[@]}" run --rm -T \
        -e NO_COLOR=1 \
        cli channels status \
        --probe \
        --channel telegram \
        --timeout 15000 2>&1)"; then
        if grep -Eqi 'Telegram[^[:cntrl:]]*running' <<< "$STATUS_OUTPUT" \
           && ! grep -Eqi 'Telegram[^[:cntrl:]]*not[[:space:]]+running' \
                <<< "$STATUS_OUTPUT" \
           && grep -Eqi 'Telegram[^[:cntrl:]]*works' <<< "$STATUS_OUTPUT"; then
            printf '%s\n' "$STATUS_OUTPUT"
            echo "OK: plugin=telegram, channel=running, probe=works"
            exit 0
        fi
    fi

    if ((attempt < PROBE_RETRIES)); then
        sleep "$PROBE_DELAY"
    fi
done

printf '%s\n' "$STATUS_OUTPUT" >&2
echo "ERROR: Telegram не подтвердил состояния running + works" >&2
exit 1
