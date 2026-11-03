import { localize, MODULE_ID } from "./module-config.mjs";

const ITEM_FLAG = "grantExpiration";
function matchesCoreExpiry(item, expiry, event, context) {
  if ( event === "updateWorldTime" ) {
    return !item.actor?.inCombat && (expiry !== "combatStart");
  }
  if ( expiry !== event ) return false;

  const combat = context.combat ?? game.combat;
  const combatant = combat?.getCombatantsByActor(item.actor)[0];
  if ( !combatant ) return false;
  if ( (event === "turnStart") || (event === "turnEnd") ) return context.combatant?.id === combatant.id;
  return true;
}

const REST_EXPIRIES = new Set(["shortRest", "longRest"]);
const TIME_UNITS = new Set(CONST.ACTIVE_EFFECT_TIME_DURATION_UNITS);
const COMBAT_UNITS = new Set(["rounds", "turns"]);
const PSEUDO_EXPIRIES = new Set(["sourceStart", "targetStart", "sourceEnd", "targetEnd"]);
const CORE_EXPIRIES = new Set(CONST.ACTIVE_EFFECT_EXPIRY_EVENTS);
const deletingItems = new Set();

function concentrationEffect(activity, results) {
  const id = results?.message?.system?.concentration ?? results?.message?.data?.system?.concentration;
  if ( !id ) return null;
  return results?.effects?.find(effect => effect.id === id)
    ?? activity.item?.actor?.effects?.get(id)
    ?? null;
}

function durationSeconds(value, units) {
  const calendar = game.time.calendar;
  if ( units === "months" ) {
    const monthCount = calendar.months.values.length;
    if ( !monthCount ) return null;
    const averageDays = calendar.days.daysPerYear / monthCount;
    return calendar.componentsToTime({day: Math.ceil(value * averageDays)});
  }
  const unit = units.replace(/s$/, "");
  const seconds = calendar.componentsToTime({[unit]: value});
  return Number.isFinite(seconds) ? seconds : null;
}

function getCombatStart(actor) {
  const combat = game.combat;
  if ( !combat?.started || !combat.turns.length || !combat.getCombatantsByActor(actor).length ) return null;
  return {
    combatId: combat.id,
    round: combat.round,
    turn: combat.turn ?? 0,
    turnsPerRound: combat.turns.length
  };
}

export function prepareGrantExpiration(activity, results, targetActor, itemData) {
  const duration = activity.duration?.getEffectData?.() ?? {};
  const expiry = typeof duration.expiry === "string" ? duration.expiry : null;
  const restExpiry = REST_EXPIRIES.has(expiry) ? expiry : null;
  const value = Number.isFinite(duration.value) ? duration.value : null;
  const units = typeof duration.units === "string" ? duration.units : null;
  const startedAt = game.time.worldTime;
  let expiresAt = null;
  let timeUnitSeconds = null;
  let combatStart = null;

  if ( (value !== null) && TIME_UNITS.has(units) ) {
    const seconds = durationSeconds(value, units);
    if ( seconds !== null ) expiresAt = startedAt + seconds;
  }
  else if ( (value !== null) && COMBAT_UNITS.has(units) ) {
    timeUnitSeconds = CONFIG.time[`${units.replace(/s$/, "")}Time`] || null;
    if ( Number.isFinite(timeUnitSeconds) ) expiresAt = startedAt + (value * timeUnitSeconds);
    combatStart = getCombatStart(targetActor);
  }

  let concentrationUuid = null;
  if ( activity.duration?.concentration ) {
    concentrationUuid = concentrationEffect(activity, results)?.uuid ?? null;
    if ( !concentrationUuid ) {
      throw new Error(localize("ADVANCED_ACTIVITIES.Grant.ConcentrationMissing"));
    }
  }

  if ( !restExpiry && !concentrationUuid && !expiry && (expiresAt === null) ) return;
  foundry.utils.setProperty(itemData, `flags.${MODULE_ID}.${ITEM_FLAG}`, {
    duration: {
      value,
      units,
      expiry,
      startedAt,
      expiresAt,
      timeUnitSeconds,
      combatStart
    },
    sourceActorUuid: activity.item?.actor?.uuid ?? null,
    restExpiry,
    concentrationUuid
  });
}

function isResponsibleGM() {
  return game.user.isGM && game.users.activeGM?.id === game.user.id;
}

async function deleteGrantedItem(item) {
  if ( !item?.actor || item.pack || deletingItems.has(item.uuid) ) return;
  deletingItems.add(item.uuid);
  try {
    const current = await fromUuid(item.uuid);
    if ( current?.actor && !current.pack ) await current.delete();
  } catch (error) {
    console.error(`${MODULE_ID} | Could not delete expired granted item "${item.name}".`, error);
  } finally {
    deletingItems.delete(item.uuid);
  }
}

function itemExpired(item, data, event, context) {
  const restExpiry = data.restExpiry;
  if ( (event === "shortRest" || event === "longRest")
    && ((restExpiry === "shortRest") || (event === "longRest" && restExpiry === "longRest")) ) return true;

  const rule = data.duration;
  if ( !rule ) return false;
  if ( PSEUDO_EXPIRIES.has(rule.expiry) ) {
    if ( event === "updateWorldTime" ) {
      if ( item.actor?.inCombat ) return false;
    }
    else {
      const turnEvent = rule.expiry.endsWith("Start") ? "turnStart" : "turnEnd";
      if ( event !== turnEvent ) return false;
      const start = rule.combatStart;
      if ( start ) {
        if ( context.combat?.id !== start.combatId ) return false;
        const isSource = rule.expiry.startsWith("source");
        const actorUuid = isSource ? data.sourceActorUuid : item.actor?.uuid;
        const actor = isSource ? foundry.utils.fromUuidSync(actorUuid) : item.actor;
        const combatant = actor && context.combat.getCombatantsByActor(actor)[0];
        if ( !combatant ) {
          if ( start.round >= context.round ) return false;
        }
        else {
          if ( context.actor?.uuid !== actorUuid ) return false;
          if ( (start.round === context.round) && (start.turn === context.turn) ) return false;
        }
      }
    }
  }
  else if ( CORE_EXPIRIES.has(rule.expiry) ) {
    if ( !matchesCoreExpiry(item, rule.expiry, event, context) ) return false;
  }
  else if ( rule.expiry && rule.expiry !== event ) {
    return false;
  }
  if ( rule.value === null ) return Boolean(rule.expiry);

  const worldTime = context.worldTime ?? game.time.worldTime;
  const timeReached = Number.isFinite(rule.expiresAt) && worldTime >= rule.expiresAt;
  let combatReached = false;
  const combat = context.combat;
  const start = rule.combatStart;
  if ( COMBAT_UNITS.has(rule.units) && start && (combat?.id === start.combatId) ) {
    const round = context.round ?? combat.round;
    const turn = context.turn ?? combat.turn ?? 0;
    let elapsed;
    if ( rule.units === "rounds" ) elapsed = Math.max(0, round - start.round);
    else {
      const currentPosition = ((round - 1) * start.turnsPerRound) + turn;
      const startPosition = ((start.round - 1) * start.turnsPerRound) + start.turn;
      elapsed = Math.max(0, currentPosition - startPosition);
    }
    const elapsedByTime = rule.timeUnitSeconds
      ? Math.floor((worldTime - rule.startedAt) / rule.timeUnitSeconds)
      : 0;
    combatReached = Math.max(elapsed, elapsedByTime) >= rule.value;
  }

  return timeReached || combatReached;
}

async function cleanExpiredItems(event, context={}, requireGM=true) {
  if ( requireGM && !isResponsibleGM() ) return;
  for await ( const item of collectOwnedItems(context.actor) ) {
    const data = item.getFlag(MODULE_ID, ITEM_FLAG);
    if ( data && itemExpired(item, data, event, context) ) await deleteGrantedItem(item);
  }
}

function onRestCompleted(actor, result, config) {
  if ( !actor?.isOwner ) return;
  const type = result?.type ?? config?.type;
  const event = (type === "long" || type === "longRest" || result?.longRest) ? "longRest"
    : (type === "short" || type === "shortRest") ? "shortRest" : null;
  if ( event ) void cleanExpiredItems(event, {actor}, false);
}

async function* collectOwnedItems(targetActor) {
  const seen = new Set();
  let sliceStart = performance.now();
  const actorItems = function* (actor) {
    if ( !actor?.isOwner ) return;
    for ( const item of actor.items ) {
      if ( !item.getFlag(MODULE_ID, ITEM_FLAG) || seen.has(item.uuid) ) continue;
      seen.add(item.uuid);
      yield item;
    }
  };
  if ( targetActor ) {
    yield* actorItems(targetActor);
    return;
  }
  const actorsWithExpiration = new Set();
  for ( const actor of game.actors ) {
    if ( actor.items.some(item => item.getFlag(MODULE_ID, ITEM_FLAG)) ) actorsWithExpiration.add(actor.id);
    yield* actorItems(actor);
    if ( performance.now() - sliceStart >= 8 ) {
      await new Promise(resolve => setTimeout(resolve, 0));
      sliceStart = performance.now();
    }
  }
  for ( const scene of game.scenes ) {
    for ( const token of scene.tokens ) {
      if ( token.actorLink ) continue;
      // Inspect stored delta records without instantiating an otherwise unused synthetic actor.
      const deltaItems = token._source.delta?.items ?? [];
      if ( actorsWithExpiration.has(token.actorId)
        || deltaItems.some(item => item.flags?.[MODULE_ID]?.[ITEM_FLAG]) ) {
        yield* actorItems(token.actor);
      }
      if ( performance.now() - sliceStart >= 8 ) {
        await new Promise(resolve => setTimeout(resolve, 0));
        sliceStart = performance.now();
      }
    }
  }
}

async function onEndConcentration(actor, effect) {
  if ( !actor?.isOwner || !effect?.uuid ) return;
  for await ( const item of collectOwnedItems() ) {
    if ( item.getFlag(MODULE_ID, ITEM_FLAG)?.concentrationUuid === effect.uuid ) {
      void deleteGrantedItem(item);
    }
  }
}

function onWorldTime(worldTime) {
  void cleanExpiredItems("updateWorldTime", {worldTime});
}

function onCombatTurnChange(combat, previous, current) {
  if ( !isResponsibleGM() || !previous || !current ) return;
  const {turns} = combat;
  let roundDelta = current.round - previous.round;
  const intervals = [];
  if ( roundDelta === 0 ) {
    if ( (current.round > 0) && (previous.turn < current.turn) ) {
      intervals.push([previous.turn + 1, current.turn]);
    }
  }
  else if ( roundDelta > 0 ) {
    if ( previous.round > 0 ) intervals.push([previous.turn + 1, turns.length - 1]);
    while ( --roundDelta ) intervals.push([0, turns.length - 1]);
    intervals.push([0, current.turn ?? 0]);
  }

  if ( !intervals.length ) {
    if ( previous.combatantId === current.combatantId ) return;
    const prior = combat.combatants.get(previous.combatantId);
    const next = combat.combatants.get(current.combatantId);
    if ( prior ) void cleanExpiredItems("turnEnd", {combat, actor: prior.actor, combatant: prior, ...previous});
    if ( next ) void cleanExpiredItems("turnStart", {combat, actor: next.actor, combatant: next, ...current});
    return;
  }

  let prior = {
    combatant: combat.combatants.get(previous.combatantId) ?? null,
    round: previous.round,
    turn: previous.turn
  };
  for ( const [from, to] of intervals ) {
    for ( let turn = from; turn <= to; turn++ ) {
      const round = prior.round + (turn === 0);
      const next = {combatant: turns[turn], round, turn};
      if ( prior.combatant ) {
        void cleanExpiredItems("turnEnd", {
          combat,
          actor: prior.combatant.actor,
          combatant: prior.combatant,
          round: prior.round,
          turn: prior.turn
        });
      }
      if ( prior.round !== next.round ) {
        void cleanExpiredItems("roundEnd", {combat, round: prior.round, turn: prior.turn});
        void cleanExpiredItems("roundStart", {combat, round: next.round, turn: next.turn});
      }
      if ( next.combatant ) {
        void cleanExpiredItems("turnStart", {
          combat,
          actor: next.combatant.actor,
          combatant: next.combatant,
          round: next.round,
          turn: next.turn
        });
      }
      prior = next;
    }
  }
}

export function registerGrantExpiration() {
  Hooks.on("updateWorldTime", onWorldTime);
  Hooks.on("combatStart", (combat, updateData) => {
    void cleanExpiredItems("combatStart", {
      combat,
      round: updateData?.round ?? combat.round,
      turn: updateData?.turn ?? combat.turn
    });
  });
  Hooks.on("combatTurnChange", onCombatTurnChange);
  Hooks.on("combatEnd", combat => void cleanExpiredItems("combatEnd", {combat}));
  Hooks.on("deleteCombat", combat => void cleanExpiredItems("combatEnd", {combat}));
  Hooks.on("dnd5e.restCompleted", onRestCompleted);
  Hooks.on("dnd5e.endConcentration", onEndConcentration);
  Hooks.once("ready", () => void cleanExpiredItems("updateWorldTime", {worldTime: game.time.worldTime}));
}