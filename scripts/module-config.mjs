export const MODULE_ID = "advanced-activities";

export function localize(key, data) {
  return data ? game.i18n.format(key, data) : game.i18n.localize(key);
}

export function setButtonLabel(button, label) {
  button.setAttribute("aria-label", label);
  button.dataset.tooltip = label;
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
