import { readPositiveIntegerParam } from "openclaw/plugin-sdk/param-readers";
import { createWebSearchProviderContractFields } from "openclaw/plugin-sdk/provider-web-search-contract";

import { runTavilySearch } from "./tavily-client.js";

const CREDENTIAL_PATH = "plugins.entries.tavily.config.webSearch.apiKey";

export function createTavilyWebSearchProvider() {
  return {
    id: "tavily",
    label: "Tavily Search",
    hint: "Structured search results for AI agents",
    onboardingScopes: ["text-inference"],
    credentialLabel: "Tavily API key",
    envVars: ["TAVILY_API_KEY"],
    placeholder: "tvly-...",
    signupUrl: "https://tavily.com/",
    docsUrl: "https://docs.openclaw.ai/tools/tavily",
    autoDetectOrder: 70,
    credentialPath: CREDENTIAL_PATH,
    ...createWebSearchProviderContractFields({
      credentialPath: CREDENTIAL_PATH,
      searchCredential: { type: "scoped", scopeId: "tavily" },
      configuredCredential: { pluginId: "tavily" },
      selectionPluginId: "tavily",
    }),
    createTool: (context) => ({
      description: "Search the web using Tavily and return titles, snippets and URLs.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query string." },
          count: {
            type: "integer",
            description: "Number of results to return (1-20).",
            minimum: 1,
            maximum: 20,
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      execute: async (args) =>
        runTavilySearch({
          config: context.config,
          query: typeof args.query === "string" ? args.query.trim() : "",
          maxResults: readPositiveIntegerParam(args, "count", {
            message: "count must be an integer from 1 to 20",
            max: 20,
          }),
        }),
    }),
  };
}
