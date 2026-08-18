import { readPositiveIntegerParam } from "openclaw/plugin-sdk/param-readers";
import { createWebSearchProviderContractFields } from "openclaw/plugin-sdk/provider-web-search-contract";

import { runTavilySearch } from "./tavily-client.js";

const CREDENTIAL_PATH = "plugins.entries.tavily.config.webSearch.apiKey";

function optionalStringParam(args, key) {
  const value = args?.[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${key} must be a string`);
  }
  const normalized = value.trim();
  return normalized || undefined;
}

function configuredMaxResults(config) {
  const value = config?.tools?.web?.search?.maxResults;
  if (!Number.isFinite(value)) {
    return undefined;
  }
  return Math.max(1, Math.min(20, Math.floor(value)));
}

function requestedMaxResults(args, config) {
  return (
    readPositiveIntegerParam(args, "count", {
      message: "count must be an integer from 1 to 20",
      max: 20,
    }) ?? configuredMaxResults(config)
  );
}

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
          topic: {
            type: "string",
            enum: ["general", "news", "finance"],
            description:
              "Search category. Use news for a date-bounded news digest.",
          },
          searchDepth: {
            type: "string",
            enum: ["basic", "advanced"],
            description:
              "Search depth. Use advanced when coverage matters more than latency.",
          },
          startDate: {
            type: "string",
            pattern: "^\\d{4}-\\d{2}-\\d{2}$",
            description:
              "Inclusive lower date boundary in YYYY-MM-DD format.",
          },
          endDate: {
            type: "string",
            pattern: "^\\d{4}-\\d{2}-\\d{2}$",
            description:
              "Inclusive upper date boundary in YYYY-MM-DD format.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      execute: async (args) =>
        runTavilySearch({
          config: context.config,
          query: typeof args.query === "string" ? args.query.trim() : "",
          maxResults: requestedMaxResults(args, context.config),
          topic: optionalStringParam(args, "topic"),
          searchDepth: optionalStringParam(args, "searchDepth"),
          startDate: optionalStringParam(args, "startDate"),
          endDate: optionalStringParam(args, "endDate"),
        }),
    }),
  };
}
