import {
  UI_CALLBACK_NAMESPACE,
  renderScreen,
  renderTermCard,
  toInteractiveResponse,
} from "./ui.js";
import { resolveUiCommandInput } from "./commands.js";
import { getKnowledgeArticle } from "./knowledge.js";

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

function normalizeChannel(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function isTelegramReplyDispatch(event) {
  const ctx = event?.ctx ?? {};
  return [
    event?.originatingChannel,
    ctx.OriginatingChannel,
    ctx.Surface,
    ctx.Provider,
  ].some((value) => normalizeChannel(value) === "telegram");
}

export function resolveReplyDispatchInput(event) {
  const ctx = event?.ctx ?? {};

  // CommandBody is the clean Telegram message, before OpenClaw rewrites
  // /knowledge and /sources into skill prompts. The remaining fields keep the
  // hook useful for ordinary known terms and for older channel adapters.
  for (const value of [
    ctx.CommandBody,
    ctx.BodyForCommands,
    ctx.RawBody,
    ctx.BodyForAgent,
    ctx.Body,
  ]) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function finishDeterministicReply(rendered, context, reason) {
  const queuedFinal = context.dispatcher.sendFinalReply(rendered);
  context.recordProcessed(queuedFinal ? "completed" : "skipped", { reason });
  context.markIdle("message_completed");

  return {
    handled: true,
    queuedFinal,
    counts: context.dispatcher.getQueuedCounts(),
  };
}

export function registerInteractions(api) {
  api.registerInteractiveHandler(interactiveDefinition);

  // Use the typed hook API here. registerHook() is the legacy internal-hook
  // surface and invokes its handler with one envelope argument; reply_dispatch
  // is a typed two-argument contract (event, context). Mixing the two leaves
  // the dispatcher context undefined and drops the deterministic UI reply.
  //
  // reply_dispatch runs before skill-command expansion and before the model.
  // before_agent_reply is too late for /knowledge, /sources and /about: by that
  // point OpenClaw has replaced the slash command with "Use the ... skill".
  // We deliberately do not register plugin commands: Telegram customCommands
  // owns the visible menu, so a second owner would cause command conflicts.
  api.on(
    "reply_dispatch",
    (event, context) => {
      if (event.isTailDispatch || !isTelegramReplyDispatch(event)) {
        return undefined;
      }

      const input = resolveReplyDispatchInput(event);
      const staticScreen = resolveUiCommandInput(input);
      if (staticScreen) {
        return finishDeterministicReply(
          staticScreen,
          context,
          "glossary_static_command",
        );
      }

      const article = resolveKnownTermInput(input);
      const termCard = article ? renderTermCard(article.title) : undefined;
      return termCard
        ? finishDeterministicReply(termCard, context, "glossary_known_term")
        : undefined;
    },
  );
}
