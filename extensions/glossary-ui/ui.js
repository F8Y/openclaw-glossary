import { readFileSync } from "node:fs";

const rawConfig = readFileSync(new URL("./ui-config.json", import.meta.url), "utf8");

export const UI_CONFIG = Object.freeze(JSON.parse(rawConfig));

const CATEGORY_BY_ID = new Map(
  UI_CONFIG.categories.map((category) => [category.id, category]),
);

function commandButton(label, command) {
  return {
    label,
    action: { type: "command", command },
  };
}

function urlButton(label, url) {
  return {
    label,
    action: { type: "url", url },
  };
}

function rows(buttons, size = 2) {
  const blocks = [];
  for (let index = 0; index < buttons.length; index += size) {
    blocks.push({
      type: "buttons",
      buttons: buttons.slice(index, index + size),
    });
  }
  return blocks;
}

function reply(text, buttons) {
  return {
    text,
    presentation: {
      tone: "info",
      blocks: rows(buttons),
    },
  };
}

function termCommand(payload) {
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) {
    throw new Error(`Unsafe Telegram start payload: ${payload}`);
  }

  return `/start term_${payload}`;
}

function termButton(term) {
  // OpenClaw's Telegram presentation schema reliably executes command
  // actions. URL actions are silently omitted by some runtime versions,
  // which previously left /knowledge with only the navigation buttons.
  return commandButton(term.label, termCommand(term.payload));
}

const KNOWLEDGE_TERM_COUNT = new Set(
  UI_CONFIG.categories
    .filter((category) => category.id !== "popular")
    .flatMap((category) => category.terms.map((term) => term.payload)),
).size;

function homeButtons() {
  return [
    commandButton("📗 Объяснить термин", "/explain"),
    commandButton("📚 База знаний", "/knowledge"),
    commandButton("📰 Новости об ИИ", "/digest"),
    commandButton("🔎 Источники", "/sources"),
  ];
}

export function renderMenu() {
  return reply(
    [
      "📗 **Glossaryck**",
      "",
      "Объясняю термины из **ИИ** и **финансов** простым языком.",
      "",
      "Выберите действие ниже или просто напишите термин — например `ROE`, `RAG` или `EBITDA`.",
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
      "📗 **Какой термин объяснить?**",
      "",
      "Напишите слово или сокращение одним сообщением.",
      "Например: `что такое EBITDA`.",
      "",
      "Или выберите готовый пример:",
    ].join("\n"),
    [
      ...examples.map(termButton),
      commandButton("🏠 Главное меню", "/menu"),
    ],
  );
}

export function renderKnowledge(categoryId = "") {
  const normalizedId = String(categoryId).trim().split(/\s+/, 1)[0].toLowerCase();
  const category = CATEGORY_BY_ID.get(normalizedId);

  if (!category) {
    return reply(
      [
        "📚 **База знаний**",
        "",
        `Здесь ${KNOWLEDGE_TERM_COUNT} коротких объяснений по ИИ, моделям и финансам.`,
        "",
        "Выберите раздел, затем нажмите на нужный термин.",
      ].join("\n"),
      [
        ...UI_CONFIG.categories.map((item) =>
          commandButton(item.buttonLabel ?? item.label, `/knowledge ${item.id}`),
        ),
        commandButton("🏠 Главное меню", "/menu"),
      ],
    );
  }

  return reply(
    [
      `**${category.label}**`,
      "",
      category.description,
      `В разделе: **${category.terms.length}** терминов.`,
      "",
      "Нажмите на термин — откроется короткое объяснение.",
    ].join("\n"),
    [
      ...category.terms.map(termButton),
      commandButton("← Все разделы", "/knowledge"),
      commandButton("🏠 Главное", "/menu"),
    ],
  );
}

export function renderSources() {
  return reply(
    [
      "🔎 **Проверенные источники**",
      "",
      "📗 **Термины** — наш проверенный глоссарий.",
      "🤖 **ИИ** — Google ML, Google Cloud и NIST.",
      "💰 **Финансы** — Банк России, IFRS и BIS.",
      "📰 **Новости** — официальные блоги разработчиков; сравнения отдельно сверяю по независимым измерениям.",
      "",
      "Для конкретного ответа всегда можно попросить ссылку на первоисточник.",
    ].join("\n"),
    [
      ...UI_CONFIG.sources.map((source) => urlButton(source.label, source.url)),
      commandButton("🏠 Главное меню", "/menu"),
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
