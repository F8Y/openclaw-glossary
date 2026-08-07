import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { registerCommands } from "./commands.js";

export default definePluginEntry({
  id: "glossary-ui",
  name: "Glossaryck Telegram UI",
  description: "Deterministic Telegram menu and knowledge catalog",
  register(api) {
    registerCommands(api);
  },
});
