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

import { normalizeTavilyResults } from "./result.js";

const DEFAULT_BASE_URL = "https://api.tavily.com";
const SEARCH_CACHE = new Map();

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
  const cacheKey = normalizeCacheKey(
    JSON.stringify({ provider: "tavily", query, count, baseUrl: baseUrl(config) }),
  );
  const cached = readCache(SEARCH_CACHE, cacheKey);
  if (cached) {
    return { ...cached.value, cached: true };
  }

  const startedAt = Date.now();
  const payload = await postTrustedWebToolsJson(
    {
      url: searchEndpoint(config),
      timeoutSeconds: 30,
      apiKey: key,
      body: { query, max_results: count },
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
