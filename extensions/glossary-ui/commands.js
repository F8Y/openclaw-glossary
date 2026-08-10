import { renderScreen } from "./ui.js";

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
    handler: (context) => renderScreen("knowledge", context.args),
  },
  {
    name: "sources",
    description: "Проверенные источники",
    acceptsArgs: false,
    requireAuth: true,
    handler: () => renderScreen("sources"),
  },
  {
    // No-argument /start becomes instant. Term buttons send commands such
    // as /start term_ROE; those carry args, do not match this definition,
    // and continue through the existing agent/skill route.
    name: "start",
    description: "Открыть Glossaryck",
    acceptsArgs: false,
    requireAuth: true,
    handler: () => renderScreen("start"),
  },
]);

export function registerCommands(api) {
  for (const definition of commandDefinitions) {
    api.registerCommand(definition);
  }
}
