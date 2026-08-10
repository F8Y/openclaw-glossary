import {
  UI_CALLBACK_NAMESPACE,
  renderScreen,
  renderTermCard,
  toInteractiveResponse,
} from "./ui.js";

const SAFE_TERM = /^[A-Za-z0-9_-]+$/;

export const interactiveDefinition = Object.freeze({
  channel: "telegram",
  namespace: UI_CALLBACK_NAMESPACE,
  async handler(context) {
    if (!context.auth?.isAuthorizedSender) {
      return { handled: true };
    }

    const payload = String(context.callback?.payload ?? "");

    if (payload.startsWith("screen:")) {
      const [, screen = "menu", args = ""] = payload.split(":", 3);
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
}
