import { localize, MODULE_ID } from "./module-config.mjs";

const FLAG_KEY = "hideFromPlayers";
const patchedClasses = new WeakSet();
let patchedActivityChoiceDialog = false;
let patchedItemUse = false;

function getHiddenGetter(prototype) {
  while ( prototype ) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "isHidden");
    if ( descriptor?.get ) return descriptor.get;
    prototype = Object.getPrototypeOf(prototype);
  }
  return null;
}

export function registerActivityVisibility() {
  const classes = new Set(Object.values(CONFIG.DND5E.activityTypes ?? {})
    .map(config => config?.documentClass)
    .filter(cls => typeof cls === "function" && cls.prototype));

  for ( const cls of classes ) {
    if ( patchedClasses.has(cls) ) continue;
    const original = getHiddenGetter(cls.prototype);
    if ( !original ) continue;
    Object.defineProperty(cls.prototype, "isHidden", {
      configurable: true,
      get() {
        return original.call(this) || (!game.user.isGM && this.flags?.[MODULE_ID]?.[FLAG_KEY] === true);
      }
    });
    patchedClasses.add(cls);
  }

  const ActivityChoiceDialog = globalThis.dnd5e?.applications?.activity?.ActivityChoiceDialog;
  if ( ActivityChoiceDialog && !patchedActivityChoiceDialog ) {
    const original = ActivityChoiceDialog.prototype._prepareContext;
    ActivityChoiceDialog.prototype._prepareContext = async function(...args) {
      const context = await original.apply(this, args);
      const hidden = new Set(this.item.system.activities
        .filter(activity => activity.flags?.[MODULE_ID]?.[FLAG_KEY] === true)
        .map(activity => activity.id));
      context.activities = context.activities.filter(activity => !hidden.has(activity.id));
      return context;
    };
    patchedActivityChoiceDialog = true;
  }

  const Item = globalThis.dnd5e?.documents?.Item5e;
  if ( Item && !patchedItemUse ) {
    const originalUse = Item.prototype.use;
    Item.prototype.use = async function(config={}, dialog={}, message={}) {
      const usable = this.system.activities?.filter(activity => activity.canUse) ?? [];
      const selectable = usable.filter(activity => activity.flags?.[MODULE_ID]?.[FLAG_KEY] !== true);
      if ( usable.length !== selectable.length ) {
        if ( selectable.length === 1 ) return selectable[0].use(config, dialog, message);
        if ( selectable.length === 0 ) return this.actor ? this.displayCard(message) : undefined;
      }
      return originalUse.call(this, config, dialog, message);
    };
    patchedItemUse = true;
  }
}

export function onRenderActivityVisibility(app, element) {
  const html = element instanceof HTMLElement ? element : element?.[0];
  const activity = app?.activity ?? app?.document;
  if ( !html || !activity?.item ) return;

  const requireMagic = html.querySelector('dnd5e-checkbox[name="visibility.requireMagic"]');
  const requireMagicGroup = requireMagic?.closest(".form-group");
  const visibility = requireMagicGroup?.closest("fieldset");
  if ( !requireMagicGroup || !visibility || visibility.querySelector(".advanced-activities-hide-from-players") ) return;

  const group = document.createElement("div");
  group.className = "form-group advanced-activities-hide-from-players";
  const id = `${app.id}-advanced-activities-hide-from-players`;
  const label = document.createElement("label");
  label.htmlFor = id;
  label.textContent = localize("ADVANCED_ACTIVITIES.Visibility.HideFromPlayers");
  const fields = document.createElement("div");
  fields.className = "form-fields";
  const checkbox = document.createElement("dnd5e-checkbox");
  checkbox.id = id;
  checkbox.checked = activity.flags?.[MODULE_ID]?.[FLAG_KEY] === true;
  checkbox.disabled = app.isEditable === false;
  checkbox.setAttribute("aria-label", label.textContent);
  checkbox.addEventListener("change", () => {
    activity.update({ [`flags.${MODULE_ID}.${FLAG_KEY}`]: checkbox.checked }).catch(error => {
      console.error(`${MODULE_ID} | Could not update activity visibility.`, error);
      checkbox.checked = activity.flags?.[MODULE_ID]?.[FLAG_KEY] === true;
    });
  });
  fields.append(checkbox);
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = localize("ADVANCED_ACTIVITIES.Visibility.HideFromPlayersHint");
  group.append(label, fields, hint);
  requireMagicGroup.before(group);
}