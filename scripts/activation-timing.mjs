import { MODULE_ID, localize, TIMING_FLAG_KEY as FLAG_KEY } from "./module-config.mjs";

const patchedClasses = new WeakSet();
const waiters = new Map();
const deletingCards = new Set();
let mutations = Promise.resolve();
let processing = false;
let processAgain = false;

function validateEntries(entries) {
  if ( !Array.isArray(entries) || entries.some(entry => !entry
    || typeof entry.id !== "string" || typeof entry.uuid !== "string" || typeof entry.name !== "string"
    || typeof entry.messageId !== "string" || !Number.isFinite(entry.startedAt) || !Number.isFinite(entry.dueAt)
    || entry.dueAt <= entry.startedAt || !["pending", "executing", "failed"].includes(entry.state)
    || !entry.args) ) {
    throw new Error(localize("ADVANCED_ACTIVITIES.TimingEntriesInvalid"));
  }
  return entries;
}

export function getPendingActivations() {
  return foundry.utils.deepClone(validateEntries(game.user.getFlag(MODULE_ID, FLAG_KEY) ?? []));
}

function mutatePendingActivations(change) {
  const operation = mutations.then(async () => {
    const entries = getPendingActivations();
    const result = change(entries);
    await game.user.setFlag(MODULE_ID, FLAG_KEY, entries);
    return result;
  });
  mutations = operation.catch(() => {});
  return operation;
}

export function formatGameDuration(seconds) {
  if ( !Number.isFinite(seconds) || seconds < 0 ) throw new Error(localize("ADVANCED_ACTIVITIES.TimingInvalid"));
  let remaining = Math.ceil(seconds);
  const locale = game.i18n.lang ?? "en";
  const plural = new Intl.PluralRules(locale);
  const number = new Intl.NumberFormat(locale);
  const parts = [];
  for ( const [unit, scale] of [["Day", 86400], ["Hour", 3600], ["Minute", 60], ["Second", 1]] ) {
    const value = Math.floor(remaining / scale);
    remaining %= scale;
    if ( value || (!parts.length && unit === "Second") ) {
      const form = plural.select(value) === "one" ? "One" : "Other";
      parts.push(localize(`ADVANCED_ACTIVITIES.Time${unit}${form}`, { value: number.format(value) }));
    }
  }
  return new Intl.ListFormat(locale, { style: "long", type: "unit" }).format(parts);
}

export function activationSeconds(activity) {
  const conversion = CONFIG.DND5E.timeUnits?.[activity.activation?.type]?.conversion;
  if ( conversion === undefined ) return null;
  const amount = activity.activation.value ?? 1;
  const seconds = amount * (conversion * 60);
  if ( !Number.isFinite(amount) || !Number.isFinite(seconds) || seconds <= 0 ) {
    throw new Error(localize("ADVANCED_ACTIVITIES.TimingInvalid"));
  }
  return seconds;
}

async function preparePendingUsage(sourceActivity, args, entry) {
  const [usage = {}, dialog = {}, message = {}] = args;
  let item = sourceActivity.item.clone({}, { keepId: true });
  let activity = item.system.activities.get(sourceActivity.id);
  const usageConfig = activity._prepareUsageConfig(usage);
  const dialogConfig = foundry.utils.mergeObject({
    configure: true,
    applicationClass: sourceActivity.metadata.usage.dialog
  }, dialog);
  const TargetsField = globalThis.dnd5e?.dataModels?.chatMessage?.fields?.TargetsField;
  const messageConfig = foundry.utils.mergeObject({
    create: true,
    data: { system: { targets: TargetsField?.getDescriptors() ?? [] } },
    hasConsumption: usageConfig.hasConsumption
  }, message);
  messageConfig.create = true;
  if ( Hooks.call("dnd5e.preUseActivity", activity, usageConfig, dialogConfig, messageConfig) === false ) return null;
  if ( dialogConfig.configure && activity._requiresConfigurationDialog(usageConfig) ) {
    try {
      await dialogConfig.applicationClass.create(activity, usageConfig, dialogConfig.options);
    } catch {
      return null;
    }
  }
  await activity._prepareUsageScaling(usageConfig, messageConfig, item);
  activity = item.system.activities.get(sourceActivity.id);
  const results = { effects: [], templates: [], updates: { rolls: [] } };
  await activity._finalizeMessageConfig(usageConfig, messageConfig, results);
  foundry.utils.setProperty(messageConfig.data, `flags.${MODULE_ID}.${FLAG_KEY}`, {
    id: entry.id,
    userId: game.user.id,
    name: entry.name,
    startedAt: entry.startedAt,
    dueAt: entry.dueAt,
    state: "pending"
  });
  const card = await activity._createUsageMessage(messageConfig);
  if ( !(card instanceof ChatMessage) ) throw new Error(localize("ADVANCED_ACTIVITIES.TimingUnavailable"));
  return { card, usageConfig, messageConfig };
}

function clearPendingFlag(data) {
  const flags = data?.flags?.[MODULE_ID];
  if ( !flags ) return;
  delete flags[FLAG_KEY];
  if ( !Object.keys(flags).length ) delete data.flags[MODULE_ID];
  if ( !Object.keys(data.flags).length ) delete data.flags;
}

async function updatePendingCard(entry, changes) {
  const message = entry?.messageId ? game.messages.get(entry.messageId) : null;
  if ( !message ) return;
  const current = message.getFlag(MODULE_ID, FLAG_KEY);
  if ( !current ) return;
  await message.setFlag(MODULE_ID, FLAG_KEY, { ...current, ...changes });
}

async function finalizeDelayedUsage(sourceActivity, usageConfig, messageConfig, entry) {
  let item = sourceActivity.item.clone({}, { keepId: true });
  let activity = item.system.activities.get(sourceActivity.id);
  usageConfig = foundry.utils.deepClone(usageConfig);
  messageConfig = foundry.utils.deepClone(messageConfig);
  messageConfig.data ??= {};
  clearPendingFlag(messageConfig.data);
  const existing = entry?.messageId ? game.messages.get(entry.messageId) : null;
  messageConfig.create = !existing;
  if ( existing ) {
    messageConfig.data.id = existing.id;
    messageConfig.data._id = existing.id;
  }
  await activity._prepareUsageScaling(usageConfig, messageConfig, item);
  activity = item.system.activities.get(sourceActivity.id);
  const updates = await activity.consume(usageConfig, messageConfig);
  if ( updates === false ) throw new Error(localize("ADVANCED_ACTIVITIES.TimingUnavailable"));
  const results = { effects: [], templates: [], updates };
  if ( usageConfig.concentration?.begin ) {
    const effect = await activity.item.actor.beginConcentrating(activity, { "flags.dnd5e.scaling": usageConfig.scaling });
    if ( effect ) {
      results.effects ??= [];
      results.effects.push(effect);
      foundry.utils.setProperty(messageConfig.data, "system.concentration", effect.id);
    }
    if ( usageConfig.concentration?.end ) {
      const deleted = await activity.item.actor.endConcentration(usageConfig.concentration.end);
      results.effects.push(...deleted);
    }
  }
  await activity._finalizeMessageConfig(usageConfig, messageConfig, results);
  const generated = await activity._createUsageMessage(messageConfig);
  if ( existing ) {
    const update = foundry.utils.deepClone(generated);
    delete update.id;
    delete update._id;
    foundry.utils.setProperty(update, `flags.${MODULE_ID}.-=${FLAG_KEY}`, null);
    await existing.update(update);
    results.message = existing;
  } else results.message = generated;
  await activity._finalizeUsage(usageConfig, results);
  if ( Hooks.call("dnd5e.postUseActivity", activity, usageConfig, results) === false ) return results;
  if ( usageConfig.subsequentActions !== false ) {
    const deltas = results.message?.system?.deltas ?? results.message?.data?.system?.deltas;
    const consumed = sourceActivity.createConsumedFlag(sourceActivity.actor, deltas);
    if ( consumed ) item.updateSource({ "flags.dnd5e.consumed": consumed });
    activity._triggerSubsequentActions(usageConfig, results);
  }
  return results;
}

function onRenderPendingActivationCard(message, html) {
  if ( !message ) return;
  const flags = message.getFlag(MODULE_ID, FLAG_KEY);
  if ( !flags || !Number.isFinite(flags.dueAt) ) return;
  const remaining = Math.max(0, flags.dueAt - game.time.worldTime);
  if ( html.querySelector(".advanced-activities-timing-remaining") ) return;
  const timing = document.createElement("p");
  timing.classList.add("supplement", "advanced-activities-timing-remaining");
  const timingLabel = document.createElement("strong");
  timingLabel.textContent = localize("ADVANCED_ACTIVITIES.TimingActivationTime");
  const name = flags.name ?? message.getAssociatedActivity()?.name ?? "";
  let timingDetail;
  if ( flags.state === "failed" ) {
    timingDetail = localize("ADVANCED_ACTIVITIES.TimingFailed", { name, error: flags.error ?? "" });
  } else if ( remaining > 0 && flags.state !== "executing" ) {
    timingDetail = localize("ADVANCED_ACTIVITIES.TimingRemaining", {
      name, duration: formatGameDuration(remaining)
    });
  } else if ( flags.state === "pending" && !game.users.get(flags.userId)?.active ) {
    const user = game.users.get(flags.userId)?.name ?? flags.userId;
    timingDetail = localize("ADVANCED_ACTIVITIES.TimingWaitingForUser", { user });
  } else timingDetail = localize("ADVANCED_ACTIVITIES.TimingExecuting");
  timing.append(timingLabel, ` ${timingDetail}`);
  const firstSupplement = html.querySelector(".chat-card p.supplement");
  if ( firstSupplement ) firstSupplement.before(timing);
  else html.querySelector(".chat-card")?.append(timing);
  const banner = document.createElement("div");
  banner.classList.add("advanced-activities-timing-banner");
  if ( flags.userId === game.user.id && flags.state !== "executing" ) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = localize(flags.state === "failed"
      ? "ADVANCED_ACTIVITIES.TimingDismiss" : "ADVANCED_ACTIVITIES.TimingCancel");
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      void cancelPendingActivation(flags.id).catch(error => report(error, name));
    });
    banner.append(button);
  }
  html.querySelectorAll([
    "button", "input", "select", "textarea", "[data-action]", '[role="button"]',
    "effect-application", "damage-application", "enchantment-application",
    "recorded-targets", "advanced-activities-macro-application"
  ].join(",")).forEach(element => {
    if ( element.closest(".card-header") ) return;
    element.hidden = true;
    element.disabled = true;
    element.setAttribute("aria-disabled", "true");
    element.toggleAttribute("inert", true);
  });
  if ( banner.children.length ) html.append(banner);
}

function encode(value, seen = new Set()) {
  if ( value === undefined ) return { type: "undefined" };
  if ( value === null || ["string", "boolean"].includes(typeof value) ) return { type: "value", value };
  if ( typeof value === "number" && Number.isFinite(value) ) return { type: "value", value };
  if ( value?.uuid && value?.documentName ) return { type: "document", value: value.uuid };
  if ( globalThis.Event && value instanceof Event ) {
    return {
      type: "event",
      value: Object.fromEntries(["ctrlKey", "altKey", "shiftKey", "metaKey", "clientX", "clientY", "button", "buttons"]
        .map(key => [key, value[key]]))
    };
  }
  if ( value instanceof foundry.applications.api.ApplicationV2
    || (foundry.appv1?.api?.Application && value instanceof foundry.appv1.api.Application) ) {
    return { type: "application", value: value.id };
  }
  if ( typeof value !== "object" || seen.has(value) ) {
    throw new Error(localize("ADVANCED_ACTIVITIES.TimingOptionsUnsupported"));
  }
  seen.add(value);
  let result;
  if ( Array.isArray(value) || value instanceof Set ) {
    result = { type: value instanceof Set ? "set" : "array", value: [...value].map(v => encode(v, seen)) };
  } else if ( Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null ) {
    result = { type: "object", value: Object.entries(value).map(([k, v]) => [k, encode(v, seen)]) };
  } else {
    throw new Error(localize("ADVANCED_ACTIVITIES.TimingOptionsUnsupported"));
  }
  seen.delete(value);
  return result;
}

async function decode(data) {
  switch ( data.type ) {
    case "undefined": return undefined;
    case "value": return data.value;
    case "document": {
      const document = await fromUuid(data.value);
      if ( !document ) throw new Error(localize("ADVANCED_ACTIVITIES.TimingDocumentMissing", { uuid: data.value }));
      return document;
    }
    case "event": return new MouseEvent("click", data.value);
    case "application": {
      const application = foundry.applications.instances.get(data.value) ?? ui.windows?.[data.value];
      if ( !application ) {
        throw new Error(localize("ADVANCED_ACTIVITIES.TimingApplicationMissing", { id: data.value }));
      }
      return application;
    }
    case "array": return Promise.all(data.value.map(decode));
    case "set": return new Set(await Promise.all(data.value.map(decode)));
    case "object": return Object.fromEntries(await Promise.all(data.value.map(async ([k, v]) => [k, await decode(v)])));
    default: throw new Error(localize("ADVANCED_ACTIVITIES.TimingOptionsUnsupported"));
  }
}

function report(error, name = "") {
  console.error(`${MODULE_ID} | Timed activation failed: ${name}`, error);
  ui.notifications.error(localize("ADVANCED_ACTIVITIES.TimingFailed", { name, error: error?.message ?? String(error) }));
}

async function schedule(activity, args) {
  const seconds = activationSeconds(activity);
  if ( !Number.isFinite(game.time.worldTime) ) throw new Error(localize("ADVANCED_ACTIVITIES.TimingInvalid"));
  const entry = {
    id: foundry.utils.randomID(),
    uuid: activity.uuid,
    name: activity.name,
    userId: game.user.id,
    startedAt: game.time.worldTime,
    dueAt: game.time.worldTime + seconds,
    state: "pending"
  };
  if ( !Number.isFinite(entry.dueAt) || entry.dueAt <= entry.startedAt ) {
    throw new Error(localize("ADVANCED_ACTIVITIES.TimingInvalid"));
  }
  let resolve;
  let reject;
  const completion = new Promise((res, rej) => { resolve = res; reject = rej; });
  const prepared = await preparePendingUsage(activity, args, entry);
  if ( !prepared ) return;
  entry.messageId = prepared.card.id;
  try {
    entry.args = encode([prepared.usageConfig, prepared.messageConfig]);
    await mutatePendingActivations(entries => {
      if ( entries.some(current => current.id === entry.id || current.messageId === entry.messageId) ) {
        throw new Error(localize("ADVANCED_ACTIVITIES.TimingEntriesInvalid"));
      }
      entries.push(entry);
    });
  } catch (error) {
    await prepared.card.delete();
    throw error;
  }
  waiters.set(entry.id, { resolve, reject });
  void processPendingActivations().catch(error => report(error, entry.name));
  return completion;
}

export async function cancelPendingActivation(id) {
  const entry = getPendingActivations().find(current => current.id === id);
  if ( !entry ) throw new Error(localize("ADVANCED_ACTIVITIES.TimingNotFound"));
  if ( entry.state === "executing" ) throw new Error(localize("ADVANCED_ACTIVITIES.TimingAlreadyExecuting"));
  await mutatePendingActivations(entries => {
    const index = entries.findIndex(current => current.id === id);
    if ( index < 0 ) throw new Error(localize("ADVANCED_ACTIVITIES.TimingNotFound"));
    if ( entries[index].state === "executing" ) {
      throw new Error(localize("ADVANCED_ACTIVITIES.TimingAlreadyExecuting"));
    }
    entries.splice(index, 1);
  });
  if ( entry.messageId ) {
    const message = game.messages.get(entry.messageId);
    if ( message ) {
      deletingCards.add(entry.messageId);
      try {
        await message.delete();
      } finally {
        deletingCards.delete(entry.messageId);
      }
    }
  }
  waiters.get(id)?.resolve(undefined);
  waiters.delete(id);
}

function onDeletePendingActivationCard(message) {
  if ( !message?.id || deletingCards.has(message.id) ) return;
  let entry;
  try {
    entry = getPendingActivations().find(current => current.messageId === message.id);
  } catch (error) {
    report(error);
    return;
  }
  if ( !entry || entry.state === "executing" ) return;
  if ( game.user.id !== entry.userId ) return;
  void cancelPendingActivation(entry.id).catch(error => report(error, entry.name));
}

function refreshPendingCards() {
  for ( const entry of getPendingActivations() ) {
    if ( entry.state !== "pending" ) continue;
    const message = game.messages.get(entry.messageId);
    if ( message ) ui.chat?.updateMessage?.(message);
  }
}

async function executePendingActivation(entry) {
  try {
    const activity = await fromUuid(entry.uuid);
    if ( !activity?.item?.isEmbedded || !activity.item.isOwner || activity.canUse === false ) {
      throw new Error(localize("ADVANCED_ACTIVITIES.TimingUnavailable"));
    }
    const [usageConfig, messageConfig] = await decode(entry.args);
    if ( entry.dueAt > game.time.worldTime ) return false;
    const result = await finalizeDelayedUsage(activity, usageConfig, messageConfig, entry);
    waiters.get(entry.id)?.resolve(result);
    return result;
  } catch (error) {
    waiters.get(entry.id)?.reject(error);
    throw error;
  } finally {
    waiters.delete(entry.id);
  }
}

async function failInterruptedActivations() {
  const interrupted = await mutatePendingActivations(entries => {
    const failed = [];
    for ( const entry of entries ) {
      if ( entry.state !== "executing" ) continue;
      entry.state = "failed";
      entry.error = localize("ADVANCED_ACTIVITIES.TimingInterrupted");
      failed.push(foundry.utils.deepClone(entry));
    }
    return failed;
  });
  for ( const entry of interrupted ) {
    await updatePendingCard(entry, { state: "failed", error: entry.error });
  }
}

export async function processPendingActivations() {
  if ( processing ) {
    processAgain = true;
    return;
  }
  processing = true;
  try {
    do {
      processAgain = false;
      const due = getPendingActivations()
        .filter(entry => entry.state === "pending" && entry.dueAt <= game.time.worldTime)
        .sort((a, b) => a.dueAt - b.dueAt || a.startedAt - b.startedAt);
      for ( const entry of due ) {
        const claimed = await mutatePendingActivations(entries => {
          const current = entries.find(candidate => candidate.id === entry.id);
          if ( !current || current.state !== "pending" || current.dueAt > game.time.worldTime ) return false;
          current.state = "executing";
          return foundry.utils.deepClone(current);
        });
        if ( !claimed ) continue;
        await updatePendingCard(claimed, { state: "executing" });
        try {
          const completed = await executePendingActivation(claimed);
          if ( completed === false ) {
            await mutatePendingActivations(entries => {
              const current = entries.find(candidate => candidate.id === entry.id);
              if ( current?.state === "executing" ) current.state = "pending";
            });
            await updatePendingCard(claimed, { state: "pending" });
            continue;
          }
          await mutatePendingActivations(entries => {
            const index = entries.findIndex(candidate => candidate.id === entry.id);
            if ( index >= 0 ) entries.splice(index, 1);
          });
        } catch (error) {
          const message = error?.message ?? String(error);
          const failed = await mutatePendingActivations(entries => {
            const current = entries.find(candidate => candidate.id === entry.id);
            if ( !current ) return null;
            current.state = "failed";
            current.error = message;
            return foundry.utils.deepClone(current);
          });
          if ( failed ) await updatePendingCard(failed, { state: "failed", error: message });
          report(error, entry.name);
        }
      }
    } while ( processAgain );
  } finally {
    processing = false;
  }
}

export function registerTimedActivityUses() {
  for ( const config of Object.values(CONFIG.DND5E.activityTypes ?? {}) ) {
    let cls = config?.documentClass;
    while ( typeof cls === "function" && cls.prototype ) {
      if ( Object.hasOwn(cls.prototype, "use") && !patchedClasses.has(cls) ) {
        const original = cls.prototype.use;
        cls.prototype.use = async function(...args) {
          try {
            if ( activationSeconds(this) === null || !this.item?.isEmbedded
              || !this.item.isOwner || this.canUse === false ) return original.apply(this, args);
            return await schedule(this, args);
          } catch (error) {
            report(error, this.name);
            throw error;
          }
        };
        patchedClasses.add(cls);
      }
      cls = Object.getPrototypeOf(cls);
    }
  }
}

export function registerActivationTiming() {
  Hooks.once("setup", registerTimedActivityUses);
  Hooks.once("ready", registerTimedActivityUses);
  Hooks.once("ready", async () => {
    try {
      await failInterruptedActivations();
      await processPendingActivations();
    } catch (error) {
      report(error);
    }
  });
  Hooks.on("dnd5e.renderChatMessage", onRenderPendingActivationCard);
  Hooks.on("deleteChatMessage", onDeletePendingActivationCard);
  Hooks.on("updateWorldTime", () => {
    refreshPendingCards();
    void processPendingActivations().catch(report);
  });
}
