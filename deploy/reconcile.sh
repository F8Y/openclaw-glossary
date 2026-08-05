#!/usr/bin/env bash
#
# reconcile.sh — цикл реконсиляции GitOps.
#
# Применяет желаемое состояние КАЖДЫЙ запуск, а не только при смене SHA.
# Это и есть разница между автодеплоем и GitOps: если кто-то руками
# сделал `docker compose down`, коммит не изменился, но состояние
# разъехалось — и починить его должен именно безусловный прогон.
#
# Запускается из openclaw-reconcile.service, не вручную.
set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/openclaw-glossary}"
BRANCH="${BRANCH:-deploy}"
RUN_DIR="${RUN_DIR:-/run/openclaw}"
ENV_FILE="${RUN_DIR}/env"
STATE_DIR="${STATE_DIR:-/var/lib/openclaw-deploy}"
LOCK_FILE="${RUN_DIR}/reconcile.lock"
HEALTH_URL="http://127.0.0.1:18789"
HEALTH_RETRIES=30
HEALTH_DELAY=5

log() { printf '%s [reconcile] %s\n' "$(date -Is)" "$*"; }
die() { log "ОШИБКА: $*"; exit 1; }

# --- Блокировка ------------------------------------------------------
# Таймер может выстрелить, пока предыдущий прогон ещё тянет образ.
mkdir -p "$RUN_DIR" "$STATE_DIR"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
    log "предыдущий прогон ещё идёт, пропускаем цикл"
    exit 0
fi

cd "$REPO_DIR"

# --- Синхронизация с git ---------------------------------------------
log "получаем origin/${BRANCH}"
git fetch --quiet origin "$BRANCH"

PREVIOUS_SHA="$(git rev-parse HEAD)"
TARGET_SHA="$(git rev-parse "origin/${BRANCH}")"

# reset --hard, а не merge: локальные правки на сервере — это дрейф,
# и он должен затираться, а не сохраняться.
git reset --quiet --hard "origin/${BRANCH}"
git clean -qfd -e '.env' -e 'node_modules'

if [[ "$PREVIOUS_SHA" != "$TARGET_SHA" ]]; then
    log "коммит: ${PREVIOUS_SHA:0:8} -> ${TARGET_SHA:0:8}"
else
    log "коммит без изменений (${TARGET_SHA:0:8}), применяем состояние"
fi

# --- Расшифровка секретов --------------------------------------------
# /run — tmpfs, содержимое не переживает перезагрузку и не попадает
# на диск. Секретам на диске делать нечего.
log "расшифровываем секреты"
umask 077
SOPS_AGE_KEY_FILE=/root/.config/sops/age/keys.txt \
    sops --decrypt --output-type dotenv secrets/openclaw.enc.yaml > "$ENV_FILE" \
    || die "sops не смог расшифровать secrets/openclaw.enc.yaml"
chmod 600 "$ENV_FILE"

# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

[[ -n "${OPENCLAW_IMAGE:-}" ]] || die "OPENCLAW_IMAGE не задан"
[[ "$OPENCLAW_IMAGE" == *"@sha256:"* ]] \
    || log "ВНИМАНИЕ: образ не запинен по digest, детерминизм не гарантирован"

# Критично: ниже идёт rsync --delete по пути, построенному из этой
# переменной. Пустое значение превратит его в путь от корня.
[[ -n "${OPENCLAW_STATE_DIR:-}" ]] || die "OPENCLAW_STATE_DIR не задан"
[[ "$OPENCLAW_STATE_DIR" == /* ]] || die "OPENCLAW_STATE_DIR должен быть абсолютным"
[[ -d "$OPENCLAW_STATE_DIR" ]]    || die "каталога $OPENCLAW_STATE_DIR не существует"

COMPOSE=(docker compose --env-file "$ENV_FILE" -f "${REPO_DIR}/docker-compose.yml")

# --- База знаний ------------------------------------------------------
# Markdown из git -> workspace агента. --delete намеренно: удалённый
# в репозитории файл должен исчезнуть и из базы знаний.
if [[ -d "${REPO_DIR}/config/knowledge" ]]; then
    log "синхронизируем базу знаний"
    mkdir -p "${OPENCLAW_STATE_DIR}/workspace/knowledge"
    rsync -a --delete \
        "${REPO_DIR}/config/knowledge/" \
        "${OPENCLAW_STATE_DIR}/workspace/knowledge/"
    chown -R 1000:1000 "${OPENCLAW_STATE_DIR}/workspace/knowledge"
fi

# --- Применение стека -------------------------------------------------
log "docker compose up -d"
"${COMPOSE[@]}" pull --quiet gateway || log "pull не удался, работаем на локальном образе"
"${COMPOSE[@]}" up -d --remove-orphans

# --- Декларативный конфиг агентов -------------------------------------
# Часть поведения гейтвей пишет в openclaw.json сам, поэтому файл
# целиком не перезаписываем — применяем только свои ключи батчем.
if [[ -f "${REPO_DIR}/config/openclaw.batch.json" ]]; then
    log "применяем конфиг агентов"
    "${COMPOSE[@]}" run --rm -T cli config set \
        --batch-json "$(cat "${REPO_DIR}/config/openclaw.batch.json")" \
        || log "ВНИМАНИЕ: не удалось применить конфиг агентов"
fi

# --- Health gate -------------------------------------------------------
log "ждём готовности гейтвея"
healthy=0
for ((i = 1; i <= HEALTH_RETRIES; i++)); do
    if curl -fsS --max-time 5 "${HEALTH_URL}/healthz" > /dev/null 2>&1 \
       && curl -fsS --max-time 5 "${HEALTH_URL}/readyz" > /dev/null 2>&1; then
        healthy=1
        log "гейтвей готов (попытка ${i})"
        break
    fi
    sleep "$HEALTH_DELAY"
done

if [[ "$healthy" -ne 1 ]]; then
    echo "$TARGET_SHA" > "${STATE_DIR}/failed-sha"
    date -Is > "${STATE_DIR}/failed-at"
    # Автооткат намеренно не делаем: на стейтфул-сервисе с миграциями
    # он способен сделать хуже, чем сломанный деплой. Будим человека.
    die "гейтвей не поднялся за $((HEALTH_RETRIES * HEALTH_DELAY))с на ${TARGET_SHA:0:8}"
fi

# --- Успех --------------------------------------------------------------
echo "$TARGET_SHA" > "${STATE_DIR}/last-successful-sha"
date -Is > "${STATE_DIR}/last-successful-at"
rm -f "${STATE_DIR}/failed-sha" "${STATE_DIR}/failed-at"

log "реконсиляция завершена на ${TARGET_SHA:0:8}"