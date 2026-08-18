import assert from "node:assert/strict";
import test from "node:test";

import { resolveTavilyProxyUrl } from "./proxy.js";

function configWithProxy(proxyUrl) {
  return {
    plugins: {
      entries: {
        tavily: {
          config: {
            webSearch: { proxyUrl },
          },
        },
      },
    },
  };
}

test("uses TAVILY_PROXY_URL when plugin config is empty", () => {
  assert.equal(
    resolveTavilyProxyUrl({}, {
      TAVILY_PROXY_URL: "http://proxy.example:8080",
    }),
    "http://proxy.example:8080/",
  );
});

test("plugin config overrides the environment", () => {
  assert.equal(
    resolveTavilyProxyUrl(
      configWithProxy("socks5://proxy.example:1080"),
      { TAVILY_PROXY_URL: "http://ignored.example:8080" },
    ),
    "socks5://proxy.example:1080",
  );
});

test("blank proxy configuration keeps direct transport available", () => {
  assert.equal(
    resolveTavilyProxyUrl(configWithProxy("  "), {
      TAVILY_PROXY_URL: "  ",
    }),
    "",
  );
});

test("unsupported protocols do not leak credentials", () => {
  const secretUrl = "ftp://user:super-secret@proxy.example:21";
  assert.throws(
    () => resolveTavilyProxyUrl({}, { TAVILY_PROXY_URL: secretUrl }),
    (error) => {
      assert.match(error.message, /unsupported protocol/);
      assert.doesNotMatch(error.message, /super-secret/);
      assert.doesNotMatch(error.message, /proxy\.example/);
      return true;
    },
  );
});

test("malformed URLs do not echo their value", () => {
  assert.throws(
    () => resolveTavilyProxyUrl({}, { TAVILY_PROXY_URL: "not a proxy" }),
    (error) => {
      assert.equal(error.message, "Tavily proxy URL is invalid.");
      assert.doesNotMatch(error.message, /not a proxy/);
      return true;
    },
  );
});
