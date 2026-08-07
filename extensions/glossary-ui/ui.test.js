import assert from "node:assert/strict";
import test from "node:test";

import { commandDefinitions, registerCommands } from "./commands.js";
import {
  UI_CONFIG,
  renderExplain,
  renderKnowledge,
  renderMenu,
  renderSources,
} from "./ui.js";

function buttonsOf(reply) {
  return reply.presentation.blocks.flatMap((block) => block.buttons ?? []);
}

function assertValidReply(reply) {
  assert.equal(typeof reply.text, "string");
  assert.ok(reply.text.length > 0);
  assert.equal(reply.presentation.tone, "info");
  assert.ok(reply.presentation.blocks.length > 0);

  for (const block of reply.presentation.blocks) {
    assert.equal(block.type, "buttons");
    assert.ok(block.buttons.length >= 1);
    assert.ok(block.buttons.length <= 2, "UI must stay readable: at most two buttons per row");

    for (const button of block.buttons) {
      assert.ok(button.label.length > 0 && button.label.length <= 64);
      assert.ok(button.action);

      if (button.action.type === "command") {
        assert.match(button.action.command, /^\/[a-z][a-z0-9_-]*(?:\s+[a-z0-9_-]+)?$/i);
      } else if (button.action.type === "url") {
        const url = new URL(button.action.url);
        assert.equal(url.protocol, "https:");
      } else {
        assert.fail(`Unexpected button action: ${button.action.type}`);
      }
    }
  }
}

test("every screen is a compact Telegram presentation", () => {
  const replies = [renderMenu(), renderExplain(), renderKnowledge(), renderSources()];

  for (const category of UI_CONFIG.categories) {
    replies.push(renderKnowledge(category.id));
  }

  for (const reply of replies) {
    assertValidReply(reply);
  }
});

test("term buttons are safe Telegram deep links", () => {
  for (const category of UI_CONFIG.categories) {
    for (const button of buttonsOf(renderKnowledge(category.id))) {
      if (button.action.type !== "url") {
        continue;
      }

      const url = new URL(button.action.url);
      assert.equal(url.hostname, "t.me");
      assert.equal(url.pathname, `/${UI_CONFIG.botUsername}`);
      assert.match(url.searchParams.get("start"), /^term_[A-Za-z0-9_-]+$/);
    }
  }
});

test("category screens always provide a way back", () => {
  for (const category of UI_CONFIG.categories) {
    const commands = buttonsOf(renderKnowledge(category.id))
      .filter((button) => button.action.type === "command")
      .map((button) => button.action.command);

    assert.ok(commands.includes("/knowledge"));
    assert.ok(commands.includes("/menu"));
  }
});

test("plugin command inventory matches ui-config", () => {
  assert.deepEqual(
    commandDefinitions.map((definition) => definition.name),
    UI_CONFIG.commands,
  );

  const start = commandDefinitions.find((definition) => definition.name === "start");
  assert.equal(start.acceptsArgs, false);
  assert.ok(commandDefinitions.every((definition) => definition.requireAuth === true));
});

test("command registration is deterministic", () => {
  const registered = [];
  registerCommands({ registerCommand: (definition) => registered.push(definition.name) });
  assert.deepEqual(registered, UI_CONFIG.commands);
});

test("unknown knowledge section safely returns the catalog", () => {
  assert.deepEqual(renderKnowledge("not-a-section"), renderKnowledge());
});
