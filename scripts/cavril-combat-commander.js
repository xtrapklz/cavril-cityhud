// ============================================================================
// Cavril Combat Commander — v1.0
// ============================================================================
// Adds to Foundry VTT:
//
//   1. DISPOSITION PANEL  — F / N / H chips on any selected token(s)
//   2. ACTION SCANNER     — builds available actions from actor stat block
//                           and equipped items (dnd5e-aware)
//   3. COMMAND QUEUE      — per-token orders stored in flags; visual badge
//   4. PATHFINDING        — A* through wall graph, road-preferring
//   5. MOVEMENT EXECUTOR  — speed-aware animated movement along paths;
//                           Dash support
//   6. AUTO-DEATH         — conditions applied automatically on HP = 0;
//                           defeated flag for combat tracker
//   7. COMBAT AI DRIVER   — full turn loop: move → action → bonus action;
//                           reads tactic from CityHUD flag; only runs when
//                           "Sim" mode is enabled by the GM
//
// Exposes: window.CavrilCommander
// Reads:   window.cityhud.app.store (optional; for citizen tactic data)
//          Domain.Combat via the CityHUD module (optional)
//
// Works as either a loaded module script (module.json) or a pasted macro.
// ============================================================================

(function () {
"use strict";

// ── Guard: only install once ────────────────────────────────────────────────
if (window.CavrilCommander?._installed) {
  console.log("[CavrilCommander] Already loaded.");
  return;
}

// ── Constants ────────────────────────────────────────────────────────────────
const FLAG_NS = "world";   // Foundry flag namespace (shared with CityHUD)

const DISP = Object.freeze({
  HOSTILE:  -1,
  NEUTRAL:   0,
  FRIENDLY:  1,
});

// Role → accent color (mirrors CityHUD palette)
const ROLE_COLOR = {
  aggressor:  "#ef4444",
  defender:   "#3b82f6",
  support:    "#22c55e",
  controller: "#a855f7",
  survivor:   "#f97316",
  ranged:     "#06b6d4",
};

const TACTIC_LIST = [
  { id: "brute",        label: "Brute",      role: "aggressor",  icon: "fa-hand-fist"       },
  { id: "assassin",     label: "Assassin",   role: "aggressor",  icon: "fa-user-ninja"      },
  { id: "guardian",     label: "Guardian",   role: "defender",   icon: "fa-shield"          },
  { id: "sentinel",     label: "Sentinel",   role: "defender",   icon: "fa-eye"             },
  { id: "medic",        label: "Medic",      role: "support",    icon: "fa-heart-pulse"     },
  { id: "tactician",    label: "Tactician",  role: "controller", icon: "fa-chess"           },
  { id: "artillery",    label: "Artillery",  role: "ranged",     icon: "fa-bullseye"        },
  { id: "coward",       label: "Coward",     role: "survivor",   icon: "fa-person-running"  },
  { id: "opportunistic",label: "Opportunist",role: "aggressor",  icon: "fa-bolt"            },
];

const CMD_META = {
  hold:   { icon: "fa-hand",           color: "#6b7280", label: "Hold"   },
  goto:   { icon: "fa-location-arrow", color: "#3b82f6", label: "Go To"  },
  follow: { icon: "fa-arrows-to-dot",  color: "#22c55e", label: "Follow" },
  attack: { icon: "fa-crosshairs",     color: "#ef4444", label: "Attack" },
  flee:   { icon: "fa-person-running", color: "#f97316", label: "Flee"   },
};

// ============================================================================
// §1 — ACTION SCANNER
// Reads a live Foundry dnd5e actor and returns a structured list of usable
// combat actions. Falls back gracefully for non-dnd5e actors.
// ============================================================================
const ActionScanner = {
  scan(actor) {
    const empty = { actions: [], bonusActions: [], reactions: [],
                    movement: { walk: 30, dash: 60 } };
    if (!actor) return empty;

    const sys     = actor.system ?? {};
    const walkFt  = sys.attributes?.movement?.walk ?? 30;
    const actions = [], bonusActions = [], reactions = [];

    for (const item of (actor.items ?? [])) {
      const actType = item.system?.activation?.type;
      if (!actType || actType === "none" || actType === "special") continue;
      const entry = ActionScanner._itemEntry(item, actor);
      if (!entry) continue;
      if (["action","legendary","lair","crew"].includes(actType)) actions.push(entry);
      else if (actType === "bonus")    bonusActions.push(entry);
      else if (actType === "reaction") reactions.push(entry);
    }

    // Always guarantee an unarmed fallback
    if (!actions.some(a => a.category === "attack" && a.reach)) {
      const strMod = ActionScanner._mod(sys.abilities?.str?.value ?? 10);
      const pb     = ActionScanner._pb(actor);
      actions.unshift({
        id: "unarmed", name: "Unarmed Strike", category: "attack",
        reach: true, ranged: false, range: 5,
        attackBonus: strMod + pb,
        damage: { average: Math.max(1, 1 + strMod), dice: "1", type: "bludgeoning" },
        uses: null, img: null,
      });
    }

    return { actions, bonusActions, reactions, movement: { walk: walkFt, dash: walkFt * 2 } };
  },

  _itemEntry(item, actor) {
    try {
      const sys      = item.system ?? {};
      const actType  = sys.actionType ?? "";  // mwak, rwak, msak, rsak, heal, util, …
      const rangeDef = sys.range ?? {};
      const dmgParts = sys.damage?.parts ?? [];

      let category = "feature";
      let reach = false, ranged = false, rangeFt = 5;

      if (item.type === "weapon") {
        category = "attack";
        reach  = actType === "mwak" || actType === "msak";
        ranged = actType === "rwak" || actType === "rsak";
        rangeFt = reach ? (rangeDef.value ?? 5) : (rangeDef.value ?? 60);
      } else if (item.type === "spell") {
        category = "spell";
        ranged = true;
        rangeFt = rangeDef.value ?? 60;
      } else if (item.type === "consumable") {
        category = "consumable";
      }

      const sys2   = actor.system ?? {};
      const strMod = ActionScanner._mod(sys2.abilities?.str?.value ?? 10);
      const dexMod = ActionScanner._mod(sys2.abilities?.dex?.value ?? 10);
      const intMod = ActionScanner._mod(sys2.abilities?.int?.value ?? 10);
      const wisMod = ActionScanner._mod(sys2.abilities?.wis?.value ?? 10);
      const chaMod = ActionScanner._mod(sys2.abilities?.cha?.value ?? 10);
      const pb     = ActionScanner._pb(actor);

      // Attack bonus: use item's explicit value, else infer from action type
      let atkBonus = typeof sys.attackBonus === "number" ? sys.attackBonus : 0;
      if (!atkBonus) {
        if (actType === "mwak")      atkBonus = strMod + pb;
        else if (actType === "rwak") atkBonus = dexMod + pb;
        else if (actType === "msak" || actType === "rsak")
          atkBonus = Math.max(intMod, wisMod, chaMod) + pb;
      }

      // Average damage
      const dmg0   = dmgParts[0];
      const dmgAvg = dmg0 ? ActionScanner._avgDice(dmg0[0]) + (parseInt(dmg0[1]) || 0) : 0;

      // Remaining uses
      let uses = null;
      if (sys.uses?.max) uses = sys.uses.value ?? 0;
      if (item.type === "spell") {
        const lvl   = sys.level ?? 0;
        const slots = actor.system?.spells?.[`spell${lvl}`];
        if (slots?.max) uses = slots.value ?? 0;
        if (lvl === 0) uses = null; // cantrips are unlimited
      }

      return {
        id: item.id, name: item.name, category,
        reach, ranged, range: rangeFt,
        attackBonus: atkBonus,
        damage: dmg0 ? { average: dmgAvg, dice: dmg0[0] ?? "1", type: dmg0[2] ?? "" } : null,
        uses,
        img: item.img,
      };
    } catch(e) { return null; }
  },

  _mod(score) { return Math.floor(((score ?? 10) - 10) / 2); },
  _pb(actor) {
    if (actor.system?.attributes?.prof != null) return actor.system.attributes.prof;
    const cr = actor.system?.details?.cr ?? 0;
    if (cr <= 4) return 2; if (cr <= 8) return 3; if (cr <= 12) return 4;
    if (cr <= 16) return 5; if (cr <= 20) return 6; return 7;
  },
  _avgDice(str) {
    const m = String(str ?? "").match(/(\d+)d(\d+)/);
    if (!m) return parseInt(str) || 0;
    return parseInt(m[1]) * (parseInt(m[2]) + 1) / 2;
  },
};

// ── Foundry V13 compat: Ray moved to foundry.canvas.geometry.Ray ────────────
// Using the global "Ray" still works but logs a deprecation warning on every
// call — which is every pathfinding cell check, i.e. thousands per turn.
const _Ray = foundry.canvas?.geometry?.Ray ?? globalThis.Ray;

// ============================================================================
// §2 — PATHFINDING
// Grid-based A* that respects Foundry wall collision and prefers road cells.
// Returns an array of {x, y} pixel waypoints (grid-cell centres).
// ============================================================================
const Pathfinder = {
  MAX_ITER: 3000,

  findPath(x0, y0, x1, y1) {
    if (!canvas?.scene) return [{ x: x1, y: y1 }];
    const gs   = canvas.scene.grid?.size ?? 100;
    const half = gs / 2;

    const sc = (c, r) => `${c},${r}`;
    const gc0 = { c: Math.floor(x0 / gs), r: Math.floor(y0 / gs) };
    const gc1 = { c: Math.floor(x1 / gs), r: Math.floor(y1 / gs) };
    if (gc0.c === gc1.c && gc0.r === gc1.r) return [{ x: x1, y: y1 }];

    const heur = (c, r) => Math.abs(c - gc1.c) + Math.abs(r - gc1.r);
    const open  = new Map();
    const closed = new Set();
    const from   = new Map();

    open.set(sc(gc0.c, gc0.r), { c: gc0.c, r: gc0.r, g: 0, f: heur(gc0.c, gc0.r) });

    let iter = 0;
    while (open.size > 0 && ++iter < Pathfinder.MAX_ITER) {
      // Pop lowest-f
      let cur = null;
      for (const n of open.values()) if (!cur || n.f < cur.f) cur = n;
      const ck = sc(cur.c, cur.r);
      open.delete(ck);
      closed.add(ck);

      if (cur.c === gc1.c && cur.r === gc1.r) {
        // Reconstruct
        const pts = [];
        let k = ck;
        while (from.has(k)) {
          const [cc, rr] = k.split(",").map(Number);
          pts.unshift({ x: cc * gs + half, y: rr * gs + half });
          k = from.get(k);
        }
        pts.push({ x: x1, y: y1 });
        return pts;
      }

      const cx = cur.c * gs + half, cy = cur.r * gs + half;
      const DIRS = [[-1,-1],[0,-1],[1,-1],[-1,0],[1,0],[-1,1],[0,1],[1,1]];
      for (const [dc, dr] of DIRS) {
        const nc = cur.c + dc, nr = cur.r + dr;
        const nk = sc(nc, nr);
        if (closed.has(nk)) continue;
        const nx = nc * gs + half, ny = nr * gs + half;
        if (Pathfinder._blocked(cx, cy, nx, ny)) continue;
        const stepCost = (dc !== 0 && dr !== 0) ? 1.414 : 1.0;
        const roadSave = Pathfinder._onRoad(nx, ny) ? 0.35 : 0;
        const g = cur.g + stepCost - roadSave;
        const existing = open.get(nk);
        if (!existing || g < existing.g) {
          open.set(nk, { c: nc, r: nr, g, f: g + heur(nc, nr) });
          from.set(nk, ck);
        }
      }
    }

    // Fallback: A* hit the iteration cap (very complex map). Step cell-by-cell
    // along the straight line so the movement budget can still be spent — a
    // single far-away waypoint would exceed the budget and produce zero movement.
    const fallback = [];
    const fdc = gc1.c - gc0.c, fdr = gc1.r - gc0.r;
    const fsteps = Math.max(Math.abs(fdc), Math.abs(fdr));
    for (let i = 1; i <= fsteps; i++) {
      fallback.push({
        x: (Math.round(gc0.c + fdc * i / fsteps)) * gs + half,
        y: (Math.round(gc0.r + fdr * i / fsteps)) * gs + half,
      });
    }
    fallback.push({ x: x1, y: y1 });
    return fallback;
  },

  _blocked(x0, y0, x1, y1) {
    try {
      return !!canvas.walls.checkCollision(
        new _Ray({ x: x0, y: y0 }, { x: x1, y: y1 }),
        { type: "move" }
      );
    } catch(e) { return false; }
  },

  // Check unobstructed line-of-sight between two scene-pixel points.
  // Uses type:"move" so ALL walls block — Foundry's sight-permeability
  // settings are deliberately ignored per the user's spec.
  // Center coords (cx, cy) are expected, not top-left token positions.
  hasLOS(x0, y0, x1, y1) {
    try {
      return !canvas.walls.checkCollision(
        new _Ray({ x: x0, y: y0 }, { x: x1, y: y1 }),
        { type: "move" }
      );
    } catch(e) { return true; }  // fail-open so LOS errors don't freeze AI
  },

  // Prefer road cells (uses road polygon cache built by cavril-enter-encounter)
  _onRoad(px, py) {
    const polys = window._cavrilRoadPolygons;
    if (!Array.isArray(polys)) return false;
    for (const poly of polys) if (Pathfinder._pip(px, py, poly)) return true;
    return false;
  },

  _pip(px, py, pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
      if (((yi > py) !== (yj > py)) && (px < (xj - xi) * (py - yi) / (yj - yi) + xi))
        inside = !inside;
    }
    return inside;
  },
};

// ============================================================================
// §3 — MOVEMENT EXECUTOR
// Walks a token along a pathfound route up to its speed budget.
// ============================================================================
const Mover = {
  // Move token toward (destX, destY). Spends up to speed ft of movement.
  // Pass useDash:true to allow spending the action for Dash (doubles budget).
  // Returns { movedPx, reached }.
  async moveToward(token, destX, destY, { useDash = false } = {}) {
    try {
      const actor      = token.actor;
      const gs         = canvas.scene?.grid?.size ?? 100;
      const half       = gs / 2;
      // Use scene's actual feet-per-cell — do NOT hardcode 5.
      // (Scenes can be configured for 10ft, 20ft, etc. per square.)
      const ftPerCell  = canvas.scene?.grid?.distance ?? 5;
      const walkFt     = _maxMoveFt(actor);
      const maxPx      = ((useDash ? walkFt * 2 : walkFt) / ftPerCell) * gs;

      // Use document position (DB truth), not the PIXI object's animated
      // position — avoids corrupting the budget walk if a previous animation
      // is still playing when this turn starts.
      const startX = token.document.x;
      const startY = token.document.y;

      const path = Pathfinder.findPath(startX, startY, destX, destY);
      if (!path?.length) return { movedPx: 0, reached: false };

      let budget = maxPx;
      // Start budget-walking from the CENTER of the token's current cell,
      // not its top-left corner. Path waypoints are also cell centers, so
      // every step is exactly one grid-distance — no phantom "first step"
      // eating half the budget just to reach the cell center.
      let lx = Math.floor(startX / gs) * gs + half;
      let ly = Math.floor(startY / gs) * gs + half;
      let lastGood = null;

      for (const wp of path) {
        const d = Math.hypot(wp.x - lx, wp.y - ly);
        if (d > budget + 0.5) break;   // 0.5px float tolerance
        budget -= d;
        lx = wp.x; ly = wp.y;
        lastGood = wp;
      }

      if (!lastGood) return { movedPx: 0, reached: false };

      // Convert cell center back to top-left for token placement.
      const snap = {
        x: Math.floor(lastGood.x / gs) * gs,
        y: Math.floor(lastGood.y / gs) * gs,
      };

      const dx      = snap.x - startX;
      const dy      = snap.y - startY;
      const movedPx = Math.hypot(dx, dy);
      if (movedPx < 1) return { movedPx: 0, reached: false };

      const cellsMoved = movedPx / gs;
      console.log(
        `[CavrilCommander] ${token.document.name}: ` +
        `budget=${Math.round(maxPx)}px (${walkFt}ft @ ${ftPerCell}ft/cell), ` +
        `path=${path.length} pts, moving ${cellsMoved.toFixed(1)} cells → (${snap.x},${snap.y})`
      );

      // Single combined update — position + current rotation together.
      // Splitting into two sequential updates caused a visual glitch where the
      // token snapped to the new rotation at the OLD position, then slid — which
      // looked exactly like "turned its back to the target, then walked backwards."
      // The caller (executeTurn) already set facing toward the target before
      // calling moveToward, so we just preserve that rotation here.
      const rotation = token.document.rotation ?? 0;
      token.document.update({ x: snap.x, y: snap.y, rotation })
        .catch(e => console.warn("[CavrilCommander] move update:", e));

      // Step 3 — Pan camera to follow the token to its destination.
      // Matches the animation timing so the viewport arrives with the token.
      // Foundry animates at ~10 cells/sec; add 250ms for DB + rendering buffer.
      const animMs    = Math.max(500, Math.round(cellsMoved * 100) + 250);
      const centerAfterX = snap.x + (token.document.width  ?? 1) * gs / 2;
      const centerAfterY = snap.y + (token.document.height ?? 1) * gs / 2;
      canvas.animatePan({ x: centerAfterX, y: centerAfterY, duration: animMs });

      // Step 4 — Block until animation is done before the AI takes its action.
      await new Promise(r => setTimeout(r, animMs));

      const destSnap = {
        x: Math.floor(destX / gs) * gs,
        y: Math.floor(destY / gs) * gs,
      };
      return { movedPx, reached: snap.x === destSnap.x && snap.y === destSnap.y };
    } catch(e) {
      console.warn("[CavrilCommander] moveToward error:", e);
      return { movedPx: 0, reached: false };
    }
  },
};

// ============================================================================
// §4 — COMMAND QUEUE
// Per-token orders stored as token flags. Commands survive scene reloads.
// ============================================================================
const Commands = {
  async issue(tokenIds, command) {
    if (!Array.isArray(tokenIds)) tokenIds = [tokenIds];
    const updates = tokenIds.map(id => ({
      _id: id,
      [`flags.${FLAG_NS}.cavrilCommand`]: { ...command, issuedAt: Date.now() },
    }));
    await canvas.scene?.updateEmbeddedDocuments("Token", updates);
    UI.refreshIndicators();
  },

  async clear(tokenId) {
    await canvas.scene?.updateEmbeddedDocuments("Token", [{
      _id: tokenId,
      [`flags.${FLAG_NS}.cavrilCommand`]: null,
    }]);
    UI.refreshIndicators();
  },

  get(tokenDoc) {
    return tokenDoc?.flags?.[FLAG_NS]?.cavrilCommand ?? null;
  },
};

// ============================================================================
// §5 — AUTO-DEATH
// Watches HP mutations and applies conditions automatically.
// ============================================================================
const AutoDeath = {
  init() {
    Hooks.on("updateActor", AutoDeath._onUpdateActor);
  },

  async _onUpdateActor(actor, change) {
    try {
      const newHp = foundry.utils.getProperty(change, "system.attributes.hp.value");
      if (newHp == null) return;

      const isChar = actor.type === "character";
      const isNPC  = actor.type === "npc";
      if (!isChar && !isNPC) return;

      // Find a canvas token for this actor (linked or best match)
      const token = canvas.tokens?.placeables?.find(t => t.actor?.id === actor.id);

      if (newHp <= 0) {
        if (isNPC) {
          // NPCs: mark dead immediately
          await AutoDeath._toggle(actor, token, "dead", true);
          // Mark defeated in combat tracker
          const cbt = game.combat?.combatants?.find(c => c.actorId === actor.id);
          if (cbt) await cbt.update({ defeated: true });
          if (token) await Commands.issue([token.id], { type: "dead" });
          ui.notifications.info(`${actor.name} has been slain.`);
        } else {
          // PCs: unconscious + prone + death saves prompt
          await AutoDeath._toggle(actor, token, "unconscious", true);
          await AutoDeath._toggle(actor, token, "prone", true);
          ChatMessage.create({
            content: `<p>⚠️ <b>${actor.name}</b> is down! Death saving throws required.</p>`,
            whisper: ChatMessage.getWhisperRecipients("GM"),
          });
        }
      } else if (newHp > 0) {
        // HP restored: clear death conditions
        await AutoDeath._toggle(actor, token, "dead",        false);
        await AutoDeath._toggle(actor, token, "unconscious", false);
        // Clear dead command if present
        if (token) {
          const cmd = Commands.get(token.document);
          if (cmd?.type === "dead") await Commands.clear(token.id);
        }
        // Un-defeat in combat tracker
        const cbt = game.combat?.combatants?.find(c => c.actorId === actor.id);
        if (cbt?.defeated) await cbt.update({ defeated: false });
      }
    } catch(e) { console.warn("[CavrilCommander] AutoDeath error:", e); }
  },

  async _toggle(actor, token, condId, active) {
    try {
      if (typeof actor.toggleStatusEffect === "function") {
        const isOn = actor.statuses?.has(condId) ?? false;
        if (isOn !== active) await actor.toggleStatusEffect(condId, { active });
      } else if (token) {
        const effect = CONFIG.statusEffects?.find(e => e.id === condId);
        if (effect) await token.toggleEffect(effect, { active });
      }
    } catch(e) { /* condition may not exist in this system — ignore */ }
  },
};

// ============================================================================
// §6 — COMBAT AI DRIVER
// On each NPC combatant's turn (when Sim mode is on), resolves tactic →
// optimal action → movement to range → execute action.
// ============================================================================
let _simMode = false;   // toggled by the command palette "Sim" button

// ── Combat constants ─────────────────────────────────────────────────────────
const ATTACK_SLACK_FT = 1.5;                                    // range tolerance (ft)
const MORALE_FLEE_PCT = 0.25;                                   // flee threshold
const MORALE_TOUGH    = new Set(["brute","guardian","sentinel","tactician"]);

// ── Speed helper — takes the highest of ALL movement modes ───────────────────
// Covers fly/swim/climb/burrow so air creatures and swimmers move correctly.
// Returns feet-per-round; minimum 30 as a safety floor.
function _maxMoveFt(actor) {
  const mv = actor?.system?.attributes?.movement ?? {};
  return Math.max(
    mv.walk   ?? 0,
    mv.fly    ?? 0,
    mv.swim   ?? 0,
    mv.climb  ?? 0,
    mv.burrow ?? 0,
  ) || 30;
}

// ── Directly face a pixel-coordinate target from self ────────────────────────
// Returns Foundry rotation degrees.
//
// Token art defaults to facing SOUTH at rotation=0.  Foundry applies rotation
// clockwise in screen space (where +y = down).  The correct offset is +270:
//
//   Moving right  (+dx, dy=0): atan2=0°  → +270 = 270° → facing east  ✓
//   Moving left   (-dx, dy=0): atan2=180°→ +270 = 450° → 90° west     ✓
//   Moving down   (dx=0, +dy): atan2=90° → +270 = 360° → 0°  south    ✓
//   Moving up     (dx=0, -dy): atan2=-90°→ +270 = 180° → facing north ✓
//
// Using +90 (the "north-up" convention for north-facing sprites) produces the
// OPPOSITE result on south-facing token art — hence the "walking backwards" bug.
function _rotationToward(fromCX, fromCY, toCX, toCY) {
  return (Math.atan2(toCY - fromCY, toCX - fromCX) * (180 / Math.PI) + 270 + 360) % 360;
}

// ── Reaction tracking (Opportunity Attacks) ──────────────────────────────────
// Key: "${actorId}-${round}" — expires naturally as the round number advances.
function _cavrilReactions() {
  return (window.__cavrilReactions ??= new Set());
}

// ── One enemy fires an Opportunity Attack on a moving token ──────────────────
async function fireAoO(threatTok, aooTarget, paceMs) {
  const atkActor = threatTok?.actor;
  if (!atkActor) return;
  const roundKey = `${atkActor.id}-${game.combat?.round ?? 0}`;
  if (_cavrilReactions().has(roundKey)) return;   // reaction already spent this round

  const meleeItem = [...(atkActor.items ?? [])].find(i => {
    const at = i.system?.actionType ?? "";
    if (at === "mwak" || at === "msak") return true;
    // dnd5e 5.x: attack stored as feat with activities; treat as melee if range ≤ 15 ft
    const acts = i.system?.activities;
    if (!acts) return false;
    const arr = acts instanceof Map ? [...acts.values()] : Object.values(acts);
    const rangeVal = i.system?.range?.value ?? 5;
    return arr.some(a => a.type === "attack") && rangeVal <= 15;
  });
  if (!meleeItem) return;

  _cavrilReactions().add(roundKey);
  const aooName = aooTarget.actor?.name ?? aooTarget.document?.name ?? "target";
  try {
    await ChatMessage.create({
      content: `<div style="padding:3px 8px;border-left:3px solid #ef4444;
                font-style:italic;font-size:.88em;">
                ⚔️ <b>${atkActor.name}</b> — Opportunity Attack on <b>${aooName}</b>!</div>`,
    });
  } catch (_) {}

  try { aooTarget.setTarget(true, { user: game.user, releaseOthers: true }); } catch (_) {}

  const midiActive = !!game.modules.get("midi-qol")?.active;
  const ev = new MouseEvent("click", { shiftKey: true });

  if (midiActive) {
    let wfId;
    const done = new Promise(res => {
      const tid = setTimeout(() => { Hooks.off("midi-qol.RollComplete", wfId); res(); }, 15_000);
      wfId = Hooks.once("midi-qol.RollComplete", () => { clearTimeout(tid); res(); });
    });
    try { meleeItem.use({}, { event: ev, fastForward: true }); } catch (_) {}
    await done;
  } else {
    try { await meleeItem.use({}, { event: ev, fastForward: true }); } catch (_) {}
  }

  try { aooTarget.setTarget(false, { user: game.user, releaseOthers: false }); } catch (_) {}
  await new Promise(r => setTimeout(r, Math.round(paceMs * 0.4)));
}

// ── Check all enemies; fire AoO if the moving token leaves their threat zone ──
// NOTE: references AIDriver._hostile — safe because function declarations are
// hoisted and AIDriver will be defined by the time this runs at call-time.
async function handleAoOs(movingToken, fromCX, fromCY, toCX, toCY, paceMs) {
  const gs        = canvas.scene?.grid?.size ?? 100;
  const ftPerCell = canvas.scene?.grid?.distance ?? 5;
  const aw        = (movingToken.document.width  ?? 1) * gs;
  const selfDisp  = movingToken.document.disposition;

  for (const t of canvas.tokens.placeables) {
    if (t.id === movingToken.id) continue;
    if (!AIDriver._hostile(selfDisp, t.document.disposition)) continue;
    const hp = t.actor?.system?.attributes?.hp?.value;
    if (hp != null && hp <= 0) continue;
    const st = t.actor?.statuses ?? new Set();
    if (st.has("incapacitated") || st.has("paralyzed") ||
        st.has("stunned")       || st.has("unconscious")) continue;

    let reachFt = 5;
    for (const itm of (t.actor?.items ?? [])) {
      const at = itm.system?.actionType ?? "";
      const rng = itm.system?.range?.value ?? 5;
      const isMeleeOld = at === "mwak" || at === "msak";
      const isMeleeNew = !isMeleeOld && (() => {
        // dnd5e 5.x: attack in activities collection; range ≤ 15 ft → melee
        const acts = itm.system?.activities;
        if (!acts) return false;
        const arr = acts instanceof Map ? [...acts.values()] : Object.values(acts);
        return arr.some(a => a.type === "attack") && rng <= 15;
      })();
      if ((isMeleeOld || isMeleeNew) && rng > reachFt) reachFt = rng;
    }
    const tw     = (t.document.width  ?? 1) * gs;
    const eCX    = t.document.x + tw / 2;
    const eCY    = t.document.y + (t.document.height ?? 1) * gs / 2;
    const zonePx = (aw + tw) / 2 + (reachFt / ftPerCell) * gs;
    const slk    = gs * 0.25;
    const wasIn  = Math.hypot(fromCX - eCX, fromCY - eCY) <= zonePx + slk;
    const nowIn  = Math.hypot(toCX   - eCX, toCY   - eCY) <= zonePx + slk;
    if (wasIn && !nowIn) {
      try { await fireAoO(t, movingToken, paceMs); } catch (_) {}
    }
  }
}

// ── Execute one real-item attack; waits for MidiQOL workflow to finish ────────
async function doOneAttack(item, label, paceMs) {
  if (label) {
    try {
      await ChatMessage.create({
        content: `<div style="padding:2px 8px;border-left:3px solid #ef4444;
                  font-size:.85em;opacity:.85;">⚔️ <em>${label}</em></div>`,
      });
    } catch (_) {}
  }
  const ev         = new MouseEvent("click", { shiftKey: true });
  const midiActive = !!game.modules.get("midi-qol")?.active;
  if (midiActive) {
    let wfId;
    const done = new Promise(res => {
      const tid = setTimeout(() => { Hooks.off("midi-qol.RollComplete", wfId); res(); }, 15_000);
      wfId = Hooks.once("midi-qol.RollComplete", () => { clearTimeout(tid); res(); });
    });
    try { item.use({}, { event: ev, fastForward: true }); } catch (e) {
      console.warn("[CavrilCommander] item.use():", e.message);
    }
    await done;
  } else {
    try { await item.use({}, { event: ev, fastForward: true }); } catch (e) {
      console.warn("[CavrilCommander] item.use():", e.message);
    }
  }
}

// ── Build attack sequence for this turn (Multiattack-aware) ──────────────────
function getAtkSequence(actor) {
  const items    = [...(actor.items ?? [])];

  // dnd5e 5.x stores attacks two ways:
  //   v2-style weapon: item.system.actionType = "mwak" / "rwak" / "msak" / "rsak"
  //   v3-style feature: item.system.activities collection contains an "attack" activity
  const hasAtk = (i) => {
    const at = i.system?.actionType ?? "";
    if (at === "mwak" || at === "rwak" || at === "msak" || at === "rsak") return true;
    const acts = i.system?.activities;
    if (!acts) return false;
    const arr = acts instanceof Map ? [...acts.values()] : Object.values(acts);
    return arr.some(a => a.type === "attack");
  };
  const atkItems = items.filter(hasAtk);
  if (!atkItems.length) return [];

  const multi = items.find(i => i.name?.toLowerCase().includes("multiattack"));
  if (multi) {
    const raw = (multi.system?.description?.value ?? "").replace(/<[^>]*>/g, "");
    const seq = [];
    for (const item of atkItems) {
      const nm = item.name.toLowerCase().replace(/[^a-z]/g, "");
      // Match "2 Bite attacks" OR "Bite (1/2)" style text
      const m1 = raw.match(new RegExp(`(\\d+)\\s+${nm}`, "i"));
      const m2 = raw.match(new RegExp(`${nm}[^)]*\\((\\d+)\\s*/`, "i"));
      const count = m1 ? parseInt(m1[1]) : m2 ? parseInt(m2[1]) : 0;
      for (let i = 0; i < count; i++)
        seq.push({ item, label: `${item.name} (${i+1}/${count})` });
    }
    if (seq.length) return seq;
    // Fallback: two attacks with best melee weapon
    const best = atkItems.find(i => i.system?.actionType === "mwak") ?? atkItems[0];
    return [
      { item: best, label: `${best.name} (1/2)` },
      { item: best, label: `${best.name} (2/2)` },
    ];
  }

  return [{ item: atkItems[0], label: atkItems[0].name }];
}

const AIDriver = {
  // ── Main entry point — called by the combatTurn hook for every NPC turn ──────
  //
  // Delegates to window.CavrilCombatStep.run() when available.
  // CavrilCombatStep.macro.js registers that function when its macro is executed
  // at least once in the session.  The Commander handles the Foundry-level
  // plumbing (skip dead/PC tokens, pan camera, advance tracker) and lets
  // CombatStep handle ALL combat AI logic — movement, facing, AoOs, multiattack,
  // animations, chat notifications — exactly as the standalone macro does.
  //
  // If CombatStep is not loaded the built-in fallback runs instead, but it is
  // intentionally simple: load the macro once and you get the full experience.
  async executeTurn(combatant) {
    try {
      const token = canvas.tokens?.placeables?.find(t => t.id === combatant.tokenId);
      if (!token) { await AIDriver._next(); return; }
      const actor = combatant.actor;
      if (!actor) { await AIDriver._next(); return; }

      const gs = canvas.scene?.grid?.size ?? 100;

      // Dead / defeated combatants: skip, advance tracker silently.
      const hpCur = actor.system?.attributes?.hp?.value ?? 1;
      if (hpCur <= 0 || combatant.defeated) { await AIDriver._next(); return; }

      // GM command override (non-auto commands handled by _runCommand).
      const cmd = Commands.get(token.document);
      if (cmd && !["auto","dead"].includes(cmd.type)) {
        await AIDriver._runCommand(token, actor, cmd);
        return;
      }

      // Pan camera to the acting token before anything else.
      const aw    = (token.document.width  ?? 1) * gs;
      const ah    = (token.document.height ?? 1) * gs;
      const selfCX = token.document.x + aw / 2;
      const selfCY = token.document.y + ah / 2;
      canvas.animatePan({ x: selfCX, y: selfCY, scale: canvas.stage?.scale?.x, duration: 500 });
      await AIDriver._pause(650);

      // ── Primary path: delegate to CombatStep ─────────────────────────────────
      // CavrilCombatStep.macro.js must be run once per session to register
      // window.CavrilCombatStep.  After that every NPC turn fires the same AI
      // logic the macro uses: wall-aware pathfinding, multiattack, AoOs,
      // lunge/hit/miss animations, and the floating pill notifications.
      if (typeof window.CavrilCombatStep?.run === "function") {
        try {
          await window.CavrilCombatStep.run(token, { autoRoll: true, pace: 700 });
        } catch (stepErr) {
          console.error("[CavrilCommander] CombatStep.run() error:", stepErr);
        }

      } else {
        // ── Fallback path: minimal built-in AI ───────────────────────────────────
        // Shown only once per session so it doesn't spam every turn.
        if (!AIDriver._warnedNoCombatStep) {
          AIDriver._warnedNoCombatStep = true;
          ui.notifications?.warn(
            "[CavrilCommander] CombatStep macro not loaded. " +
            "Run CavrilCombatStep.macro.js once to unlock full AI (movement, AoOs, animations, multiattack)."
          );
          console.warn("[CavrilCommander] Falling back to basic AI — load CavrilCombatStep.macro.js for the full experience.");
        }
        await AIDriver._basicTurn(token, actor, gs);
      }

      AIDriver._clearTargets();
      await AIDriver._pause(400);
      await AIDriver._next();
    } catch (e) {
      console.error("[CavrilCommander] executeTurn error:", e);
      AIDriver._clearTargets();
      try { await AIDriver._next(); } catch (_) {}
    }
  },

  _warnedNoCombatStep: false,

  // ── Basic fallback turn: face → approach → attack ─────────────────────────
  // Used only when CombatStep is not loaded.  Intentionally simple — no wall
  // avoidance, no AoOs, no animations.  It does use item.use() + MidiQOL so
  // at minimum a real attack roll fires.
  async _basicTurn(token, actor, gs) {
    const ftPerCell = canvas.scene?.grid?.distance ?? 5;
    const paceMs    = 700;
    const selfDisp  = token.document.disposition;
    const aw = (token.document.width  ?? 1) * gs;
    const ah = (token.document.height ?? 1) * gs;
    const walkFt = _maxMoveFt(actor);
    const walkPx = (walkFt / ftPerCell) * gs;

    const hpCur = actor.system?.attributes?.hp?.value ?? 1;
    const hpMax = actor.system?.attributes?.hp?.max  ?? 1;

    // Target: nearest hostile in LOS, or nearest hostile if none visible.
    const live = canvas.tokens.placeables.filter(t => {
      if (t.id === token.id) return false;
      const hp = t.actor?.system?.attributes?.hp?.value;
      return hp == null || hp > 0;
    });
    const enemies = live.filter(t => AIDriver._hostile(selfDisp, t.document.disposition));
    if (!enemies.length) return;

    const selfCX = token.document.x + aw / 2;
    const selfCY = token.document.y + ah / 2;

    const nearest = enemies.reduce((a, b) => {
      const da = Math.hypot(selfCX - (a.document.x + (a.document.width  ?? 1)*gs/2),
                            selfCY - (a.document.y + (a.document.height ?? 1)*gs/2));
      const db = Math.hypot(selfCX - (b.document.x + (b.document.width  ?? 1)*gs/2),
                            selfCY - (b.document.y + (b.document.height ?? 1)*gs/2));
      return da <= db ? a : b;
    });

    const tw   = (nearest.document.width  ?? 1) * gs;
    const tgtCX = nearest.document.x + tw / 2;
    const tgtCY = nearest.document.y + (nearest.document.height ?? 1) * gs / 2;

    // Face target
    try {
      await token.document.update({ rotation: _rotationToward(selfCX, selfCY, tgtCX, tgtCY) });
    } catch (_) {}

    AIDriver._setTarget(nearest.id);

    // Announce
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor }),
      content: `<div style="border-left:3px solid #6366f1;padding:3px 8px;">
        <b>${token.document.name}</b>'s turn [HP ${hpCur}/${hpMax}]
        → <b>${nearest.actor?.name ?? nearest.document?.name}</b>
        <span style="opacity:.5;font-size:.8em;">(basic AI — load CombatStep for full AI)</span>
      </div>`,
    }).catch(() => {});
    await AIDriver._pause(400);

    // Move toward target using best available speed
    const { movedPx } = await Mover.moveToward(token, tgtCX, tgtCY);
    if (movedPx > 0) await AIDriver._pause(Math.round(paceMs * 0.4));

    // Attack
    const atkSeq = getAtkSequence(actor);
    if (atkSeq.length) {
      for (let i = 0; i < atkSeq.length; i++) {
        await doOneAttack(atkSeq[i].item, atkSeq[i].label, paceMs);
        if (i < atkSeq.length - 1) await AIDriver._pause(Math.round(paceMs * 0.6));
      }
    } else {
      const scanned  = ActionScanner.scan(actor);
      const atkPool  = scanned.actions.filter(a => a.category === "attack" || a.category === "spell");
      const fallback = AIDriver._pickAction("brute", atkPool.length ? atkPool : scanned.actions, nearest);
      if (fallback) await AIDriver._doAction(actor, fallback, nearest);
    }

    await AIDriver._pause(paceMs);
  },

  // ── Flee: AoOs from adjacent enemies first, then Dash away ─────────────────
  async _doFlee(token, actor, selfCX, selfCY, budgetPx, gs, ftPerCell, paceMs) {
    const hpCur    = actor.system?.attributes?.hp?.value ?? 1;
    const hpMax    = actor.system?.attributes?.hp?.max  ?? 1;
    const selfDisp = token.document.disposition;
    const aw       = (token.document.width  ?? 1) * gs;

    await ChatMessage.create({
      content: `<div style="padding:3px 8px;border-left:3px solid #ef4444;">
        💀 <b>${token.document.name}</b> is fleeing — HP critical (${hpCur}/${hpMax})!</div>`,
    });

    // All adjacent enemies get an AoO before movement
    try {
      for (const t of canvas.tokens.placeables) {
        if (t.id === token.id) continue;
        if (!AIDriver._hostile(selfDisp, t.document.disposition)) continue;
        const hp = t.actor?.system?.attributes?.hp?.value;
        if (hp != null && hp <= 0) continue;
        const st = t.actor?.statuses ?? new Set();
        if (st.has("incapacitated") || st.has("paralyzed") ||
            st.has("stunned")       || st.has("unconscious")) continue;
        let reachFt = 5;
        for (const itm of (t.actor?.items ?? [])) {
          const at  = itm.system?.actionType ?? "";
          const rng = itm.system?.range?.value ?? 5;
          const isMeleeOld = at === "mwak" || at === "msak";
          const isMeleeNew = !isMeleeOld && (() => {
            const acts = itm.system?.activities;
            if (!acts) return false;
            const arr = acts instanceof Map ? [...acts.values()] : Object.values(acts);
            return arr.some(a => a.type === "attack") && rng <= 15;
          })();
          if ((isMeleeOld || isMeleeNew) && rng > reachFt) reachFt = rng;
        }
        const tw     = (t.document.width  ?? 1) * gs;
        const eCX    = t.document.x + tw / 2;
        const eCY    = t.document.y + (t.document.height ?? 1) * gs / 2;
        const zonePx = (aw + tw) / 2 + (reachFt / ftPerCell) * gs;
        if (Math.hypot(selfCX - eCX, selfCY - eCY) <= zonePx + gs * 0.25) {
          try { await fireAoO(t, token, paceMs); } catch (_) {}
        }
      }
    } catch (_) {}

    if ((actor.system?.attributes?.hp?.value ?? 1) <= 0) {
      await ChatMessage.create({
        content: `<div style="padding:3px 8px;border-left:3px solid #ef4444;">
          💀 <b>${token.document.name}</b> falls to Opportunity Attacks!</div>`,
      });
      return;
    }

    // Find nearest enemy, run the opposite direction
    const enemies = canvas.tokens.placeables.filter(t =>
      t.id !== token.id &&
      AIDriver._hostile(selfDisp, t.document.disposition) &&
      ((t.actor?.system?.attributes?.hp?.value ?? 0) > 0)
    );
    if (!enemies.length) return;
    const nearest = enemies.reduce((a, b) => {
      const da = Math.hypot(selfCX - (a.document.x + (a.document.width  ?? 1) * gs / 2),
                            selfCY - (a.document.y + (a.document.height ?? 1) * gs / 2));
      const db = Math.hypot(selfCX - (b.document.x + (b.document.width  ?? 1) * gs / 2),
                            selfCY - (b.document.y + (b.document.height ?? 1) * gs / 2));
      return da <= db ? a : b;
    });
    const nCX = nearest.document.x + (nearest.document.width  ?? 1) * gs / 2;
    const nCY = nearest.document.y + (nearest.document.height ?? 1) * gs / 2;
    const dx  = selfCX - nCX, dy = selfCY - nCY;
    const d   = Math.hypot(dx, dy) || 1;

    // Face away from the nearest enemy before running
    try {
      const fleeRot = _rotationToward(nCX, nCY, selfCX, selfCY);   // from enemy toward self = flee direction
      await token.document.update({ rotation: fleeRot });
    } catch (_) {}

    const { movedPx } = await Mover.moveToward(token, selfCX + (dx / d) * budgetPx, selfCY + (dy / d) * budgetPx, { useDash: true });
    const retreatFt = Math.round(movedPx / gs * ftPerCell);
    await ChatMessage.create({
      content: retreatFt > 0
        ? `<div style="padding:2px 8px;opacity:.75;font-size:.88em;">🏃 <b>${token.document.name}</b> dashes ${retreatFt}ft away!</div>`
        : `<div style="padding:2px 8px;opacity:.75;font-size:.88em;">🚧 <b>${token.document.name}</b> is cornered — cannot retreat!</div>`,
    });
  },

  async _runCommand(token, actor, cmd) {
    try {
      switch (cmd.type) {
        case "hold":
          break; // Stay put — action readied (no auto-move)

        case "goto":
          if (cmd.x != null && cmd.y != null) {
            await Mover.moveToward(token, cmd.x, cmd.y, { useDash: cmd.dash ?? false });
          }
          break;

        case "follow": {
          const ft = canvas.tokens.placeables.find(t => t.id === cmd.targetId);
          if (ft) await Mover.moveToward(token, ft.x, ft.y, { useDash: true });
          break;
        }

        case "attack": {
          const ft = canvas.tokens.placeables.find(t => t.id === cmd.targetId);
          if (ft) {
            const av  = ActionScanner.scan(actor);
            const act = AIDriver._pickAction("brute", av.actions, ft);
            if (act) {
              const gs2  = canvas.scene?.grid?.size ?? 100;
              const fpc2 = canvas.scene?.grid?.distance ?? 5;
              const rp   = ((act.range ?? 5) / fpc2) * gs2;
              const scx  = token.x + (token.document.width  ?? 1) * gs2 / 2;
              const scy  = token.y + (token.document.height ?? 1) * gs2 / 2;
              const tcx  = ft.x    + (ft.document.width     ?? 1) * gs2 / 2;
              const tcy  = ft.y    + (ft.document.height    ?? 1) * gs2 / 2;
              const d    = Math.hypot(scx - tcx, scy - tcy);
              if (d > rp) {
                const dest = AIDriver._approachDest({ x: scx, y: scy }, { x: tcx, y: tcy }, rp);
                await Mover.moveToward(token, dest.x, dest.y);
                await AIDriver._pause(350);
              }
              await AIDriver._doAction(actor, act, ft);
            }
          }
          break;
        }

        case "flee": {
          const near = canvas.tokens.placeables
            .filter(t => t.id !== token.id && AIDriver._hostile(token.document.disposition, t.document.disposition) && (t.actor?.system?.attributes?.hp?.value ?? 0) > 0)
            .sort((a, b) => Math.hypot(token.x - a.x, token.y - a.y) - Math.hypot(token.x - b.x, token.y - b.y))[0];
          if (near) {
            const awayX = token.x * 2 - near.x;
            const awayY = token.y * 2 - near.y;
            await Mover.moveToward(token, awayX, awayY, { useDash: true });
          }
          break;
        }
      }
    } catch(e) { console.warn("[CavrilCommander] _runCommand error:", e); }
    game.user.updateTokenTargets([]);
    await AIDriver._pause(600);
    await AIDriver._next();
  },

  _pickTarget(tactic, self, enemies, allies) {
    const nearest = arr => arr.reduce((a, b) =>
      Math.hypot(self.x - a.x, self.y - a.y) <= Math.hypot(self.x - b.x, self.y - b.y) ? a : b
    );
    const lowestHp = arr => arr.reduce((a, b) =>
      (a.actor?.system?.attributes?.hp?.value ?? 999) <= (b.actor?.system?.attributes?.hp?.value ?? 999) ? a : b
    );

    switch (tactic) {
      case "medic":
        // Heal allies (lowest HP) > attack nearest enemy
        if (allies.some(a => (a.actor?.system?.attributes?.hp?.value ?? 999) < (a.actor?.system?.attributes?.hp?.max ?? 999)))
          return lowestHp(allies);
        return nearest(enemies);
      case "assassin":
        return lowestHp(enemies);
      case "coward":
        // Flee from nearest — target is "away from nearest enemy"; still needs an object
        return nearest(enemies);
      case "guardian":
      case "sentinel":
      case "brute":
      default:
        return nearest(enemies);
    }
  },

  _pickAction(tactic, pool, target) {
    if (!pool.length) return null;
    const prefRanged = ["artillery", "sentinel"].includes(tactic);
    return pool.slice().sort((a, b) => {
      // Prefer attack/spell over features
      const typeScore = (x) => x.category === "attack" ? 2 : x.category === "spell" ? 1 : 0;
      const dirScore  = (x) => prefRanged ? (x.ranged ? 1 : 0) : (x.reach ? 1 : 0);
      return (typeScore(b) + dirScore(b)) - (typeScore(a) + dirScore(a));
    })[0];
  },

  // Point on line from target toward self, at distance rPx from target
  _approachDest(self, target, rPx) {
    const dx = self.x - target.x, dy = self.y - target.y;
    const d  = Math.hypot(dx, dy) || 1;
    const frac = Math.max(0, (d - rPx * 0.85)) / d;
    return { x: target.x + dx * frac, y: target.y + dy * frac };
  },

  async _doAction(actor, action, target) {
    // Fallback path: used only when no real dnd5e items were found on the actor.
    // Uses direct Roll calls (no item.use()) so it never blocks on a dialog.
    const targetName = target?.actor?.name ?? target?.document?.name ?? "target";
    console.log(`[CavrilCommander] _doAction (fallback): ${actor.name} → ${targetName} with "${action.name}" (atk+${action.attackBonus ?? 0})`);
    try {
      const atkBonus    = action.attackBonus ?? 0;
      const atkFormula  = atkBonus >= 0 ? `1d20+${atkBonus}` : `1d20-${Math.abs(atkBonus)}`;
      const atkRoll     = await new Roll(atkFormula).evaluate();

      const targetAC    = target?.actor?.system?.attributes?.ac?.value ?? null;
      const hit         = targetAC !== null ? atkRoll.total >= targetAC : null;
      const effectiveHit = hit ?? (atkRoll.total >= 10);

      let dmgRoll = null;
      if (action.damage && effectiveHit) {
        const rawDice    = String(action.damage.dice ?? "1").trim() || "1";
        const dmgFormula = /\d/.test(rawDice) ? rawDice : "1";
        dmgRoll = await new Roll(dmgFormula).evaluate();
      }

      // ── Styled chat card ─────────────────────────────────────────────────
      const hitLabel = hit !== null
        ? (hit ? `<span style="color:#22c55e;font-weight:700;">HIT</span> <span style="opacity:0.6;">(AC ${targetAC})</span>`
                : `<span style="color:#ef4444;font-weight:700;">MISS</span> <span style="opacity:0.6;">(AC ${targetAC})</span>`)
        : `<span style="color:#f59e0b;font-weight:600;">${atkRoll.total}</span>`;

      const dmgLine = dmgRoll
        ? `<div style="margin-top:3px;">💥 Damage: <b>${dmgRoll.total}</b> <span style="opacity:0.55;font-size:0.82em;">${action.damage.type ?? ""}</span></div>`
        : "";

      console.log(`[CavrilCommander] Roll result: ${atkRoll.total} vs AC ${targetAC} → ${hit === null ? "unknown" : hit ? "HIT" : "MISS"}${dmgRoll ? `, dmg ${dmgRoll.total}` : ""}`);

      await ChatMessage.create({
        speaker: ChatMessage.getSpeaker({ actor }),
        content: `<div style="border-left:3px solid #ef4444;padding:3px 8px;background:#1a0a0a;border-radius:0 4px 4px 0;font-family:inherit;">
          <div><b>${actor.name}</b> ⚔️ <b>${targetName}</b></div>
          <div style="font-size:0.85em;opacity:0.7;margin-bottom:2px;"><em>${action.name}</em></div>
          <div>Attack: <b>${atkRoll.total}</b> <span style="opacity:0.5;font-size:0.8em;">(d20+${atkBonus})</span> — ${hitLabel}</div>
          ${dmgLine}
        </div>`,
      });

      // ── Apply damage if we have a confirmed hit ───────────────────────────
      if (dmgRoll && hit === true && target?.actor) {
        try {
          if (typeof target.actor.applyDamage === "function") {
            // dnd5e 3.x API
            await target.actor.applyDamage(
              [{ value: dmgRoll.total, type: action.damage.type ?? "bludgeoning" }]
            );
          } else {
            // Direct HP write fallback (non-dnd5e systems or older versions)
            const cur = target.actor.system?.attributes?.hp?.value ?? 0;
            await target.actor.update({
              "system.attributes.hp.value": Math.max(0, cur - dmgRoll.total),
            });
          }
        } catch(e) {
          // Damage application is best-effort — mismatched API just means
          // the GM handles HP manually from the roll card.
          console.warn("[CavrilCommander] damage apply:", e.message);
        }
      }
    } catch(e) {
      // Make this visible — a silent warning here means nobody attacks and
      // it's very hard to diagnose without seeing it.
      console.error("[CavrilCommander] _doAction FAILED:", e);
      ui.notifications?.warn(`${actor.name} attack failed: ${e.message?.slice(0,80) ?? e}`);
    }
  },

  _hostile(selfDisp, otherDisp) {
    return (selfDisp === DISP.FRIENDLY && otherDisp === DISP.HOSTILE)
        || (selfDisp === DISP.HOSTILE  && otherDisp === DISP.FRIENDLY);
  },
  _allied(selfDisp, otherDisp) {
    return selfDisp === otherDisp && selfDisp !== DISP.NEUTRAL;
  },

  _next()       { return game.combat?.nextTurn?.() ?? Promise.resolve(); },
  _pause(ms)    { return new Promise(r => setTimeout(r, ms)); },

  // ── Targeting helpers (Foundry V12 API) ────────────────────────────────────
  // game.user.updateTokenTargets() was removed in V12.
  // V12 uses token.setTarget() instead.
  _setTarget(tokenId) {
    try {
      // Release all existing targets first
      for (const t of [...(game.user.targets ?? [])]) {
        t.setTarget(false, { user: game.user, releaseOthers: false });
      }
      if (!tokenId) return;
      const tok = canvas.tokens?.placeables?.find(t => t.id === tokenId);
      if (tok) tok.setTarget(true, { user: game.user, releaseOthers: false });
    } catch(e) { /* targeting is cosmetic — don't let it break turns */ }
  },
  _clearTargets() {
    try {
      for (const t of [...(game.user.targets ?? [])]) {
        t.setTarget(false, { user: game.user, releaseOthers: false });
      }
    } catch(e) {}
  },
};

// ============================================================================
// §7 — UI
// Floating command palette (bottom-center) on token selection.
// Command indicator badges on tokens.
// ============================================================================
const UI = {
  _el:          null,
  _indRaf:      null,   // rAF gate for indicator repositioning on pan
  _targetCb:    null,   // pending targeting callback

  init() {
    Hooks.on("controlToken",  () => UI._onSelectionChange());
    Hooks.on("updateToken",   (tdoc) => UI._onUpdateToken(tdoc));
    Hooks.on("deleteToken",   (tdoc) => UI._removeIndicator(tdoc.id));
    Hooks.on("canvasReady",   () => UI.refreshIndicators());
    Hooks.on("canvasPan",     () => UI._onPan());
    document.addEventListener("keydown", ev => {
      if (ev.key === "Escape") UI._cancelTargeting();
    });
  },

  // ── Selection change ────────────────────────────────────────────────────
  _onSelectionChange() {
    const sel = canvas.tokens?.controlled ?? [];
    if (sel.length) UI._show(sel);
    else            UI._hide();
  },

  _onUpdateToken(tdoc) {
    // Refresh indicator badge for this token
    UI._removeIndicator(tdoc.id);
    const cmd = Commands.get(tdoc);
    if (cmd && !["auto","dead"].includes(cmd.type)) {
      const token = canvas.tokens?.placeables?.find(t => t.id === tdoc.id);
      if (token) UI._createIndicator(token, cmd);
    }
    // Re-render palette if token is selected
    const sel = canvas.tokens?.controlled ?? [];
    if (sel.some(t => t.id === tdoc.id)) UI._show(sel);
  },

  _onPan() {
    if (UI._indRaf) return;
    UI._indRaf = requestAnimationFrame(() => {
      UI._indRaf = null;
      UI.refreshIndicators();
    });
  },

  // ── Palette ─────────────────────────────────────────────────────────────
  _show(tokens) {
    UI._ensure();
    UI._render(tokens);
    UI._el.style.display = "flex";
  },

  _hide() {
    if (UI._el) UI._el.style.display = "none";
    UI._cancelTargeting();
  },

  _ensure() {
    if (UI._el && document.body.contains(UI._el)) return;
    const el = document.createElement("div");
    el.id = "cavril-commander-palette";
    el.style.cssText = [
      "position:fixed","bottom:76px","left:50%","transform:translateX(-50%)",
      "z-index:80","display:flex","align-items:center","gap:10px",
      "background:rgba(10,10,18,0.94)","border:1px solid rgba(255,255,255,0.12)",
      "border-radius:16px","padding:8px 16px",
      "box-shadow:0 4px 32px rgba(0,0,0,0.8)",
      "font-family:Signika,ui-sans-serif,sans-serif",
      "user-select:none","white-space:nowrap",
    ].join(";");
    document.body.appendChild(el);
    UI._el = el;
  },

  _render(tokens) {
    const el = UI._el;

    // Aggregate current state for the selection
    const dispSet   = new Set(tokens.map(t => t.document.disposition));
    const tacticSet = new Set(tokens.map(t => t.document.flags?.[FLAG_NS]?.cavrilTactic ?? ""));
    const curDisp   = dispSet.size   === 1 ? [...dispSet][0]   : null;
    const curTactic = tacticSet.size === 1 ? [...tacticSet][0] : null;

    el.innerHTML = `
      ${UI._renderDisp(curDisp)}
      ${UI._divider()}
      ${UI._renderCmds()}
      ${UI._divider()}
      ${UI._renderTactics(curTactic)}
      ${UI._divider()}
      ${UI._renderSimToggle()}
    `;

    // Wire events
    el.querySelectorAll("[data-set-disp]").forEach(btn =>
      btn.addEventListener("click", () => UI._setDisp(tokens, parseInt(btn.dataset.setDisp)))
    );
    el.querySelectorAll("[data-set-cmd]").forEach(btn =>
      btn.addEventListener("click", () => UI._startCmd(btn.dataset.setCmd, tokens))
    );
    el.querySelectorAll("[data-set-tactic]").forEach(btn =>
      btn.addEventListener("click", () => UI._setTactic(tokens, btn.dataset.setTactic))
    );
    el.querySelector("#cavril-sim-toggle")?.addEventListener("click", UI._toggleSim);
  },

  _divider() {
    return `<div style="width:1px;height:38px;background:rgba(255,255,255,0.09);margin:0 2px;"></div>`;
  },

  _renderDisp(curDisp) {
    const chips = [
      { v: DISP.FRIENDLY, l: "F", c: "#22c55e", t: "Friendly" },
      { v: DISP.NEUTRAL,  l: "N", c: "#f59e0b", t: "Neutral"  },
      { v: DISP.HOSTILE,  l: "H", c: "#ef4444", t: "Hostile"  },
    ].map(({ v, l, c, t }) => {
      const on = curDisp === v;
      return `<button data-set-disp="${v}" title="${t}" style="
        width:30px;height:30px;border-radius:50%;
        border:2px solid ${c}${on ? "cc" : "44"};
        background:${on ? c + "28" : "transparent"};
        color:${c};font-weight:700;font-size:13px;
        cursor:pointer;transition:all 0.12s;
      " onmouseenter="this.style.background='${c}20'" onmouseleave="this.style.background='${on ? c + "28" : "transparent"}'">${l}</button>`;
    }).join("");
    return `<div style="display:flex;gap:5px;align-items:center;" title="Disposition">${chips}</div>`;
  },

  _renderCmds() {
    const btns = Object.entries(CMD_META).map(([id, { icon, color, label }]) => `
      <button data-set-cmd="${id}" title="${label}" style="
        display:flex;flex-direction:column;align-items:center;gap:2px;
        background:transparent;border:1px solid ${color}44;border-radius:8px;
        padding:5px 9px;color:${color};cursor:pointer;
        font-size:10px;font-weight:600;letter-spacing:0.3px;
        transition:all 0.1s;
      " onmouseenter="this.style.background='${color}20'" onmouseleave="this.style.background='transparent'">
        <i class="fas ${icon}" style="font-size:14px;"></i>
        <span>${label}</span>
      </button>`
    ).join("");
    return `<div style="display:flex;gap:5px;align-items:center;">${btns}</div>`;
  },

  _renderTactics(curTactic) {
    const chips = TACTIC_LIST.map(({ id, label, role, icon }) => {
      const c  = ROLE_COLOR[role] ?? "#a1a1aa";
      const on = curTactic === id;
      return `<button data-set-tactic="${id}" title="${label}" style="
        display:flex;align-items:center;gap:3px;
        background:${on ? c + "22" : "transparent"};
        border:1px solid ${on ? c + "99" : c + "33"};
        border-radius:6px;padding:3px 7px;
        color:${on ? c : "#94a3b8"};font-size:10px;
        font-weight:${on ? "700" : "400"};cursor:pointer;
        transition:all 0.1s;
      " onmouseenter="this.style.background='${c}18';this.style.color='${c}'"
        onmouseleave="this.style.background='${on ? c + "22" : "transparent"}';this.style.color='${on ? c : "#94a3b8"}'">
        <i class="fas ${icon}" style="font-size:9px;"></i>${label}
      </button>`;
    }).join("");
    return `<div style="display:flex;flex-wrap:wrap;gap:3px;max-width:210px;align-items:center;">${chips}</div>`;
  },

  _renderSimToggle() {
    const c = _simMode ? "#a855f7" : "#71717a";
    return `<button id="cavril-sim-toggle" title="${_simMode ? "Sim: ON — NPC turns run automatically. Click to disable." : "Sim: OFF — Click to enable auto-NPC turns."}" style="
      display:flex;flex-direction:column;align-items:center;gap:2px;
      background:${_simMode ? "#a855f722" : "transparent"};
      border:1px solid ${c}${_simMode ? "aa" : "44"};
      border-radius:8px;padding:5px 9px;color:${c};cursor:pointer;
      font-size:10px;font-weight:${_simMode ? "700" : "400"};transition:all 0.1s;
    " onmouseenter="this.style.background='${c}20'" onmouseleave="this.style.background='${_simMode ? "#a855f722" : "transparent"}'">
      <i class="fas fa-robot" style="font-size:14px;"></i>
      <span>${_simMode ? "SIM ON" : "SIM"}</span>
    </button>`;
  },

  // ── Commands ─────────────────────────────────────────────────────────────
  _startCmd(cmdId, tokens) {
    const ids = tokens.map(t => t.id);

    if (cmdId === "hold" || cmdId === "flee") {
      Commands.issue(ids, { type: cmdId });
      return;
    }

    if (cmdId === "goto") {
      UI._enterTargeting("Click the destination on the canvas.", (cx, cy) => {
        const gs = canvas.scene?.grid?.size ?? 100;
        Commands.issue(ids, { type: "goto", x: Math.round(cx / gs) * gs, y: Math.round(cy / gs) * gs });
        return false;  // one click resolves goto
      });
      return;
    }

    // follow / attack — need a token target
    // Callback returns true to keep targeting active, false when resolved.
    UI._enterTargeting(`Click a token to ${cmdId}.`, (cx, cy) => {
      // Explicit bounds check using scene-coord document position — avoids
      // relying on t.bounds which can be stale or behave differently across versions.
      const gs = canvas.scene?.grid?.size ?? 100;
      const hit = canvas.tokens?.placeables?.find(t => {
        if (ids.includes(t.id)) return false;
        const tw = (t.document.width  ?? 1) * gs;
        const th = (t.document.height ?? 1) * gs;
        return cx >= t.document.x && cx <= t.document.x + tw
            && cy >= t.document.y && cy <= t.document.y + th;
      });
      if (!hit) {
        ui.notifications.warn("No token there — click directly on a token. [Esc] to cancel.");
        return true;  // keep targeting active; user can try again without re-clicking Attack
      }
      Commands.issue(ids, { type: cmdId, targetId: hit.id });
      return false;   // resolved — exit targeting
    });
  },

  // ── Targeting mode ────────────────────────────────────────────────────────
  // Uses a document-level click listener (not canvas.app.view) so it fires
  // regardless of active Foundry layer. Converts screen → scene coords via
  // inverse worldTransform.
  //
  // callback(cx, cy) → return false to exit targeting, true to stay active
  // (so missed clicks on follow/attack auto-retry without re-clicking the button).
  _enterTargeting(hint, callback) {
    UI._cancelTargeting();
    ui.notifications.info(`${hint} [Esc] to cancel.`);
    document.body.style.cursor = "crosshair";

    // canvas.app.view was renamed to canvas.app.canvas in PIXI v8 / Foundry V13.
    // Support both so the same script runs on V12 and V13.
    const canvasEl = canvas.app?.canvas ?? canvas.app?.view;

    const handler = (ev) => {
      // Only fire on the PIXI canvas itself, not palette buttons or other overlays.
      if (ev.target !== canvasEl) return;
      ev.preventDefault();
      ev.stopPropagation();

      // Convert screen → scene coords via inverse worldTransform.
      const rect = canvasEl.getBoundingClientRect();
      const wt   = canvas.stage?.worldTransform;
      if (!wt) { UI._cancelTargeting(); return; }
      const sx = ev.clientX - rect.left;
      const sy = ev.clientY - rect.top;
      const cx = (sx - wt.tx) / wt.a;
      const cy = (sy - wt.ty) / wt.d;

      // If callback returns true, keep the listener alive for the next click.
      // If false (or undefined), we're done — remove listener.
      const keepActive = callback(cx, cy);
      if (!keepActive) UI._cancelTargeting();
    };

    UI._targetCb = handler;
    // No "once: true" — handler stays registered until _cancelTargeting() or
    // a successful resolution. This lets missed clicks retry automatically.
    document.addEventListener("click", handler, { capture: true });
  },

  _cancelTargeting() {
    document.body.style.cursor = "";
    if (UI._targetCb) {
      document.removeEventListener("click", UI._targetCb, { capture: true });
      UI._targetCb = null;
    }
  },

  // ── Disposition + Tactic writers ──────────────────────────────────────────
  async _setDisp(tokens, dispValue) {
    await canvas.scene?.updateEmbeddedDocuments("Token",
      tokens.map(t => ({ _id: t.id, disposition: dispValue }))
    );
    // Re-render palette with updated state
    UI._show(canvas.tokens?.controlled ?? tokens);
  },

  async _setTactic(tokens, tacticId) {
    // Write to token flag (scene-level, fast)
    await canvas.scene?.updateEmbeddedDocuments("Token",
      tokens.map(t => ({ _id: t.id, [`flags.${FLAG_NS}.cavrilTactic`]: tacticId }))
    );
    // Write to actor flag too (persists across scenes)
    for (const t of tokens) {
      try { await t.actor?.setFlag?.(FLAG_NS, "tactic", tacticId); } catch(e) {}
    }
    UI._show(canvas.tokens?.controlled ?? tokens);
  },

  // ── Sim toggle ───────────────────────────────────────────────────────────
  async _toggleSim() {
    _simMode = !_simMode;

    if (_simMode && game.combat) {
      // Auto-assign dispositions from actor type so the AI can tell friend from foe
      // without the GM manually F/N/H-chipping every token first.
      //   character (PC)  → Friendly
      //   npc             → Hostile
      // Tokens already explicitly set to Friendly or Hostile are left alone.
      const updates = [];
      for (const combatant of (game.combat.combatants ?? [])) {
        const tok = canvas.tokens?.placeables?.find(t => t.id === combatant.tokenId);
        if (!tok) continue;
        const cur  = tok.document.disposition;
        const type = combatant.actor?.type;
        if (type === "character" && cur !== DISP.FRIENDLY)
          updates.push({ _id: tok.id, disposition: DISP.FRIENDLY });
        else if (type === "npc" && cur !== DISP.HOSTILE)
          updates.push({ _id: tok.id, disposition: DISP.HOSTILE });
      }
      if (updates.length) {
        await canvas.scene?.updateEmbeddedDocuments("Token", updates);
        ui.notifications.info(`SIM ON — auto-assigned dispositions for ${updates.length} tokens (PCs=Friendly, NPCs=Hostile). Change any chip to override.`);
      } else {
        ui.notifications.info("Combat simulation: ON");
      }

      // If the current combatant is an NPC, kick off their turn right now —
      // otherwise SIM won't start until the tracker advances manually.
      const cur = game.combat?.combatant;
      if (cur?.actor?.type === "npc") {
        setTimeout(() => AIDriver.executeTurn(cur), 1200);
      }
    } else {
      ui.notifications.info(`Combat simulation: ${_simMode ? "ON" : "OFF"}`);
    }

    const sel = canvas.tokens?.controlled ?? [];
    if (sel.length) UI._show(sel);
  },

  // ── Command indicator badges ──────────────────────────────────────────────
  // Small colored dot in the top-right corner of each token that has
  // an active command. pointer-events:none so they don't block input.
  refreshIndicators() {
    document.querySelectorAll(".cavril-cmd-ind").forEach(el => el.remove());
    if (!canvas?.scene) return;
    for (const token of (canvas.tokens?.placeables ?? [])) {
      const cmd = Commands.get(token.document);
      if (!cmd || ["auto","dead"].includes(cmd.type)) continue;
      UI._createIndicator(token, cmd);
    }
  },

  _removeIndicator(tokenId) {
    document.querySelector(`.cavril-cmd-ind[data-tid="${tokenId}"]`)?.remove();
  },

  _createIndicator(token, cmd) {
    const wt   = canvas?.stage?.worldTransform;
    const cv   = canvas?.app?.view;
    if (!wt || !cv) return;
    const rect = cv.getBoundingClientRect();
    const gs   = canvas.scene?.grid?.size ?? 100;
    const tw   = (token.document.width  ?? 1) * gs;
    // Top-right corner of the token
    const sx   = rect.left + (token.document.x + tw) * wt.a + wt.tx;
    const sy   = rect.top  +  token.document.y        * wt.d + wt.ty;

    const meta = CMD_META[cmd.type] ?? { icon: "fa-circle", color: "#a1a1aa" };
    const el   = document.createElement("div");
    el.className = "cavril-cmd-ind";
    el.dataset.tid = token.id;
    el.title = `Command: ${meta.label ?? cmd.type}`;
    el.style.cssText = [
      "position:fixed",
      `left:${sx}px`,`top:${sy}px`,
      "transform:translate(-80%,10%)",
      "z-index:69",
      "width:18px","height:18px","border-radius:50%",
      `background:${meta.color}ee`,
      `border:2px solid rgba(0,0,0,0.5)`,
      "display:flex","align-items:center","justify-content:center",
      "font-size:8px","color:#fff",
      "pointer-events:none",
      "box-shadow:0 1px 4px rgba(0,0,0,0.7)",
    ].join(";");
    el.innerHTML = `<i class="fas ${meta.icon}"></i>`;
    document.body.appendChild(el);
  },
};

// ============================================================================
// §8 — COMBAT HOOKS
// ============================================================================
function _initCombatHooks() {
  Hooks.on("combatTurn", async (combat) => {
    if (!_simMode) return;
    try {
      const combatant = combat.combatant;
      if (!combatant) return;
      // Only auto-run for NPCs
      if (combatant.actor?.type !== "npc") return;
      await AIDriver._pause(700);
      await AIDriver.executeTurn(combatant);
    } catch(e) { console.warn("[CavrilCommander] combatTurn hook error:", e); }
  });
}

// ============================================================================
// §9 — BOOT
// ============================================================================
function _init() {
  if (window.CavrilCommander?._installed) return;

  // Public API
  window.CavrilCommander = {
    _installed: true,
    // Query
    scanActions:  actor       => ActionScanner.scan(actor),
    findPath:     (x0,y0,x1,y1) => Pathfinder.findPath(x0,y0,x1,y1),
    // Commands
    issueCommand: (ids, cmd)  => Commands.issue(ids, cmd),
    clearCommand: tokenId     => Commands.clear(tokenId),
    getCommand:   tokenDoc    => Commands.get(tokenDoc),
    // Movement
    moveToward:   (tok,x,y,o) => Mover.moveToward(tok,x,y,o),
    // AI
    executeTurn:  combatant   => AIDriver.executeTurn(combatant),
    simMode:      () => _simMode,
    setSim:       v  => { _simMode = !!v; },
    // UI
    ui: UI,
  };

  AutoDeath.init();
  UI.init();
  _initCombatHooks();

  // If canvas is already live (module re-run / macro mode), refresh indicators
  if (canvas?.scene) UI.refreshIndicators();

  console.log("[CavrilCommander] Loaded. window.CavrilCommander ready.");
}

if (game?.ready) _init();
else Hooks.once("ready", _init);

})(); // end IIFE
