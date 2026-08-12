// Slim, dependency-free port of the official OpenClaw 2026.7.1 Tavily
// web-search provider. Dedicated tavily_search/tavily_extract tools are
// intentionally omitted: Glossaryck only needs the stable web_search contract.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { createTavilyWebSearchProvider } from "./provider.js";

export default definePluginEntry({
  id: "tavily",
  name: "Tavily Search Provider",
  description: "Tavily-backed web_search for Glossaryck",
  register(api) {
    api.registerWebSearchProvider(createTavilyWebSearchProvider());
  },
});
