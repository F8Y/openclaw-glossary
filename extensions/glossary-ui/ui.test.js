import assert from "node:assert/strict";
import test from "node:test";

import { commandDefinitions, registerCommands } from "./commands.js";
import { interactiveDefinition, registerInteractions } from "./interactions.js";
import {
  UI_CALLBACK_NAMESPACE,
  UI_CONFIG,
  renderExplain,
  renderKnowledge,
  renderMenu,
  renderSources,
} from "./ui.js";

function rowsOf(reply) {
  return reply.channelData.telegram.buttons;
}

function buttonsOf(reply) {
  return rowsOf(reply).flat();
}

function assertValidReply(reply) {
  assert.equal(typeof reply.text, "string");
  assert.ok(reply.text.length > 0);
  assert.equal(reply.presentation, undefined, "native Telegram UI must not create text fallback");

  for (const row of rowsOf(reply)) {
    assert.ok(row.length >= 1);
    assert.ok(row.length <= 2, "UI must stay readable: at most two buttons per row");

    for (const button of row) {
      assert.ok(button.text.length > 0 && button.text.length <= 64);
      assert.notEqual(Boolean(button.callback_data), Boolean(button.url));

      if (button.callback_data) {
        assert.ok(Buffer.byteLength(button.callback_data, "utf8") <= 64);
        assert.match(button.callback_data, new RegExp(`^${UI_CALLBACK_NAMESPACE}:`));
      } else {
        const url = new URL(button.url);
        assert.equal(url.protocol, "https:");
      }
    }
  }
}

test("every screen is a compact native Telegram keyboard", () => {
  const replies = [renderMenu(), renderExplain(), renderKnowledge(), renderSources()];

  for (const category of UI_CONFIG.categories) {
    replies.push(renderKnowledge(category.id));
  }

  for (const reply of replies) {
    assertValidReply(reply);
  }
});

test("term buttons submit safe term callbacks", () => {
  for (const category of UI_CONFIG.categories) {
    const buttons = buttonsOf(renderKnowledge(category.id));
    const termButtons = buttons.slice(0, category.terms.length);

    assert.deepEqual(
      termButtons.map((button) => button.callback_data),
      category.terms.map((term) => `${UI_CALLBACK_NAMESPACE}:term:${term.payload}`),
    );
  }
});

test("category screens always provide a way back", () => {
  for (const category of UI_CONFIG.categories) {
    const callbacks = buttonsOf(renderKnowledge(category.id)).map(
      (button) => button.callback_data,
    );

    assert.ok(callbacks.includes(`${UI_CALLBACK_NAMESPACE}:screen:knowledge`));
    assert.ok(callbacks.includes(`${UI_CALLBACK_NAMESPACE}:screen:menu`));
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

test("command and interaction registration is deterministic", () => {
  const commands = [];
  const interactions = [];
  registerCommands({ registerCommand: (definition) => commands.push(definition.name) });
  registerInteractions({
    registerInteractiveHandler: (definition) => interactions.push(definition),
  });

  assert.deepEqual(commands, UI_CONFIG.commands);
  assert.equal(interactions.length, 1);
  assert.equal(interactions[0], interactiveDefinition);
  assert.equal(interactions[0].channel, "telegram");
  assert.equal(interactions[0].namespace, UI_CALLBACK_NAMESPACE);
});

test("callbacks edit navigation in place and submit dynamic actions", async () => {
  const edits = [];
  const replies = [];
  const context = {
    auth: { isAuthorizedSender: true },
    callback: { payload: "screen:knowledge:popular" },
    respond: {
      editMessage: async (payload) => edits.push(payload),
      reply: async (payload) => replies.push(payload),
    },
  };

  assert.deepEqual(await interactiveDefinition.handler(context), { handled: true });
  assert.equal(edits.length, 1);
  assert.match(edits[0].text, /Популярные термины/);
  assert.ok(edits[0].buttons.length > 1);

  context.callback.payload = "term:RAG";
  assert.deepEqual(await interactiveDefinition.handler(context), {
    handled: true,
    submitText: "/start term_RAG",
  });

  context.callback.payload = "run:digest";
  assert.deepEqual(await interactiveDefinition.handler(context), {
    handled: true,
    submitText: "/digest",
  });
  assert.equal(replies.length, 0);
});

test("unknown knowledge section safely returns the catalog", () => {
  assert.deepEqual(renderKnowledge("not-a-section"), renderKnowledge());
});
