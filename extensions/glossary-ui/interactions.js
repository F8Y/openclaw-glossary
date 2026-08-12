import {
  UI_CALLBACK_NAMESPACE,
  renderScreen,
  renderTermCard,
  toInteractiveResponse,
} from "./ui.js";
import { formatKnowledgeArticle, getKnowledgeArticle } from "./knowledge.js";

const SAFE_TERM = /^[A-Za-z0-9_-]+$/;

export function splitScreenPayload(payload) {
  const route = payload.slice("screen:".length);
  const separator = route.indexOf(":");

  if (separator === -1) {
    return { screen: route || "menu", args: "" };
  }

  return {
    screen: route.slice(0, separator) || "menu",
    args: route.slice(separator + 1),
  };
}

function stripWrapper(value) {
  return value
    .trim()
    .replace(/^["'«„“]+|["'»“”]+$/gu, "")
    .replace(/[?!.]+$/u, "")
    .trim();
}

export function resolveKnownTermInput(input) {
  const text = String(input ?? "").trim();
  if (!text || text.startsWith("/") || text.length > 120) {
    return undefined;
  }

  const direct = getKnowledgeArticle(stripWrapper(text));
  if (direct) {
    return direct;
  }

  const prompted = text.match(
    /^(?:что\s+такое|что\s+значит|объясни(?:те)?|расшифруй(?:те)?)\s+(.+)$/iu,
  );
  return prompted ? getKnowledgeArticle(stripWrapper(prompted[1])) : undefined;
}

export const interactiveDefinition = Object.freeze({
  channel: "telegram",
  namespace: UI_CALLBACK_NAMESPACE,
  async handler(context) {
    if (!context.auth?.isAuthorizedSender) {
      return { handled: true };
    }

    const payload = String(context.callback?.payload ?? "");

    if (payload.startsWith("screen:")) {
      const { screen, args } = splitScreenPayload(payload);
      await context.respond.editMessage(
        toInteractiveResponse(renderScreen(screen, args)),
      );
      return { handled: true };
    }

    if (payload === "run:digest") {
      return { handled: true, submitText: "/digest" };
    }

    if (payload.startsWith("term:")) {
      const parts = payload.slice("term:".length).split(":");
      const term = parts.pop() ?? "";
      const category = parts.pop() ?? "";

      if (SAFE_TERM.test(term)) {
        const card = renderTermCard(term, category);
        if (card) {
          await context.respond.editMessage(toInteractiveResponse(card));
          return { handled: true };
        }

        // Unknown terms keep the old agent/RAG route. This is also a safe
        // fallback if the knowledge volume is temporarily unavailable.
        return { handled: true, submitText: `/start term_${term}` };
      }
    }

    await context.respond.reply({
      text: "Эта кнопка устарела. Откройте /menu и попробуйте ещё раз.",
    });
    return { handled: true };
  },
});

export function registerInteractions(api) {
  api.registerInteractiveHandler(interactiveDefinition);

  // Known terms bypass the model for both button clicks and ordinary text.
  // This keeps one renderer and one visual format regardless of entry point.
  api.registerHook(
    "before_dispatch",
    (event) => {
      if (event.channel !== "telegram" || event.isGroup) {
        return undefined;
      }

      const article = resolveKnownTermInput(event.body ?? event.content);
      return article
        ? { handled: true, text: formatKnowledgeArticle(article) }
        : undefined;
    },
    {
      name: "glossary-known-term-router",
      description: "Answer known Telegram glossary terms without an LLM round-trip",
    },
  );
}
