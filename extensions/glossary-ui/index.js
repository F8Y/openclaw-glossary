import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

import { registerInteractions } from "./interactions.js";

export default definePluginEntry({
  id: "glossary-ui",
  name: "Glossaryck Telegram UI",
  description: "Deterministic Telegram menu and knowledge catalog",
  register(api) {
    registerInteractions(api);
  },
});
