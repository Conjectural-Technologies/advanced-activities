import { createSettingsTray, localize, MODULE_ID } from "./module-config.mjs";
import { getTextEditor } from "./macro-config.mjs";
import { prepareGrantExpiration } from "./grant-expiration.mjs";

const GRANT_TEMPLATE = `modules/${MODULE_ID}/templates/activity/grant.hbs`;
const GRANT_ICON = `modules/${MODULE_ID}/assets/svg/present.svg`;
const MAX_GRANT_QUANTITY = 1000;
const renderedApplications = new WeakMap();
const expandedGrantSettings = new WeakMap();

function grantItems(activity) {
  return activity.grant.items.map(item => foundry.utils.deepClone(item.toObject?.() ?? item));
}

async function updateGrantItems(app, items) {
  await app.activity.update({ "grant.items": items });
  await app.render({ force: true });
}

function levelAllowsGrant(activity, item) {
  const { min, max } = item.level ?? {};
  if ( min === null && max === null ) return true;
  const level = activity.relevantLevel;
  return Number.isFinite(level) && level >= (min ?? 0) && level <= (max ?? Infinity);
}

async function evaluateGrantQuantity(activity, entry) {
  const formula = entry.quantity?.trim() || "1";
  const roll = Roll.create(formula, activity.item?.actor?.getRollData?.() ?? {});
  await roll.evaluate({ strict: false });
  const quantity = roll.total;
  if ( !Number.isSafeInteger(quantity) || quantity < 0 || quantity > MAX_GRANT_QUANTITY ) {
    throw new Error(localize("ADVANCED_ACTIVITIES.Grant.QuantityInvalid", { formula }));
  }
  return quantity;
}

function copyGrantRiders(activity, grant, sourceItem, itemData) {
  const originItem = activity.item;
  const copiedEffects = new Map();
  const effectData = [];
  const copyEffect = id => {
    if ( copiedEffects.has(id) ) return copiedEffects.get(id);
    const effect = originItem?.effects.get(id);
    if ( !effect ) return null;
    const data = effect.toObject();
    data._id = foundry.utils.randomID();
    delete data.flags?.dnd5e?.dependentOn;
    copiedEffects.set(id, data._id);
    effectData.push(data);
    return data._id;
  };

  const itemModel = CONFIG.Item.dataModels[sourceItem.type];
  if ( itemModel?.schema.fields.activities && itemData.system.activities ) {
    for ( const id of grant.riders?.activity ?? [] ) {
      const sourceActivity = originItem?.system.activities.get(id);
      if ( !sourceActivity ) continue;
      const data = sourceActivity.toObject();
      const activityId = foundry.utils.randomID();
      data._id = activityId;
      delete data.flags?.dnd5e?.dependentOn;
      data.effects = (data.effects ?? []).filter(applied => {
        if ( applied.uuid ) return true;
        const effectId = copyEffect(applied._id);
        if ( !effectId ) return false;
        applied._id = effectId;
        return true;
      });
      itemData.system.activities[activityId] = data;
    }
  }

  for ( const id of grant.riders?.effect ?? [] ) copyEffect(id);
  if ( effectData.length ) itemData.effects = [...(itemData.effects ?? []), ...effectData];
}

function createItemIcon(item) {
  const img = item?.img || "icons/svg/item-bag.svg";
  if ( img.toLowerCase().endsWith(".svg") && customElements.get("dnd5e-icon") ) {
    const icon = document.createElement("dnd5e-icon");
    icon.classList.add("gold-icon");
    icon.setAttribute("src", img);
    icon.setAttribute("alt", item?.name ?? "");
    return icon;
  }
  const icon = document.createElement("img");
  icon.className = "gold-icon";
  icon.src = img;
  icon.alt = item?.name ?? "";
  return icon;
}

function createGrantSettings(app, entry, item, index, expanded) {
  const { tray, wrapper } = createSettingsTray(entry._id, expanded);
  wrapper.classList.add("grant-settings");

  const formulaField = CONFIG.DND5E.activityTypes.utility.documentClass.schema.fields.roll.fields.formula;
  const quantityGroup = formulaField.toFormGroup({
    label: localize("ADVANCED_ACTIVITIES.Grant.Quantity"),
    hint: localize("ADVANCED_ACTIVITIES.Grant.QuantityHint"),
    rootId: `grant-${entry._id}`
  }, {
    name: "",
    value: entry.quantity ?? "",
    placeholder: ""
  });
  const quantityInput = quantityGroup.querySelector("formula-input");
  quantityInput.removeAttribute("name");

  const levelGroup = document.createElement("div");
  levelGroup.className = "form-group";
  const levelLabel = document.createElement("label");
  levelLabel.textContent = localize("DND5E.ACTIVITY.FIELDS.effects.element.level.label");
  const levelFields = document.createElement("div");
  levelFields.className = "form-fields range-fields";
  const levelInputs = ["min", "max"].map(bound => {
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.step = "1";
    input.placeholder = bound === "min" ? "0" : "\u221e";
    input.value = entry.level?.[bound] ?? "";
    input.setAttribute("aria-label", localize(`DND5E.LevelLimit.${bound === "min" ? "Min" : "Max"}`));
    return input;
  });
  const connector = document.createElement("dnd5e-icon");
  connector.className = "sep";
  connector.setAttribute("src", "systems/dnd5e/icons/svg/range-connector.svg");
  levelFields.append(levelInputs[0], connector, levelInputs[1]);
  const levelHint = document.createElement("p");
  levelHint.className = "hint";
  levelHint.textContent = localize("ADVANCED_ACTIVITIES.Grant.LevelHint");
  levelGroup.append(levelLabel, levelFields, levelHint);
  wrapper.append(quantityGroup, levelGroup);

  const saveEntry = async change => {
    const items = grantItems(app.activity);
    const current = items[index];
    if ( !current ) return;
    change(current);
    await updateGrantItems(app, items);
  };

  quantityInput.addEventListener("change", async () => {
    const quantity = quantityInput.value.trim();
    try {
      await saveEntry(current => {
        current.quantity = quantity;
      });
    } catch (error) {
      quantityInput.value = entry.quantity ?? "";
      console.error(`${MODULE_ID} | Invalid Grant quantity formula.`, error);
    }
  });

  for ( const input of levelInputs ) {
    input.addEventListener("change", async () => {
      const values = levelInputs.map(field => field.value === "" ? null : Number(field.value));
      if ( !values.every(value => value === null || (Number.isSafeInteger(value) && value >= 0))
        || (values[0] !== null && values[1] !== null && values[0] > values[1]) ) {
        input.value = entry.level?.[input === levelInputs[0] ? "min" : "max"] ?? "";
        return;
      }
      await saveEntry(current => {
        current.level = { min: values[0], max: values[1] };
      });
    });
  }

  const activityModel = item && CONFIG.Item.dataModels[item.type];
  const activityOptions = activityModel?.schema.fields.activities
    ? Array.from(app.activity.item?.system.activities ?? [])
      .filter(activity => activity.id !== app.activity.id)
      .map(activity => ({ value: activity.id, label: activity.name }))
    : [];
  const effectOptions = Array.from(app.activity.item?.effects ?? [])
    .filter(effect => effect.type === "base")
    .map(effect => ({ value: effect.id, label: effect.name }));

  const addMultiSelect = (key, labelText, hintText, options) => {
    const group = document.createElement("div");
    group.className = "form-group";
    const selectLabel = document.createElement("label");
    const fieldId = `grant-${entry._id}-${key}`;
    selectLabel.htmlFor = fieldId;
    selectLabel.textContent = labelText;
    const fields = document.createElement("div");
    fields.className = "form-fields";
    const select = document.createElement("multi-select");
    select.id = fieldId;
    select.setAttribute("aria-label", labelText);
    const selected = new Set(entry.riders?.[key] ?? []);
    for ( const option of options ) {
      const element = document.createElement("option");
      element.value = option.value;
      element.textContent = option.label;
      element.selected = selected.has(option.value);
      select.append(element);
    }
    select.addEventListener("change", () => saveEntry(current => {
      current.riders ??= { activity: [], effect: [] };
      current.riders[key] = select.value;
    }));
    fields.append(select);
    const hint = document.createElement("p");
    hint.className = "hint";
    hint.textContent = hintText;
    group.append(selectLabel, fields, hint);
    wrapper.append(group);
  };

  addMultiSelect(
    "activity",
    localize("ADVANCED_ACTIVITIES.Grant.AdditionalActivities"),
    localize("ADVANCED_ACTIVITIES.Grant.AdditionalActivitiesHint"),
    activityOptions
  );
  addMultiSelect(
    "effect",
    localize("ADVANCED_ACTIVITIES.Grant.AdditionalEffects"),
    localize("ADVANCED_ACTIVITIES.Grant.AdditionalEffectsHint"),
    effectOptions
  );

  return tray;
}

async function renderGrantItems(app, html) {
  const list = html.querySelector(".grant-items-list");
  if ( !list ) return;
  if ( !expandedGrantSettings.has(app) ) expandedGrantSettings.set(app, new Set());
  const expanded = expandedGrantSettings.get(app);
  const token = (renderedApplications.get(app) ?? 0) + 1;
  renderedApplications.set(app, token);
  const activity = app.activity;
  const rows = await Promise.all(activity.grant.items.map(async (entry, index) => ({
    entry: foundry.utils.deepClone(entry.toObject?.() ?? entry),
    index,
    item: await fromUuid(entry.uuid).catch(() => null)
  })));
  if ( renderedApplications.get(app) !== token || !list.isConnected ) return;

  list.replaceChildren();
  if ( !rows.length ) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = localize("ADVANCED_ACTIVITIES.Grant.ItemsEmpty");
    list.append(empty);
  }

  for ( const row of rows ) {
    const li = document.createElement("li");
    li.className = "grant-item-row";
    li.dataset.index = String(row.index);
    li.dataset.uuid = row.entry.uuid;
    const details = document.createElement("div");
    details.className = "details flexrow";
    details.append(createItemIcon(row.item));

    if ( row.item ) {
      const anchor = row.item.toAnchor();
      anchor.classList.add("content-link");
      anchor.addEventListener("click", event => {
        event.preventDefault();
        event.stopImmediatePropagation();
        Promise.resolve().then(() => row.item.sheet.render({ force: true }));
      });
      details.append(anchor);
    } else {
      const missing = document.createElement("span");
      missing.className = "name grant-item-missing";
      missing.textContent = localize("ADVANCED_ACTIVITIES.Grant.ItemMissing");
      details.append(missing);
    }

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "unbutton control-button grant-remove";
    remove.dataset.tooltip = localize("ADVANCED_ACTIVITIES.Grant.RemoveItem");
    remove.setAttribute("aria-label", localize("ADVANCED_ACTIVITIES.Grant.RemoveItem"));
    remove.innerHTML = '<i class="fa-solid fa-minus" inert></i>';
    remove.addEventListener("click", async event => {
      event.preventDefault();
      event.stopPropagation();
      const items = grantItems(activity);
      items.splice(row.index, 1);
      await updateGrantItems(app, items);
    });
    const controls = document.createElement("div");
    controls.className = "list-controls flexrow";
    controls.append(remove);
    details.append(controls);
    li.append(details, createGrantSettings(app, row.entry, row.item, row.index, expanded));
    list.append(li);
  }
}

async function handleGrantDrop(app, event) {
  let data;
  try {
    data = getTextEditor().getDragEventData(event);
  } catch {
    data = null;
  }
  if ( data?.type !== "Item" || typeof data.uuid !== "string" || !data.uuid ) return;
  const uuid = data.uuid;
  const item = await fromUuid(uuid);
  if ( item?.documentName !== "Item" ) return;
  const activity = app.activity;
  const items = grantItems(activity);
  if ( items.some(entry => entry.uuid === uuid) ) return;
  items.push({
    _id: foundry.utils.randomID(),
    uuid,
    quantity: "",
    level: { min: null, max: null },
    riders: { activity: [], effect: [] }
  });
  await updateGrantItems(app, items);
}

export function onRenderGrantActivitySheet(app, element) {
  const html = element instanceof HTMLElement ? element : element?.[0];
  if ( !html || (app?.activity ?? app?.document)?.type !== "grant" ) return;
  const dropArea = html.querySelector(".grant-drop-area");
  if ( !dropArea ) return;
  renderGrantItems(app, html).catch(error => console.error(`${MODULE_ID} | Could not render grant items.`, error));
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
    handleGrantDrop(app, event).catch(error => console.error(`${MODULE_ID} | Could not add a grant item.`, error));
  });
}

export function registerGrantActivity() {
  const dnd5eActivity = globalThis.dnd5e?.documents?.activity;
  const ActivityMixin = dnd5eActivity?.ActivityMixin;
  const UtilitySheet = dnd5eActivity?.UtilityActivity?.metadata?.sheetClass;
  const ActivitySheet = UtilitySheet && Object.getPrototypeOf(UtilitySheet);
  const ActivityData = globalThis.dnd5e?.dataModels?.activity;
  const FormulaField = dnd5eActivity?.UtilityActivity?.schema?.fields?.roll?.fields?.formula?.constructor;
  if ( !ActivityMixin || !ActivitySheet || !ActivityData?.BaseActivityData || !FormulaField ) {
    console.error(`${MODULE_ID} | Unable to register the Grant activity.`);
    return;
  }

  const { ArrayField, DocumentIdField, DocumentUUIDField, NumberField, SchemaField, SetField } = foundry.data.fields;

  class GrantActivityData extends ActivityData.BaseActivityData {
    static defineSchema() {
      return {
        ...super.defineSchema(),
        grant: new SchemaField({
          items: new ArrayField(new SchemaField({
            _id: new DocumentIdField({ initial: () => foundry.utils.randomID() }),
            uuid: new DocumentUUIDField({ type: "Item" }),
            quantity: new FormulaField({ initial: "", required: true, blank: true }),
            level: new SchemaField({
              min: new NumberField({ min: 0, integer: true, nullable: true }),
              max: new NumberField({ min: 0, integer: true, nullable: true })
            }),
            riders: new SchemaField({
              activity: new SetField(new DocumentIdField()),
              effect: new SetField(new DocumentIdField())
            })
          }))
        })
      };
    }

  }

  class GrantActivitySheet extends ActivitySheet {
    static DEFAULT_OPTIONS = {
      ...super.DEFAULT_OPTIONS,
      classes: [...(super.DEFAULT_OPTIONS.classes ?? []), "grant-activity"]
    };

    static PARTS = {
      ...super.PARTS,
      effect: { template: GRANT_TEMPLATE }
    };

    tabGroups = { sheet: "identity", activation: "time" };

    _getTabs(...args) {
      const tabs = super._getTabs(...args);
      if ( tabs.effect ) {
        tabs.effect.label = "ADVANCED_ACTIVITIES.Grant.Tab";
        tabs.effect.icon = "fa-solid fa-gift";
      }
      return tabs;
    }

  }

  class GrantActivity extends ActivityMixin(GrantActivityData) {
    static LOCALIZATION_PREFIXES = [...super.LOCALIZATION_PREFIXES, "ADVANCED_ACTIVITIES.Grant"];

    static metadata = Object.freeze(foundry.utils.mergeObject(super.metadata, {
      type: "grant",
      img: GRANT_ICON,
      title: "ADVANCED_ACTIVITIES.Grant.Title",
      hint: "ADVANCED_ACTIVITIES.Grant.Hint",
      sheetClass: GrantActivitySheet
    }, { inplace: false }));

    get canUse() {
      return super.canUse && this.grant?.items?.some(item => item.uuid) === true;
    }

    async _triggerSubsequentActions(config, results) {
      await super._triggerSubsequentActions(config, results);
      const grants = this.grant.items.filter(item => item.uuid && levelAllowsGrant(this, item));
      if ( !grants.length ) return;

      const targetActors = this.target?.affects?.type === "self" ? [this.item.actor] : [];
      const targetUuids = results.message?.system?.targets?.map(target => target.actor).filter(Boolean) ?? [];
      for ( const uuid of new Set(targetUuids) ) {
        const actor = await fromUuid(uuid);
        if ( actor?.documentName === "Actor" && actor.isOwner ) targetActors.push(actor);
      }

      const actors = new Map(targetActors.filter(actor => actor?.isOwner).map(actor => [actor.uuid, actor]));
      if ( !actors.size ) return;
      for ( const grant of grants ) {
        const sourceItem = await fromUuid(grant.uuid);
        if ( sourceItem?.documentName !== "Item" ) {
          throw new Error(localize("ADVANCED_ACTIVITIES.Grant.ItemUnavailable"));
        }
        const quantity = await evaluateGrantQuantity(this, grant);
        if ( quantity === 0 ) continue;
        const isStackable = Boolean(CONFIG.Item.dataModels[sourceItem.type]?.schema.fields.quantity);
        for ( const actor of actors.values() ) {
          const roots = isStackable ? [sourceItem] : Array.from({ length: quantity }, () => sourceItem);
          const itemData = await CONFIG.Item.documentClass.createWithContents(roots, {
            transformFirst: item => {
              const copy = item.clone({}, { keepId: true });
              const data = copy.toObject();
              if ( isStackable ) data.system.quantity = quantity;
              copyGrantRiders(this, grant, item, data);
              prepareGrantExpiration(this, results, actor, data);
              copy.updateSource(data);
              return copy;
            }
          });
          if ( itemData?.length ) {
            await actor.createEmbeddedDocuments("Item", itemData, { keepId: true });
          }
        }
      }
    }
  }

  GrantActivity.localize();
  CONFIG.DND5E.activityTypes.grant = { documentClass: GrantActivity };
  Hooks.on("renderActivitySheet", onRenderGrantActivitySheet);
}