#!/usr/bin/env bash
# Один ручной live smoke-test после переключения primary-модели.
# Не запускается reconcile-таймером: запрос расходует токены Cloud.ru.
set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/openclaw-glossary}"
ENV_FILE="${ENV_FILE:-/run/openclaw/env}"
MODEL="Qwen/Qwen3-Coder-Next"
PRIMARY="cloudru/${MODEL}"

COMPOSE=(
    docker compose
    --env-file "$ENV_FILE"
    -f "${REPO_DIR}/docker-compose.yml"
)

configured_primary="$("${COMPOSE[@]}" run --rm -T cli \
    config get agents.defaults.model.primary --json | jq -r '.')"

if [[ "$configured_primary" != "$PRIMARY" ]]; then
    printf 'ОШИБКА: primary=%s, ожидался %s\n' \
        "$configured_primary" "$PRIMARY" >&2
    exit 1
fi

"${COMPOSE[@]}" exec -T gateway \
    env PRIMARY_SMOKE_MODEL="$MODEL" node --input-type=module <<'NODE'
const model = String(process.env.PRIMARY_SMOKE_MODEL ?? "").trim();
const apiKey = String(process.env.CLOUDRU_API_KEY ?? "").trim();
const expected = "PRIMARY_SMOKE_OK";

if (!apiKey) {
  console.error("ОШИБКА: CLOUDRU_API_KEY не задан внутри gateway");
  process.exit(1);
}

let response;
try {
  response = await fetch(
    "https://foundation-models.api.cloud.ru/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "user",
            content: `Ответь только строкой ${expected}`,
          },
        ],
        max_completion_tokens: 32,
        stream: false,
      }),
      signal: AbortSignal.timeout(30_000),
    },
  );
} catch {
  console.error("ОШИБКА: Cloud.ru не ответил за 30 секунд");
  process.exit(1);
}

let raw;
try {
  raw = await response.text();
} catch {
  console.error("ОШИБКА: не удалось прочитать ответ Cloud.ru");
  process.exit(1);
}

if (!response.ok) {
  let detail = "";
  try {
    const errorPayload = JSON.parse(raw);
    detail =
      errorPayload?.error?.message ??
      errorPayload?.message ??
      errorPayload?.detail ??
      "";
  } catch {
    // Ответ может быть не JSON.
  }

  const suffix = detail ? `: ${String(detail).slice(0, 500)}` : "";
  console.error(`ОШИБКА: Cloud.ru HTTP ${response.status}${suffix}`);
  process.exit(1);
}

let payload;
try {
  payload = JSON.parse(raw);
} catch {
  console.error("ОШИБКА: Cloud.ru вернул невалидный JSON");
  process.exit(1);
}

const content = payload?.choices?.[0]?.message?.content;
if (typeof content !== "string" || !content.includes(expected)) {
  console.error("ОШИБКА: primary-модель не прошла контрольную фразу");
  process.exit(1);
}

console.log(`OK: primary=cloudru/${model}, inference=${expected}`);
NODE
