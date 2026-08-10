import { readFileSync } from "node:fs";

import { formatKnowledgeArticle, getKnowledgeArticle } from "./knowledge.js";

const rawConfig = readFileSync(new URL("./ui-config.json", import.meta.url), "utf8");

export const UI_CONFIG = Object.freeze(JSON.parse(rawConfig));
export const UI_CALLBACK_NAMESPACE = "glossary";

const CATEGORY_BY_ID = new Map(
  UI_CONFIG.categories.map((category) => [category.id, category]),
);

function callbackButton(text, payload) {
  const callbackData = `${UI_CALLBACK_NAMESPACE}:${payload}`;
  if (Buffer.byteLength(callbackData, "utf8") > 64) {
    throw new Error(`Telegram callback is longer than 64 bytes: ${callbackData}`);
  }
  return { text, callback_data: callbackData };
}

function urlButton(text, url) {
  return { text, url };
}

function rows(buttons, size = 2) {
  const result = [];
  for (let index = 0; index < buttons.length; index += size) {
    result.push(buttons.slice(index, index + size));
  }
  return result;
}

function reply(text, buttons) {
  // Telegram is the only channel for this bot. Provider-native buttons avoid
  // OpenClaw's shared presentation fallback, which otherwise repeats every
  // button and its slash command inside the message body.
  return {
    text,
    channelData: {
      telegram: { buttons: rows(buttons) },
    },
  };
}

function termButton(term, categoryId) {
  if (!/^[A-Za-z0-9_-]+$/.test(term.payload)) {
    throw new Error(`Unsafe Telegram term payload: ${term.payload}`);
  }
  return callbackButton(term.label, `term:${categoryId}:${term.payload}`);
}

const KNOWLEDGE_TERM_COUNT = new Set(
  UI_CONFIG.categories
    .filter((category) => category.id !== "popular")
    .flatMap((category) => category.terms.map((term) => term.payload)),
).size;

function homeButtons() {
  return [
    callbackButton("📗 Объяснить термин", "screen:explain"),
    callbackButton("📚 База знаний", "screen:knowledge"),
    callbackButton("📰 Новости об ИИ", "run:digest"),
    callbackButton("🔎 Источники", "screen:sources"),
  ];
}

function primaryCategoryId(payload) {
  return (
    UI_CONFIG.categories.find(
      (category) =>
        category.id !== "popular" &&
        category.terms.some((term) => term.payload === payload),
    )?.id ?? "popular"
  );
}

export function renderMenu() {
  return reply(
    [
      "📗 Glossaryck",
      "",
      "Понятный справочник по ИИ и финансам.",
      "",
      "Выберите действие или просто напишите термин — например ROE, RAG или EBITDA.",
    ].join("\n"),
    homeButtons(),
  );
}

export function renderExplain() {
  const examples = [
    { label: "RAG", payload: "RAG" },
    { label: "EBITDA", payload: "EBITDA" },
    { label: "ROE", payload: "ROE" },
    { label: "MCP", payload: "MCP" },
  ];

  return reply(
    [
      "📗 Объяснить термин",
      "",
      "Напишите слово или сокращение одним сообщением.",
      "Например: что такое EBITDA?",
      "",
      "Или выберите готовый пример 👇",
    ].join("\n"),
    [
      ...examples.map((term) => termButton(term, primaryCategoryId(term.payload))),
      callbackButton("🏠 Главное меню", "screen:menu"),
    ],
  );
}

export function renderKnowledge(categoryId = "") {
  const normalizedId = String(categoryId).trim().split(/\s+/, 1)[0].toLowerCase();
  const category = CATEGORY_BY_ID.get(normalizedId);

  if (!category) {
    return reply(
      [
        "📚 База знаний",
        "",
        `${KNOWLEDGE_TERM_COUNT} коротких карточек — без учебников и воды.`,
        "",
        "🔥 База для быстрого старта",
        "🤖 Как модели учатся, отвечают и ищут",
        "💰 Метрики бизнеса и стоимость капитала",
        "🧠 Кто делает популярные модели",
        "",
        "Выберите раздел 👇",
      ].join("\n"),
      [
        ...UI_CONFIG.categories.map((item) =>
          callbackButton(item.buttonLabel ?? item.label, `screen:knowledge:${item.id}`),
        ),
        callbackButton("🏠 Главное меню", "screen:menu"),
      ],
    );
  }

  return reply(
    [
      category.label,
      "",
      category.description,
      `${category.terms.length} карточек — выберите нужную 👇`,
    ].join("\n"),
    [
      ...category.terms.map((term) => termButton(term, category.id)),
      callbackButton("← Все разделы", "screen:knowledge"),
      callbackButton("🏠 Главное", "screen:menu"),
    ],
  );
}

export function renderTermCard(payload, categoryId = "") {
  const article = getKnowledgeArticle(payload);
  if (!article) {
    return undefined;
  }

  const backCategory = CATEGORY_BY_ID.has(categoryId)
    ? categoryId
    : primaryCategoryId(payload);

  return reply(formatKnowledgeArticle(article), [
    callbackButton("← К разделу", `screen:knowledge:${backCategory}`),
    callbackButton("🏠 Главное", "screen:menu"),
  ]);
}

export function renderSources() {
  return reply(
    [
      "🔎 Проверенные источники",
      "",
      "📗 Термины — локальный проверенный глоссарий",
      "🤖 ИИ — Google ML, Google Cloud и NIST",
      "💰 Финансы — Банк России, IFRS и BIS",
      "📰 Новости — официальные блоги и независимые измерения",
      "",
      "Нажмите, чтобы открыть первоисточник 👇",
    ].join("\n"),
    [
      ...UI_CONFIG.sources.map((source) => urlButton(source.label, source.url)),
      callbackButton("🏠 Главное меню", "screen:menu"),
    ],
  );
}

export function renderScreen(screen, args = "") {
  switch (screen) {
    case "knowledge":
      return renderKnowledge(args);
    case "sources":
      return renderSources();
    case "explain":
      return renderExplain();
    case "about":
    case "menu":
    case "start":
    default:
      return renderMenu();
  }
}

export function toInteractiveResponse(rendered) {
  return {
    text: rendered.text,
    buttons: rendered.channelData.telegram.buttons,
  };
}
