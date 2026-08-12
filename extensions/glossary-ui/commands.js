import { renderScreen, renderTermCard } from "./ui.js";

const TELEGRAM_COMMAND = /^\/([a-z][a-z0-9_]*)(?:@[a-z0-9_]+)?(?:\s+([\s\S]*))?$/i;
const SAFE_TERM = /^[A-Za-z0-9_-]+$/;

function renderStart(args = "") {
  const payload = String(args).trim();
  if (!payload) {
    return renderScreen("start");
  }

  if (payload.startsWith("term_")) {
    const term = payload.slice("term_".length);
    return SAFE_TERM.test(term) ? renderTermCard(term) : undefined;
  }

  const screen = {
    cmd_menu: "menu",
    cmd_knowledge: "knowledge",
    cmd_sources: "sources",
  }[payload];
  return screen ? renderScreen(screen) : undefined;
}

export const commandDefinitions = Object.freeze([
  {
    name: "menu",
    description: "Главное меню Glossaryck",
    acceptsArgs: false,
    requireAuth: true,
    handler: () => renderScreen("menu"),
  },
  {
    name: "about",
    description: "Что умеет Glossaryck",
    acceptsArgs: false,
    requireAuth: true,
    handler: () => renderScreen("about"),
  },
  {
    name: "explain",
    description: "Объяснить термин",
    acceptsArgs: false,
    requireAuth: true,
    handler: () => renderScreen("explain"),
  },
  {
    name: "knowledge",
    description: "Каталог терминов и моделей",
    acceptsArgs: true,
    requireAuth: true,
    handler: (args) => renderScreen("knowledge", args),
  },
  {
    name: "sources",
    description: "Проверенные источники",
    acceptsArgs: false,
    requireAuth: true,
    handler: () => renderScreen("sources"),
  },
  {
    name: "start",
    description: "Открыть Glossaryck",
    acceptsArgs: true,
    requireAuth: true,
    handler: renderStart,
  },
]);

export function resolveUiCommandInput(input) {
  const match = String(input ?? "").trim().match(TELEGRAM_COMMAND);
  if (!match) {
    return undefined;
  }

  const command = commandDefinitions.find(
    (definition) => definition.name === match[1].toLowerCase(),
  );
  return command?.handler(match[2]?.trim() ?? "");
}
