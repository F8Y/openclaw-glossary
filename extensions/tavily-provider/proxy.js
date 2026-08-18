const SUPPORTED_PROXY_PROTOCOLS = new Set([
  "http:",
  "https:",
  "socks:",
  "socks5:",
]);

function configuredProxyUrl(config) {
  const value = config?.plugins?.entries?.tavily?.config?.webSearch?.proxyUrl;
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Resolve the Tavily-only proxy without ever including its value in
 * diagnostics. The URL may contain credentials and must be treated as secret.
 */
export function resolveTavilyProxyUrl(config, env = process.env) {
  const configured = configuredProxyUrl(config);
  const raw = configured || String(env.TAVILY_PROXY_URL ?? "").trim();
  if (!raw) {
    return "";
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("Tavily proxy URL is invalid.");
  }

  if (!SUPPORTED_PROXY_PROTOCOLS.has(parsed.protocol)) {
    throw new Error("Tavily proxy URL uses an unsupported protocol.");
  }
  if (!parsed.hostname) {
    throw new Error("Tavily proxy URL must include a host.");
  }

  return parsed.toString();
}
