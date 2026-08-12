import assert from "node:assert/strict";
import test from "node:test";

import { normalizeTavilyResults } from "./result.js";

test("normalizes Tavily search results into OpenClaw web_search fields", () => {
  assert.deepEqual(
    normalizeTavilyResults(
      [
        {
          title: "Release",
          url: "https://example.com/release",
          content: "Fresh model",
          score: 0.9,
          published_date: "2026-08-12",
        },
      ],
      (value) => `[wrapped]${value}`,
    ),
    [
      {
        title: "[wrapped]Release",
        url: "https://example.com/release",
        snippet: "[wrapped]Fresh model",
        score: 0.9,
        published: "2026-08-12",
      },
    ],
  );
});

test("malformed result lists degrade to an empty result", () => {
  assert.deepEqual(normalizeTavilyResults(undefined), []);
});
