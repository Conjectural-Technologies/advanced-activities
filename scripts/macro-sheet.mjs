import { MODULE_ID, createLevelRangeGroup, createSettingsTray, localize } from "./module-config.mjs";
import {
  getMacroLevel, getMacroRunMode, getMacroUuids, getTextEditor, renderMacroTooltip, reportMacroError,
  resolveMacro, RUN_MODES, setMacroUuids, updateMacroSetting
} from "./macro-config.mjs";

const SECTION_CLASS = "advanced-activities-macros";
const TAB_CLASS = "advanced-activities-macro-tab";
const TAB_ID = "macro";
const TAB_GROUP = "sheet";
const renderTokens = new WeakMap();
const expandedMacroSettings = new WeakMap();

function resolveActivitySheetClass() {
  const direct = globalThis.dnd5e?.applications?.activity?.ActivitySheet;
  if ( typeof direct === "function" ) return direct;

  for ( const config of Object.values(CONFIG.DND5E?.activityTypes ?? {}) ) {
    let cls = config?.documentClass?.metadata?.sheetClass;
    while ( typeof cls === "function" ) {
      if ( cls.name === "ActivitySheet" ) return cls;
      cls = Object.getPrototypeOf(cls);
    }
  }
  return null;
}

function collectTabProviders() {
  const classes = new Set();

  const walk = cls => {
    while ( (typeof cls === "function") && cls.prototype ) {
      if ( Object.hasOwn(cls.prototype, "_getTabs") ) classes.add(cls);
      if ( cls.name === "ActivitySheet" ) break;
      cls = Object.getPrototypeOf(cls);
    }
  };

  walk(resolveActivitySheetClass());
  for ( const config of Object.values(CONFIG.DND5E?.activityTypes ?? {}) ) {
    walk(config?.documentClass?.metadata?.sheetClass);
  }
  return classes;
}

export function registerMacroTab() {
  const classes = collectTabProviders();
  if ( !classes.size ) {
    console.error(`${MODULE_ID} | Unable to locate any dnd5e activity sheet class; the Macro tab was not added.`);
    return;
  }

  for ( const cls of classes ) {
    if ( Object.hasOwn(cls.prototype, "_advancedActivitiesPatched") ) continue;
    const original = cls.prototype._getTabs;
    cls.prototype._getTabs = function(...args) {
      const tabs = original.apply(this, args);
      if ( tabs.effect?.label === "DND5E.TRANSFORM.SECTIONS.Transformation" ) {
        tabs.effect.label = "ADVANCED_ACTIVITIES.TransformTab";
      }
      const macroTabs = this._markTabs({
        [TAB_ID]: {
          id: TAB_ID,
          group: TAB_GROUP,
          icon: CONFIG.Macro?.sidebarIcon ?? "fa-solid fa-code",
          label: "ADVANCED_ACTIVITIES.MacroTab"
        }
      });
      const resultTabs = {};
      for ( const [id, tab] of Object.entries(tabs) ) {
        if ( id === TAB_ID ) continue;
        resultTabs[id] = tab;
        if ( id === "activation" ) Object.assign(resultTabs, macroTabs);
      }
      if ( !Object.hasOwn(resultTabs, TAB_ID) ) Object.assign(resultTabs, macroTabs);
      return resultTabs;
    };
    cls.prototype._advancedActivitiesPatched = true;
  }
}

export function onRenderActivitySheet(app, element) {
  const html = element instanceof HTMLElement ? element : element?.[0];
  if ( !html ) return;

  const activity = app?.activity ?? app?.document;
  if ( !activity?.item ) return;

  const container = html.querySelector(".window-content") ?? html;

  for ( const existing of html.querySelectorAll(`.${TAB_CLASS}`) ) existing.remove();

  const token = (renderTokens.get(app) ?? 0) + 1;
  renderTokens.set(app, token);

  const editable = app.isEditable !== false;
  const section = buildTabSection(editable);
  container.append(section);

  if ( app.tabGroups?.[TAB_GROUP] === TAB_ID ) {
    section.classList.add("active");
    html.querySelector('.window-content > [data-application-part="tabs"]')?.classList.remove("nested-tabs");
  }

  if ( editable ) activateDropArea(activity, section.querySelector(".macro-drop-area"));

  populateMacroList(app, activity, section, editable, token).catch(reportMacroError);
}

function buildTabSection(editable) {
  const section = document.createElement("section");
  section.className = `tab activity-macro ${TAB_CLASS}`;
  section.dataset.tab = TAB_ID;
  section.dataset.group = TAB_GROUP;

  const fieldset = document.createElement("fieldset");
  fieldset.classList.add(SECTION_CLASS);

  const legend = document.createElement("legend");
  const title = document.createElement("span");
  title.textContent = localize("ADVANCED_ACTIVITIES.Macros");
  legend.append(title);
  fieldset.append(legend);

  const list = document.createElement("ul");
  list.className = "separated-list macros-list flexcol unlist";
  fieldset.append(list);

  if ( editable ) {
    const dropArea = document.createElement("div");
    dropArea.className = "drop-area macro-drop-area";
    dropArea.textContent = localize("ADVANCED_ACTIVITIES.MacrosDropHint");
    fieldset.append(dropArea);
  }

  section.append(fieldset);
  return section;
}

async function populateMacroList(app, activity, section, editable, token) {
  const uuids = getMacroUuids(activity);
  if ( !expandedMacroSettings.has(app) ) expandedMacroSettings.set(app, new Set());
  const expanded = expandedMacroSettings.get(app);
  const rows = uuids.length
    ? await Promise.all(uuids.map((uuid, index) => buildMacroRow(activity, uuid, index, editable, expanded)))
    : [];
  if ( (renderTokens.get(app) !== token) || !section.isConnected ) return;

  const list = section.querySelector("ul.macros-list");
  if ( !list ) return;
  list.replaceChildren();

  if ( !rows.length ) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = localize("ADVANCED_ACTIVITIES.MacrosEmpty");
    list.append(empty);
    return;
  }

  list.append(...rows);
  if ( editable ) activateRowListeners(activity, list);
}

async function buildMacroRow(activity, uuid, index, editable, expanded) {
  let macro = null;
  try {
    macro = await resolveMacro(uuid);
  } catch {
    macro = null;
  }

  const li = document.createElement("li");
  li.classList.add("macro-row");
  li.dataset.index = String(index);
  li.dataset.uuid = uuid;

  const details = document.createElement("div");
  details.className = "details flexrow";

  details.append(buildMacroIcon(macro));

  if ( macro ) {
    const anchor = macro.toAnchor();
    anchor.classList.add("content-link");
    anchor.dataset.tooltipHtml = await renderMacroTooltip(macro);
    anchor.dataset.tooltipClass = "dnd5e2 dnd5e-tooltip effect-tooltip document-tooltip";
    anchor.addEventListener("click", event => {
      event.preventDefault();
      event.stopImmediatePropagation();
      Promise.resolve().then(() => macro.sheet.render({ force: true })).catch(reportMacroError);
    });
    details.append(anchor);
  } else {
    const missing = document.createElement("span");
    missing.className = "name macro-missing";
    missing.textContent = localize("ADVANCED_ACTIVITIES.MacroMissing");
    details.append(missing);
  }

  if ( editable ) {
    const controls = document.createElement("div");
    controls.className = "list-controls flexrow";
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "unbutton control-button macro-remove";
    remove.dataset.tooltip = localize("ADVANCED_ACTIVITIES.ActionDelete");
    remove.setAttribute("aria-label", localize("ADVANCED_ACTIVITIES.ActionDelete"));
    const minus = document.createElement("i");
    minus.className = "fa-solid fa-minus";
    minus.toggleAttribute("inert", true);
    remove.append(minus);
    controls.append(remove);
    details.append(controls);
  }

  li.append(details);
  li.append(buildMacroSettings(activity, uuid, editable, expanded));
  return li;
}

function buildMacroSettings(activity, uuid, editable, expanded = new Set()) {
  const level = getMacroLevel(activity, uuid);
  const { tray, wrapper } = createSettingsTray(uuid, expanded);
  const { group, inputs } = createLevelRangeGroup(level, "ADVANCED_ACTIVITIES.LevelHint", editable);
  wrapper.append(group);
  for ( const input of inputs ) {
    input.addEventListener("change", async event => {
      event.stopPropagation();
      const [min, max] = inputs.map(field => field.value === "" ? null : Number(field.value));
      try {
        await updateMacroSetting(activity, uuid, { level: { min, max } });
      } catch (error) {
        const saved = getMacroLevel(activity, uuid);
        inputs[0].value = saved.min ?? "";
        inputs[1].value = saved.max ?? "";
        reportMacroError(error);
      }
    });
  }
  wrapper.append(buildRunModeGroup(activity, uuid, editable));
  return tray;
}

function buildRunModeGroup(activity, uuid, editable) {
  const group = document.createElement("div");
  group.className = "form-group";
  const id = `macro-run-mode-${foundry.utils.randomID()}`;
  const label = document.createElement("label");
  label.htmlFor = id;
  label.textContent = localize("ADVANCED_ACTIVITIES.RunMode");
  const fields = document.createElement("div");
  fields.className = "form-fields";
  const select = document.createElement("select");
  select.id = id;
  select.disabled = !editable;
  const current = getMacroRunMode(activity, uuid);
  for ( const mode of RUN_MODES ) {
    const option = document.createElement("option");
    option.value = mode;
    option.textContent = localize(`ADVANCED_ACTIVITIES.RunModes.${mode}`);
    option.selected = mode === current;
    select.append(option);
  }
  select.addEventListener("change", async event => {
    event.stopPropagation();
    try {
      await updateMacroSetting(activity, uuid, { run: select.value });
    } catch (error) {
      select.value = getMacroRunMode(activity, uuid);
      reportMacroError(error);
    }
  });
  fields.append(select);
  group.append(label, fields);
  return group;
}

function buildMacroIcon(macro) {
  const img = macro?.img || "icons/svg/dice-target.svg";
  if ( img.toLowerCase().endsWith(".svg") && customElements.get("dnd5e-icon") ) {
    const icon = document.createElement("dnd5e-icon");
    icon.classList.add("gold-icon");
    icon.setAttribute("src", img);
    return icon;
  }
  const icon = document.createElement("img");
  icon.classList.add("gold-icon");
  icon.src = img;
  icon.alt = macro?.name ?? "";
  return icon;
}

function activateRowListeners(activity, list) {
  for ( const button of list.querySelectorAll("button.macro-remove") ) {
    button.addEventListener("click", event => {
      event.preventDefault();
      event.stopPropagation();
      const index = Number(button.closest(".macro-row")?.dataset.index);
      if ( !Number.isInteger(index) ) return;
      const uuids = getMacroUuids(activity);
      if ( index < 0 || index >= uuids.length ) return;
      uuids.splice(index, 1);
      setMacroUuids(activity, uuids).catch(reportMacroError);
    });
  }
}

function activateDropArea(activity, dropArea) {
  if ( !dropArea ) return;

  dropArea.addEventListener("dragover", event => {
    event.preventDefault();
    event.stopPropagation();
    if ( event.dataTransfer ) event.dataTransfer.dropEffect = "copy";
    dropArea.classList.add("dragover");
  });

  for ( const type of ["dragleave", "dragend", "drop"] ) {
    dropArea.addEventListener(type, () => dropArea.classList.remove("dragover"));
  }

  dropArea.addEventListener("drop", event => {
    event.preventDefault();
    event.stopPropagation();
    handleMacroDrop(activity, event).catch(reportMacroError);
  });
}

async function handleMacroDrop(activity, event) {
  let data;
  try {
    data = getTextEditor().getDragEventData(event);
  } catch {
    data = null;
  }
  if ( !data ) return;

  if ( data.type !== "Macro" ) {
    ui.notifications?.warn(localize("ADVANCED_ACTIVITIES.WarnNotAMacro"));
    return;
  }

  const macro = data.uuid ? await resolveMacro(data.uuid) : null;
  if ( !macro ) {
    ui.notifications?.warn(localize("ADVANCED_ACTIVITIES.WarnUnresolved"));
    return;
  }

  const uuids = getMacroUuids(activity);
  if ( uuids.includes(macro.uuid) ) {
    ui.notifications?.warn(localize("ADVANCED_ACTIVITIES.WarnDuplicate"));
    return;
  }

  uuids.push(macro.uuid);
  await setMacroUuids(activity, uuids);
}
