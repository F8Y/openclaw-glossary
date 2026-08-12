#!/usr/bin/env bash
# Ручная диагностика DuckDuckGo: конфиг, регистрация provider и доступность
# HTML-выдачи с того же сетевого адреса, где работает gateway.
set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/openclaw-glossary}"
ENV_FILE="${ENV_FILE:-/run/openclaw/env}"
COMPOSE=(docker compose --env-file "$ENV_FILE" -f "${REPO_DIR}/docker-compose.yml")

provider="$(
    "${COMPOSE[@]}" run --rm -T cli \
        config get tools.web.search.provider --json | jq -r '.'
)"
if [[ "$provider" != "duckduckgo" ]]; then
    printf 'ОШИБКА: выбран provider=%s, ожидался duckduckgo\n' "$provider" >&2
    exit 1
fi

inspect="$("${COMPOSE[@]}" run --rm -T cli plugins inspect duckduckgo)"
grep -q 'Status:[[:space:]]*loaded' <<< "$inspect" || {
    printf '%s\n' "$inspect" >&2
    printf 'ОШИБКА: плагин DuckDuckGo не загружен\n' >&2
    exit 1
}

"${COMPOSE[@]}" exec -T gateway node --input-type=module <<'NODE'
const url = new URL("https://html.duckduckgo.com/html");
url.searchParams.set("q", "OpenClaw web search health check");
url.searchParams.set("kl", "us-en");
url.searchParams.set("kp", "-1");

const response = await fetch(url, {
  headers: {
    "User-Agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  },
  signal: AbortSignal.timeout(20_000),
});
const html = await response.text();

if (!response.ok) {
  console.error(`ОШИБКА: DuckDuckGo HTTP ${response.status}`);
  process.exit(1);
}
if (/g-recaptcha|are you a human|challenge-form|name="challenge"/i.test(html)) {
  console.error("ОШИБКА: DuckDuckGo вернул bot challenge для IP этой VM");
  process.exit(2);
}
if (!/\bresult__a\b/i.test(html)) {
  console.error("ОШИБКА: DuckDuckGo ответил, но формат выдачи не распознан");
  process.exit(3);
}

console.log("OK: provider=duckduckgo, plugin=loaded, HTML search=available");
NODE
