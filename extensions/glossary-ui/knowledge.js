import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const KNOWLEDGE_FILES = Object.freeze([
  "ai-glossary.md",
  "finance-glossary.md",
  "models.md",
]);

// Telegram payloads are deliberately short and ASCII-only. Most of them match
// the Markdown heading after normalization; these aliases bridge the few
// Russian headings whose payload is an English technical name.
const PAYLOAD_ALIASES = Object.freeze({
  context: "Контекстное окно",
  embedding: "Эмбеддинг",
  hallucination: "Галлюцинация",
  inference: "Инференс",
  token: "Токен",
});

function normalize(value) {
  return String(value)
    .normalize("NFKC")
    .toLocaleLowerCase("ru-RU")
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function candidateDirectories() {
  return [
    process.env.GLOSSARY_KNOWLEDGE_DIR,
    "/home/node/.openclaw/workspace/memory/knowledge",
    fileURLToPath(new URL("../../config/knowledge/", import.meta.url)),
  ].filter(Boolean);
}

let cachedDirectory;

function resolveKnowledgeDirectory() {
  if (cachedDirectory) {
    return cachedDirectory;
  }

  cachedDirectory = candidateDirectories().find((directory) =>
    KNOWLEDGE_FILES.every((file) => existsSync(join(directory, file))),
  );
  return cachedDirectory;
}

function parseArticles(markdown, sourceFile) {
  return markdown.split(/^---\s*$/m).flatMap((section) => {
    const match = section.match(/(?:^|\n)##\s+([^\n]+)\n([\s\S]*)$/);
    if (!match) {
      return [];
    }

    const heading = match[1].trim();
    const body = match[2].trim();
    const title = heading.split(/\s+—\s+/, 1)[0].trim();

    return [{ heading, title, body, sourceFile }];
  });
}

function articleKeys(article) {
  const keys = new Set([normalize(article.title)]);

  // Composite headings such as "CAC и LTV" should be addressable by either
  // acronym. The normalized full title also covers punctuation such as P/E.
  for (const token of article.title.match(/[\p{L}\p{N}]+/gu) ?? []) {
    if (!/^(и|and)$/iu.test(token)) {
      keys.add(normalize(token));
    }
  }

  return keys;
}

let cachedSignature = "";
let cachedArticles = new Map();

export function loadKnowledgeArticles() {
  const directory = resolveKnowledgeDirectory();
  if (!directory) {
    return new Map();
  }

  let signature;
  try {
    signature = KNOWLEDGE_FILES.map((file) => {
      const stat = statSync(join(directory, file));
      return `${file}:${stat.size}:${stat.mtimeMs}`;
    }).join("|");
  } catch {
    cachedDirectory = undefined;
    cachedSignature = "";
    cachedArticles = new Map();
    return cachedArticles;
  }

  if (signature === cachedSignature) {
    return cachedArticles;
  }

  const articles = new Map();
  try {
    for (const sourceFile of KNOWLEDGE_FILES) {
      const markdown = readFileSync(join(directory, sourceFile), "utf8");
      for (const article of parseArticles(markdown, sourceFile)) {
        for (const key of articleKeys(article)) {
          articles.set(key, article);
        }
      }
    }
  } catch {
    cachedDirectory = undefined;
    return new Map();
  }

  cachedSignature = signature;
  cachedArticles = articles;
  return articles;
}

export function getKnowledgeArticle(payload) {
  const alias = PAYLOAD_ALIASES[String(payload).toLocaleLowerCase("en-US")];
  const key = normalize(alias ?? payload);
  return loadKnowledgeArticles().get(key);
}

export function formatKnowledgeArticle(article) {
  if (!article) {
    return undefined;
  }

  const body = article.body
    .replace(/^ {4}(.+)$/gm, "📐 $1")
    .replace(
      /^Источник:\s*(?!(?:https?:\/\/))(\S+)$/gm,
      "🔗 Источник: https://$1",
    )
    .replace(/^Источник:\s*/gm, "🔗 Источник: ")
    .trim();

  return [
    `📗 ${article.heading}`,
    "",
    body,
    "",
    "📚 База знаний Glossaryck",
  ].join("\n");
}
