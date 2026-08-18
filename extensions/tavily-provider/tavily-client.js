import { createRequire } from "node:module";

import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import {
  DEFAULT_CACHE_TTL_MINUTES,
  normalizeCacheKey,
  postTrustedWebToolsJson,
  readCache,
  resolveCacheTtlMs,
  writeCache,
} from "openclaw/plugin-sdk/provider-web-search";
import { wrapWebContent } from "openclaw/plugin-sdk/security-runtime";

import { resolveTavilyProxyUrl } from "./proxy.js";
import { normalizeTavilyResults } from "./result.js";

const DEFAULT_BASE_URL = "https://api.tavily.com";
const SEARCH_TIMEOUT_MS = 30_000;
const SEARCH_CACHE = new Map();
const PROXY_AGENTS = new Map();

// Контейнер OpenClaw хранит host-зависимости в /app/node_modules.
// Загружаем undici относительно package.json самого приложения.
const requireFromOpenClaw = createRequire("/app/package.json");
const { ProxyAgent, fetch: undiciFetch } = requireFromOpenClaw("undici");

function pluginSearchConfig(config) {
  const value = config?.plugins?.entries?.tavily?.config?.webSearch;
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function apiKey(config) {
  const configured = pluginSearchConfig(config).apiKey;
  if (typeof configured === "string" && configured.trim()) {
    return configured.trim();
  }
  return String(process.env.TAVILY_API_KEY ?? "").trim();
}

function baseUrl(config) {
  const configured = pluginSearchConfig(config).baseUrl;
  return String(configured || process.env.TAVILY_BASE_URL || DEFAULT_BASE_URL).trim();
}

function searchEndpoint(config) {
  try {
    const url = new URL(baseUrl(config));
    url.pathname = `${url.pathname.replace(/\/$/, "")}/search`;
    return url.toString();
  } catch {
    return `${DEFAULT_BASE_URL}/search`;
  }
}

function proxyAgent(proxyUrl) {
  const cached = PROXY_AGENTS.get(proxyUrl);
  if (cached) {
    return cached;
  }

  const dispatcher = new ProxyAgent(proxyUrl);
  PROXY_AGENTS.set(proxyUrl, dispatcher);
  return dispatcher;
}

async function postTavilyViaProxy({ url, key, body, proxyUrl }) {
  let response;

  try {
    response = await undiciFetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        "X-Client-Source": "openclaw",
      },
      body: JSON.stringify(body),
      dispatcher: proxyAgent(proxyUrl),
      redirect: "error",
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
  } catch {
    // Не прикладываем low-level error: URL прокси может содержать пароль.
    throw new Error("Tavily Search failed through the configured proxy.");
  }

  return readProviderJsonResponse(response, "Tavily Search");
}

export async function runTavilySearch({ config, query, maxResults }) {
  const key = apiKey(config);
  if (!key) {
    throw new Error(
      "web_search (tavily) needs TAVILY_API_KEY in the Gateway environment.",
    );
  }
  if (!query) {
    throw new Error("web_search (tavily) needs a non-empty query.");
  }

  const count = Number.isFinite(maxResults)
    ? Math.max(1, Math.min(20, Math.floor(maxResults)))
    : 5;
  const proxyUrl = resolveTavilyProxyUrl(config);
  const cacheKey = normalizeCacheKey(
    JSON.stringify({
      provider: "tavily",
      query,
      count,
      baseUrl: baseUrl(config),
      transport: proxyUrl ? "proxy" : "direct",
    }),
  );
  const cached = readCache(SEARCH_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const startedAt = Date.now();
  const body = { query, max_results: count };
  const endpoint = searchEndpoint(config);
  const payload = proxyUrl
    ? await postTavilyViaProxy({
        url: endpoint,
        key,
        body,
        proxyUrl,
      })
    : await postTrustedWebToolsJson(
        {
          url: endpoint,
          timeoutSeconds: SEARCH_TIMEOUT_MS / 1000,
          apiKey: key,
          body,
          errorLabel: "Tavily Search",
          extraHeaders: { "X-Client-Source": "openclaw" },
        },
        (response) => readProviderJsonResponse(response, "Tavily Search"),
      );

  const results = normalizeTavilyResults(payload.results, (value) =>
    wrapWebContent(value, "web_search"),
  );
  const result = {
    query,
    provider: "tavily",
    count: results.length,
    tookMs: Date.now() - startedAt,
    externalContent: {
      untrusted: true,
      source: "web_search",
      provider: "tavily",
      wrapped: true,
    },
    results,
  };

  writeCache(
    SEARCH_CACHE,
    cacheKey,
    result,
    resolveCacheTtlMs(undefined, DEFAULT_CACHE_TTL_MINUTES),
  );
  return result;
}
