import { MODULE_ID, localize, TIMING_FLAG_KEY } from "./module-config.mjs";
import {
  FLAG_KEY, getMacroRunMode, getMacroUuids, isMacroLevelEligible, renderMacroTooltip, reportMacroError, resolveMacro,
  resolveMacroTarget
} from "./macro-config.mjs";

const MACRO_APPLICATION_TAG = "advanced-activities-macro-application";
const patchedMessageModels = new WeakSet();

function registerMacroTargetContext() {
  const cls = CONFIG.ChatMessage?.dataModels?.usage;
  if ( typeof cls?.prototype?._prepareContext !== "function" ) {
    console.error(`${MODULE_ID} | Unable to locate dnd5e's usage message rendering context.`);
    return;
  }
  if ( patchedMessageModels.has(cls) ) return;
  const original = cls.prototype._prepareContext;
  cls.prototype._prepareContext = async function(...args) {
    const context = await original.apply(this, args);
    const macros = this.parent.getFlag(MODULE_ID, FLAG_KEY);
    if ( !args[0]?.summary && !context.content && Array.isArray(macros) && macros.length
      && !this.parent.getFlag(MODULE_ID, TIMING_FLAG_KEY) ) {
      context.showTargets = true;
    }
    return context;
  };
  patchedMessageModels.add(cls);
}

function partitionMacroUuids(activity) {
  const modes = { manual: [], before: [], after: [] };
  for ( const uuid of getMacroUuids(activity) ) {
    let mode = "manual";
    try {
      mode = getMacroRunMode(activity, uuid);
    } catch (error) {
      reportMacroError(error);
    }
    modes[mode].push(uuid);
  }
  return modes;
}

export function onPreUseActivity(activity, usageConfig, dialogConfig, messageConfig) {
  const { manual } = partitionMacroUuids(activity);
  if ( !manual.length ) return;
  foundry.utils.setProperty(messageConfig.data, `flags.${MODULE_ID}.${FLAG_KEY}`, manual);
}

async function resolveUsageTargets(activity, results) {
  let uuids;
  if ( activity.target?.affects?.type === "self" ) {
    const actor = activity.item?.actor;
    uuids = actor ? [actor.token?.uuid ?? actor.uuid] : [];
  } else if ( results ) {
    const message = results.message;
    const descriptors = message?.system?.targets ?? message?.data?.system?.targets ?? [];
    uuids = descriptors.map(target => target?.token ?? target?.actor).filter(Boolean);
  } else {
    uuids = Array.from(game.user.targets ?? []).map(token => token.document?.uuid).filter(Boolean);
  }
  const targets = await Promise.all([...new Set(uuids)].map(async uuid => {
    try {
      return await resolveMacroTarget(uuid);
    } catch (error) {
      reportMacroError(new Error(localize("ADVANCED_ACTIVITIES.TargetResolutionFailed", {
        uuid, error: error?.message ?? String(error)
      })));
      return null;
    }
  }));
  return targets.filter(Boolean);
}

export function onPostUseActivity(activity, usageConfig, results) {
  const { after } = partitionMacroUuids(activity);
  if ( !after.length ) return;
  // Deferred so dnd5e can start the activity's subsequent actions before the macros run.
  Promise.resolve().then(async () => {
    const targets = await resolveUsageTargets(activity, results);
    await executeMacros(activity, after, usageConfig, results, targets);
  }).catch(reportMacroError);
}

/**
 * Run an activity's "before use" macros. Any macro that returns false, fails, or cannot run cancels the use.
 * @returns {Promise<boolean>}  Whether the activity may continue.
 */
export async function runBeforeUseMacros(activity, [usageConfig = {}, dialogConfig = {}, messageConfig = {}] = []) {
  const { before } = partitionMacroUuids(activity);
  if ( !before.length ) return true;
  const targets = await resolveUsageTargets(activity, null);
  const scope = { ...buildMacroScope(activity, targets), usageConfig, dialogConfig, messageConfig, results: null };
  for ( const uuid of before ) {
    let macro;
    try {
      if ( !isMacroLevelEligible(activity, uuid) ) continue;
      macro = await resolveMacro(uuid);
    } catch (error) {
      reportMacroError(error);
      return false;
    }
    if ( !macro ) {
      ui.notifications?.error(localize("ADVANCED_ACTIVITIES.ErrorBeforeUseMissing", { activity: activity.name }));
      return false;
    }
    if ( macro.canExecute === false ) {
      ui.notifications?.warn(localize("ADVANCED_ACTIVITIES.WarnCannotExecute", { name: macro.name }));
      return false;
    }
    try {
      if ( (await macro.execute({ ...scope, message: null })) === false ) return false;
    } catch (err) {
      console.error(`${MODULE_ID} | Before-use macro "${macro.name}" threw an error.`, err);
      ui.notifications?.error(localize("ADVANCED_ACTIVITIES.ErrorBeforeUseFailed", {
        name: macro.name, activity: activity.name
      }));
      return false;
    }
  }
  return true;
}

function shouldCollapseMacroTray(message) {
  const remembered = message._trayStates?.get(MACRO_APPLICATION_TAG.toUpperCase());
  if ( remembered !== undefined ) return !remembered;
  switch ( game.settings.get("dnd5e", "autoCollapseChatTrays") ) {
    case "always": return true;
    case "older": return message.timestamp < Date.now() - (5 * 60 * 1000);
    default: return false;
  }
}

function onRenderChatMessage(message, html) {
  if ( message.getFlag(MODULE_ID, TIMING_FLAG_KEY) ) return;
  const uuids = message.getFlag(MODULE_ID, FLAG_KEY);
  if ( !Array.isArray(uuids) || !uuids.length || html.querySelector(MACRO_APPLICATION_TAG) ) return;

  const application = document.createElement(MACRO_APPLICATION_TAG);
  application.classList.add("dnd5e2");
  application.chatMessage = message;
  for ( const uuid of uuids ) {
    const option = document.createElement("option");
    option.value = uuid;
    application.append(option);
  }
  application.toggleAttribute("open", !shouldCollapseMacroTray(message));
  html.append(application);
}

function registerMacroTrayType() {
  const trayTypes = CONFIG.ChatMessage?.documentClass?.TRAY_TYPES;
  if ( !Array.isArray(trayTypes) || trayTypes.includes(MACRO_APPLICATION_TAG) ) return;
  trayTypes.push(MACRO_APPLICATION_TAG);
}

function registerMacroApplicationElement() {
  if ( customElements.get(MACRO_APPLICATION_TAG) ) return;
  const Base = globalThis.dnd5e?.applications?.components?.EffectApplicationElement;
  if ( !Base ) {
    console.error(`${MODULE_ID} | Unable to locate dnd5e's effect application component.`);
    return;
  }

  class MacroApplicationElement extends Base {
    macros = [];
    macroUuids = [];
    macroOptions = new Map();

    connectedCallback() {
      this.chatMessage ??= game.messages.get(this.closest("[data-message-id]")?.dataset.messageId);
      if ( !this.chatMessage || this.querySelector(".macros-tray") ) return;
      this.macroUuids = Array.from(this.querySelectorAll("option")).map(option => option.value);

      const div = document.createElement("div");
      div.classList.add("card-tray", "effects-tray", "macros-tray", "collapsible");
      if ( !this.open ) div.classList.add("collapsed");
      div.innerHTML = `
        <label class="roboto-upper">
          <i class="fa-solid fa-code"></i>
          <span>${foundry.utils.escapeHTML(localize("ADVANCED_ACTIVITIES.Macros"))}</span>
          <i class="fa-solid fa-caret-down"></i>
        </label>
        <div class="collapsible-content">
          <div class="wrapper">
            <menu class="effects macros unlist"></menu>
            <button type="button" class="apply-button" data-action="apply">
              <i class="fa-light fa-reply-all fa-flip-horizontal" inert></i>
              <span>${foundry.utils.escapeHTML(localize("ADVANCED_ACTIVITIES.ApplyMacros"))}</span>
            </button>
          </div>
        </div>
      `;
      this.replaceChildren(div);
      this.effectsList = div.querySelector(".macros");
      this.effectsList.addEventListener("click", this.onCheckMacro.bind(this));
      div.addEventListener("click", this._handleClickHeader.bind(this));
      div.querySelector(".apply-button").addEventListener("click", event => {
        void this.onApplyMacros(event).catch(reportMacroError);
      });
      this.resolveMacros().catch(reportMacroError);
    }

    async resolveMacros() {
      const activity = this.chatMessage.getAssociatedActivity({ scaled: true });
      const macros = await Promise.all(this.macroUuids.map(async uuid => {
        try {
          const macro = await resolveMacro(uuid);
          return macro && isMacroLevelEligible(activity, uuid) ? macro : null;
        } catch (error) {
          reportMacroError(error);
          return null;
        }
      }));
      this.macros = macros.filter(Boolean);
      if ( !this.macros.length ) {
        this.remove();
        return;
      }
      this.macroOptions.set(this.macros[0].uuid, true);
      await this.buildMacrosList();
    }

    async buildMacrosList() {
      for ( const macro of this.macros ) {
        const li = document.createElement("li");
        li.classList.add("effect", "macro");
        Object.assign(li.dataset, {
          uuid: macro.uuid,
          tooltipClass: "dnd5e2 dnd5e-tooltip effect-tooltip document-tooltip",
          tooltipDirection: "LEFT"
        });
        li.dataset.tooltipHtml = await renderMacroTooltip(macro);
        li.innerHTML = `
          <button type="button" class="unbutton" aria-pressed="${this.macroChecked(macro.uuid)}">
            <img class="gold-icon">
            <span class="title"></span>
            <span class="pip" inert></span>
          </button>
        `;
        Object.assign(li.querySelector(".gold-icon"), {
          alt: macro.name,
          src: macro.img || "icons/svg/dice-target.svg"
        });
        li.querySelector(".title").append(macro.name);
        this.effectsList.append(li);
      }
    }

    macroChecked(uuid) {
      return this.macroOptions.get(uuid) ?? false;
    }

    onCheckMacro(event) {
      const macro = event.target.closest(".macro[data-uuid]");
      if ( !macro ) return;
      event.stopPropagation();
      const { uuid } = macro.dataset;
      const checked = this.macroOptions.get(uuid);
      if ( !event.shiftKey ) this.macroOptions.clear();
      this.macroOptions.set(uuid, event.shiftKey ? !checked : true);
      this.querySelectorAll(".macro[data-uuid]").forEach(element => {
        element.querySelector("button").ariaPressed = `${this.macroChecked(element.dataset.uuid)}`;
      });
    }

    getTargets(activity) {
      if ( activity.target?.affects?.type === "self" ) {
        const actor = activity.item?.actor;
        return actor ? [actor.token?.uuid ?? actor.uuid] : [];
      }
      const message = this.closest("[data-message-id]");
      const recorded = message?.querySelector(".chat-card > recorded-targets")
        ?? message?.querySelector("recorded-targets");
      return Array.from(recorded?.targets ?? []);
    }

    async onApplyMacros(event) {
      event.preventDefault();
      const activity = this.chatMessage.getAssociatedActivity({ scaled: true });
      if ( !activity ) {
        ui.notifications?.error(localize("ADVANCED_ACTIVITIES.ActivityMissing"));
        return;
      }
      const targets = (await Promise.all(this.getTargets(activity).map(async uuid => {
        try {
          return await resolveMacroTarget(uuid);
        } catch (error) {
          reportMacroError(new Error(localize("ADVANCED_ACTIVITIES.TargetResolutionFailed", {
            uuid, error: error?.message ?? String(error)
          })));
          return null;
        }
      }))).filter(Boolean);
      if ( !targets.length ) {
        ui.notifications?.warn(localize("ADVANCED_ACTIVITIES.WarnNoValidTargets"));
        return;
      }

      const uuids = this.macros.filter(macro => this.macroChecked(macro.uuid)).map(macro => macro.uuid);
      await executeMacros(activity, uuids, null, { message: this.chatMessage }, targets);
      if ( game.settings.get("dnd5e", "autoCollapseChatTrays") !== "manual" ) this.open = false;
    }
  }

  customElements.define(MACRO_APPLICATION_TAG, MacroApplicationElement);
}

function buildMacroScope(activity, targets = []) {
  const item = activity.item ?? null;
  const actor = item?.actor ?? null;
  const token = actor?.token?.object ?? actor?.getActiveTokens?.()[0] ?? null;
  return {
    speaker: ChatMessage.implementation.getSpeaker(actor ? { actor } : {}),
    actor, token, activity, item, targets,
    target: targets.length === 1 ? targets[0] : null,
    targetActors: targets.map(target => target.actor),
    targetTokens: targets.map(target => target.token).filter(Boolean)
  };
}

async function executeMacros(activity, uuids, usageConfig, results, targets = []) {
  const scope = buildMacroScope(activity, targets);

  for ( const uuid of uuids ) {
    try {
      if ( !isMacroLevelEligible(activity, uuid) ) continue;
    } catch (error) {
      reportMacroError(error);
      continue;
    }
    let macro = null;
    try {
      macro = await resolveMacro(uuid);
    } catch {
      macro = null;
    }

    if ( !macro ) {
      console.warn(`${MODULE_ID} | Could not resolve macro "${uuid}" for activity "${activity.name}".`);
      continue;
    }

    if ( macro.canExecute === false ) {
      ui.notifications?.warn(localize("ADVANCED_ACTIVITIES.WarnCannotExecute", { name: macro.name }));
      continue;
    }

    try {
      await macro.execute({ ...scope, usageConfig, results, message: results?.message ?? null });
    } catch (err) {
      console.error(`${MODULE_ID} | Macro "${macro.name}" threw an error.`, err);
      ui.notifications?.error(localize("ADVANCED_ACTIVITIES.ErrorMacroFailed", { name: macro.name }));
    }
  }
}

export function registerMacroChat() {
  registerMacroTargetContext();
  registerMacroApplicationElement();
  registerMacroTrayType();
  Hooks.on("dnd5e.renderChatMessage", onRenderChatMessage);
}
