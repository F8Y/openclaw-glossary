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
set -Eeuo pipefail

REPO_DIR="${REPO_DIR:-/opt/openclaw-glossary}"
BRANCH="${BRANCH:-deploy}"
RUN_DIR="${RUN_DIR:-/run/openclaw}"
ENV_FILE="${RUN_DIR}/env"
STATE_DIR="${STATE_DIR:-/var/lib/openclaw-deploy}"
LOCK_FILE="${RUN_DIR}/reconcile.lock"
HEALTH_URL="http://127.0.0.1:18789"
HEALTH_RETRIES=30
HEALTH_DELAY=5
GIT_FETCH_ATTEMPTS="${GIT_FETCH_ATTEMPTS:-3}"
GIT_FETCH_TIMEOUT_SECONDS="${GIT_FETCH_TIMEOUT_SECONDS:-25}"
GIT_FETCH_ALERT_AFTER="${GIT_FETCH_ALERT_AFTER:-3}"
# Системный юнит работает без терминала. BatchMode запрещает запросы пароля,
# IPv4 обходит наблюдавшиеся зависания маршрута до ssh.github.com по IPv6.
GIT_SSH_COMMAND="${GIT_SSH_COMMAND:-ssh -4 -o BatchMode=yes -o ConnectTimeout=10 -o ConnectionAttempts=1 -o ServerAliveInterval=5 -o ServerAliveCountMax=2}"
export GIT_SSH_COMMAND
TARGET_SHA=""
SELF_REEXECUTED="${OPENCLAW_RECONCILE_REEXECUTED:-0}"
FAILURE_KIND="reconcile"
GIT_SYNC_DEGRADED=0
GIT_FETCH_FAILURE_COUNT=0

log() { printf '%s [reconcile] %s\n' "$(date -Is)" "$*"; }

# Записываем SHA для любого вида отказа, а не только для health-check.
# Раньше ошибка config set показывалась в алерте как «Сломанный SHA:
# неизвестен», хотя TARGET_SHA уже был известен.
record_failed_state() {
    local failed_sha="${TARGET_SHA:-неизвестен}"

    mkdir -p "$STATE_DIR" 2>/dev/null || return 0
    printf '%s\n' "$failed_sha" > "${STATE_DIR}/failed-sha" 2>/dev/null || true
    printf '%s\n' "$FAILURE_KIND" > "${STATE_DIR}/failure-kind" 2>/dev/null || true
    date -Is > "${STATE_DIR}/failed-at" 2>/dev/null || true
}

die() {
    log "ОШИБКА: $*"
    record_failed_state
    exit 1
}

on_unexpected_error() {
    local rc=$?
    local line="${BASH_LINENO[0]:-неизвестна}"

    # Не даём сбою внутри самой диагностики рекурсивно вызвать ERR trap.
    trap - ERR
    set +e
    log "ОШИБКА: необработанный сбой, код ${rc}, строка ${line}"
    record_failed_state
    exit "$rc"
}

trap on_unexpected_error ERR

for numeric_setting in \
    GIT_FETCH_ATTEMPTS \
    GIT_FETCH_TIMEOUT_SECONDS \
    GIT_FETCH_ALERT_AFTER; do
    numeric_value="${!numeric_setting}"
    [[ "$numeric_value" =~ ^[1-9][0-9]*$ ]] \
        || die "${numeric_setting} должен быть положительным целым числом"
done

fetch_branch() {
    local attempt rc=1 previous_count=0

    for ((attempt = 1; attempt <= GIT_FETCH_ATTEMPTS; attempt++)); do
        if timeout --signal=TERM --kill-after=5s \
            "${GIT_FETCH_TIMEOUT_SECONDS}s" \
            git fetch --quiet origin "$BRANCH"; then
            if [[ -f "${STATE_DIR}/git-fetch-failed-at" ]]; then
                log "доступ к origin/${BRANCH} восстановлен"
            fi
            rm -f \
                "${STATE_DIR}/git-fetch-failed-at" \
                "${STATE_DIR}/git-fetch-failures" \
                "${STATE_DIR}/git-fetch-alerted"
            GIT_FETCH_FAILURE_COUNT=0
            return 0
        else
            rc=$?
        fi

        log "git fetch не удался: попытка ${attempt}/${GIT_FETCH_ATTEMPTS}, код ${rc}"
        if ((attempt < GIT_FETCH_ATTEMPTS)); then
            sleep $((attempt * 3))
        fi
    done

    if [[ -r "${STATE_DIR}/git-fetch-failures" ]]; then
        previous_count="$(cat "${STATE_DIR}/git-fetch-failures")"
        [[ "$previous_count" =~ ^[0-9]+$ ]] || previous_count=0
    fi
    GIT_FETCH_FAILURE_COUNT=$((previous_count + 1))
    printf '%s\n' "$GIT_FETCH_FAILURE_COUNT" \
        > "${STATE_DIR}/git-fetch-failures"
    if [[ ! -e "${STATE_DIR}/git-fetch-failed-at" ]]; then
        date -Is > "${STATE_DIR}/git-fetch-failed-at"
    fi

    return "$rc"
}

select_last_known_good() {
    local last_good_file="${STATE_DIR}/last-successful-sha"
    local last_good_sha

    [[ -r "$last_good_file" ]] \
        || die "origin недоступен и нет сохранённого last-known-good SHA"
    last_good_sha="$(cat "$last_good_file")"
    [[ "$last_good_sha" =~ ^[0-9a-fA-F]{40,64}$ ]] \
        || die "last-known-good SHA имеет неверный формат"
    git cat-file -e "${last_good_sha}^{commit}" 2>/dev/null \
        || die "last-known-good commit отсутствует в локальном git-кэше"

    # Не выполняем скрытый rollback. Если checkout уже отличается от
    # последнего успешно применённого SHA, без Git нельзя доказать, какое
    # состояние желаемое — такой случай должен остановить реконсиляцию.
    [[ "$PREVIOUS_SHA" == "$last_good_sha" ]] \
        || die "origin недоступен, а HEAD не совпадает с last-known-good SHA"

    TARGET_SHA="$last_good_sha"
}

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
SELF_PATH="${REPO_DIR}/deploy/reconcile.sh"
SELF_HASH_BEFORE="$(sha256sum "$SELF_PATH" | cut -d' ' -f1)"
PREVIOUS_SHA="$(git rev-parse HEAD)"
TARGET_SHA="$PREVIOUS_SHA"

if [[ "$SELF_REEXECUTED" == "1" ]]; then
    # Родительский процесс уже успешно получил origin, выбрал TARGET_SHA и
    # сделал reset перед exec новой версии этого файла. Повторный fetch здесь
    # не нужен и создавал лишнее окно для сетевого сбоя посреди одной выкатки.
    log "self-reexec: используем уже выбранный SHA ${TARGET_SHA:0:8}"
else
    log "получаем origin/${BRANCH}"
    if fetch_branch; then
        TARGET_SHA="$(git rev-parse "origin/${BRANCH}")"
    else
        GIT_SYNC_DEGRADED=1
        select_last_known_good
        log "ВНИМАНИЕ: origin/${BRANCH} недоступен; применяем last-known-good ${TARGET_SHA:0:8} (сбойных циклов: ${GIT_FETCH_FAILURE_COUNT})"
    fi
fi

# reset --hard, а не merge: локальные правки на сервере — это дрейф,
# и он должен затираться, а не сохраняться.
git reset --quiet --hard "$TARGET_SHA"
git clean -qfd -e '.env' -e 'node_modules'

if [[ "$PREVIOUS_SHA" != "$TARGET_SHA" ]]; then
    log "коммит: ${PREVIOUS_SHA:0:8} -> ${TARGET_SHA:0:8}"
else
    log "коммит без изменений (${TARGET_SHA:0:8}), применяем состояние"
fi

# Текущий процесс продолжает исполнять ту версию shell-скрипта, с которой
# стартовал, даже если git reset уже заменил файл на диске. Это критично для
# миграций: старый reconcile может увидеть новый batch, но ещё не знать, как
# удалить устаревший ключ. Перезапускаемся новым файлом до применения state.
SELF_HASH_AFTER="$(sha256sum "$SELF_PATH" | cut -d' ' -f1)"
if [[ "$SELF_HASH_BEFORE" != "$SELF_HASH_AFTER" \
      && "$SELF_REEXECUTED" != "1" ]]; then
    log "reconcile.sh изменился, перезапускаемся новой версией"
    flock -u 9
    exec 9>&-
    export OPENCLAW_RECONCILE_REEXECUTED=1
    exec "$SELF_PATH"
fi

# --- Расшифровка секретов --------------------------------------------
# /run — tmpfs, содержимое не переживает перезагрузку и не попадает
# на диск. Секретам на диске делать нечего.
log "расшифровываем секреты"
PREVIOUS_UMASK="$(umask)"
umask 077
SOPS_AGE_KEY_FILE=/root/.config/sops/age/keys.txt \
    sops --decrypt --output-type dotenv secrets/openclaw.enc.yaml > "$ENV_FILE" \
    || die "sops не смог расшифровать secrets/openclaw.enc.yaml"
chmod 600 "$ENV_FILE"
# Ограниченная umask нужна только файлу с секретами. Если оставить 077,
# последующие каталоги создаются root:root/0700, и uid 1000 внутри
# контейнера не может пройти к локальным плагинам.
umask "$PREVIOUS_UMASK"

# Директива должна стоять непосредственно над `source`: в составной
# строке `set -a; source ...; set +a` она привязалась бы к `set -a`.
set -a
# shellcheck source=/dev/null
source "$ENV_FILE"
set +a

[[ -n "${OPENCLAW_IMAGE:-}" ]] || die "OPENCLAW_IMAGE не задан"
[[ "$OPENCLAW_IMAGE" == *"@sha256:"* ]] \
    || log "ВНИМАНИЕ: образ не запинен по digest, детерминизм не гарантирован"
[[ -n "${TELEGRAM_BOT_TOKEN:-}" ]] || die "TELEGRAM_BOT_TOKEN не задан"

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

    # Кладём В штатный корень памяти (<workspace>/memory), но в свой
    # подкаталог. Движок сканирует memory/**/*.md рекурсивно, поэтому
    # extraPaths не нужен.
    #
    # Подкаталог обязателен: в memory/ пишет сам агент (session-memory
    # hook, .dreams/), и rsync --delete по всему memory/ снёс бы это.
    # Так удаление ограничено нашей папкой.
    KNOWLEDGE_DST="${OPENCLAW_STATE_DIR}/workspace/memory/knowledge"
    mkdir -p "$KNOWLEDGE_DST"
    rsync -a --delete \
        "${REPO_DIR}/config/knowledge/" \
        "${KNOWLEDGE_DST}/"
    chown -R 1000:1000 "${OPENCLAW_STATE_DIR}/workspace/memory"
fi

# --- Файлы личности ---------------------------------------------------
# SOUL.md, IDENTITY.md, AGENTS.md кладутся в КОРЕНЬ workspace — там их
# ищет агент при старте сессии. Благодаря им бот одинаков для всех
# собеседников, хотя сессии у каждого свои.
#
# БЕЗ --delete, в отличие от базы знаний: рядом лежат MEMORY.md, USER.md,
# memory/ и agents/, которые пишет сам агент. Удаление снесло бы всё
# накопленное состояние.
if [[ -d "${REPO_DIR}/config/workspace" ]]; then
    log "синхронизируем файлы личности"
    rsync -a \
        "${REPO_DIR}/config/workspace/" \
        "${OPENCLAW_STATE_DIR}/workspace/"
    chown -R 1000:1000 "${OPENCLAW_STATE_DIR}/workspace"
fi

# --- Локальные плагины -----------------------------------------------
# Плагин живёт в git, а OpenClaw ищет внешние расширения в своём
# config-root. Поэтому переносим пакет целиком до запуска compose и
# отдельно помечаем изменение кода: config fingerprint его не видит,
# но без рестарта gateway продолжил бы исполнять старый модуль.
PLUGIN_CHANGED=0
PLUGIN_SRC="${REPO_DIR}/extensions"
PLUGIN_ROOT="${OPENCLAW_STATE_DIR}/config/extensions"

[[ -d "${PLUGIN_SRC}/glossary-ui" ]] || die "нет исходников плагина glossary-ui"
[[ -d "${PLUGIN_SRC}/tavily-provider" ]] || die "нет исходников плагина tavily-provider"
# install -d не только создаёт каталог, но и чинит владельца/режим уже
# существующего root:root/0700 после прежних запусков с umask 077.
install -d -o 1000 -g 1000 -m 0700 "$PLUGIN_ROOT"

# Корень исходников имеет режим 0755, а runtime-каталог намеренно 0700.
# Игнорируем только эту ожидаемую строку itemize (`.d...p... ./`). Права
# вложенных файлов по-прежнему входят в drift detection: глобальный
# --no-perms скрыл бы полезные изменения executable/readable bits.
if PLUGIN_DIFF_RAW="$(rsync -ain --no-owner --no-group --delete \
    "${PLUGIN_SRC}/" "${PLUGIN_ROOT}/")"; then
    :
else
    die "не удалось сравнить локальные плагины"
fi
PLUGIN_DIFF="$(printf '%s\n' "$PLUGIN_DIFF_RAW" \
    | sed '\|^[.]d[.][.][.]p[.]* [.]/$|d')"
if [[ -n "$PLUGIN_DIFF" ]]; then
    PLUGIN_CHANGED=1
    log "локальные плагины изменились"
else
    log "локальные плагины без изменений"
fi

rsync -a --no-owner --no-group --delete \
    "${PLUGIN_SRC}/" "${PLUGIN_ROOT}/"
chown -R 1000:1000 "$PLUGIN_ROOT"
# rsync -a сохраняет режим исходного каталога, но родитель обязан
# оставаться доступным только владельцу node и при этом проходимым для него.
chown 1000:1000 "$PLUGIN_ROOT"
chmod 0700 "$PLUGIN_ROOT"

# --- Применение стека -------------------------------------------------
log "docker compose up -d"
if [[ "$OPENCLAW_IMAGE" == *@sha256:* ]] \
    && docker image inspect "$OPENCLAW_IMAGE" > /dev/null 2>&1; then
    log "запиненный образ уже есть локально, pull пропускаем"
else
    "${COMPOSE[@]}" pull --quiet gateway \
        || log "pull не удался, compose попробует использовать локальный образ"
fi
"${COMPOSE[@]}" up -d --remove-orphans

# --- Декларативный конфиг агентов -------------------------------------
# Часть поведения гейтвей пишет в openclaw.json сам, поэтому файл
# целиком не перезаписываем — применяем только свои ключи батчем.
OPENCLAW_JSON="${OPENCLAW_STATE_DIR}/config/openclaw.json"

# Хеш конфига БЕЗ служебных полей. `config set` переписывает
# meta.lastTouchedAt при каждом применении, даже если ни одно значение
# не изменилось, и CLI на это отвечает "Restart the gateway to apply.".
# Ориентироваться на текст вывода нельзя: получался рестарт каждые
# 5 минут, обрывавший диалоги посреди ответа.
config_fingerprint() {
    [[ -f "$OPENCLAW_JSON" ]] || { echo "нет-файла"; return; }
    jq -S 'del(.meta)' "$OPENCLAW_JSON" 2>/dev/null | sha256sum | cut -d' ' -f1
}

CONFIG_CHANGED=0
if [[ -f "${REPO_DIR}/config/openclaw.batch.json" \
      || -f "${REPO_DIR}/config/openclaw.unset.txt" ]]; then
    log "применяем конфиг агентов"

    FINGERPRINT_BEFORE="$(config_fingerprint)"

    # config set применяет новые значения, но не удаляет ключи, исчезнувшие
    # из batch. Явный список unsets закрывает эту дыру в декларативности.
    # Отсутствующий путь — нормальное идемпотентное состояние.
    if [[ -f "${REPO_DIR}/config/openclaw.unset.txt" ]]; then
        while IFS= read -r raw_path || [[ -n "$raw_path" ]]; do
            config_path="${raw_path%%#*}"
            config_path="${config_path#"${config_path%%[![:space:]]*}"}"
            config_path="${config_path%"${config_path##*[![:space:]]}"}"
            [[ -n "$config_path" ]] || continue

            if CONFIG_OUTPUT="$(
                "${COMPOSE[@]}" run --rm -T cli config unset "$config_path" 2>&1
            )"; then
                printf '%s\n' "$CONFIG_OUTPUT"
            elif grep -qi 'Config path not found' <<< "$CONFIG_OUTPUT"; then
                log "ключ уже отсутствует: ${config_path}"
            else
                printf '%s\n' "$CONFIG_OUTPUT" >&2
                die "не удалось удалить ключ конфига ${config_path}"
            fi
        done < "${REPO_DIR}/config/openclaw.unset.txt"
    fi

    if [[ -f "${REPO_DIR}/config/openclaw.batch.json" ]]; then
        # Git хранит полное желаемое состояние. Разрешаем намеренно удалять
        # устаревшие элементы массивов, например предыдущую модель Cloud.ru.
        # Без --replace OpenClaw останавливает такую смену защитной проверкой.
        if CONFIG_OUTPUT="$(
            "${COMPOSE[@]}" run --rm -T cli config set --replace \
                --batch-json "$(cat "${REPO_DIR}/config/openclaw.batch.json")" 2>&1
        )"; then
            printf '%s\n' "$CONFIG_OUTPUT"
        else
            printf '%s\n' "$CONFIG_OUTPUT" >&2
            die "не удалось применить декларативный конфиг OpenClaw"
        fi
    fi

    FINGERPRINT_AFTER="$(config_fingerprint)"

    if [[ "$FINGERPRINT_BEFORE" != "$FINGERPRINT_AFTER" ]]; then
        CONFIG_CHANGED=1
        log "конфиг изменился"
    else
        log "конфиг без изменений"
    fi
fi

# Часть ключей применяется hot-reload'ом, но plugin registry и код
# плагинов требуют полного перезапуска. Не рестартуем вхолостую каждые
# пять минут: это обрывало пользовательские диалоги посреди ответа.
if [[ "$CONFIG_CHANGED" -eq 1 || "$PLUGIN_CHANGED" -eq 1 ]]; then
    log "желаемое состояние изменилось, перезапускаем gateway"
    "${COMPOSE[@]}" restart gateway
else
    log "конфиг и плагины без изменений, gateway не трогаем"
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
    # Автооткат намеренно не делаем: на стейтфул-сервисе с миграциями
    # он способен сделать хуже, чем сломанный деплой. Будим человека.
    die "гейтвей не поднялся за $((HEALTH_RETRIES * HEALTH_DELAY))с на ${TARGET_SHA:0:8}"
fi

# HTTP-ready не означает, что пользовательский канал поднялся: gateway
# успешно стартует и без Telegram. Проверяем bundled-плагин и живой getMe
# probe отдельно, иначе деплой зелёный, а бот молчит без единой ошибки.
log "проверяем Telegram-канал"
if TELEGRAM_CHECK_OUTPUT="$(
    env REPO_DIR="$REPO_DIR" ENV_FILE="$ENV_FILE" \
        "${REPO_DIR}/deploy/check-telegram.sh" 2>&1
)"; then
    printf '%s\n' "$TELEGRAM_CHECK_OUTPUT"
else
    printf '%s\n' "$TELEGRAM_CHECK_OUTPUT" >&2
    die "Telegram-плагин или канал не прошёл live probe"
fi

# Проверяем регистрацию provider без настоящего поискового запроса:
# reconcile выполняется каждые пять минут и не должен расходовать квоту.
SEARCH_PROVIDER="$(
    jq -er '
      [.[] | select(.path == "tools.web.search.provider") | .value]
      | if length == 1 and (.[0] | type) == "string"
        then .[0]
        else error("tools.web.search.provider must be declared exactly once")
        end
    ' "${REPO_DIR}/config/openclaw.batch.json"
)" || die "не удалось определить выбранный web-search provider"

case "$SEARCH_PROVIDER" in
    tavily)
        log "проверяем регистрацию Tavily"
        if SEARCH_INSPECT="$(
            "${COMPOSE[@]}" run --rm -T cli plugins inspect tavily 2>&1
        )"; then
            printf '%s\n' "$SEARCH_INSPECT"
        else
            printf '%s\n' "$SEARCH_INSPECT" >&2
            die "не удалось проверить плагин Tavily"
        fi

        grep -q 'Status:[[:space:]]*loaded' <<< "$SEARCH_INSPECT" \
            || die "Tavily выбран, но его плагин не загружен"
        grep -Eq 'web-search:[[:space:]]*tavily' <<< "$SEARCH_INSPECT" \
            || die "Tavily не зарегистрировал capability web-search"

        # Переменные раскрываются внутри CLI-контейнера.
        # shellcheck disable=SC2016
        if ! "${COMPOSE[@]}" run --rm -T \
            --entrypoint /bin/sh cli -lc '
              test -n "${TAVILY_API_KEY:-}" || {
                echo "TAVILY_API_KEY не задан" >&2
                exit 1
              }
              test -n "${TAVILY_PROXY_URL:-}" || {
                echo "TAVILY_PROXY_URL не задан" >&2
                exit 1
              }
            '; then
            die "Tavily не получил ключ или proxy URL"
        fi
        ;;
    duckduckgo)
        log "проверяем регистрацию DuckDuckGo"
        if SEARCH_INSPECT="$(
            "${COMPOSE[@]}" run --rm -T cli plugins inspect duckduckgo 2>&1
        )"; then
            printf '%s\n' "$SEARCH_INSPECT"
        else
            printf '%s\n' "$SEARCH_INSPECT" >&2
            die "не удалось проверить плагин DuckDuckGo"
        fi
        grep -q 'Status:[[:space:]]*loaded' <<< "$SEARCH_INSPECT" \
            || die "DuckDuckGo выбран, но его плагин не загружен"
        ;;
    *)
        die "неподдерживаемый web-search provider: ${SEARCH_PROVIDER}"
        ;;
esac

# --- Успех --------------------------------------------------------------
echo "$TARGET_SHA" > "${STATE_DIR}/last-successful-sha"
date -Is > "${STATE_DIR}/last-successful-at"
rm -f \
    "${STATE_DIR}/failed-sha" \
    "${STATE_DIR}/failed-at" \
    "${STATE_DIR}/failure-kind"

# Единичный сетевой сбой — деградация, а не поломка production. После
# нескольких полностью проваленных fetch-циклов отправляем один отдельный
# алерт. alert.sh создаст marker только после успешной отправки, поэтому
# потерянное уведомление будет повторено на следующем цикле.
if [[ "$GIT_SYNC_DEGRADED" -eq 1 \
      && "$GIT_FETCH_FAILURE_COUNT" -ge "$GIT_FETCH_ALERT_AFTER" \
      && ! -e "${STATE_DIR}/git-fetch-alerted" ]]; then
    FAILURE_KIND="git-sync"
    die "origin/${BRANCH} недоступен ${GIT_FETCH_FAILURE_COUNT} циклов подряд; production подтверждён на ${TARGET_SHA:0:8}"
fi

if [[ "$GIT_SYNC_DEGRADED" -eq 1 ]]; then
    log "реконсиляция завершена на cached SHA ${TARGET_SHA:0:8}; Git source degraded"
else
    log "реконсиляция завершена на ${TARGET_SHA:0:8}"
fi
