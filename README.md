# Advanced Activities

Extends D&D 5e item activities in Foundry VTT v14 with a new **Grant** activity, macros attached to activities, delayed activation, and per-activity visibility.

**Requirements:** Foundry VTT 14.367 or newer and the D&D 5e system 6.0.6 or newer. The module adds no settings and no compendium content.

## Installation

In Foundry's **Add-on Modules** tab choose **Install Module** and paste this manifest URL:

```
https://github.com/Conjectural-Technologies/advanced-activities/releases/latest/download/module.json
```

## Features

### Grant activity
A new activity type, **Grant**, gives items to actors when it is used.

- **Who receives the items:** the activity's own actor when it targets itself, otherwise the owned actors among its resolved targets. Targets the user does not own are ignored.
- **Associated Items:** drag items onto the Grant tab. Missing or unresolved items are flagged, and any item can be removed.
- **Number of Items:** a formula, evaluated separately for each grant, that must resolve to a whole number from 0 to 1000. Stackable items receive the result as their quantity, and other items are copied once per unit.
- **Level range:** an optional minimum and maximum relevant level for each item. Ranges must be whole numbers, and the minimum cannot exceed the maximum.
- **Additional Activities and Additional Effects:** choose which of the source item's other activities and base effects are copied onto the granted item.
- Granted items keep their embedded contents, and the grant runs after the activity's other actions.
- The activity can only be used when at least one configured item is set.

### Grant expiration
Granted items can remove themselves automatically using the activity's normal duration settings.

- Duration in seconds, minutes, hours or days of world time.
- Duration in combat rounds or turns.
- Expiry at a rest.
- Expiry when the source actor's concentration ends.
- Expiry data is stored on the granted item, and cleanup runs on world-time changes, combat events, rests, loss of concentration and at startup.

### Associated macros
Activities get a **Macro** tab.

- Drag macros onto the tab to associate them. Missing macros are shown, and each one can be removed.
- Each macro can have its own relevant-level range, and macros outside their range are not offered.
- The activity's chat card gains a collapsible **Macros** tray that follows the D&D 5e auto-collapse setting for chat trays.
- Select one macro, or Shift-click several, to run them. A macro only runs for users who have permission to execute it.
- Macros receive the speaker, actor, token, activity, item, usage configuration, use results, resolved targets, target actors and tokens, and a single `target` when there is exactly one.

### Timed activation
Activities with an activation time are scheduled instead of firing immediately.

- Scheduling uses world time, and the original use configuration is saved so the activity completes later.
- Pending activations survive a reload.
- The chat card shows the activation time, the time remaining, and a **Cancel** control for the user who started it. If that user is offline, the card says it is waiting for them to reconnect.
- When the time arrives, the activation is checked again for document existence, ownership, permissions and usability before it completes.
- Interrupted or failed activations are marked and reported on the card.
- Options that cannot be saved, such as custom functions, are rejected up front.

### Hide Activity
- A **Hide Activity** checkbox in an activity's visibility settings hides it from players. GMs still see and use it.
- Hidden activities disappear from the activity choice dialog and item use.
- If only one visible activity remains, it is used automatically. If none do, using the item shows its item card instead.
