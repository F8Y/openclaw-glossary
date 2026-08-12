export function normalizeTavilyResults(rawResults, wrap = (value) => value) {
  if (!Array.isArray(rawResults)) {
    return [];
  }

  return rawResults.map((result) => ({
    title: typeof result?.title === "string" ? wrap(result.title) : "",
    url: typeof result?.url === "string" ? result.url : "",
    snippet: typeof result?.content === "string" ? wrap(result.content) : "",
    score: typeof result?.score === "number" ? result.score : undefined,
    ...(typeof result?.published_date === "string"
      ? { published: result.published_date }
      : {}),
  }));
}
