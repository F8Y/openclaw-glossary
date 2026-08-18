import assert from "node:assert/strict";
import test from "node:test";

import { buildTavilySearchRequest } from "./search-options.js";

test("maps digest search options to the Tavily request exactly", () => {
  assert.deepEqual(
    buildTavilySearchRequest({
      query: "AI model releases",
      maxResults: 8,
      topic: "news",
      searchDepth: "advanced",
      startDate: "2026-08-11",
      endDate: "2026-08-18",
    }),
    {
      query: "AI model releases",
      max_results: 8,
      topic: "news",
      search_depth: "advanced",
      start_date: "2026-08-11",
      end_date: "2026-08-18",
    },
  );
});

test("optional filters stay absent for ordinary glossary searches", () => {
  assert.deepEqual(
    buildTavilySearchRequest({
      query: "data-driven definition",
      maxResults: undefined,
    }),
    {
      query: "data-driven definition",
      max_results: 5,
    },
  );
});

test("result count is kept inside the Tavily contract", () => {
  assert.equal(
    buildTavilySearchRequest({ query: "AI", maxResults: 100 }).max_results,
    20,
  );
  assert.equal(
    buildTavilySearchRequest({ query: "AI", maxResults: 0 }).max_results,
    1,
  );
});

test("rejects inverted or invalid date windows", () => {
  assert.throws(
    () =>
      buildTavilySearchRequest({
        query: "AI",
        startDate: "2026-08-18",
        endDate: "2026-08-11",
      }),
    /startDate/,
  );
  assert.throws(
    () =>
      buildTavilySearchRequest({
        query: "AI",
        startDate: "2026-02-30",
      }),
    /real calendar date/,
  );
});

test("rejects unknown Tavily modes", () => {
  assert.throws(
    () => buildTavilySearchRequest({ query: "AI", topic: "models" }),
    /topic/,
  );
  assert.throws(
    () => buildTavilySearchRequest({ query: "AI", searchDepth: "deep" }),
    /searchDepth/,
  );
});
