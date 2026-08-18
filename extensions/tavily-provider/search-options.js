const TOPICS = new Set(["general", "news", "finance"]);
const SEARCH_DEPTHS = new Set(["basic", "advanced"]);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function normalizeChoice(value, allowed, label) {
  if (value === undefined) {
    return undefined;
  }
  const normalized = String(value).trim().toLowerCase();
  if (!allowed.has(normalized)) {
    throw new Error(`${label} is not supported.`);
  }
  return normalized;
}

function normalizeDate(value, label) {
  if (value === undefined) {
    return undefined;
  }
  const normalized = String(value).trim();
  if (!ISO_DATE.test(normalized)) {
    throw new Error(`${label} must use YYYY-MM-DD.`);
  }
  const parsed = new Date(`${normalized}T00:00:00Z`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== normalized
  ) {
    throw new Error(`${label} must be a real calendar date.`);
  }
  return normalized;
}

export function buildTavilySearchRequest({
  query,
  maxResults,
  topic,
  searchDepth,
  startDate,
  endDate,
}) {
  const count = Number.isFinite(maxResults)
    ? Math.max(1, Math.min(20, Math.floor(maxResults)))
    : 5;
  const normalizedTopic = normalizeChoice(topic, TOPICS, "topic");
  const normalizedDepth = normalizeChoice(
    searchDepth,
    SEARCH_DEPTHS,
    "searchDepth",
  );
  const normalizedStart = normalizeDate(startDate, "startDate");
  const normalizedEnd = normalizeDate(endDate, "endDate");

  if (
    normalizedStart !== undefined &&
    normalizedEnd !== undefined &&
    normalizedStart > normalizedEnd
  ) {
    throw new Error("startDate must not be later than endDate.");
  }

  return {
    query,
    max_results: count,
    ...(normalizedTopic ? { topic: normalizedTopic } : {}),
    ...(normalizedDepth ? { search_depth: normalizedDepth } : {}),
    ...(normalizedStart ? { start_date: normalizedStart } : {}),
    ...(normalizedEnd ? { end_date: normalizedEnd } : {}),
  };
}
