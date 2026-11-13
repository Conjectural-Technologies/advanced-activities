import { registerActivationTiming } from "./activation-timing.mjs";
import { registerGrantActivity } from "./grant-activity.mjs";
import { registerGrantExpiration } from "./grant-expiration.mjs";
import { onRenderActivityVisibility, registerActivityVisibility } from "./activity-visibility.mjs";
import { registerMacroChat, onPostUseActivity, onPreUseActivity } from "./macro-chat.mjs";
import { registerMacroTab, onRenderActivitySheet } from "./macro-sheet.mjs";

Hooks.once("init", () => {
  registerActivationTiming();
  registerGrantActivity();
  registerGrantExpiration();
  registerActivityVisibility();
  Hooks.on("dnd5e.preUseActivity", onPreUseActivity);
  Hooks.on("dnd5e.postUseActivity", onPostUseActivity);
  Hooks.on("renderActivitySheet", onRenderActivityVisibility);
});

Hooks.once("setup", () => {
  registerMacroTab();
  registerMacroChat();
  Hooks.on("renderActivitySheet", onRenderActivitySheet);
});
