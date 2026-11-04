export const MODULE_ID = "advanced-activities";
export const TIMING_FLAG_KEY = "pendingActivations";

export function localize(key, data) {
  return data ? game.i18n.format(key, data) : game.i18n.localize(key);
}

export function setButtonLabel(button, label) {
  button.setAttribute("aria-label", label);
  button.dataset.tooltip = label;
}

export function isValidLevelRange({ min, max }) {
  return [min, max].every(value => value === null || (Number.isSafeInteger(value) && value >= 0))
    && !(min !== null && max !== null && min > max);
}

export function createLevelRangeGroup(level, hintKey, editable = true) {
  const group = document.createElement("div");
  group.className = "form-group";
  const label = document.createElement("label");
  label.textContent = localize("DND5E.ACTIVITY.FIELDS.effects.element.level.label");
  const fields = document.createElement("div");
  fields.className = "form-fields range-fields";
  const inputs = ["min", "max"].map(bound => {
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.step = "1";
    input.placeholder = bound === "min" ? "0" : "\u221e";
    input.value = level?.[bound] ?? "";
    input.disabled = !editable;
    input.setAttribute("aria-label", localize(`DND5E.LevelLimit.${bound === "min" ? "Min" : "Max"}`));
    return input;
  });
  const connector = document.createElement("dnd5e-icon");
  connector.className = "sep";
  connector.setAttribute("src", "systems/dnd5e/icons/svg/range-connector.svg");
  fields.append(inputs[0], connector, inputs[1]);
  const hint = document.createElement("p");
  hint.className = "hint";
  hint.textContent = localize(hintKey);
  group.append(label, fields, hint);
  return { group, inputs };
}

export function createSettingsTray(key, expanded) {
  const tray = document.createElement("div");
  tray.className = `additional-tray collapsible${expanded.has(key) ? "" : " collapsed"}`;
  const label = document.createElement("label");
  label.className = "roboto-upper";
  label.tabIndex = 0;
  label.setAttribute("role", "button");
  label.setAttribute("aria-expanded", String(expanded.has(key)));
  label.innerHTML = `<i class="fa-solid fa-gears" inert></i><span>${foundry.utils.escapeHTML(
    localize("DND5E.AdditionalSettings")
  )}</span><i class="fa-solid fa-caret-down" inert></i>`;
  const toggle = () => {
    tray.classList.toggle("collapsed");
    const open = !tray.classList.contains("collapsed");
    if ( open ) expanded.add(key);
    else expanded.delete(key);
    label.setAttribute("aria-expanded", String(open));
  };
  label.addEventListener("click", toggle);
  label.addEventListener("keydown", event => {
    if ( !["Enter", " "].includes(event.key) ) return;
    event.preventDefault();
    toggle();
  });
  const content = document.createElement("div");
  content.className = "collapsible-content";
  const wrapper = document.createElement("div");
  wrapper.className = "wrapper";
  content.append(wrapper);
  tray.append(label, content);
  return { tray, wrapper };
}
