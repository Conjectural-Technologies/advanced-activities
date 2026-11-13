import { MODULE_ID, isValidLevelRange, localize } from "./module-config.mjs";

export const FLAG_KEY = "macros";

export function getTextEditor() {
  return foundry.applications?.ux?.TextEditor?.implementation ?? globalThis.TextEditor;
}

export function getMacroUuids(activity) {
  const stored = activity?.flags?.[MODULE_ID]?.[FLAG_KEY];
  if ( !Array.isArray(stored) ) return [];
  return stored.filter(uuid => typeof uuid === "string" && uuid.length);
}

export async function setMacroUuids(activity, uuids) {
  const settings = getMacroSettings(activity).filter(setting => uuids.includes(setting.uuid));
  await activity.update({
    [`flags.${MODULE_ID}.${FLAG_KEY}`]: uuids,
    [`flags.${MODULE_ID}.macroSettings`]: settings
  });
}

export function getMacroSettings(activity) {
  const settings = activity?.flags?.[MODULE_ID]?.macroSettings ?? [];
  if ( !Array.isArray(settings) || settings.some(setting => !setting || typeof setting.uuid !== "string"
    || !setting.level || typeof setting.level !== "object") ) {
    throw new Error(localize("ADVANCED_ACTIVITIES.LevelInvalid"));
  }
  return settings;
}

export function getMacroLevel(activity, uuid) {
  const level = getMacroSettings(activity).find(setting => setting.uuid === uuid)?.level ?? {};
  const { min = null, max = null } = level;
  if ( !isValidLevelRange({ min, max }) ) {
    throw new Error(localize("ADVANCED_ACTIVITIES.LevelInvalid"));
  }
  return { min, max };
}

export const RUN_MODES = Object.freeze(["manual", "before", "after"]);

export function getMacroRunMode(activity, uuid) {
  const setting = getMacroSettings(activity).find(entry => entry.uuid === uuid);
  if ( RUN_MODES.includes(setting?.run) ) return setting.run;
  // Settings saved before run modes existed used a boolean autoRun flag.
  return setting?.autoRun === true ? "after" : "manual";
}

export async function updateMacroSetting(activity, uuid, changes) {
  const current = getMacroSettings(activity).find(setting => setting.uuid === uuid);
  const setting = {
    uuid,
    level: { min: current?.level?.min ?? null, max: current?.level?.max ?? null },
    run: getMacroRunMode(activity, uuid),
    ...changes
  };
  if ( !isValidLevelRange(setting.level) ) throw new Error(localize("ADVANCED_ACTIVITIES.LevelInvalid"));
  if ( !RUN_MODES.includes(setting.run) ) setting.run = "manual";
  const settings = getMacroSettings(activity).filter(entry => entry.uuid !== uuid);
  if ( setting.level.min !== null || setting.level.max !== null || setting.run !== "manual" ) settings.push(setting);
  await activity.update({ [`flags.${MODULE_ID}.macroSettings`]: settings });
}

export function isMacroLevelEligible(activity, uuid) {
  const { min, max } = getMacroLevel(activity, uuid);
  if ( min === null && max === null ) return true;
  const level = activity?.relevantLevel;
  if ( !Number.isFinite(level) ) throw new Error(localize("ADVANCED_ACTIVITIES.LevelUnavailable"));
  return level >= (min ?? 0) && level <= (max ?? Infinity);
}

export async function resolveMacro(uuid) {
  const macro = await fromUuid(uuid);
  return macro?.documentName === "Macro" ? macro : null;
}

export async function resolveMacroTarget(uuid) {
  const document = await fromUuid(uuid);
  const actor = document?.actor ?? document;
  if ( !actor ) throw new Error(localize("ADVANCED_ACTIVITIES.TargetMissing"));
  if ( !actor.isOwner ) return null;
  return { uuid, document, actor, token: document?.object ?? actor.token?.object ?? null };
}

export function renderMacroTooltip(macro) {
  return foundry.applications.handlebars.renderTemplate(
    "systems/dnd5e/templates/effects/parts/effect-tooltip.hbs",
    { effect: macro, properties: [localize(`TYPES.Macro.${macro.type}`)] }
  );
}

export function reportMacroError(error) {
  const message = error?.message ?? String(error);
  console.error(`${MODULE_ID} | Macro configuration failed: ${message}`, error);
  ui.notifications.error(message);
}
