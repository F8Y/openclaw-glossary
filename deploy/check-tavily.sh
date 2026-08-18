#!/usr/bin/env bash
# Ручная live-диагностика Tavily. Выполняет один настоящий запрос,
# поэтому не запускается пятиминутным reconcile.
set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/openclaw-glossary}"
ENV_FILE="${ENV_FILE:-/run/openclaw/env}"
COMPOSE=(
    docker compose
    --env-file "$ENV_FILE"
    -f "${REPO_DIR}/docker-compose.yml"
)

provider="$(
    "${COMPOSE[@]}" run --rm -T cli \
        config get tools.web.search.provider --json | jq -r '.'
)"
if [[ "$provider" != "tavily" ]]; then
    printf 'ОШИБКА: выбран provider=%s, ожидался tavily\n' "$provider" >&2
    exit 1
fi

inspect="$("${COMPOSE[@]}" run --rm -T cli plugins inspect tavily)"
if ! grep -q 'Status:[[:space:]]*loaded' <<< "$inspect" \
   || ! grep -Eq 'web-search:[[:space:]]*tavily' <<< "$inspect"; then
    printf '%s\n' "$inspect" >&2
    echo "ОШИБКА: Tavily не зарегистрировал web-search" >&2
    exit 1
fi

"${COMPOSE[@]}" exec -T gateway node --input-type=module <<'NODE'
import { createRequire } from "node:module";

const apiKey = String(process.env.TAVILY_API_KEY ?? "").trim();
const proxyUrl = String(process.env.TAVILY_PROXY_URL ?? "").trim();

if (!apiKey) {
  console.error("ОШИБКА: TAVILY_API_KEY не задан внутри gateway");
  process.exit(1);
}
if (!proxyUrl) {
  console.error("ОШИБКА: TAVILY_PROXY_URL не задан внутри gateway");
  process.exit(1);
}

const requireFromApp = createRequire("/app/package.json");
const { ProxyAgent, fetch } = requireFromApp("undici");

let dispatcher;
try {
  dispatcher = new ProxyAgent(proxyUrl);
} catch {
  console.error("ОШИБКА: TAVILY_PROXY_URL имеет неверный формат");
  process.exit(1);
}

let response;
try {
  response = await fetch("https://api.tavily.com/search", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Client-Source": "openclaw-health-check",
    },
    body: JSON.stringify({
      query: "OpenClaw Tavily health check",
      search_depth: "basic",
      max_results: 1,
    }),
    dispatcher,
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
} catch {
  console.error("ОШИБКА: Tavily недоступен через настроенный прокси");
  await dispatcher.close();
  process.exit(1);
}

if (!response.ok) {
  console.error(`ОШИБКА: Tavily HTTP ${response.status}`);
  await dispatcher.close();
  process.exit(1);
}

let payload;
try {
  payload = await response.json();
} catch {
  console.error("ОШИБКА: Tavily вернул невалидный JSON");
  await dispatcher.close();
  process.exit(1);
}

await dispatcher.close();

if (!Array.isArray(payload.results) || payload.results.length < 1) {
  console.error("ОШИБКА: Tavily ответил без результатов");
  process.exit(1);
}

console.log("OK: provider=tavily, plugin=loaded, proxy=available, search=available");
NODE
