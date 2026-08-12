import assert from "node:assert/strict";
import test from "node:test";

import { commandDefinitions, resolveUiCommandInput } from "./commands.js";
import {
  interactiveDefinition,
  isTelegramReplyDispatch,
  registerInteractions,
  resolveKnownTermInput,
  resolveReplyDispatchInput,
  splitScreenPayload,
} from "./interactions.js";
import {
  UI_CALLBACK_NAMESPACE,
  UI_CONFIG,
  renderAbout,
  renderExplain,
  renderKnowledge,
  renderMenu,
  renderSources,
  renderTermCard,
} from "./ui.js";
import { getKnowledgeArticle } from "./knowledge.js";

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
  const replies = [
    renderMenu(),
    renderAbout(),
    renderExplain(),
    renderKnowledge(),
    renderSources(),
  ];

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
      category.terms.map(
        (term) => `${UI_CALLBACK_NAMESPACE}:term:${category.id}:${term.payload}`,
      ),
    );
  }
});

test("every configured term resolves to a local knowledge article", () => {
  for (const category of UI_CONFIG.categories) {
    for (const term of category.terms) {
      const article = getKnowledgeArticle(term.payload);
      assert.ok(article, `missing local article for ${term.payload}`);

      const card = renderTermCard(term.payload, category.id);
      assertValidReply(card);
      assert.match(card.text, /^📗 /);
      assert.match(card.text, /📚 База знаний Glossaryck$/);
      assert.doesNotMatch(card.text, /^🔗 Источник:/m);
      assert.doesNotMatch(card.text, /memory\/knowledge|\.md$/m);
    }
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
  assert.equal(start.acceptsArgs, true);
  assert.ok(commandDefinitions.every((definition) => definition.requireAuth === true));
});

test("interaction and static UI routing use their native SDK registrations", () => {
  const interactions = [];
  const typedHooks = [];
  registerInteractions({
    registerInteractiveHandler: (definition) => {
      interactions.push(definition);
    },
    on: (name, handler, options) => typedHooks.push({ name, handler, options }),
    registerHook: () => assert.fail("reply_dispatch must use the typed api.on surface"),
  });

  assert.equal(interactions.length, 1);
  assert.equal(interactions[0], interactiveDefinition);
  assert.equal(interactions[0].channel, "telegram");
  assert.equal(interactions[0].namespace, UI_CALLBACK_NAMESPACE);
  assert.equal(typeof interactions[0].handler, "function");
  assert.deepEqual(typedHooks.map((hook) => hook.name), ["reply_dispatch"]);
  assert.equal(typeof typedHooks[0].handler, "function");
  assert.equal(typedHooks[0].options, undefined);
});

test("static slash commands render without plugin command ownership", () => {
  assert.deepEqual(resolveUiCommandInput("/menu"), renderMenu());
  assert.deepEqual(resolveUiCommandInput("/knowledge finance"), renderKnowledge("finance"));
  assert.deepEqual(resolveUiCommandInput("/sources@glossary_ai_bot"), renderSources());
  assert.deepEqual(resolveUiCommandInput("/term"), renderExplain());
  assert.deepEqual(resolveUiCommandInput("/term ROE"), renderTermCard("ROE"));
  assert.deepEqual(resolveUiCommandInput("/start cmd_knowledge"), renderKnowledge());
  assert.deepEqual(resolveUiCommandInput("/start term_ROE"), renderTermCard("ROE"));
  assert.equal(resolveUiCommandInput("/digest"), undefined);
  assert.equal(resolveUiCommandInput("/start cmd_digest"), undefined);
  assert.equal(resolveUiCommandInput("/start term_DOES_NOT_EXIST"), undefined);
});

test("static Telegram commands short-circuit the model with native buttons", () => {
  const typedHooks = [];
  registerInteractions({
    registerInteractiveHandler: () => {},
    on: (name, handler, options) => typedHooks.push({ name, handler, options }),
  });

  const staticRouter = typedHooks.find((hook) => hook.name === "reply_dispatch");
  const sent = [];
  const processed = [];
  const idle = [];
  const runtime = {
    dispatcher: {
      sendFinalReply: (reply) => {
        sent.push(reply);
        return true;
      },
      getQueuedCounts: () => ({ tool: 0, block: 0, final: sent.length }),
    },
    recordProcessed: (...args) => processed.push(args),
    markIdle: (reason) => idle.push(reason),
  };
  const result = staticRouter.handler(
    {
      ctx: {
        Surface: "telegram",
        CommandBody: "/menu",
        BodyForAgent: 'Use the "about" skill for this request.',
      },
    },
    runtime,
  );

  assert.equal(result.handled, true);
  assert.equal(result.queuedFinal, true);
  assert.deepEqual(result.counts, { tool: 0, block: 0, final: 1 });
  assertValidReply(sent[0]);
  assert.deepEqual(processed, [["completed", { reason: "glossary_static_command" }]]);
  assert.deepEqual(idle, ["message_completed"]);
  assert.equal(
    staticRouter.handler(
      { ctx: { Surface: "webchat", CommandBody: "/menu" } },
      runtime,
    ),
    undefined,
  );
  assert.equal(
    staticRouter.handler(
      { ctx: { Surface: "telegram", CommandBody: "/digest" } },
      runtime,
    ),
    undefined,
  );
  assert.equal(sent.length, 1);
});

test("reply dispatch reads the clean command and identifies Telegram", () => {
  const event = {
    originatingChannel: "Telegram",
    ctx: {
      CommandBody: "/knowledge finance",
      BodyForAgent: 'Use the "knowledge" skill for this request.',
    },
  };

  assert.equal(isTelegramReplyDispatch(event), true);
  assert.equal(resolveReplyDispatchInput(event), "/knowledge finance");
  assert.equal(isTelegramReplyDispatch({ ctx: { Provider: "discord" } }), false);
  assert.equal(resolveReplyDispatchInput({ ctx: { RawBody: "ROE" } }), "ROE");
});

test("about is distinct from the home menu", () => {
  assert.notDeepEqual(renderAbout(), renderMenu());
  assert.match(renderAbout().text, /О Glossaryck/);
  assert.match(renderAbout().text, /инвестиционных рекомендаций/);
});

test("known text terms resolve through the deterministic renderer", () => {
  assert.equal(resolveKnownTermInput("ROE")?.title, "ROE");
  assert.equal(resolveKnownTermInput("что такое EBITDA?")?.title, "EBITDA");
  assert.equal(resolveKnownTermInput("Объясните контекстное окно")?.title, "Контекстное окно");
  assert.equal(resolveKnownTermInput("ROE или ROA — что лучше?"), undefined);
  assert.equal(resolveKnownTermInput("/digest"), undefined);
});

test("screen callback parser preserves the complete argument tail", () => {
  assert.deepEqual(splitScreenPayload("screen:knowledge:models:detail"), {
    screen: "knowledge",
    args: "models:detail",
  });
  assert.deepEqual(splitScreenPayload("screen:menu"), {
    screen: "menu",
    args: "",
  });
});

test("known Telegram terms are answered before model dispatch", () => {
  const typedHooks = [];
  registerInteractions({
    registerInteractiveHandler: () => {},
    on: (name, handler, options) => typedHooks.push({ name, handler, options }),
  });

  const handler = typedHooks.find(({ name }) => name === "reply_dispatch")?.handler;
  assert.equal(typeof handler, "function");

  const sent = [];
  const runtime = {
    dispatcher: {
      sendFinalReply: (reply) => {
        sent.push(reply);
        return true;
      },
      getQueuedCounts: () => ({ tool: 0, block: 0, final: sent.length }),
    },
    recordProcessed: () => {},
    markIdle: () => {},
  };

  const known = handler(
    { ctx: { Provider: "telegram", RawBody: "что такое ROE?" } },
    runtime,
  );
  assert.equal(known.handled, true);
  assert.equal(known.queuedFinal, true);
  assertValidReply(sent[0]);
  assert.match(sent[0].text, /^📗 ROE — Return on Equity/);
  assert.match(sent[0].text, /📐 ROE = Чистая прибыль \/ Собственный капитал/);

  assert.equal(
    handler({ ctx: { Provider: "telegram", RawBody: "новый термин" } }, runtime),
    undefined,
  );
  assert.equal(
    handler({ ctx: { Provider: "discord", RawBody: "ROE" } }, runtime),
    undefined,
  );
});

test("callbacks edit navigation and known cards in place", async () => {
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
  assert.deepEqual(await interactiveDefinition.handler(context), { handled: true });
  assert.equal(edits.length, 2);
  assert.match(edits[1].text, /^📗 RAG — Retrieval-Augmented Generation/);
  assert.doesNotMatch(edits[1].text, /memory\/knowledge|\.md$/m);

  context.callback.payload = "term:finance:ROE";
  assert.deepEqual(await interactiveDefinition.handler(context), { handled: true });
  assert.equal(edits.length, 3);
  assert.match(edits[2].text, /📐 ROE = Чистая прибыль \/ Собственный капитал/);

  context.callback.payload = "run:digest";
  assert.deepEqual(await interactiveDefinition.handler(context), {
    handled: true,
    submitText: "/digest",
  });
  assert.equal(replies.length, 0);
});

test("unknown terms safely fall back to the agent route", async () => {
  const context = {
    auth: { isAuthorizedSender: true },
    callback: { payload: "term:ai:NewTerm" },
    respond: {
      editMessage: async () => assert.fail("unknown term must not edit a card"),
      reply: async () => assert.fail("unknown term must use the agent route"),
    },
  };

  assert.deepEqual(await interactiveDefinition.handler(context), {
    handled: true,
    submitText: "/start term_NewTerm",
  });
});

test("unknown knowledge section safely returns the catalog", () => {
  assert.deepEqual(renderKnowledge("not-a-section"), renderKnowledge());
});
