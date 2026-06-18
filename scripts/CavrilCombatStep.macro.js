/**
 * Cavril — Combat Step
 * ============================================================================
 * Standalone: select a token, run macro.
 * From CombatSim: window.CavrilCombatStep.run(token)
 *
 * Turn: target → walk → (snap | dash | dodge) → attack → outcome animation
 * ============================================================================
 */

window.CavrilCombatStep = window.CavrilCombatStep ?? {};

// opts.autoRoll = true  → bypass roll dialog (used by CombatSim)
// ── One-time dedup hook ────────────────────────────────────────────────────
// Prevents two identical condition effects (e.g. Grappled) being applied to
// the same actor during a single item.use() workflow.  This happens when
// dnd5e v3's activity system AND MidiQOL both apply the item's effects.
// The flag window.__cavrilDeduping is raised only while our item.use() is
// in flight so normal gameplay is never affected.
if (!window.__cavrilEffectDedupHook) {
  window.__cavrilEffectDedupHook = Hooks.on("preCreateActiveEffect", (effect, data) => {
    if (!window.__cavrilDeduping) return true;
    const actor = effect.parent;
    if (!actor?.effects) return true;
    const newName = (data.name ?? "").toLowerCase().trim();
    if (!newName) return true;
    const already = [...actor.effects.values()].some(e => e.name.toLowerCase().trim() === newName);
    if (already) {
      console.log(`[CombatStep] Dedup: blocked duplicate effect "${data.name}"`);
      return false;
    }
    return true;
  });
}

window.CavrilCombatStep.run = async function (token, opts = {}) {
  const autoRoll = opts.autoRoll === true;
  if (!token?.actor) return;
  const actor = token.actor;
  const wait  = ms => new Promise(r => setTimeout(r, ms));

  // ── Pace ──────────────────────────────────────────────────────────────────
  // Controls the pause inserted between major combat beats so the GM can
  // narrate along.  Pass opts.pace as a number (ms) or a preset string.
  // "slow" = 1200ms  "medium" = 700ms (default)  "fast" = 300ms
  const pace = typeof opts.pace === "number" ? opts.pace
             : opts.pace === "slow"           ? 1200
             : opts.pace === "fast"           ? 300
             :                                  700;   // default: medium

  // ── Tactical AI constants (gs-independent) ───────────────────────────────
  // Self-preservation thresholds (HP fraction of max).
  //   MORALE_HP_PCT  — token prefers to disengage and flee.
  //   MORALE_HP_CRIT — emergency: token spends Dash action to flee.
  //   MORALE_OUTNUM  — token flees if (visible enemies − allies) ≥ this.
  const MORALE_HP_PCT  = 0.25;
  const MORALE_HP_CRIT = 0.10;
  const MORALE_OUTNUM  = 2;

  // ── Movement animation ────────────────────────────────────────────────────
  // true  → token slides step-by-step along its path (cinematic, more GPU load)
  // false → token jumps directly to its final position (instant, no frame drops)
  //
  // Large city scenes with many tokens cause WebGL frame violations (~120-150ms
  // per frame) during animations because PixiJS re-renders every visible sprite
  // each rAF tick.  Set this to false when running combat on a populated scene.
  // Can also be overridden per-call via opts.animate (true/false).
  const ANIMATE_MOVEMENT = opts.animate !== undefined ? !!opts.animate : true;

  // ── Grid ──────────────────────────────────────────────────────────────────
  const gs        = canvas.scene.grid.size;
  const ftPerCell = canvas.scene.grid.distance ?? 5;
  // Use the highest available movement speed — fly/swim if it exceeds walk,
  // so creatures like Rocs default to their primary (air) movement.
  const mov       = actor.system?.attributes?.movement ?? {};
  const walkFt    = Math.max(mov.walk ?? 0, mov.fly ?? 0, mov.swim ?? 0, mov.climb ?? 0) || 30;
  const walkCells = Math.max(1, Math.round(walkFt / ftPerCell));

  // Scene boundary in cells — keeps BFS finite.
  const maxCX = Math.ceil(canvas.scene.width  / gs) + 1;
  const maxCY = Math.ceil(canvas.scene.height / gs) + 1;

  // ── Tactical AI constants (gs-dependent) ─────────────────────────────────
  // FLANK_SLACK_PX — extra pixels the AI will travel to land on the opposite
  //   side of a target from a nearby ally (flanking preference).
  const FLANK_SLACK_PX  = gs * 2.0;

  // ── Off-grid distance tolerances ─────────────────────────────────────────
  const RANGE_SLACK_FT  = 3;          // generous slack for approach-cell generation
  const ATTACK_SLACK_FT = 0.5;        // strict "am I in range right now?" gate
  const WALL_MARGIN_PX  = gs * 0.5;   // preferred clearance from blocking walls

  // ── Grid / gridless detection ─────────────────────────────────────────────
  // type 0 = GRIDLESS, type 1 = SQUARE, type 2/3 = HEX variants.
  // All positioning and range-gate code branches on this flag.
  const SCENE_IS_GRIDLESS = (canvas.scene.grid.type ?? 0) === 0;

  // ── Screen notifications ──────────────────────────────────────────────────
  // notify() posts a stacking pill at the centre-top of the screen, below the
  // calendar widget.  Each pill persists ~3.5 s then fades out.  Messages
  // arrive sequentially so rapid calls stack — all remain readable.
  function notify(text, color = "#a78bfa") {
    if (!document.getElementById("cavril-notif-css")) {
      const s = document.createElement("style");
      s.id = "cavril-notif-css";
      s.textContent = `
        #cavril-notif-host {
          position: fixed; top: 80px; left: 50%; transform: translateX(-50%);
          z-index: 999999; pointer-events: none;
          display: flex; flex-direction: column; gap: 5px; align-items: center;
        }
        .cavril-notif {
          padding: 5px 18px; border-radius: 6px;
          background: rgba(12,12,22,0.90); border-left: 3px solid #a78bfa;
          color: #f1f5f9; font-size: 13px; font-family: sans-serif;
          font-style: italic; line-height: 1.4; white-space: nowrap;
          box-shadow: 0 2px 10px rgba(0,0,0,.55);
          animation: cavril-drop-in 0.18s ease-out both;
          transition: opacity 0.35s ease;
        }
        @keyframes cavril-drop-in {
          from { opacity: 0; transform: translateY(-10px); }
          to   { opacity: 1; transform: translateY(0); }
        }`;
      document.head.appendChild(s);
    }
    let host = document.getElementById("cavril-notif-host");
    if (!host) {
      host = document.createElement("div");
      host.id = "cavril-notif-host";
      document.body.appendChild(host);
    }
    const el = document.createElement("div");
    el.className = "cavril-notif";
    el.style.borderLeftColor = color;
    el.textContent = text;
    host.appendChild(el);
    // Auto-fade: 3.5 s display then 350 ms fade, then DOM remove
    setTimeout(() => { el.style.opacity = "0"; setTimeout(() => el.remove(), 360); }, 3500);
  }

  // ── Chat ──────────────────────────────────────────────────────────────────
  async function say(line, color = "#a78bfa") {
    // Post a screen notification (HTML stripped) + a chat message.
    const plain = line.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
    const txt   = plain.length > 72 ? plain.slice(0, 69) + "…" : plain;
    notify(txt, color);
    await ChatMessage.create({
      speaker: ChatMessage.getSpeaker({ actor, token: token.document }),
      content: `<div style="padding:3px 8px;border-left:3px solid ${color};
                font-style:italic;font-size:.9em;">${line}</div>`,
    });
    await wait(80);   // minimal delay — explicit pace waits are added between phases
  }

  // ── Rotation ──────────────────────────────────────────────────────────────
  // Token art defaults to facing south at rotation=0 → add 270° to atan2.
  const facingDeg = (dx, dy) => (Math.atan2(dy, dx) * 180 / Math.PI + 270 + 360) % 360;

  async function rotateTo(tok, dx, dy, ms = 260) {
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
    await tok.document.update({ rotation: facingDeg(dx, dy) });
    await wait(ms);
  }

  async function waitAnim(tok, fallback) {
    await wait(80);
    try {
      const key  = tok.animationName ?? `Token.${tok.id}`;
      const anim = CanvasAnimation.getAnimation?.(key);
      if (anim?.promise) { await anim.promise; await wait(60); return; }
    } catch (_) {}
    await wait(Math.max(0, fallback - 80));
  }

  // ── LOS helpers (wall-geometry, multi-version) ───────────────────────────
  // Primary: Foundry V12+ polygon backend (ClockwiseSweepPolygon), which handles
  // ALL wall types (sight / terrain / ethereal) correctly.
  // Secondary: globalThis.ClockwiseSweepPolygon direct call (same class, different path).
  // Tertiary: Ray-based canvas.walls.checkCollision (V10-V11 compatible).
  // Last resort: FAIL CLOSED — treat as no LOS so a wall-blocked target is never
  // selected.  A missed attack opportunity is far less disruptive than the token
  // pathfinding toward an unreachable target and doing nothing.
  function hasLOSfromPx(ax, ay, bx, by) {
    if (Math.abs(ax-bx) < 0.1 && Math.abs(ay-by) < 0.1) return true;
    const origin = {x:ax, y:ay}, dest = {x:bx, y:by};
    try {
      const pb = CONFIG.Canvas.polygonBackends?.sight;
      if (typeof pb?.testCollision === "function")
        return !pb.testCollision(origin, dest, {type:"sight", mode:"any"});
    } catch(_) {}
    try {
      const CSP = globalThis.ClockwiseSweepPolygon;
      if (typeof CSP?.testCollision === "function")
        return !CSP.testCollision(origin, dest, {type:"sight", mode:"any"});
    } catch(_) {}
    try {
      const R = globalThis.Ray ?? foundry?.canvas?.geometry?.Ray;
      if (R) return !canvas.walls.checkCollision(new R(origin, dest), {type:"sight", mode:"any"});
    } catch(_) {}
    console.warn("[CombatStep] LOS API unavailable — treating ray as blocked");
    return false;  // fail CLOSED: no LOS if all APIs are unavailable
  }

  // Token-to-token LOS (centre of each footprint).
  function hasLOS(a, b) {
    return hasLOSfromPx(
      a.document.x + (a.document.width  ?? 1) * gs / 2,
      a.document.y + (a.document.height ?? 1) * gs / 2,
      b.document.x + (b.document.width  ?? 1) * gs / 2,
      b.document.y + (b.document.height ?? 1) * gs / 2
    );
  }

  // LOS from the CENTRE of a hypothetical attacker footprint at cell (cx, cy)
  // to a target token.  Used by the search phase to evaluate candidate positions
  // without actually moving the token.
  function hasLOSfromCell(cx, cy, toToken) {
    const atkW = token.document.width  ?? 1;
    const atkH = token.document.height ?? 1;
    return hasLOSfromPx(
      cx * gs + atkW * gs / 2,
      cy * gs + atkH * gs / 2,
      toToken.document.x + (toToken.document.width  ?? 1) * gs / 2,
      toToken.document.y + (toToken.document.height ?? 1) * gs / 2
    );
  }

  // ── Special senses (dnd5e 5.x compatible) ────────────────────────────────
  // dnd5e 5.3 moved senses from attributes.senses.X → attributes.senses.ranges.X.
  // Read both paths so we work on 5.0-5.3 without deprecation warnings.
  function getSenseRange(actor, sense) {
    const senses = actor?.system?.attributes?.senses;
    if (!senses) return 0;
    return (senses.ranges?.[sense] ?? senses[sense]) || 0;
  }

  // Full perception check — geometric LOS plus special senses.
  //
  //   Tremorsense — detects vibrations through shared ground; bypasses walls.
  //                 Range-gated only: if within tremorsense radius → perceived.
  //   Blindsight  — echolocation / pressure; still blocked by total cover (walls).
  //                 Treated the same as geometric LOS for our purposes.
  //   Darkvision / Truesight — see through darkness/illusions; walls still block.
  //                 No extra check needed — geometric LOS handles them.
  function canPerceive(fromToken, toToken) {
    // Tremorsense bypasses walls — distance is the only gate.
    const tremor = getSenseRange(fromToken.actor, "tremorsense");
    if (tremor > 0 && measureFt(fromToken, toToken) <= tremor) return true;
    // Everything else: wall-geometry LOS.
    return hasLOS(fromToken, toToken);
  }

  // Hypothetical canPerceive from a proposed attacker cell (no actual move).
  function canPerceiveFromCell(cx, cy, toToken) {
    const atkW = token.document.width  ?? 1;
    const atkH = token.document.height ?? 1;
    const t    = tokenCellFootprint(toToken);   // handles off-grid placement
    const { naX, naY, ntX, ntY } = nearestCells(cx, cy, atkW, atkH, t.cx, t.cy, t.cw, t.ch);
    const distFt = cellPairFt(naX, naY, ntX, ntY);
    const tremor = getSenseRange(token.actor, "tremorsense");
    if (tremor > 0 && distFt <= tremor) return true;
    return hasLOSfromCell(cx, cy, toToken);
  }

  // ── Movement-wall collision (single ray, raw pixels) ─────────────────────
  // Uses the V12+ polygon backend (CONFIG.Canvas.polygonBackends.move) as the
  // primary check, with the Ray-based API as fallback.  Returns true if the ray
  // is blocked by a movement wall.
  function moveBlocked(ax, ay, bx, by) {
    if (Math.abs(ax-bx) < 0.1 && Math.abs(ay-by) < 0.1) return false;
    const origin = {x:ax, y:ay}, dest = {x:bx, y:by};
    // Check BOTH movement and sight walls so that decorative/sight-only walls
    // (no Foundry "move" flag) still stop the token.  The GM's double-wall
    // style uses sight-only walls: type:"move" returns false for them, letting
    // tokens walk through.  A sight-wall check catches those too.
    try {
      const pbMove  = CONFIG.Canvas.polygonBackends?.move;
      const pbSight = CONFIG.Canvas.polygonBackends?.sight;
      if (pbMove  && pbMove .testCollision(origin, dest, {type:"move",  mode:"any"})) return true;
      if (pbSight && pbSight.testCollision(origin, dest, {type:"sight", mode:"any"})) return true;
      if (pbMove || pbSight) return false;   // backends present, neither blocked
    } catch(_) {}
    try {
      // Legacy Ray-based fallback — also checks both types.
      const R = globalThis.Ray ?? foundry?.canvas?.geometry?.Ray;
      if (R) {
        const ray = new R(origin, dest);
        if (canvas.walls.checkCollision(ray, {type:"move",  mode:"any"})) return true;
        if (canvas.walls.checkCollision(ray, {type:"sight", mode:"any"})) return true;
      }
    } catch(_) {}
    return false;   // fail open — never silently block movement
  }

  // ── Wall check between two BFS-node positions ────────────────────────────
  // BFS nodes are the token's TOP-LEFT cell.  For a multi-cell token we check
  // the footprint CENTRE plus all FOUR CORNERS so that:
  //   • Walls that split the centre ray are caught (as before).
  //   • Walls that a large token's edge would clip — but that the centre ray
  //     misses — are also caught.
  //   • Sight-only walls (no Foundry movement flag) are blocked via moveBlocked
  //     now checking type:"sight" as well as type:"move".
  //
  // squeeze=true: treat the token as one size smaller (5e squeezing rule).
  // The footprint used for wall-probing shrinks by one cell in each dimension,
  // letting the token thread through gaps that its full body could not fit.
  function canStep(cx1, cy1, cx2, cy2, squeeze = false) {
    const rawW = token.document.width  ?? 1;
    const rawH = token.document.height ?? 1;
    const atkW = squeeze ? Math.max(1, rawW - 1) : rawW;
    const atkH = squeeze ? Math.max(1, rawH - 1) : rawH;

    // Footprint-centre pixel positions for each BFS node.
    const x1 = cx1 * gs + atkW * gs / 2;
    const y1 = cy1 * gs + atkH * gs / 2;
    const x2 = cx2 * gs + atkW * gs / 2;
    const y2 = cy2 * gs + atkH * gs / 2;

    // Centre ray.
    if (moveBlocked(x1, y1, x2, y2)) return false;

    // Corner rays with 20 % inset — far enough from cell edges to avoid
    // false positives from building walls on exact grid boundaries, close
    // enough to catch walls genuinely bisecting the footprint interior.
    const m = gs * 0.20;
    const srcTL = [cx1       * gs + m,          cy1       * gs + m         ];
    const srcTR = [(cx1+atkW)* gs - m,           cy1       * gs + m         ];
    const srcBL = [cx1       * gs + m,           (cy1+atkH)* gs - m         ];
    const srcBR = [(cx1+atkW)* gs - m,           (cy1+atkH)* gs - m         ];
    const dstTL = [cx2       * gs + m,           cy2       * gs + m         ];
    const dstTR = [(cx2+atkW)* gs - m,           cy2       * gs + m         ];
    const dstBL = [cx2       * gs + m,           (cy2+atkH)* gs - m         ];
    const dstBR = [(cx2+atkW)* gs - m,           (cy2+atkH)* gs - m         ];
    if (moveBlocked(srcTL[0], srcTL[1], dstTL[0], dstTL[1])) return false;
    if (moveBlocked(srcTR[0], srcTR[1], dstTR[0], dstTR[1])) return false;
    if (moveBlocked(srcBL[0], srcBL[1], dstBL[0], dstBL[1])) return false;
    if (moveBlocked(srcBR[0], srcBR[1], dstBR[0], dstBR[1])) return false;

    return true;
  }

  // ── Shared cell-pair helper ───────────────────────────────────────────────
  // Returns the nearest occupied cell in range A (na*) and range B (nt*).
  // Each range is an axis-aligned rectangle of cells: top-left (x1,y1),
  // width w, height h.  If the ranges overlap the result is the shared cell —
  // na == nt, and the caller returns 0 ft.
  //
  // Why cell-to-cell instead of pixel nearest-edge?
  //   canvas.grid.measurePath is designed for centre-to-centre grid steps.
  //   When handed a sub-cell path (e.g. attacker centre → nearest pixel on
  //   target bounding box), Foundry measures raw Euclidean pixels regardless
  //   of the scene's diagonal-mode setting — so a diagonal-adjacent token
  //   reads as ~7 ft even on an equidistant (5-5-5) grid.
  //   Feeding it two full cell-CENTRES gives it a proper grid step, and
  //   Foundry applies the configured diagonal rule correctly.
  // ── Off-grid token footprint ──────────────────────────────────────────────
  // Citizens are placed at arbitrary pixel positions within buildings, not
  // necessarily at grid-aligned coordinates.  Math.round(document.x / gs) can
  // give the WRONG cell when the token's left edge is past the midpoint of a
  // cell: e.g. document.x=450 on a 100px grid rounds to cell 5, but the body
  // spans pixels 450-549 which covers cells 4 AND 5.  An attacker at cell 3
  // would then compute 10ft (two-cell gap to cell 5) instead of 5ft (one-cell
  // gap to cell 4) — exactly the "can't reach from this side" bug.
  //
  // Solution: compute the full pixel extent and derive ALL cells the token
  // physically touches, using Math.floor (never rounds past the boundary).
  // This expands single-cell off-grid tokens to span two cells when needed,
  // and keeps on-grid tokens exactly as-is.
  //
  // Returns {cx, cy, cw, ch} — the effective grid-cell bounding box.
  function tokenCellFootprint(tok) {
    const w  = tok.document.width  ?? 1;
    const h  = tok.document.height ?? 1;
    const cx = Math.floor(tok.document.x / gs);
    const cy = Math.floor(tok.document.y / gs);
    // Include every cell whose left/top boundary falls within the pixel extent.
    // (document.x + w*gs - 1) is the last pixel of the token's right edge.
    const cx2 = Math.floor((tok.document.x + w * gs - 1) / gs);
    const cy2 = Math.floor((tok.document.y + h * gs - 1) / gs);
    return { cx, cy, cw: cx2 - cx + 1, ch: cy2 - cy + 1 };
  }

  function nearestCells(ax1, ay1, aw, ah, bx1, by1, bw, bh) {
    // 1-D: nearest cell in [a1, a1+aw-1] facing [b1, b1+bw-1]
    function near1D(a1, aw, b1, bw) {
      const a2 = a1 + aw - 1, b2 = b1 + bw - 1;
      if (b1 > a2) return { na: a2, nb: b1 };   // b entirely right of a
      if (a1 > b2) return { na: a1, nb: b2 };   // b entirely left of a
      const mid = Math.max(a1, b1);              // overlap — pick shared cell
      return { na: mid, nb: mid };
    }
    const { na: naX, nb: ntX } = near1D(ax1, aw, bx1, bw);
    const { na: naY, nb: ntY } = near1D(ay1, ah, by1, bh);
    return { naX, naY, ntX, ntY };
  }

  // Measure feet between two pairs of nearest occupied cells.
  // p1/p2 are cell-CENTRE pixels — measurePath handles diagonal mode correctly.
  function cellPairFt(naX, naY, ntX, ntY) {
    if (naX === ntX && naY === ntY) return 0;
    const p1 = { x: naX * gs + gs / 2, y: naY * gs + gs / 2 };
    const p2 = { x: ntX * gs + gs / 2, y: ntY * gs + gs / 2 };
    try {
      const d = canvas.grid.measurePath?.([p1, p2])?.distance;
      if (d != null) return d;
    } catch (_) {}
    try {
      const R  = foundry.canvas?.geometry?.Ray ?? globalThis.Ray;
      const [d] = canvas.grid.measureDistances([{ ray: new R(p1, p2) }], { gridSpaces: true });
      if (d != null) return d;
    } catch (_) {}
    // Chebyshev fallback — correct for equidistant (5-5-5) diagonal mode
    return Math.max(Math.abs(ntX - naX), Math.abs(ntY - naY)) * ftPerCell;
  }

  // ── Live distance measurement (nearest occupied cell, uses document pos) ──
  // Uses tokenCellFootprint so off-grid tokens are handled correctly.
  function measureFt(tokA, tokB) {
    const a = tokenCellFootprint(tokA);
    const b = tokenCellFootprint(tokB);
    const { naX, naY, ntX, ntY } = nearestCells(a.cx, a.cy, a.cw, a.ch, b.cx, b.cy, b.cw, b.ch);
    return cellPairFt(naX, naY, ntX, ntY);
  }

  // ── Straight-line greedy path ──────────────────────────────────────────────
  // Moves diagonally toward the target until aligned on one axis, then cardinal.
  // This is the minimum-turn path on a Chebyshev grid — no unnecessary detours.
  // ── Hypothetical distance from a proposed attacker cell position ─────────
  // Answers: "if the attacker were standing at cell (cx,cy), how many feet
  // to the target?"  Uses the nearestCells + cellPairFt helpers above, so
  // it always measures cell-centre to cell-centre and respects diagonal mode.
  function pxHypFt(cx, cy, targetTok) {
    const atkW = token.document.width  ?? 1;
    const atkH = token.document.height ?? 1;
    // Use the full pixel-extent footprint for the target so off-grid citizens
    // are correctly treated as occupying all cells their body spans.
    const t = tokenCellFootprint(targetTok);
    const { naX, naY, ntX, ntY } = nearestCells(cx, cy, atkW, atkH, t.cx, t.cy, t.cw, t.ch);
    return cellPairFt(naX, naY, ntX, ntY);
  }

  // ── Pixel-exact distance functions ───────────────────────────────────────
  // hypotheticalFt expands off-grid targets to a multi-cell footprint, which
  // can make a token appear closer than it truly is (the expanded footprint
  // reaches further toward the attacker than the token's actual centre).
  // These two functions use true Euclidean centre-to-centre pixel distance
  // instead, which matches what dnd5e uses for its own attack range checks.
  //
  // pxDistFt    — distance between two tokens that are ALREADY on the canvas.
  // pxHypFt     — distance from a HYPOTHETICAL attacker cell (cx, cy) to a
  //               target that may be off-grid.
  //
  // Used for "am I already in range?" and pre-attack gate checks only.
  // moveCandidates / findReachableTarget still use pxHypFt + RANGE_SLACK_FT
  // to generate a generous set of approach cells; the stricter ATTACK_SLACK_FT
  // is used only when deciding whether to skip movement or attempt an attack.
  function pxDistFt(tokA, tokB) {
    const ax = tokA.document.x + (tokA.document.width  ?? 1) * gs / 2;
    const ay = tokA.document.y + (tokA.document.height ?? 1) * gs / 2;
    const bx = tokB.document.x + (tokB.document.width  ?? 1) * gs / 2;
    const by = tokB.document.y + (tokB.document.height ?? 1) * gs / 2;
    return Math.hypot(ax - bx, ay - by) / gs * ftPerCell;
  }

  function pxHypFt(cx, cy, targetTok) {
    const atkW = token.document.width  ?? 1;
    const atkH = token.document.height ?? 1;
    const ax   = cx * gs + atkW * gs / 2;
    const ay   = cy * gs + atkH * gs / 2;
    const bx   = targetTok.document.x + (targetTok.document.width  ?? 1) * gs / 2;
    const by   = targetTok.document.y + (targetTok.document.height ?? 1) * gs / 2;
    return Math.hypot(ax - bx, ay - by) / gs * ftPerCell;
  }

  // ── Gridless pixel-space movement helpers ─────────────────────────────────
  // Phase 4 movement is entirely pixel-exact: tokens slide to the nearest
  // valid point at weapon range rather than snapping to a grid cell.
  //
  // posOccupiedPx  — AABB overlap: would placing attacker TL at (tlx,tly)
  //                  collide with any live token?
  // posNearWallPx  — is the pixel centre (cx,cy) within WALL_MARGIN_PX of
  //                  any blocking wall?  (Reuses _ptSegDist defined later.)
  // pathClearPx    — multi-ray movement-wall check between two pixel centres.
  // findAttackPosPx — sweep a ring at weaponRangePx around the target, find
  //                  the closest valid position (budget, LOS, clear, no overlap).
  // findApproachPosPx — binary-search the furthest clear point toward target.
  // placeAtPx      — single document.update with sight suppression + animation.
  //
  // NOTE: posNearWallPx / findAttackPosPx reference _ptSegDist and WALL_MARGIN_PX
  // which are defined in the moveCandidates/wall-filter block further below.
  // All gridless helpers are CALLED in Phase 4 which runs after that block.

  // skipId: pass target.id when checking attack ring positions so the attacker
  // is allowed to be adjacent to (touching) the target token.  Without this,
  // every 5ft ring position has its AABB touching the target's AABB and gets
  // falsely rejected, causing the "dancing around" symptom.
  // 1px inset on the AABB test prevents floating-point false positives where
  // cos/sin produces e.g. tly+ah = 450.0001 against t.document.y = 450.
  function posOccupiedPx(tlx, tly, skipId = null) {
    const aw = (token.document.width  ?? 1) * gs;
    const ah = (token.document.height ?? 1) * gs;
    for (const t of canvas.tokens.placeables) {
      if (t.id === token.id) continue;
      if (skipId && t.id === skipId) continue;   // attacker may touch the target
      if (isDeadToken(t)) continue;
      const tw = (t.document.width  ?? 1) * gs;
      const th = (t.document.height ?? 1) * gs;
      // 1px inset prevents floating-point false positives at exact AABB edges.
      if (tlx < t.document.x + tw - 1 && tlx + aw > t.document.x + 1 &&
          tly < t.document.y + th - 1 && tly + ah > t.document.y + 1) return true;
    }
    return false;
  }

  function posNearWallPx(cx, cy) {
    for (const wall of canvas.walls.placeables) {
      const c = wall.document.c;
      if (!c || c.length < 4) continue;
      const mt = wall.document.move  ?? 20;
      const st = wall.document.sight ?? 20;
      if (mt === 0 && st === 0) continue;
      // _ptSegDist and WALL_MARGIN_PX are defined in the wall-filter block below.
      if (_ptSegDist(cx, cy, c[0], c[1], c[2], c[3]) < WALL_MARGIN_PX) return true;
    }
    return false;
  }

  // Check whether the direct pixel-space path from (ax,ay)→(bx,by) is clear.
  // For 1×1 tokens the single centre ray is enough.  For larger tokens we also
  // probe four inset corners so edge-clips from big footprints are caught.
  function pathClearPx(ax, ay, bx, by) {
    if (moveBlocked(ax, ay, bx, by)) return false;
    const aw = (token.document.width  ?? 1) * gs;
    const ah = (token.document.height ?? 1) * gs;
    if (aw <= gs && ah <= gs) return true;   // 1×1: centre ray sufficient
    const m = gs * 0.20;
    for (const [ox, oy] of [
      [-aw / 2 + m, -ah / 2 + m],
      [ aw / 2 - m, -ah / 2 + m],
      [-aw / 2 + m,  ah / 2 - m],
      [ aw / 2 - m,  ah / 2 - m],
    ]) {
      if (moveBlocked(ax + ox, ay + oy, bx + ox, by + oy)) return false;
    }
    return true;
  }

  // Sweep a ring at weaponRangePx around (tgtCX,tgtCY), starting from the
  // angle that points toward self so the shortest-path position is tested first.
  //
  // PASS 1 — direct straight-line paths from self to each ring position.
  // PASS 2 — 2-hop routing: if all direct paths are blocked (e.g. a building
  //   corner sits between self and the ring), sample intermediate waypoints on
  //   a fan of angles around the toward-target direction, then re-sweep the ring
  //   from each valid waypoint.  A waypoint is valid when:
  //     • pathClearPx(self → waypoint) AND pathClearPx(waypoint → ring) are both clear
  //     • total walk distance self→waypoint→ring is within budget
  //   The returned object carries an optional `waypoint` top-left so the caller
  //   can issue two placeAtPx calls (leg 1: self→waypoint, leg 2: waypoint→ring).
  //
  // Returns {x, y, distPx, waypoint?} (top-left) or null.
  function findAttackPosPx(selfCX, selfCY, tgtCX, tgtCY, weaponRangePx, budgetPx) {
    const aw  = (token.document.width  ?? 1) * gs;
    const ah  = (token.document.height ?? 1) * gs;
    const tw  = (target.document.width  ?? 1) * gs;
    const th  = (target.document.height ?? 1) * gs;  // eslint-disable-line no-unused-vars
    const slkPx   = ATTACK_SLACK_FT / ftPerCell * gs;
    const baseAng = Math.atan2(selfCY - tgtCY, selfCX - tgtCX); // from target toward self

    // ── Edge-to-edge ring radius ──────────────────────────────────────────
    // Melee range is measured edge-to-edge (nearest cell footprint), NOT
    // center-to-center.  A 2×2 Roc attacking a 1×1 citizen is in 5-ft range
    // the moment their bounding boxes touch — even though their centers are
    // 1.5 cells apart.  Use max(weaponRangePx, aw/2 + tw/2) so the sweep ring
    // places the attacker with bounding boxes just touching the target, never
    // overlapping.  On a 5-ft weapon this is harmless for equal-size tokens
    // (max(gs, gs) = gs) and corrects large-vs-small positioning.
    const effectiveRingPx = Math.max(weaponRangePx, (aw + tw) / 2);

    // ── Flanking helpers ────────────────────────────────────────────────────
    // An ally is "adjacent to the target" if their centre is within weapon range
    // + one cell of the target.  isFlankingPos() returns true when the candidate
    // position is on the OPPOSITE side of the target from any such ally.
    const _flankAllies = canvas.tokens.placeables.filter(t =>
      t.id !== token.id &&
      !isDeadToken(t) &&
      t.document.disposition === selfDisp &&
      Math.hypot(
        t.document.x + (t.document.width  ?? 1) * gs / 2 - tgtCX,
        t.document.y + (t.document.height ?? 1) * gs / 2 - tgtCY
      ) <= weaponRangePx + gs
    );

    function isFlankingPos(cCX, cCY) {
      if (!_flankAllies.length) return false;
      const cAng = Math.atan2(cCY - tgtCY, cCX - tgtCX);
      for (const a of _flankAllies) {
        const aAng = Math.atan2(
          a.document.y + (a.document.height ?? 1) * gs / 2 - tgtCY,
          a.document.x + (a.document.width  ?? 1) * gs / 2 - tgtCX
        );
        let diff = cAng - aAng;
        while (diff >  Math.PI) diff -= 2 * Math.PI;
        while (diff < -Math.PI) diff += 2 * Math.PI;
        // Flanking: attacker on opposite side → |diff| ≈ π (within 60° tolerance)
        if (Math.abs(Math.abs(diff) - Math.PI) < Math.PI / 3) return true;
      }
      return false;
    }

    // ── AoO-threat helpers ──────────────────────────────────────────────────
    // A "threat" is a non-target, non-ally enemy whose melee reach currently
    // covers selfCX/selfCY.  Moving OUT of their reach provokes an AoO.
    // We build this list once from the token's START position.
    const _threats = [];
    for (const t of canvas.tokens.placeables) {
      if (t.id === token.id || t.id === target.id) continue;
      if (isDeadToken(t) || isAllyToken(t)) continue;
      const st = getTokenStatuses(t);
      if (st.has("incapacitated") || st.has("paralyzed") ||
          st.has("stunned")       || st.has("unconscious")) continue;
      let reachFt = 5;
      for (const item of (t.actor?.items ?? [])) {
        const aType = item.system?.actionType ?? "";
        if (aType === "mwak" || aType === "msak") {
          const r = item.system?.range?.reach ?? item.system?.range?.value ?? 5;
          if (r > reachFt) reachFt = r;
        }
      }
      const eCX = t.document.x + (t.document.width  ?? 1) * gs / 2;
      const eCY = t.document.y + (t.document.height ?? 1) * gs / 2;
      const rPx = reachFt / ftPerCell * gs;
      if (Math.hypot(selfCX - eCX, selfCY - eCY) <= rPx + gs * 0.5)
        _threats.push({ eCX, eCY, rPx, tok: t });
    }

    // Returns true if moving from (fCX,fCY) to (tCX,tCY) exits any threat zone.
    function wouldTriggerAoO(fCX, fCY, tCX, tCY) {
      for (const { eCX, eCY, rPx } of _threats) {
        if (Math.hypot(fCX - eCX, fCY - eCY) <= rPx + gs * 0.5 &&
            Math.hypot(tCX - eCX, tCY - eCY)  > rPx + gs * 0.5) return true;
      }
      return false;
    }

    // ── Ring sweep helper ───────────────────────────────────────────────────
    // originCX/CY = position the sweep is done FROM.
    // skipWallCheck = true on the final fallback pass so narrow roads don't
    //   block every candidate.  pathClearPx + hasLOSfromPx are the real guards;
    //   posNearWallPx is a soft preference, not a hard requirement.
    //
    // Priority buckets (evaluated in order, returns first non-empty bucket):
    //   1. flanking + no AoO   — ideal
    //   2. flanking + AoO      — accept if not much further than safest non-flank
    //   3. no flanking + no AoO
    //   4. no flanking + AoO   — last resort
    function sweepRing(originCX, originCY, ringBudget, skipWallCheck) {
      const angFrom = Math.atan2(originCY - tgtCY, originCX - tgtCX);
      for (const rf of [1.0, 0.92, 0.82, 0.70, 0.55]) {
        const radius = effectiveRingPx * rf;
        let bestFS = null, bestFSD = Infinity;   // flank + AoO-safe
        let bestFR = null, bestFRD = Infinity;   // flank + AoO-risky
        let bestNS = null, bestNSD = Infinity;   // no-flank + AoO-safe
        let bestNR = null, bestNRD = Infinity;   // no-flank + AoO-risky
        for (let step = 0; step < 72; step++) {
          const sign    = step % 2 === 0 ? 1 : -1;
          const half    = Math.floor(step / 2);
          const ang     = angFrom + sign * half * (Math.PI / 36);
          const rawCX   = tgtCX + Math.cos(ang) * radius;
          const rawCY   = tgtCY + Math.sin(ang) * radius;
          // On gridded scenes snap the TL to the nearest grid cell so Foundry
          // accepts the position.  The distance check uses the snapped centre.
          let tlx = rawCX - aw / 2;
          let tly = rawCY - ah / 2;
          if (!SCENE_IS_GRIDLESS) {
            tlx = Math.round(tlx / gs) * gs;
            tly = Math.round(tly / gs) * gs;
          }
          const candCX = tlx + aw / 2;
          const candCY = tly + ah / 2;
          if (tlx < 0 || tly < 0 ||
              tlx + aw > canvas.scene.width  + gs ||
              tly + ah > canvas.scene.height + gs) continue;
          const d = Math.hypot(candCX - originCX, candCY - originCY);
          if (d > ringBudget + slkPx) continue;
          if (!skipWallCheck && posNearWallPx(candCX, candCY)) continue;
          if (posOccupiedPx(tlx, tly, target.id)) continue;
          if (!pathClearPx(originCX, originCY, candCX, candCY)) continue;
          if (!hasLOSfromPx(candCX, candCY, tgtCX, tgtCY)) continue;
          const flank = isFlankingPos(candCX, candCY);
          const risky = wouldTriggerAoO(originCX, originCY, candCX, candCY);
          const pos   = { x: tlx, y: tly, distPx: d, flanking: flank, aoo: risky };
          if ( flank && !risky && d < bestFSD) { bestFSD = d; bestFS = pos; }
          if ( flank &&  risky && d < bestFRD) { bestFRD = d; bestFR = pos; }
          if (!flank && !risky && d < bestNSD) { bestNSD = d; bestNS = pos; }
          if (!flank &&  risky && d < bestNRD) { bestNRD = d; bestNR = pos; }
        }
        // Return best result in priority order.
        // Accept flank+risky only when within FLANK_SLACK_PX of the safest option.
        if (bestFS) return bestFS;
        if (bestFR && (!bestNS || bestFRD <= bestNSD + FLANK_SLACK_PX)) return bestFR;
        if (bestNS) return bestNS;
        if (bestNR) return bestNR;
      }
      return null;
    }

    // ── PASS 1: direct straight-line paths ──────────────────────────────────
    // Try with wall-proximity preference first, then without (narrow roads).
    const p1 = sweepRing(selfCX, selfCY, budgetPx, false)
             ?? sweepRing(selfCX, selfCY, budgetPx, true);
    if (p1) return p1;

    // ── PASS 2: 2-hop via intermediate waypoint ─────────────────────────────
    // When every direct ring position is blocked (building corner between self
    // and ring), fan out to waypoints in the general direction of the target,
    // then re-sweep the ring from each valid waypoint.
    const towardTgt    = Math.atan2(tgtCY - selfCY, tgtCX - selfCX);
    const wpAngDegrees = [25, -25, 50, -50, 75, -75, 100, -100];
    const wpDists      = [gs, gs * 1.5, gs * 2.0, gs * 2.5]
                           .filter(d => d < budgetPx * 0.65);

    let best2 = null, bestD2 = Infinity;

    for (const skipWC of [false, true]) {       // try wall-avoiding first, then allow
      for (const deg of wpAngDegrees) {
        const waAng = towardTgt + deg * Math.PI / 180;
        for (const wDist of wpDists) {
          const wCX  = selfCX + Math.cos(waAng) * wDist;
          const wCY  = selfCY + Math.sin(waAng) * wDist;
          const wTLX = wCX - aw / 2;
          const wTLY = wCY - ah / 2;
          if (wTLX < 0 || wTLY < 0 ||
              wTLX + aw > canvas.scene.width  + gs ||
              wTLY + ah > canvas.scene.height + gs) continue;
          if (!pathClearPx(selfCX, selfCY, wCX, wCY)) continue;
          if (posOccupiedPx(wTLX, wTLY)) continue;
          if (!skipWC && posNearWallPx(wCX, wCY)) continue;

          const remainBudget = budgetPx - wDist;
          const wpBaseAng    = Math.atan2(wCY - tgtCY, wCX - tgtCX);

          for (const rf of [1.0, 0.92, 0.80]) {
            const radius = effectiveRingPx * rf;
            for (let step = 0; step < 36; step++) {
              const sign    = step % 2 === 0 ? 1 : -1;
              const half    = Math.floor(step / 2);
              const ang     = wpBaseAng + sign * half * (Math.PI / 18);
              const rawCX2  = tgtCX + Math.cos(ang) * radius;
              const rawCY2  = tgtCY + Math.sin(ang) * radius;
              let   tlx     = rawCX2 - aw / 2;
              let   tly     = rawCY2 - ah / 2;
              if (!SCENE_IS_GRIDLESS) {
                tlx = Math.round(tlx / gs) * gs;
                tly = Math.round(tly / gs) * gs;
              }
              const candCX = tlx + aw / 2;
              const candCY = tly + ah / 2;
              if (tlx < 0 || tly < 0 ||
                  tlx + aw > canvas.scene.width  + gs ||
                  tly + ah > canvas.scene.height + gs) continue;
              const d2 = Math.hypot(candCX - wCX, candCY - wCY);
              if (d2 > remainBudget + slkPx) continue;
              if (!skipWC && posNearWallPx(candCX, candCY)) continue;
              if (posOccupiedPx(tlx, tly, target.id)) continue;   // target touch is fine
              if (!pathClearPx(wCX, wCY, candCX, candCY)) continue;
              if (!hasLOSfromPx(candCX, candCY, tgtCX, tgtCY)) continue;
              const totalD = wDist + d2;
              if (totalD < bestD2) {
                bestD2 = totalD;
                best2  = { x: tlx, y: tly, distPx: totalD,
                           waypoint: { x: wTLX, y: wTLY } };
              }
            }
          }
        }
      }
      if (best2) return best2;   // wall-avoiding worked — don't need near-wall pass
    }
    return null;
  }

  // Fan-search toward target: 9 angular directions (direct ± offsets),
  // binary-searching the furthest valid point on each ray.
  // Scored by remaining distance to target (primary) — the direction that
  // physically gets closest wins, even if it's a slight detour.
  //
  // Two-pass: Pass A enforces wall-proximity clearance (preferred).
  //           Pass B drops that requirement — fallback for narrow roads where
  //           the entire walkable lane is within WALL_MARGIN_PX of buildings.
  //           pathClearPx + posOccupiedPx are always enforced.
  // Returns {x, y, distPx} (top-left) or null.
  function findApproachPosPx(selfCX, selfCY, tgtCX, tgtCY, budgetPx) {
    const aw   = (token.document.width  ?? 1) * gs;
    const ah   = (token.document.height ?? 1) * gs;
    const dist = Math.hypot(tgtCX - selfCX, tgtCY - selfCY);
    if (dist < 1) return null;

    const baseAngle = Math.atan2(tgtCY - selfCY, tgtCX - selfCX);
    const DEGS      = [0, 22, -22, 44, -44, 66, -66, 90, -90];

    function runFan(skipWallCheck) {
      let bestResult = null, bestScore = Infinity;
      for (const deg of DEGS) {
        const angle = baseAngle + deg * Math.PI / 180;
        const dx    = Math.cos(angle);
        const dy    = Math.sin(angle);
        const maxD  = Math.min(dist * 1.4, budgetPx);

        let lo = 0, hi = maxD, cand = null;
        for (let i = 0; i < 12; i++) {
          const mid = (lo + hi) / 2;
          const cx  = selfCX + dx * mid;
          const cy  = selfCY + dy * mid;
          const tlx = cx - aw / 2;
          const tly = cy - ah / 2;
          if (pathClearPx(selfCX, selfCY, cx, cy) &&
              !posOccupiedPx(tlx, tly) &&
              (skipWallCheck || !posNearWallPx(cx, cy))) {
            cand = { x: tlx, y: tly, distPx: mid, cx, cy };
            lo   = mid;
          } else {
            hi   = mid;
          }
        }

        if (!cand || cand.distPx < gs * 0.15) continue;

        const remaining = Math.hypot(tgtCX - cand.cx, tgtCY - cand.cy);
        const score     = remaining * 10000 + cand.distPx;
        if (score < bestScore) {
          bestScore  = score;
          bestResult = { x: cand.x, y: cand.y, distPx: cand.distPx };
        }
      }
      return bestResult;
    }

    // Prefer wall-avoiding positions; fall back to allowing near-wall.
    return runFan(false) ?? runFan(true);
  }

  // Pixel-exact placement — single document.update with sight suppression
  // and optional animation (respects ANIMATE_MOVEMENT flag).
  //
  // IMPORTANT: Foundry V12 TokenDocument schema declares x/y as integer fields.
  // Passing floating-point coords (produced by cos/sin ring sweeps) causes a
  // silent DataValidationError that is swallowed by .catch, leaving the token
  // at its original position while the camera animation still plays.  Always
  // Math.round() before the update so the schema validator accepts the values.
  async function placeAtPx(tok, destX, destY) {
    // Gridded scenes require x/y to be exact multiples of the grid size —
    // Foundry V12 declares them integer:true and silently rejects floats.
    // Snap to the nearest grid-aligned top-left; gridless keeps pixel precision.
    const rx = SCENE_IS_GRIDLESS ? Math.round(destX) : Math.round(destX / gs) * gs;
    const ry = SCENE_IS_GRIDLESS ? Math.round(destY) : Math.round(destY / gs) * gs;
    const sightOn = !!tok.document.sight?.enabled;
    if (sightOn) await tok.document.update({ "sight.enabled": false }).catch(() => {});
    try {
      if (ANIMATE_MOVEMENT) {
        const fCX = tok.document.x + (tok.document.width  ?? 1) * gs / 2;
        const fCY = tok.document.y + (tok.document.height ?? 1) * gs / 2;
        const tCX = rx + (tok.document.width  ?? 1) * gs / 2;
        const tCY = ry + (tok.document.height ?? 1) * gs / 2;
        const dx  = tCX - fCX, dy = tCY - fCY;
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1) await rotateTo(tok, dx, dy, 160);
        const ms  = Math.max(400, Math.min(1400, Math.hypot(dx, dy) / gs * 160 + 260));
        const upd = tok.document.update({ x: rx, y: ry })
          .catch(err => console.warn("[CombatStep] placeAtPx update failed:", err));
        canvas.animatePan({ x: tCX, y: tCY, duration: ms });
        await Promise.all([waitAnim(tok, ms), upd]);
      } else {
        await tok.document.update({ x: rx, y: ry })
          .catch(err => console.warn("[CombatStep] placeAtPx update failed:", err));
      }
    } finally {
      if (sightOn) {
        await tok.document.update({ "sight.enabled": true }).catch(() => {});
        try { canvas.perception.initialize(); } catch (_) {}
      }
    }
  }

  // ── Occupied cells (token footprints, excluding self) ─────────────────────
  // Hard-occupied: cells blocked by LIVING tokens.  Pathfinding cannot route
  // through these — a token cannot share space with a living creature.
  // Uses tokenCellFootprint so off-grid tokens block every cell they physically touch.
  function getOccupied() {
    const s = new Set();
    for (const t of canvas.tokens.placeables) {
      if (t.id === token.id) continue;
      if (isDeadToken(t)) continue;    // dead = soft obstacle only (see getSoftOccupied)
      const fp = tokenCellFootprint(t);
      for (let x = fp.cx; x < fp.cx + fp.cw; x++)
        for (let y = fp.cy; y < fp.cy + fp.ch; y++)
          s.add(`${x},${y}`);
    }
    return s;
  }

  // Soft-occupied: cells covered by DEAD tokens.  Bodies don't block movement
  // in 5e but we strongly prefer to walk around them — treated as impassable on
  // the first pathfinding pass, allowed on the fallback pass.
  function getSoftOccupied() {
    const s = new Set();
    for (const t of canvas.tokens.placeables) {
      if (t.id === token.id) continue;
      if (!isDeadToken(t)) continue;   // living tokens → handled by getOccupied
      const fp = tokenCellFootprint(t);
      for (let x = fp.cx; x < fp.cx + fp.cw; x++)
        for (let y = fp.cy; y < fp.cy + fp.ch; y++)
          s.add(`${x},${y}`);
    }
    return s;
  }

  // ── BFS ───────────────────────────────────────────────────────────────────
  // Bounded by budget (cells) AND scene dimensions — cannot run away.
  // Wall-aware: won't add cells that require crossing a movement-blocking wall.
  function bfs(fromCX, fromCY, budget, occupied) {
    const visited = new Map();
    visited.set(`${fromCX},${fromCY}`, { cost: 0, parent: null });
    const queue = [{ cx: fromCX, cy: fromCY, cost: 0 }];

    while (queue.length) {
      const { cx, cy, cost } = queue.shift();
      if (cost >= budget) continue;               // at or past budget: don't expand

      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (!dx && !dy) continue;
          const nx = cx + dx, ny = cy + dy;

          // Hard bounds — no negative coords, no beyond-scene coords.
          if (nx < 0 || ny < 0 || nx > maxCX || ny > maxCY) continue;

          const key = `${nx},${ny}`;
          if (occupied.has(key) || visited.has(key)) continue;

          // Don't path through movement-blocking walls.
          if (!canStep(cx, cy, nx, ny)) continue;

          const newCost = cost + 1;               // Chebyshev: diagonal = 1
          if (newCost > budget) continue;

          visited.set(key, { cost: newCost, parent: `${cx},${cy}` });
          queue.push({ cx: nx, cy: ny, cost: newCost });
        }
      }
    }
    return visited;
  }

  // Reconstruct cell-by-cell path from parent-pointer map.
  function makePath(visited, fromCX, fromCY, dest) {
    const path = [];
    let cur = `${dest.cx},${dest.cy}`;
    const start = `${fromCX},${fromCY}`;
    while (cur && cur !== start) {
      const [cx, cy] = cur.split(",").map(Number);
      path.unshift({ cx, cy });
      cur = visited.get(cur)?.parent ?? null;
    }
    return path;
  }

  // Find shortest wall-aware path to any attack-position candidate cell.
  //
  // Uses A* with a Chebyshev heuristic (min distance to nearest goal cell).
  // This replaces the old greedy-straight-path + BFS-fallback design.
  //
  // Why A* over plain BFS:
  //   BFS explores in all directions equally.  When the straight path is
  //   blocked by a wall, BFS's fixed neighbour iteration order (UL→L→DL→U→D→
  //   UR→R→DR) causes the first found detour to go *down* even when the target
  //   is to the *right*.  The GM sees the token step one cell down and then
  //   nothing — that's the "5 ft downward" bug.  A* with a Chebyshev heuristic
  //   always expands toward the goal first, so the first step is in the correct
  //   direction regardless of how the detour resolves.
  //
  // Returns {cost, path} or null.  `path` is wall-safe and budget-capped.
  function findPath(fromCX, fromCY, adjCells, occupied, squeeze = false) {
    // Prefer positions not occupied by another token.
    const valid = adjCells.filter(c => !occupied.has(`${c.cx},${c.cy}`));
    const pool  = valid.length ? valid : adjCells;
    if (!pool.length) return null;

    const goalSet = new Set(pool.map(c => `${c.cx},${c.cy}`));

    // Chebyshev heuristic: distance to the nearest goal cell.
    const h = (cx, cy) => {
      let best = Infinity;
      for (const g of pool) {
        const d = Math.max(Math.abs(g.cx - cx), Math.abs(g.cy - cy));
        if (d < best) best = d;
      }
      return best;
    };

    const budget   = walkCells * 2 + 2;
    const startKey = `${fromCX},${fromCY}`;
    const gScore   = new Map([[startKey, 0]]);
    const cameFrom = new Map([[startKey, null]]);

    // Open list — unsorted array; we scan for min-f each iteration.
    // The budget is small (≤ ~15 cells) so O(N) scan is negligible.
    const open = [{ f: h(fromCX, fromCY), g: 0, key: startKey }];

    while (open.length) {
      // Pop minimum-f node.
      let bi = 0;
      for (let i = 1; i < open.length; i++) {
        if (open[i].f < open[bi].f) bi = i;
      }
      const { g, key } = open.splice(bi, 1)[0];

      // Goal reached — reconstruct path.
      if (goalSet.has(key)) {
        const path = [];
        let cur = key;
        while (cur !== startKey) {
          const [cx, cy] = cur.split(",").map(Number);
          path.unshift({ cx, cy });
          cur = cameFrom.get(cur);
        }
        return { cost: g, path };
      }

      if (g >= budget) continue;

      const [cx, cy] = key.split(",").map(Number);
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (!dx && !dy) continue;
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx > maxCX || ny > maxCY) continue;
          const nKey = `${nx},${ny}`;
          // Allow stepping INTO a goal cell even if another token occupies it
          // (adjacent attack position behind an ally).
          if (occupied.has(nKey) && !goalSet.has(nKey)) continue;
          if (!canStep(cx, cy, nx, ny, squeeze)) continue;
          const newG = g + 1;
          if (newG > budget) continue;
          if (newG < (gScore.get(nKey) ?? Infinity)) {
            gScore.set(nKey, newG);
            cameFrom.set(nKey, key);
            open.push({ f: newG + h(nx, ny), g: newG, key: nKey });
          }
        }
      }
    }
    return null;
  }

  // findPathPreferClear — routes around dead tokens (soft obstacles) when
  // possible, falls back to allowing body-crossing when no clear path exists.
  //
  // First pass:  hard-occupied UNION soft-occupied → path that avoids all tokens.
  // Fallback:    hard-occupied only                → path steps over dead bodies.
  //
  // This two-pass approach keeps findPath's internals simple while giving the
  // pathfinder a strong preference for clear ground without ever hard-blocking
  // movement through corpses (which is legal in 5e).
  function findPathPreferClear(fromCX, fromCY, adjCells, occupied, squeeze, softOccupied) {
    if (softOccupied?.size) {
      const strictOcc = new Set([...occupied, ...softOccupied]);
      const clearResult = findPath(fromCX, fromCY, adjCells, strictOcc, squeeze);
      if (clearResult) return clearResult;
    }
    return findPath(fromCX, fromCY, adjCells, occupied, squeeze);
  }

  // ── LOS-based position search ─────────────────────────────────────────────
  // When no token is visible from the current position, find the minimum-cost
  // cell (within `budget` Chebyshev steps) from which the attacker would have
  // LOS to at least one candidate token.
  //
  // candidatesByThreat must be pre-sorted descending by threat score so that
  // the FIRST candidate that is visible from any cell is always the highest-
  // threat available target — no secondary sort needed.
  //
  // Returns {cx, cy, cost, target, path} or null.
  //
  // requireLOS — when true, only cells with geometric LOS (walls block) are
  //   accepted.  Used when we know a target exists via special sense (tremorsense)
  //   but need to move to a position where we can actually see and attack it.
  //   When false (default), special senses also count (any perception path works).
  function searchForLOSPosition(fromCX, fromCY, budget, candidatesByThreat, occupied, requireLOS = false) {
    const visited = bfs(fromCX, fromCY, budget, occupied);

    let best = null; // {cx, cy, cost, target, path}

    for (const [key, entry] of visited) {
      if (entry.cost === 0) continue;               // skip starting cell — already checked
      if (best && entry.cost > best.cost) continue; // BFS visit order is mostly cost-ordered;
                                                    // once we have a best, skip pricier cells

      const [cx, cy] = key.split(",").map(Number);

      // Check candidates in threat order — first hit is the best available target.
      for (const tok of candidatesByThreat) {
        const perceivable = requireLOS
          ? hasLOSfromCell(cx, cy, tok)        // geometric LOS only — walls block
          : canPerceiveFromCell(cx, cy, tok);  // includes tremorsense, etc.
        if (perceivable) {
          if (!best || entry.cost < best.cost) {
            best = {
              cx, cy,
              cost: entry.cost,
              target: tok,
              path: makePath(visited, fromCX, fromCY, {cx, cy}),
            };
          }
          break; // highest-threat visible target found for this cell; check next cell
        }
      }
    }
    return best;
  }

  // ── Path → animation segments (collapse same-direction runs) ─────────────
  function toSegments(fromCX, fromCY, path) {
    if (!path.length) return [];
    const segs = [];
    let prevCX = fromCX, prevCY = fromCY, segFX = fromCX, segFY = fromCY;
    let curDX = null, curDY = null;

    for (let i = 0; i < path.length; i++) {
      const { cx, cy } = path[i];
      const dx = Math.sign(cx - prevCX), dy = Math.sign(cy - prevCY);
      if (curDX === null) {
        curDX = dx; curDY = dy;
      } else if (dx !== curDX || dy !== curDY) {
        const p = path[i - 1];
        segs.push({ toCX: p.cx, toCY: p.cy,
          n: Math.max(Math.abs(p.cx - segFX), Math.abs(p.cy - segFY)) });
        segFX = p.cx; segFY = p.cy; curDX = dx; curDY = dy;
      }
      prevCX = cx; prevCY = cy;
    }
    const last = path[path.length - 1];
    segs.push({ toCX: last.cx, toCY: last.cy,
      n: Math.max(Math.abs(last.cx - segFX), Math.abs(last.cy - segFY)) });
    return segs;
  }

  // Animate token along a path slice.  fromCX/fromCY = current cell.
  // Tracks pixel position independently so rotation uses the correct direction
  // even when tok.document.x hasn't flushed between async segment updates.
  // moveAlong — move `tok` through a cell-path, optionally animated.
  //
  // Vision suppression: if the token has sight enabled, we temporarily disable
  // it for the duration of movement.  When sight is enabled, every position
  // update triggers canvas.perception.update() → ClockwiseSweepPolygon rebuild
  // for ALL sighted tokens → GPU vision/fog mesh upload.  On a 6-step path
  // that's 6 full vision rebuilds.  Disabling sight lets position updates update
  // only the sprite transform (cheap) and we do one final rebuild at the end.
  //
  // Our hasLOS / testCollision checks are not affected — they use the polygon
  // backend directly, independent of the token's sight.enabled flag.
  async function moveAlong(tok, fromCX, fromCY, path) {
    if (!path.length) return { cx: fromCX, cy: fromCY };
    const last = path[path.length - 1];

    // Suppress vision rebuilds during movement.
    const sightWasEnabled = !!tok.document.sight?.enabled;
    if (sightWasEnabled) {
      await tok.document.update({ "sight.enabled": false }).catch(() => {});
    }

    const restoreSight = async () => {
      if (sightWasEnabled) {
        await tok.document.update({ "sight.enabled": true }).catch(() => {});
        try { canvas.perception.initialize(); } catch (_) {}
      }
    };

    try {
      if (!ANIMATE_MOVEMENT) {
        // ── Instant mode ────────────────────────────────────────────────────
        // Jump directly to the final position — one document write, one render,
        // no sustained rAF loop.  Eliminates GPU frame violations on dense scenes.
        const nx = last.cx * gs, ny = last.cy * gs;
        await tok.document.update({ x: nx, y: ny }).catch(() => {});
      } else {
        // ── Animated mode ──────────────────────────────────────────────────
        let curPx = fromCX * gs, curPy = fromCY * gs;   // track ourselves, don't read doc
        for (const seg of toSegments(fromCX, fromCY, path)) {
          const nx = seg.toCX * gs, ny = seg.toCY * gs;
          const dx = nx - curPx, dy = ny - curPy;
          if (!dx && !dy) continue;
          await rotateTo(tok, dx, dy, 160);
          const ms = Math.max(500, seg.n * 160 + 260);
          // Await both: animation completion AND server acknowledgment of the new
          // position.  Without awaiting the update, tok.document.x may still reflect
          // the old position when we call measureFt() after moveAlong() returns.
          const updateP = tok.document.update({ x: nx, y: ny }).catch(() => {});
          canvas.animatePan({ x: nx + gs / 2, y: ny + gs / 2, duration: ms });
          await Promise.all([waitAnim(tok, ms), updateP]);
          curPx = nx; curPy = ny;
        }
      }
    } finally {
      await restoreSight();
    }

    return { cx: last.cx, cy: last.cy };
  }

  // ── Mesh animations (PIXI visual offsets — no document writes) ────────────
  const mesh = tok => tok.mesh ?? tok.icon ?? null;

  async function animLunge(tok, tgt) {
    const m = mesh(tok); if (!m) return;
    const sCX = tok.document.x+(tok.document.width??1)*gs/2;
    const sCY = tok.document.y+(tok.document.height??1)*gs/2;
    const tCX = tgt.document.x+(tgt.document.width??1)*gs/2;
    const tCY = tgt.document.y+(tgt.document.height??1)*gs/2;
    const len = Math.hypot(tCX-sCX,tCY-sCY)||1;
    const d = Math.min(gs*.35,7), lx=(tCX-sCX)/len*d, ly=(tCY-sCY)/len*d;
    const ox=m.x,oy=m.y;
    for(let i=1;i<=3;i++){m.x=ox+lx*(i/3);m.y=oy+ly*(i/3);await wait(50);}
    for(let i=3;i>=0;i--){m.x=ox+lx*(i/3);m.y=oy+ly*(i/3);await wait(50);}
    m.x=ox;m.y=oy;
  }
  async function animHit(tok) {
    const m=mesh(tok);if(!m)return;
    const d=gs*.25,ox=m.x;
    for(const x of [d,-d*1.3,d*.9,-d*.6,d*.3,0]){m.x=ox+x;await wait(40);}
    m.x=ox;
  }
  async function animCrit(tok) {
    const m=mesh(tok);if(!m)return;
    const d=gs*.5,ox=m.x;
    for(let i=0;i<8;i++){m.x=ox+d*(i%2?-1:1)*(1-i*.1);m.alpha=i%2?.5:1;await wait(45);}
    m.x=ox;m.alpha=1;
  }
  async function animMiss(tok) {
    const m=mesh(tok);if(!m)return;
    const d=gs*.3,ox=m.x;
    for(const x of [d*.5,d,d*.7,d*.3,0]){m.x=ox+x;await wait(65);}
    m.x=ox;
  }
  async function animDodge(tgt,atk) {
    const m=mesh(tgt);if(!m)return;
    const tCX=tgt.document.x+(tgt.document.width??1)*gs/2;
    const tCY=tgt.document.y+(tgt.document.height??1)*gs/2;
    const aCX=atk.document.x+(atk.document.width??1)*gs/2;
    const aCY=atk.document.y+(atk.document.height??1)*gs/2;
    const len=Math.hypot(tCX-aCX,tCY-aCY)||1;
    const d=gs*.4,lx=(tCX-aCX)/len*d,ly=(tCY-aCY)/len*d;
    const ox=m.x,oy=m.y;
    for(let i=1;i<=3;i++){m.x=ox+lx*(i/3);m.y=oy+ly*(i/3);await wait(50);}
    await wait(70);
    for(let i=3;i>=0;i--){m.x=ox+lx*(i/3);m.y=oy+ly*(i/3);await wait(50);}
    m.x=ox;m.y=oy;
  }
  async function animFumble(tok,tgt) {
    const m=mesh(tok);if(!m)return;
    const sCX=tok.document.x+(tok.document.width??1)*gs/2;
    const sCY=tok.document.y+(tok.document.height??1)*gs/2;
    const tCX=tgt.document.x+(tgt.document.width??1)*gs/2;
    const tCY=tgt.document.y+(tgt.document.height??1)*gs/2;
    const len=Math.hypot(sCX-tCX,sCY-tCY)||1;
    const d=gs*.4,lx=(sCX-tCX)/len*d,ly=(sCY-tCY)/len*d;
    const ox=m.x,oy=m.y;
    for(let i=1;i<=3;i++){m.x=ox+lx*(i/3);m.y=oy+ly*(i/3);await wait(55);}
    for(let i=3;i>=0;i--){m.x=ox+lx*(i/3);m.y=oy+ly*(i/3);await wait(55);}
    m.x=ox;m.y=oy;
  }
  async function animBrace(tok,tgt) {
    const m=mesh(tok);if(!m)return;
    let lx=0,ly=gs*.18;
    if(tgt){
      const sCX=tok.document.x+(tok.document.width??1)*gs/2;
      const sCY=tok.document.y+(tok.document.height??1)*gs/2;
      const tCX=tgt.document.x+(tgt.document.width??1)*gs/2;
      const tCY=tgt.document.y+(tgt.document.height??1)*gs/2;
      const len=Math.hypot(sCX-tCX,sCY-tCY)||1;
      lx=(sCX-tCX)/len*gs*.18;ly=(sCY-tCY)/len*gs*.18;
    }
    const ox=m.x,oy=m.y;
    for(const f of [.4,1,.8,.5,.2,0]){m.x=ox+lx*f;m.y=oy+ly*f;await wait(60);}
    m.x=ox;m.y=oy;
  }

  // ── Attack items ──────────────────────────────────────────────────────────
  // Returns attack items in sheet order (item.sort ascending).
  // actor.items iteration order is database-insertion order, NOT sheet order,
  // so without sorting the "second" attack can end up at index 0.
  // Excludes Multiattack itself (feature declaration, not a rollable action).
  // Weapon fallback requires action activation so passive/reaction items are skipped.
  function findAllAttacks(a) {
    const ACTS  = new Set(["action","legendary","crew","lair"]);
    const TYPES = new Set(["mwak","rwak","msak","rsak"]);
    const seen  = new Set();
    const list  = [];
    for (const item of a.items) {
      if (seen.has(item.id)) continue;
      if (/multiattack/i.test(item.name)) continue;
      let ok = ACTS.has(item.system?.activation?.type??"") && TYPES.has(item.system?.actionType??"");
      if (!ok) {
        const acts = item.system?.activities;
        if (acts) {
          const arr = typeof acts.values==="function" ? [...acts.values()] : Object.values(acts);
          ok = arr.some(x => x?.type==="attack");
        }
      }
      // Weapon fallback: only include if it has an action-type activation.
      if (!ok && item.type==="weapon" && ACTS.has(item.system?.activation?.type??"")) ok = true;
      if (ok) { list.push(item); seen.add(item.id); }
    }
    // Sort by sheet order (sort ascending), name alphabetically as tiebreaker.
    list.sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0) || a.name.localeCompare(b.name));
    console.log("[CombatStep] attack list (sheet order):", list.map(i => i.name));
    return list;
  }

  // Parse the Multiattack description and build an ordered attack sequence.
  // Returns an array of items in the order they should be used this turn.
  //
  // Handles natural-language patterns like:
  //   "makes two attacks"
  //     → [primary, primary]
  //   "makes one Bite attack and three Claw attacks"
  //     → [Bite, Claw, Claw, Claw]
  //   "makes one Bite attack and three other attacks, using Claw or Tail in any combination"
  //     → [Bite, Claw, Tail, Claw]   (cycles through the listed alternatives)
  //   "three attacks: one with its Bite and two with its Claws"
  //     → [Bite, Claw, Claw]
  //   No Multiattack item → [primary attack]
  function buildAttackSequence(a, attacks) {
    if (!attacks.length) return [];
    const multi = a.items.find(i => /multiattack/i.test(i.name));
    if (!multi) return [attacks[0]];

    const raw  = multi.system?.description?.value ?? "";
    const text = raw.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    console.log("[CombatStep] Multiattack text:", text);

    const NUMS = { one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8 };

    // Fuzzy item lookup — strips trailing plural/attack words before comparing
    function normalize(s) {
      return s.toLowerCase().replace(/\s*attacks?\s*/gi, "").replace(/s$/, "").trim();
    }
    function findItem(name) {
      const lo = name.toLowerCase().trim();
      const nr = normalize(name);
      for (const item of attacks) {
        if (item.name.toLowerCase() === lo) return item;
        if (normalize(item.name) === nr)    return item;
      }
      // Partial fallback: longest-name first to avoid "Claw" matching "Claws"
      for (const item of [...attacks].sort((x,y) => y.name.length - x.name.length)) {
        if (lo.includes(normalize(item.name)) || normalize(item.name).includes(nr)) return item;
      }
      return null;
    }

    const sequence = [];

    // Strip preamble ("The tarrasque makes …" → "one Bite and three other…")
    // then split on " and " to get individual attack clauses
    const body  = (text.match(/makes\s+(.+)/i)?.[1] ?? text).replace(/[:.]/g, "");
    const parts = body.split(/\s+and\s+/i);

    for (const part of parts) {
      const numMatch = part.match(/\b(one|two|three|four|five|six|seven|eight|\d+)\b/i);
      if (!numMatch) continue;
      const count = NUMS[numMatch[1].toLowerCase()] ?? parseInt(numMatch[1]);
      if (!count || count < 1) continue;

      // "N other attack(s) [using X or Y [in any combination]]"
      if (/\bother\b/i.test(part)) {
        const usingMatch = part.match(/using\s+(.+?)(?:\s+in\s+any\s+combination)?\s*$/i);
        let pool = attacks;
        if (usingMatch) {
          const names = usingMatch[1].split(/\s+or\s+|\s*,\s*/i).map(s => s.trim());
          const items = names.map(findItem).filter(Boolean);
          if (items.length) pool = items;
        }
        for (let i = 0; i < count; i++) sequence.push(pool[i % pool.length]);
        continue;
      }

      // "N AttackName attack(s)" — match longest item name first
      let matched = null;
      for (const item of [...attacks].sort((x,y) => y.name.length - x.name.length)) {
        const esc = item.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (new RegExp(`\\b${esc}s?\\b`, "i").test(part)) { matched = item; break; }
        const nEsc = normalize(item.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (nEsc && new RegExp(`\\b${nEsc}s?\\b`, "i").test(normalize(part))) { matched = item; break; }
      }

      if (matched) {
        for (let i = 0; i < count; i++) sequence.push(matched);
      } else {
        // Generic "N attacks" — cycle through available attacks in sheet order
        for (let i = 0; i < count; i++) {
          sequence.push(attacks[Math.min(sequence.length + i, attacks.length - 1)]);
        }
      }
    }

    console.log("[CombatStep] Parsed attack sequence:", sequence.map(i => i.name));
    return sequence.length ? sequence : [attacks[0]];
  }

  // ════════════════════════════════════════════════════════════════════════
  //  TURN
  // ════════════════════════════════════════════════════════════════════════

  // Capture turn-start position + pixel centre (used for rotation, threat scoring).
  const selfX  = token.document.x + (token.document.width  ?? 1) * gs / 2;
  const selfY  = token.document.y + (token.document.height ?? 1) * gs / 2;
  const fromCX0 = Math.round(token.document.x / gs);
  const fromCY0 = Math.round(token.document.y / gs);

  // ── Condition helpers ─────────────────────────────────────────────────────

  // dnd5e v3: actor.statuses is a Set<string> of condition IDs ("dead",
  // "unconscious", "prone", etc.).  Falls back to scanning active effects
  // for older versions or edge cases where statuses hasn't been populated.
  function getTokenStatuses(tok) {
    const a = tok.actor;
    if (!a) return new Set();
    if (a.statuses instanceof Set && a.statuses.size > 0) return a.statuses;
    const s = new Set();
    for (const e of (a.effects ?? [])) {
      const id = e.flags?.dnd5e?.statusId ?? e.statuses?.first?.() ?? null;
      if (id) s.add(id);
    }
    return s;
  }

  // True if the token should be considered dead / out of the fight.
  // Checks HP, the Foundry defeated overlay, and condition IDs.
  function isDeadToken(tok) {
    if (tok.document.defeated) return true;
    const hp = tok.actor?.system?.attributes?.hp;
    if (hp && hp.value <= 0 && hp.max > 0) return true;
    const st = getTokenStatuses(tok);
    return st.has("dead") || st.has("defeated");
  }

  // Threat score — higher means more dangerous; pick the highest.
  // Proximity is a tiebreaker (up to +50) so equal-condition tokens prefer
  // the nearest one, preserving the old "closest enemy first" behaviour.
  function threatScore(tok) {
    const st = getTokenStatuses(tok);
    let score = 1000;
    if (st.has("unconscious") || st.has("incapacitated") ||
        st.has("paralyzed")   || st.has("stunned") || st.has("petrified")) score -= 800;
    if (st.has("restrained")  || st.has("grappled")) score -= 200;
    if (st.has("prone"))                              score -= 100;
    if (st.has("blinded"))                            score -=  50;
    const dx    = (tok.document.x + (tok.document.width ??1)*gs/2) - selfX;
    const dy    = (tok.document.y + (tok.document.height??1)*gs/2) - selfY;
    const maxPx = Math.hypot(canvas.scene.width, canvas.scene.height) || 1;
    score += Math.round((1 - Math.hypot(dx, dy) / maxPx) * 50);
    return score;
  }

  // ── Action / movement budget (declared early so search phase can write them) ──
  let actionUsed         = null;   // "dash" | "dodge" | null
  let remainingWalkCells = walkCells;   // cells of walk movement left for approach
  // target declared here (not at Phase 1) so AoO helpers in the morale/flee
  // block can safely reference it via try-catch without a TDZ ReferenceError.
  let target             = null;

  // 1. Find a target (wall-aware LOS, incremental search fallback) ──────────
  //
  // Priority order:
  //   a. Tokens visible from current position → pick highest threat.
  //   b. No visible tokens → BFS the reachable area (walk speed) looking for
  //      any cell that gives LOS.  Move there (no action cost).
  //   c. Still none → extend search to dash range (action: Dash).
  //   d. Still none → hold.
  //
  // Once a cell with LOS is found the token moves there, target is set, and
  // Phase 4 closes the remaining distance to attack range using whatever walk
  // budget is left.

  const allLiving = canvas.tokens.placeables.filter(t => t.id !== token.id && !isDeadToken(t));
  if (!allLiving.length) {
    await say(`${actor.name} sees no living targets — holding.`, "#64748b");
    return;
  }

  // Pre-sort by threat descending so searchForLOSPosition always returns the
  // highest-threat target visible from whichever cell it picks.
  const byThreat = [...allLiving].sort((a, b) => threatScore(b) - threatScore(a));

  // ── Disposition helpers ───────────────────────────────────────────────────
  // Drives both flanking preference and self-preservation logic.
  // selfDisp: -1 = hostile (monsters), 0 = neutral, 1 = friendly (players/allies).
  // Two tokens with the same disposition are allies; opposite = enemies.
  const selfDisp = token.document.disposition ?? -1;
  function isAllyToken(t) { return t.document.disposition === selfDisp; }
  function isEnemyToken(t) {
    const d = t.document.disposition ?? 0;
    return d !== selfDisp && d !== 0;
  }
  const visibleAllies  = allLiving.filter(isAllyToken);
  const visibleEnemies = allLiving.filter(isEnemyToken);

  // Conditions on the acting token — needed by both the flee check below
  // and the full condition-processing block in Phase 3.5.
  const selfStatuses  = getTokenStatuses(token);
  // Attack-roll warnings accumulated in Phase 3.5, announced before Phase 8.
  const attackWarnings = [];

  // ── Self-preservation / morale check ─────────────────────────────────────
  // Evaluated BEFORE target selection.  If the token's HP is dangerously low
  // OR it is badly outnumbered, it abandons any attack plan and flees.
  {
    const hp      = actor.system?.attributes?.hp;
    const hpPct   = hp && hp.max > 0 ? hp.value / hp.max : 1;
    const outNum  = visibleEnemies.length - visibleAllies.length;
    const fleeing = hpPct <= MORALE_HP_PCT || outNum >= MORALE_OUTNUM;
    const critical = hpPct <= MORALE_HP_CRIT;

    if (fleeing) {
      const reason = hpPct <= MORALE_HP_PCT
        ? `HP critical (${Math.round(hpPct * 100)}%)`
        : `Outnumbered ${visibleEnemies.length}–${visibleAllies.length}`;
      notify(critical ? "🏃 ROUTING!" : "🏃 Retreating…", "#ef4444");
      await say(`${actor.name} is fleeing! (${reason})`, "#ef4444");

      // Grappled or Restrained → speed is 0, cannot flee at all.
      if (selfStatuses.has("grappled") || selfStatuses.has("restrained")) {
        const cond = selfStatuses.has("grappled") ? "grappled" : "restrained";
        notify(`🤜 ${cond.charAt(0).toUpperCase() + cond.slice(1)} — cornered!`, "#ef4444");
        await say(`${actor.name} tries to flee but is ${cond} — cannot move!`, "#ef4444");
        return;
      }

      if (visibleEnemies.length) {
        // Retreat direction: away from the centroid of all visible enemies.
        const selfCX = token.document.x + (token.document.width  ?? 1) * gs / 2;
        const selfCY = token.document.y + (token.document.height ?? 1) * gs / 2;
        const centX  = visibleEnemies.reduce((s, t) =>
          s + t.document.x + (t.document.width  ?? 1) * gs / 2, 0) / visibleEnemies.length;
        const centY  = visibleEnemies.reduce((s, t) =>
          s + t.document.y + (t.document.height ?? 1) * gs / 2, 0) / visibleEnemies.length;

        const ang     = Math.atan2(selfCY - centY, selfCX - centX);
        const farDist = Math.hypot(canvas.scene.width, canvas.scene.height);
        const rtX     = selfCX + Math.cos(ang) * farDist;
        const rtY     = selfCY + Math.sin(ang) * farDist;

        // Fleeing always uses Dash — a retreating creature uses every available
        // inch of movement.  The Action is consumed; no attack this turn.
        // If prone, standing up eats ½ max speed before the Dash budget applies.
        actionUsed = "dash";
        let fleeMov = remainingWalkCells;
        if (selfStatuses.has("prone")) {
          const standCost = Math.ceil(walkCells / 2);
          fleeMov = Math.max(0, fleeMov - standCost);
          notify("🧎 Standing — then flee!", "#a78bfa");
        }
        const budget = fleeMov * 2 * gs;  // Dash doubles the walk movement
        notify(critical ? "🏃 ROUTING — Dash!" : "🏃 Fleeing — Dash!", "#ef4444");

        // ── Opportunity Attacks: every hostile currently in melee range ──────
        // Fire BEFORE movement — fleeing out of melee always triggers AoO.
        // Uses edge-to-edge zone: (aw + tw)/2 + weaponReachPx covers all
        // sizes correctly.  Wrapped in try-catch so a crash here never
        // prevents the actual movement from happening.
        const fleeAW = (token.document.width  ?? 1) * gs;
        const fleeAH = (token.document.height ?? 1) * gs;
        try {
          for (const t of canvas.tokens.placeables) {
            if (t.id === token.id || isDeadToken(t) || isAllyToken(t)) continue;
            const st = getTokenStatuses(t);
            if (st.has("incapacitated") || st.has("paralyzed") ||
                st.has("stunned")       || st.has("unconscious")) continue;
            let reachFt = 5;
            for (const itm of (t.actor?.items ?? [])) {
              const at = itm.system?.actionType ?? "";
              if (at === "mwak" || at === "msak") {
                const r = itm.system?.range?.value ?? 5;
                if (r > reachFt) reachFt = r;
              }
            }
            const tw  = (t.document.width  ?? 1) * gs;
            const eCX = t.document.x + tw / 2;
            const eCY = t.document.y + (t.document.height ?? 1) * gs / 2;
            const zonePx = (fleeAW + tw) / 2 + reachFt / ftPerCell * gs;
            if (Math.hypot(selfCX - eCX, selfCY - eCY) <= zonePx + gs * 0.25) {
              await fireAoO(t, token);
            }
          }
        } catch (_) {}

        // ── Alive check — skip movement if AoOs dropped the token ────────
        const hpAfterAoO = actor.system?.attributes?.hp?.value ?? 1;
        if (hpAfterAoO <= 0) {
          await say(`${actor.name} falls to the Opportunity Attacks!`, "#ef4444");
        } else {
          const rtPos = findApproachPosPx(selfCX, selfCY, rtX, rtY, budget);
          if (rtPos) {
            await placeAtPx(token, rtPos.x, rtPos.y);
            const retreatedFt = Math.round(rtPos.distPx / gs * ftPerCell);
            await say(`${actor.name} dashes ${retreatedFt}ft away!`, "#ef4444");
          } else {
            await say(`${actor.name} is cornered — cannot retreat!`, "#ef4444");
          }
        }
      }
      return;   // no attack this turn
    }
  }

  // Split visibility into two tiers:
  //   visibleLOS   — pure geometric line-of-sight (walls block)
  //   visibleSense — only reachable via special senses (tremorsense, etc.)
  //                  that bypass walls
  // LOS targets are always preferred.  Special-sense-only targets are used
  // only when nothing is in LOS — they trigger the search phase so the token
  // moves until it has actual LOS before committing to an attack.
  const visibleLOS   = allLiving.filter(t => hasLOS(token, t));
  const visibleSense = visibleLOS.length
    ? []
    : allLiving.filter(t => canPerceive(token, t) && !hasLOS(token, t));
  const visibleNow   = visibleLOS.length ? visibleLOS : visibleSense;

  if (visibleLOS.length) {
    // ── (a) At least one enemy in LOS — pick highest threat ──────────────
    target = visibleLOS.reduce((best, t) => threatScore(t) >= threatScore(best) ? t : best);

  } else if (visibleSense.length) {
    // ── (b) Special sense only — search for LOS position first ───────────
    // We know something is out there (tremorsense, etc.) but can't attack
    // through a wall.  Fall through to the search phase with the sense-visible
    // tokens as candidates so the token moves until it can see one.
    await say(`${actor.name} senses a target — moving for line of sight…`, "#94a3b8");
    const occ = getOccupied();
    const senseCandidates = [...visibleSense].sort((a, b) => threatScore(b) - threatScore(a));
    // requireLOS = true: only cells with geometric LOS count.  We need a position
    // where we can actually SEE the target, not just be within tremorsense range.
    let srch = searchForLOSPosition(fromCX0, fromCY0, walkCells, senseCandidates, occ, true);
    if (!srch) srch = searchForLOSPosition(fromCX0, fromCY0, walkCells * 2, senseCandidates, occ, true);
    if (srch) {
      const usedDash = srch.cost > walkCells;
      if (usedDash) {
        notify("Moving — searching for LOS…", "#3b82f6");
        const walkSlice = srch.path.slice(0, walkCells);
        const { cx: wCX, cy: wCY } = await moveAlong(token, fromCX0, fromCY0, walkSlice);
        notify("Dash — eyes on target!", "#f59e0b");
        await moveAlong(token, wCX, wCY, srch.path.slice(walkCells));
        actionUsed = "dash";
      } else {
        notify("Moving — eyes on target!", "#3b82f6");
        await moveAlong(token, fromCX0, fromCY0, srch.path);
      }
      // Re-evaluate with fresh LOS from new position.
      const nowLOS = allLiving.filter(t => hasLOS(token, t));
      if (nowLOS.length) {
        target = nowLOS.reduce((best, t) => threatScore(t) >= threatScore(best) ? t : best);
      } else {
        await say(`${actor.name} cannot get line of sight — holding.`, "#64748b");
        return;
      }
    } else {
      await say(`${actor.name} cannot find line of sight — holding.`, "#64748b");
      return;
    }

  } else {
    // ── (c) No enemy detectable at all — search phase ────────────────────
    await say(`${actor.name} searches for a target…`, "#94a3b8");
    const occ  = getOccupied();

    // Walk-range search (no action cost).
    let srch = searchForLOSPosition(fromCX0, fromCY0, walkCells, byThreat, occ);

    // Dash-range search (action: Dash).
    if (!srch) srch = searchForLOSPosition(fromCX0, fromCY0, walkCells * 2, byThreat, occ);

    if (!srch) {
      await say(`${actor.name} cannot find any visible target — holding.`, "#64748b");
      return;
    }

    const usedDash  = srch.cost > walkCells;
    const searchFt  = srch.cost * ftPerCell;

    if (usedDash) {
      // Walk portion first, then dash the remainder.
      notify("Moving — searching…", "#3b82f6");
      const walkSlice = srch.path.slice(0, walkCells);
      const { cx: wCX, cy: wCY } = await moveAlong(token, fromCX0, fromCY0, walkSlice);
      notify("Dash — eyes on target!", "#f59e0b");
      const dashSlice = srch.path.slice(walkCells);
      await moveAlong(token, wCX, wCY, dashSlice);
      remainingWalkCells = 0;
      actionUsed = "dash";
      await say(`${actor.name} dashes ${searchFt}ft — spots ${srch.target.document.name}! (Action: Dash)`, "#f59e0b");
    } else {
      notify("Moving — searching…", "#3b82f6");
      await moveAlong(token, fromCX0, fromCY0, srch.path);
      remainingWalkCells = walkCells - srch.cost;
      await say(`${actor.name} moves ${searchFt}ft — spots ${srch.target.document.name}!`, "#22c55e");
    }

    target = srch.target;
  }

  let tName = target.document.name;
  let tX    = target.document.x + (target.document.width  ?? 1) * gs / 2;
  let tY    = target.document.y + (target.document.height ?? 1) * gs / 2;
  // Nearest-cell footprint distance for the opening announcement (matches dnd5e).
  const initialDistFt = Math.round(measureFt(token, target));

  // 2. Face target, announce — lock in crosshairs NOW ───────────────────────
  // Set Foundry's targeting indicator as soon as we pick the target so the GM
  // can see who this token is moving toward before any movement begins.
  try { target.setTarget(true, { user: game.user, releaseOthers: true }); } catch (_) {}
  await say(`Target: ${tName} (${initialDistFt}ft)`, "#22c55e");
  const nowPX = token.document.x + (token.document.width  ?? 1) * gs / 2;
  const nowPY = token.document.y + (token.document.height ?? 1) * gs / 2;
  await rotateTo(token, tX - nowPX, tY - nowPY, 800);
  await wait(pace);   // ← beat: GM can narrate "the Roc locks eyes on…"

  // 3. Resolve attacks + build attack-position ring ─────────────────────────
  // Build the attack sequence FIRST — weaponRange comes from the sequence so
  // movement stops at the closest range needed to land every attack in the turn.
  const allAtks = findAllAttacks(actor);
  if (!allAtks.length) {
    await say("No attack items found — check actor sheet.", "#ef4444");
    return;
  }
  // Full ordered sequence for this turn (multiattack-aware).
  const atkSeq = buildAttackSequence(actor, allAtks);
  // Move to within the shortest reach among all attacks so every hit can land.
  const weaponRange = Math.min(...atkSeq.map(i => i.system?.range?.value ?? 5));
  // Pixel equivalent — used by gridless Phase 4 helpers.
  // weaponRange ft × (gs px / ftPerCell ft) = px.
  const weaponRangePx = weaponRange / ftPerCell * gs;

  // ── Off-grid tolerance constants ─────────────────────────────────────────
  // Buildings in this campaign are NOT grid-aligned.  A token that appears
  // visually adjacent can read as 1-2 ft further than expected due to grid
  // quantisation.  These two constants compensate:
  //
  // RANGE_SLACK_FT — added to every range check (moveCandidates, isNowAdjacent,
  //   pre-attack gate, etc.).  3 ft turns a 5 ft melee weapon into an effective
  //   8 ft check — enough to cover sub-grid drift without granting clearly
  //   out-of-range attacks.
  //
  // WALL_MARGIN_PX — minimum pixel clearance a proposed destination cell's centre
  //   must have from every blocking wall.  A cell whose centre lands within this
  //   margin is in the wall's vision shadow and will lose sight of targets the
  //   moment the token arrives.  gs/2 (half a cell) is the right value: a 1×1
  //   token is gs pixels wide, so this ensures the token edge can touch but never
  //   cross the nearest wall.
  // RANGE_SLACK_FT, ATTACK_SLACK_FT, WALL_MARGIN_PX defined near top with tactical constants.

  // Footprint-aware candidate-cell generation.
  //
  // The old 1-cell ring used target footprint coordinates as the attacker's
  // TOP-LEFT position.  That works for 1×1 tokens, but a 4×4 Roc placed at
  // ring-cell (tCX-1, tCY-1) actually occupies columns [tCX-1 … tCX+2] and
  // rows [tCY-1 … tCY+2] — completely engulfing a 1×1 target at (tCX, tCY).
  //
  // Fix: search a wider area (pad = weaponRangeCells + attacker footprint) and
  // use hypotheticalFt — which computes the nearest-cell footprint-to-footprint
  // distance — to filter:
  //   d  > 0 → footprints don't overlap (attacker won't stand on the target)
  //   d ≤ weaponRange + RANGE_SLACK_FT → Foundry measures this placement as in-reach
  // Use tokenCellFootprint so off-grid targets expand the ring correctly.
  const tFP  = tokenCellFootprint(target);
  const tCX  = tFP.cx;
  const tCY  = tFP.cy;
  const tCW  = tFP.cw;  // may be > target.document.width if off-grid
  const tCH  = tFP.ch;
  const atkW = token.document.width  ?? 1;
  const atkH = token.document.height ?? 1;
  const weaponRangeCells = Math.ceil(weaponRange / ftPerCell);
  const pad = weaponRangeCells + Math.max(atkW, atkH);
  const moveCandidates = [];
  for (let cx = tCX - pad; cx <= tCX + tCW + pad - 1; cx++) {
    for (let cy = tCY - pad; cy <= tCY + tCH + pad - 1; cy++) {
      if (cx < 0 || cy < 0 || cx > maxCX || cy > maxCY) continue;
      const d = pxHypFt(cx, cy, target);
      if (d > 0 && d <= weaponRange + RANGE_SLACK_FT) moveCandidates.push({ cx, cy });
    }
  }
  // Safety fallback: unusual weapon-range / token-size combo yielded nothing —
  // generate a bare 1-cell border around the target and let path-finder decide.
  let moveCells = moveCandidates;
  if (!moveCells.length) {
    for (let cx = tCX - 1; cx <= tCX + tCW; cx++)
      for (let cy = tCY - 1; cy <= tCY + tCH; cy++) {
        const inside = cx >= tCX && cx < tCX + tCW && cy >= tCY && cy < tCY + tCH;
        if (!inside) moveCells.push({ cx, cy });
      }
  }

  // ── Wall-margin pre-filter ────────────────────────────────────────────────
  // Buildings in this campaign are not grid-aligned, so a grid cell that is
  // geometrically reachable can still place the token's centre pixel inside a
  // wall's vision shadow ("double-wall" problem).  Rather than testing LOS to
  // a specific target, we reject cells whose centre is too close to ANY wall.
  //
  // _ptSegDist: squared-form point-to-segment distance (no sqrt in the hot loop).
  // isNearWall: returns true if the token centre at (cx, cy) falls within
  //   WALL_MARGIN_PX of any wall that blocks movement or sight.
  //
  // Fail-safe: if every candidate cell is wall-adjacent we keep the full set so
  // the pathfinder can still get the token as close as possible; the pre-attack
  // gate below will veto the strike if vision is still absent on arrival.
  function _ptSegDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq < 0.0001) return Math.hypot(px - ax, py - ay);
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
  }

  function isNearWall(cx, cy, marginPx) {
    // Token centre for a 1×1 token at grid cell (cx, cy).
    const px = cx * gs + gs / 2;
    const py = cy * gs + gs / 2;
    for (const wall of canvas.walls.placeables) {
      const c = wall.document.c;
      if (!c || c.length < 4) continue;
      // Skip walls that have no move AND no sight restriction (purely decorative).
      // The GM's double walls typically use normal move + sight — include those.
      const moveType  = wall.document.move  ?? 20;  // 0 = NONE, non-zero = restricts
      const sightType = wall.document.sight ?? 20;
      if (moveType === 0 && sightType === 0) continue;
      if (_ptSegDist(px, py, c[0], c[1], c[2], c[3]) < marginPx) return true;
    }
    return false;
  }

  {
    const wallFiltered = moveCells.filter(c => !isNearWall(c.cx, c.cy, WALL_MARGIN_PX));
    if (wallFiltered.length) moveCells = wallFiltered;
  }

  console.log(`[CombatStep] weaponRange=${weaponRange}ft  walkCells=${walkCells}  range-valid: ${moveCandidates.length}  wall-clear: ${moveCells.length}`);

  // ── Danger-zone + AoO-aware pathfinding helpers ───────────────────────────
  //
  // D&D 5e: a creature provokes an Attack of Opportunity when it LEAVES a
  // hostile's melee reach voluntarily (not via Disengage, teleport, etc.).
  // "Reach" is typically 5 ft (1 cell) but Polearm / Reach weapons extend to 10 ft.
  //
  // buildDangerCells() maps every cell the MOVING TOKEN's footprint would
  // occupy that is within a hostile's reach — i.e. cells that, if entered and
  // then left, would provoke an AoO from that hostile.
  //
  // findPathSafe() first tries to route entirely around those cells.  If no
  // safe route exists it falls back to the shortest path (with an AoO warning).
  function buildDangerCells(targetTok) {
    const danger = new Set();
    for (const t of canvas.tokens.placeables) {
      if (t.id === token.id || t.id === targetTok.id) continue; // self & chosen target: skip
      if (isDeadToken(t)) continue;
      const st = getTokenStatuses(t);
      // Incapacitated / unconscious / paralyzed / stunned creatures can't take reactions.
      if (st.has("incapacitated") || st.has("paralyzed") ||
          st.has("stunned")       || st.has("unconscious")) continue;

      // Melee reach: check all attack items for the longest mwak/msak reach.
      let reachFt = 5;
      for (const item of (t.actor?.items ?? [])) {
        const aType = item.system?.actionType ?? "";
        if (aType !== "mwak" && aType !== "msak") {
          // dnd5e 5.x activity system: check activity types.
          const acts = item.system?.activities;
          if (!acts) continue;
          const arr = typeof acts.values === "function" ? [...acts.values()] : Object.values(acts);
          if (!arr.some(x => x?.type === "attack")) continue;
        }
        // range.reach is the explicit reach property; fall back to range.value.
        const r = item.system?.range?.reach ?? item.system?.range?.value ?? 5;
        if (r > reachFt) reachFt = r;
      }

      // Every cell where the moving token's footprint would be within this enemy's reach.
      const eFP = tokenCellFootprint(t);   // handles off-grid enemy placement
      const searchPad = Math.ceil(reachFt / ftPerCell) + Math.max(token.document.width ?? 1, token.document.height ?? 1);

      for (let cx = eFP.cx - searchPad; cx <= eFP.cx + eFP.cw + searchPad - 1; cx++) {
        for (let cy = eFP.cy - searchPad; cy <= eFP.cy + eFP.ch + searchPad - 1; cy++) {
          if (cx < 0 || cy < 0 || cx > maxCX || cy > maxCY) continue;
          if (pxHypFt(cx, cy, t) <= reachFt + 0.5) danger.add(`${cx},${cy}`);
        }
      }
    }
    return danger;
  }

  // Attempt a path that avoids AoO-triggering cells.
  // Returns {cost, path, aoo} where aoo=true means the path enters a danger zone.
  function findPathSafe(fromCX, fromCY, adjCells, occupied, dangerCells, softOccupied = null) {
    // Safe pass: treat danger cells as temporarily impassable (except starting cell).
    // Also prefer to avoid dead-body cells (softOccupied) on both passes.
    const startKey  = `${fromCX},${fromCY}`;
    const safeOcc   = new Set(occupied);
    for (const k of dangerCells) { if (k !== startKey) safeOcc.add(k); }

    const safeResult = findPathPreferClear(fromCX, fromCY, adjCells, safeOcc, false, softOccupied);
    if (safeResult) return { ...safeResult, aoo: false };

    // No AoO-free path — route normally and warn.
    const dangerResult = findPathPreferClear(fromCX, fromCY, adjCells, occupied, false, softOccupied);
    if (dangerResult) return { ...dangerResult, aoo: true };

    return null;
  }

  // findBestApproach — used when findPathSafe returns null (direct route blocked).
  //
  // Instead of giving up, BFS the ENTIRE reachable area within the walk budget
  // and return the cell that minimises footprint-to-footprint distance to the
  // target.  This lets a large token (Awakened Tree, Blight, etc.) move along
  // building exteriors toward a target it can't reach directly, ending up as
  // close as the terrain allows.
  //
  // Returns { cx, cy, cost, distFt, path } or null if the token literally
  // cannot move at all (budget 0 or all cells occupied/walled).
  function findBestApproach(fromCX, fromCY, budget, targetTok, occupied) {
    if (budget <= 0) return null;

    const visited = bfs(fromCX, fromCY, budget, occupied);

    let best     = null;
    let bestDist = Infinity;

    for (const [key, entry] of visited) {
      if (entry.cost === 0) continue;   // don't count standing still
      const [cx, cy] = key.split(",").map(Number);
      const d = pxHypFt(cx, cy, targetTok);
      // Prefer the cell that is closest to the target; break ties by lower cost
      // so we don't waste movement getting to an equally-close cell.
      if (d < bestDist || (d === bestDist && entry.cost < (best?.cost ?? Infinity))) {
        bestDist = d;
        best = {
          cx, cy,
          cost:   entry.cost,
          distFt: d,
          path:   makePath(visited, fromCX, fromCY, { cx, cy }),
        };
      }
    }
    return best;
  }

  // findReachableTarget — iterate candidates in threat order and return the
  // first one the token can physically reach within `budget` walk cells.
  // Used in Phase 4 (alt-target when primary is blocked) AND Phase 8
  // (between-attack target switching after a kill).
  //
  // Reads weaponRange / weaponRangeCells / atkW / atkH from outer scope;
  // all are set in Phase 3 before this is ever invoked.
  function findReachableTarget(fromCX, fromCY, budget, candidates, occ, squeeze = false, softOccupied = null) {
    for (const tok of candidates) {
      if (isDeadToken(tok)) continue;
      const rFP  = tokenCellFootprint(tok);  // handles off-grid targets
      const rPad = weaponRangeCells + Math.max(atkW, atkH);
      const rCells = [];
      for (let cx = rFP.cx - rPad; cx <= rFP.cx + rFP.cw + rPad - 1; cx++) {
        for (let cy = rFP.cy - rPad; cy <= rFP.cy + rFP.ch + rPad - 1; cy++) {
          if (cx < 0 || cy < 0 || cx > maxCX || cy > maxCY) continue;
          const d = pxHypFt(cx, cy, tok);
          if (d > 0 && d <= weaponRange + RANGE_SLACK_FT) rCells.push({ cx, cy });
        }
      }
      if (!rCells.length) continue;
      // Prefer approach cells whose centre is safely away from walls — same
      // wall-margin logic as moveCells above.  Fall back to full rCells if
      // every candidate is wall-adjacent (tiny rooms, enclosed targets, etc.).
      const rCellsClean = rCells.filter(c => !isNearWall(c.cx, c.cy, WALL_MARGIN_PX));
      const rCellsFinal = rCellsClean.length ? rCellsClean : rCells;
      const res = findPathPreferClear(fromCX, fromCY, rCellsFinal, occ, squeeze, softOccupied);
      if (res && res.cost <= budget) return { target: tok, result: res };
    }
    return null;
  }

  // ── Phase 3.5: Condition processing ──────────────────────────────────────
  // Resolve active conditions on the acting token BEFORE Phase 4 moves it.
  // dnd5e + MidiQOL automatically set advantage/disadvantage on the dice roll
  // when these status effects are present — we handle the MOVEMENT BUDGET and
  // AI-DECISION layer here (stand-up cost, speed zeroing, attack-roll warnings).
  //
  // Execution order matters: Exhaustion is checked first (it may already have
  // zeroed speed before Grappled/Restrained get a chance), then Prone (which
  // needs a remaining-speed check), then pure attack-roll conditions.

  // ── Exhaustion ─────────────────────────────────────────────────────────
  // dnd5e 5.x stores exhaustion as actor.system.attributes.exhaustion (0-6).
  // Level 1: disadvantage on ability checks (no movement/attack change here).
  // Level 2: disadvantage on attack rolls → flag warning (dnd5e auto-applies).
  // Level 4: speed halved.
  // Level 5: speed = 0.
  // Level 6: death — treated by isDeadToken, never reaches here.
  {
    const exhLevel = actor.system?.attributes?.exhaustion ?? 0;
    if (exhLevel >= 5) {
      remainingWalkCells = 0;
      notify("☠️ Exhaustion 5 — speed 0!", "#64748b");
      await say(`${actor.name} is severely exhausted (level ${exhLevel}) — cannot move.`, "#64748b");
    } else if (exhLevel === 4) {
      remainingWalkCells = Math.max(0, Math.floor(remainingWalkCells / 2));
      notify("😓 Exhaustion 4 — speed halved", "#64748b");
      await say(`${actor.name} is exhausted (level 4) — speed halved.`, "#64748b");
    }
    if (exhLevel >= 2 && exhLevel < 5) {
      attackWarnings.push(`Exhaustion ${exhLevel}`);
    }
  }

  // ── Grappled → speed = 0 ──────────────────────────────────────────────
  // Speed drops to 0 but the token can still act (attack, cast, etc.).
  if (selfStatuses.has("grappled")) {
    remainingWalkCells = 0;
    notify("🤜 Grappled — speed 0", "#f59e0b");
    await say(`${actor.name} is grappled — cannot move this turn.`, "#f59e0b");
  }

  // ── Restrained → speed = 0 + attacks at disadvantage ─────────────────
  // Unlike grappled, restrained ALSO gives attackers advantage against this
  // token and imposes disadvantage on the token's own attacks.
  if (selfStatuses.has("restrained")) {
    remainingWalkCells = 0;
    attackWarnings.push("Restrained");
    notify("⛓️ Restrained — speed 0, ⚠️ disadv.", "#f59e0b");
    await say(`${actor.name} is restrained — cannot move, attacks at disadvantage.`, "#f59e0b");
  }

  // ── Prone → stand up (costs ½ max speed) or fight from the ground ─────
  // PHB p.191: standing up costs movement equal to HALF your maximum speed,
  // not your remaining speed.  The AI stands up if it can afford to; otherwise
  // it stays prone and attacks at disadvantage (melee attacks only — ranged
  // attacks against a prone target you're not adjacent to are at disadvantage
  // for the attacker, but our token's OWN attacks while prone are always disadv).
  let isStillProne = false;
  if (selfStatuses.has("prone")) {
    const standUpCostCells = Math.ceil(walkCells / 2);   // ½ MAX speed
    if (remainingWalkCells >= standUpCostCells) {
      remainingWalkCells -= standUpCostCells;
      notify("🧎 Standing up…", "#a78bfa");
      await say(
        `${actor.name} stands up from prone (costs ${standUpCostCells * ftPerCell}ft — `
        + `${remainingWalkCells * ftPerCell}ft movement remaining).`,
        "#a78bfa"
      );
      // Remove the prone active effect so dnd5e stops applying roll penalties.
      try {
        const proneEffect = actor.effects.find(e =>
          [...(e.statuses ?? [])].includes("prone") ||
          e.flags?.core?.statusId === "prone"        ||
          e.flags?.dnd5e?.statusId === "prone"
        );
        if (proneEffect) await proneEffect.delete().catch(() => {});
      } catch (_) {}
    } else {
      isStillProne = true;
      attackWarnings.push("Prone");
      notify("🤕 Prone — not enough move to stand", "#f59e0b");
      await say(
        `${actor.name} cannot stand up (needs ${standUpCostCells * ftPerCell}ft, `
        + `has ${remainingWalkCells * ftPerCell}ft) — staying prone, attacks at disadvantage.`,
        "#f59e0b"
      );
    }
  }

  // ── Poisoned → disadvantage on attack rolls + ability checks ──────────
  // dnd5e applies this automatically on the roll; we just flag it.
  if (selfStatuses.has("poisoned")) {
    attackWarnings.push("Poisoned");
    notify("🤢 Poisoned — ⚠️ disadv. attacks", "#84cc16");
  }

  // ── Blinded → disadvantage on attacks, targets have advantage ─────────
  if (selfStatuses.has("blinded")) {
    attackWarnings.push("Blinded");
    notify("🙈 Blinded — ⚠️ disadv. attacks", "#64748b");
    await say(`${actor.name} is blinded — attacks at disadvantage, enemies have advantage.`, "#64748b");
  }

  // ── Frightened → disadv. on attacks while fear source is in sight ─────
  // The macro doesn't track the fear source actor, so we warn and let the
  // GM handle targeting restrictions.  The token still attacks normally but
  // should not willingly move closer to whatever frightened it.
  if (selfStatuses.has("frightened")) {
    attackWarnings.push("Frightened");
    notify("😱 Frightened — ⚠️ disadv. attacks", "#ef4444");
    await say(`${actor.name} is frightened — disadvantage while fear source is visible.`, "#ef4444");
  }

  // ── Charmed → cannot attack the charmer ───────────────────────────────
  // We can't reliably identify the charmer from the status alone, so just flag.
  if (selfStatuses.has("charmed")) {
    attackWarnings.push("Charmed");
    notify("💜 Charmed — cannot attack charmer", "#c084fc");
  }

  await wait(pace * 0.5);

  // ── Opportunity Attack helpers ────────────────────────────────────────────
  // AoO fires when the active token moves OUT of a hostile's melee zone.
  // Rules:  each hostile has 1 reaction per round (tracked in __cavrilReactions).
  //         The attack auto-rolls (fastForward) — no confirmation dialog needed
  //         mid-movement.  Disengaging would bypass AoOs but is not AI behaviour.

  // Fires one AoO: threatTok attacks aooTarget with its best melee weapon.
  async function fireAoO(threatTok, aooTarget) {
    const atkActor = threatTok.actor;
    if (!atkActor) return;
    const meleeItems = [...(atkActor.items ?? [])].filter(i => {
      const at = i.system?.actionType ?? "";
      return at === "mwak" || at === "msak";
    });
    if (!meleeItems.length) return;
    const aooItem = meleeItems[0];

    // Reaction gate — 1 per actor per round.
    window.__cavrilReactions = window.__cavrilReactions ?? new Set();
    const roundKey = `${atkActor.id}-${game.combat?.round ?? 0}`;
    if (window.__cavrilReactions.has(roundKey)) {
      notify(`🛡 ${atkActor.name} — reaction spent`, "#64748b");
      return;
    }
    window.__cavrilReactions.add(roundKey);

    notify(`⚔️ ${atkActor.name}: Opportunity Attack!`, "#ef4444");
    try {
      await say(
        `⚔️ ${atkActor.name} takes an Opportunity Attack on ${aooTarget.actor?.name ?? aooTarget.document?.name}!`,
        "#ef4444"
      );
    } catch (_) {}

    // Re-target the moving token before rolling.
    try { aooTarget.setTarget(true, { user: game.user, releaseOthers: true }); } catch (_) {}

    // Roll — always fast-forwarded (no dialog mid-movement).
    const aooEvent   = new MouseEvent("click", { shiftKey: true });
    const midiActive = !!game.modules.get("midi-qol")?.active;
    if (midiActive) {
      let wfHookId;
      const done = new Promise(res => {
        const tid = setTimeout(() => { Hooks.off("midi-qol.RollComplete", wfHookId); res(); }, 15000);
        wfHookId = Hooks.once("midi-qol.RollComplete", () => { clearTimeout(tid); res(); });
      });
      try { aooItem.use({}, { event: aooEvent, fastForward: true }); } catch (_) {}
      await done;
    } else {
      try { await aooItem.use({}, { event: aooEvent, fastForward: true }); } catch (_) {}
    }

    // Restore the acting token's target (safely handles pre-Phase-1 case).
    try { if (target) target.setTarget(true, { user: game.user, releaseOthers: true }); } catch (_) {}

    await wait(pace * 0.4);
  }

  // For each hostile whose melee zone the token is leaving (start IN, end OUT),
  // fire an AoO.  Uses edge-to-edge zone radius = (aw+tw)/2 + weaponReach_px.
  async function handleAoOs(fromCX, fromCY, toCX, toCY) {
    const aw = (token.document.width  ?? 1) * gs;
    const ah = (token.document.height ?? 1) * gs;   // eslint-disable-line no-unused-vars
    for (const t of canvas.tokens.placeables) {
      if (t.id === token.id) continue;
      if (isDeadToken(t) || isAllyToken(t)) continue;
      const st = getTokenStatuses(t);
      if (st.has("incapacitated") || st.has("paralyzed") ||
          st.has("stunned")       || st.has("unconscious")) continue;
      // Max melee reach for this threat.
      let reachFt = 5;
      for (const itm of (t.actor?.items ?? [])) {
        const at = itm.system?.actionType ?? "";
        if (at === "mwak" || at === "msak") {
          const r = itm.system?.range?.value ?? 5;
          if (r > reachFt) reachFt = r;
        }
      }
      const tw  = (t.document.width  ?? 1) * gs;
      const eCX = t.document.x + tw / 2;
      const eCY = t.document.y + (t.document.height ?? 1) * gs / 2;
      // Edge-to-edge melee zone: touching distance + weapon reach.
      // Center-to-center at which the moving token's edge is just within reach:
      //   (aw + tw) / 2  → boxes touching
      //   + reachFt_px   → weapon reach extends beyond the edge
      const zonePx = (aw + tw) / 2 + reachFt / ftPerCell * gs;
      const slk    = gs * 0.25;   // small tolerance matches sweepRing wouldTriggerAoO
      const wasIn  = Math.hypot(fromCX - eCX, fromCY - eCY) <= zonePx + slk;
      const nowIn  = Math.hypot(toCX   - eCX, toCY   - eCY) <= zonePx + slk;
      if (wasIn && !nowIn) await fireAoO(t, token);
    }
  }

  // 4. Movement ──────────────────────────────────────────────────────────
  // Grid-aware: on gridless scenes tokens move to the nearest valid PIXEL
  // position at weapon range (findAttackPosPx ring sweep).  On gridded scenes
  // placeAtPx snaps to the nearest grid cell.  All "in range?" checks use
  // measureFt (nearest-cell footprint = what dnd5e actually gates on) rather
  // than center-to-centre pixel distance, so large-vs-small tokens are judged
  // correctly — a 2×2 Roc touching a 1×1 citizen reads as 5 ft.
  let isNowAdjacent      = false;
  let remainingMovePx    = remainingWalkCells * gs;  // walk budget in pixels
  const initialMovePx    = remainingMovePx;           // stored for post-terrain-hug Dash budget
  let remainingMoveBudget = remainingWalkCells;       // cell approximation kept for Phase 8

  if (measureFt(token, target) <= weaponRange + ATTACK_SLACK_FT) {
    // Already in attack range — no movement needed.
    await say(`${actor.name} is already in range of ${tName}.`, "#3b82f6");
    isNowAdjacent = true;

  } else if (actionUsed === "dash") {
    // Dash consumed during search phase — action already spent.
    await say(`${actor.name} used Dash to find ${tName} — no attack this turn.`, "#f59e0b");

  } else {
    // Current and target pixel centres.
    const selfCnow = {
      x: token.document.x + (token.document.width  ?? 1) * gs / 2,
      y: token.document.y + (token.document.height ?? 1) * gs / 2,
    };
    const tgtCnow = {
      x: target.document.x + (target.document.width  ?? 1) * gs / 2,
      y: target.document.y + (target.document.height ?? 1) * gs / 2,
    };
    const p4aw = (token.document.width  ?? 1) * gs;
    const p4ah = (token.document.height ?? 1) * gs;

    // ── Try normal walk budget first ─────────────────────────────────────
    let atkPos = findAttackPosPx(
      selfCnow.x, selfCnow.y,
      tgtCnow.x,  tgtCnow.y,
      weaponRangePx, remainingMovePx
    );
    let needsDash = false;

    // ── If walk can't reach, try dash budget (costs Action) ──────────────
    if (!atkPos && actionUsed === null) {
      atkPos = findAttackPosPx(
        selfCnow.x, selfCnow.y,
        tgtCnow.x,  tgtCnow.y,
        weaponRangePx, remainingMovePx * 2
      );
      if (atkPos) needsDash = true;
    }

    if (atkPos) {
      // ── Move to pixel-exact attack position (1 or 2 legs) ───────────
      // atkPos.waypoint is set when a 2-hop route was needed to arc around
      // an obstacle (e.g. a building corner between self and the ring).
      const destCX  = atkPos.x + p4aw / 2;
      const destCY  = atkPos.y + p4ah / 2;
      const distPx  = atkPos.distPx;  // total walk distance (both legs if 2-hop)
      const movedFt = Math.round(distPx / gs * ftPerCell);

      if (needsDash) {
        actionUsed = "dash";
        remainingMoveBudget = 0;
        notify("Dash!", "#f59e0b");
        // AoO: dashing may exit an adjacent enemy's melee zone.
        try { await handleAoOs(selfCnow.x, selfCnow.y, destCX, destCY); } catch (_) {}
        if (atkPos.waypoint) await placeAtPx(token, atkPos.waypoint.x, atkPos.waypoint.y);
        await placeAtPx(token, atkPos.x, atkPos.y);
        remainingMovePx = 0;
        isNowAdjacent = measureFt(token, target) <= weaponRange + ATTACK_SLACK_FT;
        if (isNowAdjacent) {
          await say(`${actor.name} dashes — ${movedFt}ft total, now in range of ${tName}. (Action spent, no attack.)`, "#f59e0b");
        } else {
          await say(`${actor.name} dashes ${movedFt}ft toward ${tName} — still out of reach. (Action spent, no attack.)`, "#f59e0b");
        }

      } else {
        // Build movement notification including tactical context.
        let moveTag = atkPos.waypoint ? "Routing around obstacle…" : "Moving…";
        if (atkPos.flanking) moveTag = "⚔️ Flanking!";
        if (atkPos.aoo)      moveTag = "⚠️ Provoking AoO…";
        if (movedFt > 0) notify(moveTag, atkPos.flanking ? "#22c55e" : atkPos.aoo ? "#f59e0b" : "#3b82f6");
        // AoO: moving to attack position may exit another enemy's melee zone.
        try { await handleAoOs(selfCnow.x, selfCnow.y, destCX, destCY); } catch (_) {}
        if (atkPos.waypoint) await placeAtPx(token, atkPos.waypoint.x, atkPos.waypoint.y);
        await placeAtPx(token, atkPos.x, atkPos.y);
        remainingMovePx    -= distPx;
        remainingMoveBudget = Math.max(0, Math.round(remainingMovePx / gs));
        isNowAdjacent = measureFt(token, target) <= weaponRange + ATTACK_SLACK_FT;
        const flankSuffix = atkPos.flanking ? " (flanking!)" : "";
        const aooSuffix   = atkPos.aoo      ? " ⚠️ Provokes AoO!" : "";
        await say(
          isNowAdjacent
            ? `${actor.name} moves ${movedFt}ft into range of ${tName}.${flankSuffix}${aooSuffix}`
            : `${actor.name} moves ${movedFt}ft toward ${tName} — just out of reach.${aooSuffix}`,
          atkPos.flanking ? "#22c55e" : "#3b82f6"
        );
      }

    } else {
      // ── No attack position reachable for primary target ──────────────
      // Try other living targets in threat order before terrain-hugging.
      const altCandidates = byThreat.filter(t => t.id !== target.id && !isDeadToken(t));
      let altDone = false;

      for (const altTok of altCandidates) {
        const altC = {
          x: altTok.document.x + (altTok.document.width  ?? 1) * gs / 2,
          y: altTok.document.y + (altTok.document.height ?? 1) * gs / 2,
        };
        const altPos = findAttackPosPx(
          selfCnow.x, selfCnow.y,
          altC.x, altC.y,
          weaponRangePx, remainingMovePx
        );
        if (!altPos) continue;

        const oldName = tName;
        target = altTok;
        tName  = altTok.document.name;
        tX     = altC.x;
        tY     = altC.y;
        try { altTok.setTarget(true, { user: game.user, releaseOthers: true }); } catch (_) {}

        const altCX  = altPos.x + p4aw / 2;
        const altCY  = altPos.y + p4ah / 2;
        const distPx = Math.hypot(altCX - selfCnow.x, altCY - selfCnow.y);
        const movedFt = Math.round(distPx / gs * ftPerCell);
        if (movedFt > 0) notify(`${oldName} blocked — moving to ${tName}…`, "#f59e0b");
        // AoO: switching to an alternate target may exit another enemy's zone.
        try { await handleAoOs(selfCnow.x, selfCnow.y, altCX, altCY); } catch (_) {}
        await placeAtPx(token, altPos.x, altPos.y);
        remainingMovePx    -= distPx;
        remainingMoveBudget = Math.max(0, Math.round(remainingMovePx / gs));
        isNowAdjacent = measureFt(token, target) <= weaponRange + ATTACK_SLACK_FT;
        await say(`${actor.name} — ${oldName} unreachable, moves ${movedFt}ft to ${tName}!`, "#22c55e");
        altDone = true;
        break;
      }

      if (!altDone) {
        // ── Terrain-hug: approach primary target as close as possible ────
        const approachPos = findApproachPosPx(
          selfCnow.x, selfCnow.y,
          tgtCnow.x,  tgtCnow.y,
          remainingMovePx
        );

        if (!approachPos) {
          await say(`${actor.name} is completely blocked — cannot move!`, "#ef4444");

        } else {
          notify("Blocked — closing as far as possible…", "#f59e0b");
          const distPx  = approachPos.distPx;
          const movedFt = Math.round(distPx / gs * ftPerCell);
          // AoO: terrain-hug may exit an enemy's melee zone even while closing.
          const approachCX = approachPos.x + p4aw / 2;
          const approachCY = approachPos.y + p4ah / 2;
          try { await handleAoOs(selfCnow.x, selfCnow.y, approachCX, approachCY); } catch (_) {}
          await placeAtPx(token, approachPos.x, approachPos.y);
          remainingMovePx    -= distPx;
          remainingMoveBudget = Math.max(0, Math.round(remainingMovePx / gs));

          // Check if any living target with LOS is now in range at landing pos.
          const nowInRange = allLiving.filter(t =>
            !isDeadToken(t) &&
            hasLOS(token, t) &&
            measureFt(token, t) <= weaponRange + ATTACK_SLACK_FT
          );

          if (nowInRange.length) {
            const oldName     = tName;
            const pivotTarget = nowInRange.reduce(
              (best, t) => threatScore(t) >= threatScore(best) ? t : best
            );
            target = pivotTarget;
            tName  = pivotTarget.document.name;
            tX     = pivotTarget.document.x + (pivotTarget.document.width  ?? 1) * gs / 2;
            tY     = pivotTarget.document.y + (pivotTarget.document.height ?? 1) * gs / 2;
            try { pivotTarget.setTarget(true, { user: game.user, releaseOthers: true }); } catch (_) {}
            isNowAdjacent = true;
            await say(
              tName === oldName
                ? `${actor.name} moves ${movedFt}ft — forced around obstacles, now in range of ${tName}!`
                : `${actor.name} moves ${movedFt}ft — blocked from ${oldName}, pivots to ${tName}!`,
              "#22c55e"
            );

          } else {
            // ── Dash to close after terrain-hug ──────────────────────────
            // Walk budget exhausted, action still free — spend it as Dash to
            // gain one extra speed's worth of movement from the current position.
            // Uses initialMovePx (condition-adjusted speed at turn start) for the
            // Dash bonus, plus any walk movement left over from the terrain-hug.
            const stillFt = Math.round(measureFt(token, target));
            if (actionUsed === null) {
              const afterHugCX = token.document.x + p4aw / 2;
              const afterHugCY = token.document.y + p4ah / 2;
              const newTgtCX   = target.document.x + (target.document.width  ?? 1) * gs / 2;
              const newTgtCY   = target.document.y + (target.document.height ?? 1) * gs / 2;
              // Total dash budget from current pos = leftover walk + full-speed bonus.
              const dashBudgetPx = remainingMovePx + initialMovePx;
              const dashPos = findAttackPosPx(afterHugCX, afterHugCY, newTgtCX, newTgtCY, weaponRangePx, dashBudgetPx);
              if (dashPos) {
                actionUsed = "dash";
                const dashFt     = Math.round(dashPos.distPx / gs * ftPerCell);
                const dashDestCX = dashPos.x + p4aw / 2;
                const dashDestCY = dashPos.y + p4ah / 2;
                notify("Dash!", "#f59e0b");
                // AoO from new position en route to dash destination.
                try { await handleAoOs(afterHugCX, afterHugCY, dashDestCX, dashDestCY); } catch (_) {}
                if (dashPos.waypoint) await placeAtPx(token, dashPos.waypoint.x, dashPos.waypoint.y);
                await placeAtPx(token, dashPos.x, dashPos.y);
                remainingMovePx = 0;
                remainingMoveBudget = 0;
                isNowAdjacent = measureFt(token, target) <= weaponRange + ATTACK_SLACK_FT;
                if (isNowAdjacent) {
                  await say(`${actor.name} dashes ${dashFt}ft — now in range of ${tName}. (Action spent, no attack.)`, "#f59e0b");
                } else {
                  await say(`${actor.name} dashes ${dashFt}ft toward ${tName} — still out of reach. (Action spent.)`, "#f59e0b");
                }
              } else {
                await say(
                  `${actor.name} moves ${movedFt}ft toward ${tName} — still blocked (${stillFt}ft away), even with Dash.`,
                  "#f59e0b"
                );
              }
            } else {
              await say(
                `${actor.name} moves ${movedFt}ft toward ${tName} — still blocked (${stillFt}ft away), no attack.`,
                "#f59e0b"
              );
            }
          }
        }
      }
    }
  }
  // ── Beat after movement phase ───────────────────────────────────────────
  await wait(pace);

  // 5. Face target — always use CURRENT position, not selfX/selfY which is
  //    the turn-start position and is stale if the search phase moved the token.
  {
    const finalCX = token.document.x + (token.document.width  ?? 1) * gs / 2;
    const finalCY = token.document.y + (token.document.height ?? 1) * gs / 2;
    await rotateTo(token, tX - finalCX, tY - finalCY, 280);
  }
  await wait(pace);  // ← beat: GM can narrate "…raises its weapon…"

  // 6. Attack ─────────────────────────────────────────────────────────────
  if (actionUsed !== null) {
    await say(actionUsed === "dash"
      ? `${actor.name} dashed — action spent, no attack.`
      : `${actor.name} dodged — action spent, no attack.`, "#64748b");
    return;
  }
  if (!isNowAdjacent) {
    await say(`${actor.name} couldn't reach melee — no attack.`, "#64748b");
    return;
  }

  // Final range gate — nearest-cell footprint distance, matching what dnd5e
  // uses for its own attack range check.  measureFt correctly handles
  // mixed token sizes: a 2×2 attacker touching a 1×1 target reads as 5 ft
  // (adjacent cells), not 7.5 ft (centre-to-centre).
  // ATTACK_SLACK_FT (0.5 ft) absorbs sub-cell positioning drift.
  const distNow = measureFt(token, target);
  console.log(`[CombatStep] pre-attack check — footprint dist ${distNow.toFixed(1)}ft, limit ${(weaponRange + ATTACK_SLACK_FT).toFixed(1)}ft`);
  if (distNow > weaponRange + ATTACK_SLACK_FT) {
    await say(
      `${actor.name} is out of range — ${Math.round(distNow)}ft away, max ${weaponRange}ft.`,
      "#f59e0b"
    );
    return;
  }

  // targetAC is `let` so the attack loop can update it when the target changes
  // (multiattack pivot after a kill or between-attack movement to a new target).
  let targetAC = target.actor?.system?.attributes?.ac?.value ?? null;

  // 7. Single-attack helper ────────────────────────────────────────────────
  // Event-driven: await item.use() directly — it resolves the moment the roll
  // is complete (dialog confirmed + dice rolled + message created).
  // No hook, no timer.  Read the result from the return value or game.messages.

  // Walk a roll's term tree looking for a d20 die (handles standard rolls,
  // advantage pools, and any dnd5e v2/v3 nesting variation).
  function findD20In(roll) {
    for (const t of roll?.terms ?? []) {
      if (t?.faces === 20) return { roll, term: t };
      for (const inner of t?.rolls ?? [])          // PoolTerm (adv/disadv)
        for (const st of inner?.terms ?? [])
          if (st?.faces === 20) return { roll, term: st };
    }
    return null;
  }

  // Search a list of ChatMessages for the first one that contains a d20 roll.
  function extractD20(messages) {
    for (const msg of messages ?? []) {
      const rolls = msg?.rolls ?? msg?.message?.rolls ?? [];
      for (const r of rolls) {
        const found = findD20In(r);
        if (found) return found;
      }
    }
    return null;
  }

  async function doOneAttack(item, atkLabel) {
    window.__cavrilDeduping = false;   // reset defensively at each attack entry
    await say(`${atkLabel} → ${tName}!`, "#ef4444");
    await animLunge(token, target);

    const e = autoRoll
      ? new MouseEvent("click", { shiftKey: true })
      : new MouseEvent("click");

    // ── MidiQOL detection ─────────────────────────────────────────────────────
    // MidiQOL patches item.use() via libWrapper and returns a ChatMessageMidi
    // shell BEFORE any dice are rolled.  Its full pipeline
    // (attack → damage → saves → conditions) continues asynchronously, so:
    //
    //   • extractD20(useResult) always fails  — effects: [] at resolve time
    //   • game.messages fallback also fails   — roll not yet written to message
    //   • both Multiattack strikes run concurrently (Beak's workflow still running
    //     when Talons starts), which desynchronises animations from chat output
    //
    // Fix: two hooks registered BEFORE item.use() fires (without await):
    //   dnd5e.rollAttack      — fires when the attack die is actually rolled
    //                           (mid-pipeline); gives us the Roll for animations
    //   midi-qol.RollComplete — fires when the entire workflow is done
    //                           (attack + damage + saves + effects); used as a
    //                           gate so the next Multiattack strike doesn't start
    //                           while MidiQOL is still applying conditions
    //
    // Without MidiQOL the existing path (await item.use(), read useResult) is
    // unchanged — no vanilla dnd5e behaviour is altered.
    const midiActive = !!game.modules.get("midi-qol")?.active;

    let found = null;
    let capturedWorkflow = null;   // set when midi-qol.RollComplete fires (MidiQOL path)
    let postWorkflow = Promise.resolve(); // no-op for vanilla dnd5e

    if (midiActive) {
      let capturedRoll = null;

      // Hook 2 — set up FIRST because rollReady's fallback chains off this Promise.
      // MidiQOL passes the full workflow object to RollComplete; we capture it so
      // we can read isCritical / isFumble / attackTotal / hitTargets directly when
      // the dnd5e roll hooks are intercepted before our listener fires.
      let workflowHookId;
      postWorkflow = new Promise(resolve => {
        const tid = setTimeout(() => {
          Hooks.off("midi-qol.RollComplete", workflowHookId);
          resolve();   // timed out — safe to continue anyway
        }, 20_000);
        workflowHookId = Hooks.on("midi-qol.RollComplete", (workflow) => {
          clearTimeout(tid);
          Hooks.off("midi-qol.RollComplete", workflowHookId);
          capturedWorkflow = workflow;   // capture for outcome extraction below
          resolve();
        });
      });

      // Hook 1 — try to capture the attack roll the moment the die lands.
      // dnd5e ≥5.3 renamed rollAttack → rollAttackV2; register both for compat.
      // In practice MidiQOL intercepts the hook before our listener runs, so
      // postWorkflow.then() is the fallback: it resolves as soon as the full
      // workflow is done (~1-2s) instead of waiting out a 10s blind timeout.
      let rollHookId, rollHookIdV2;
      const rollReady = new Promise(resolve => {
        const finish = roll => {
          Hooks.off("dnd5e.rollAttack",   rollHookId);
          Hooks.off("dnd5e.rollAttackV2", rollHookIdV2);
          capturedRoll = roll;
          resolve();
        };
        rollHookId   = Hooks.on("dnd5e.rollAttack",
                         (_src, roll) => finish(roll));
        rollHookIdV2 = Hooks.on("dnd5e.rollAttackV2",
                         (rolls, _ctx) => finish(Array.isArray(rolls) ? rolls[0] : rolls));
        // Fallback: resolve when the full workflow completes so capturedWorkflow
        // is populated and we can derive the outcome from it instead.
        postWorkflow.then(() => {
          Hooks.off("dnd5e.rollAttack",   rollHookId);
          Hooks.off("dnd5e.rollAttackV2", rollHookIdV2);
          resolve();
        });
      });

      // Suppress Dice So Nice 3D dice for this automated sim roll.
      // messageHookDisabled is an internal DSN flag (not public API) — DSN
      // checks it before showing the dice tray.  Cleared after roll is captured.
      if (game.dice3d) game.dice3d.messageHookDisabled = true;
      window.__cavrilDeduping = true;   // raise dedup gate

      // Fire item.use() — intentionally NOT awaited.
      // MidiQOL would return immediately anyway; awaiting only adds confusion.
      try { item.use({}, { event: e, fastForward: autoRoll }); } catch (_) {}

      // Wait for the attack die (or full workflow as fallback), then extract d20.
      await rollReady;
      if (game.dice3d) game.dice3d.messageHookDisabled = false;

      // Priority 1: dnd5e hook captured the roll directly (best — fires early)
      if (capturedRoll) found = findD20In(capturedRoll);
      // Priority 2: workflow has an attackRoll Roll object we can walk
      if (!found && capturedWorkflow?.attackRoll) found = findD20In(capturedWorkflow.attackRoll);
      // Priority 3: scan recent chat messages (last resort)
      if (!found) {
        const recent = [...game.messages.contents].slice(-4).reverse();
        found = extractD20(recent);
      }
      // Priority 4 (1st-attack fix): rollReady resolved early via the dnd5e hook
      // (finish() was called) but findD20In failed and game.messages was empty because
      // no prior attack has posted a chat card yet.  midi-qol.RollComplete fires
      // ~200 ms after the attack resolves — postWorkflow is still pending.
      // Awaiting it here gives capturedWorkflow time to populate so we can read
      // isCritical / isFumble / attackTotal directly instead of bailing out.
      if (!found && capturedWorkflow == null) {
        await postWorkflow;   // resolves when midi-qol.RollComplete fires (max 20s)
        if (capturedWorkflow?.attackRoll) found = findD20In(capturedWorkflow.attackRoll);
        if (!found) {
          const recent = [...game.messages.contents].slice(-4).reverse();
          found = extractD20(recent);
        }
      }

    } else {
      // ── Vanilla dnd5e ───────────────────────────────────────────────────────
      // item.use() resolves only after dice are rolled — original read path.
      let useResult;
      if (game.dice3d) game.dice3d.messageHookDisabled = true;
      window.__cavrilDeduping = true;   // raise dedup gate
      try { useResult = await item.use({}, { event: e, fastForward: autoRoll }); }
      catch(_) { try { useResult = await item.use(); } catch(__) {} }
      window.__cavrilDeduping = false;
      if (game.dice3d) game.dice3d.messageHookDisabled = false;

      found = extractD20(Array.isArray(useResult) ? useResult : [useResult]);
      if (!found) {
        const recent = [...game.messages.contents].slice(-4).reverse();
        found = extractD20(recent);
      }
    }

    // ── Outcome animation (shared for both paths) ─────────────────────────────
    // Normalise the result into _crit/_fumb/_hit/_tot regardless of source:
    //   found           → Roll from dnd5e hook (arrives early, ideal)
    //   capturedWorkflow → MidiQOL workflow (arrives after full workflow)
    let _crit = false, _fumb = false, _hit = null, _tot = 0;
    let outcomeKnown = false;

    if (found) {
      const { roll: r0, term: t0 } = found;
      const d20 = t0.results?.[0]?.result ?? t0.total ?? 0;
      _tot  = r0.total ?? 0;
      _crit = d20 >= 20 || r0.isCritical;
      _fumb = d20 <= 1;
      _hit  = targetAC != null ? _tot >= targetAC : null;
      console.log(`[CombatStep] ${item.name}: d20=${d20} total=${_tot} AC=${targetAC} crit=${_crit} fumb=${_fumb} hit=${_hit}`);
      outcomeKnown = true;
    } else if (capturedWorkflow != null) {
      // MidiQOL exposes isCritical / isFumble / attackTotal / hitTargets directly.
      _tot  = capturedWorkflow.attackTotal ?? 0;
      _crit = capturedWorkflow.isCritical  ?? false;
      _fumb = capturedWorkflow.isFumble    ?? false;
      // hitTargets is a Set of canvas Token objects (or TokenDocuments); check both.
      const ht = capturedWorkflow.hitTargets;
      if (ht instanceof Set && ht.size > 0) {
        _hit = ht.has(target.document) || ht.has(target);
      } else {
        _hit = targetAC != null ? _tot >= targetAC : null;
      }
      console.log(`[CombatStep] ${item.name} (workflow): total=${_tot} AC=${targetAC} crit=${_crit} fumb=${_fumb} hit=${_hit}`);
      outcomeKnown = true;
    } else {
      console.warn("[CombatStep] Could not read d20 result for", item.name,
        "— skipping outcome animation.");
    }

    if (outcomeKnown) {
      // Outcome notification tells the GM the result at a glance.
      if (_crit) {
        notify("⚡ CRIT!", "#f59e0b");
        await animCrit(token);
      } else if (_fumb) {
        notify("💨 Fumble…", "#ef4444");
        await animFumble(token, target);
      } else if (_hit === false) {
        const acStr = targetAC != null ? ` (${_tot} vs ${targetAC})` : "";
        notify(`✗ Miss${acStr}`, "#64748b");
        notify(`${tName}: Dodged!`, "#64748b");
        const aCX = token.document.x+(token.document.width??1)*gs/2;
        const aCY = token.document.y+(token.document.height??1)*gs/2;
        const dCX = target.document.x+(target.document.width??1)*gs/2;
        const dCY = target.document.y+(target.document.height??1)*gs/2;
        await Promise.all([animMiss(token), animDodge(target, token)]);
        await rotateTo(target, aCX - dCX, aCY - dCY, 260);
      } else {
        const acStr = targetAC != null ? ` (${_tot} vs ${targetAC})` : "";
        notify(`✓ Hit${acStr}`, "#22c55e");
        await animHit(token);
      }
    }

    // ── MidiQOL sequential gate ───────────────────────────────────────────────
    // Block here until MidiQOL's full workflow (damage + saves + conditions) is
    // done.  For vanilla dnd5e this resolves immediately (no-op Promise).
    // Without this gate a Multiattack's second strike would start while MidiQOL
    // is still applying the first strike's effects — causing concurrent workflows
    // that interleave saves, conditions, and HP updates.
    await postWorkflow;
    window.__cavrilDeduping = false;   // lower dedup gate — full workflow complete
  }

  // 8. Attack loop ───────────────────────────────────────────────────────────
  // 5e multi-attack rules implemented here:
  //   • Each strike in a Multiattack may target a DIFFERENT creature.
  //   • Remaining walk movement may be spent BETWEEN attacks to close on a
  //     new target (remainingMoveBudget tracks how much is left).
  //   • If the current target dies mid-multiattack, check for:
  //       1. Another creature already within weapon range (free pivot).
  //       2. A creature reachable with leftover walk movement.
  //       3. No valid next target → multiattack ends early.
  //   • Crosshairs (setTarget) are updated before each individual attack so
  //     the GM always sees who is being attacked.

  // Remind the GM of any attack-modifying conditions (flagged in Phase 3.5).
  // dnd5e applies advantage/disadvantage automatically via active effects —
  // this line makes the condition visible in the chat log before dice fly.
  if (attackWarnings.length) {
    await say(
      `⚠️ ${actor.name}: ${attackWarnings.join(" · ")} — roll modified by dnd5e automatically.`,
      "#f59e0b"
    );
  }

  if (atkSeq.length > 1) {
    const seqLabel = atkSeq.map(i => i.name).join(" + ");
    await say(`Multiattack ×${atkSeq.length}: ${seqLabel}`, "#ef4444");
    await wait(pace * 0.5);
  }

  for (let i = 0; i < atkSeq.length; i++) {
    const item = atkSeq[i];

    // ── Target validation before each strike ─────────────────────────────
    // First attack always uses the target chosen in Phase 1-2.
    // Subsequent attacks re-check: if the target is dead, find a new one.
    if (i > 0 && isDeadToken(target)) {
      // Option A: a living token is already within weapon range AND in LOS —
      // free pivot.  Use nearest-cell footprint distance (matches dnd5e gate).
      const inRangeNow = allLiving.filter(t =>
        !isDeadToken(t) &&
        hasLOS(token, t) &&
        measureFt(token, t) <= weaponRange + ATTACK_SLACK_FT
      );

      if (inRangeNow.length) {
        target   = inRangeNow.reduce((best, t) => threatScore(t) >= threatScore(best) ? t : best);
        tName    = target.document.name;
        tX       = target.document.x + (target.document.width  ?? 1) * gs / 2;
        tY       = target.document.y + (target.document.height ?? 1) * gs / 2;
        targetAC = target.actor?.system?.attributes?.ac?.value ?? null;
        try { target.setTarget(true, { user: game.user, releaseOthers: true }); } catch (_) {}
        notify(`Pivoting — ${tName}!`, "#ef4444");

      // Option B: spend remaining walk movement to reach a new target (gridless).
      } else if (remainingMoveBudget > 0) {
        const liveCandidates = byThreat.filter(t => !isDeadToken(t));
        const nowC8 = {
          x: token.document.x + (token.document.width  ?? 1) * gs / 2,
          y: token.document.y + (token.document.height ?? 1) * gs / 2,
        };
        const budgetPx8 = remainingMoveBudget * gs;
        let nxtDone = false;

        for (const cand of liveCandidates) {
          const candC = {
            x: cand.document.x + (cand.document.width  ?? 1) * gs / 2,
            y: cand.document.y + (cand.document.height ?? 1) * gs / 2,
          };
          const nxtPos = findAttackPosPx(nowC8.x, nowC8.y, candC.x, candC.y, weaponRangePx, budgetPx8);
          if (!nxtPos) continue;

          notify("Moving to next target…", "#3b82f6");
          const distPx = nxtPos.distPx;
          if (nxtPos.waypoint) await placeAtPx(token, nxtPos.waypoint.x, nxtPos.waypoint.y);
          await placeAtPx(token, nxtPos.x, nxtPos.y);
          remainingMoveBudget = Math.max(0, Math.round((budgetPx8 - distPx) / gs));
          remainingMovePx     = Math.max(0, remainingMovePx - distPx);
          target   = cand;
          tName    = cand.document.name;
          tX       = candC.x;
          tY       = candC.y;
          targetAC = cand.actor?.system?.attributes?.ac?.value ?? null;
          try { cand.setTarget(true, { user: game.user, releaseOthers: true }); } catch (_) {}
          await say(`${actor.name} moves ${Math.round(distPx / gs * ftPerCell)}ft — ${tName} is next!`, "#ef4444");
          nxtDone = true;
          break;
        }

        if (!nxtDone) {
          await say(`${actor.name} — no more targets in reach. Multiattack ends.`, "#64748b");
          break;
        }

      // Option C: no movement budget and nothing in range — done.
      } else {
        await say(`${actor.name} — no more targets in reach. Multiattack ends.`, "#64748b");
        break;
      }
    }

    // Set crosshairs for this specific strike (may have pivoted above).
    try { target.setTarget(true, { user: game.user, releaseOthers: true }); } catch (_) {}

    const label = atkSeq.length > 1 ? `${item.name} (${i + 1}/${atkSeq.length})` : item.name;

    // ── Pre-attack LOS gate (hard veto) ────────────────────────────────────
    // Nearest-cell footprint distance — same metric dnd5e uses internally,
    // so a large-vs-small pair that is edge-touching passes correctly.
    // Verifies (a) still alive, (b) within weapon range, (c) clear LOS.
    {
      const gateOK = !isDeadToken(target)
        && measureFt(token, target) <= weaponRange + ATTACK_SLACK_FT
        && hasLOS(token, target);

      if (!gateOK) {
        // Redirect to any in-range, LOS-clear, living target.
        const redirectCandidates = allLiving.filter(t =>
          !isDeadToken(t) &&
          hasLOS(token, t) &&
          measureFt(token, t) <= weaponRange + ATTACK_SLACK_FT
        );
        if (redirectCandidates.length) {
          target   = redirectCandidates.reduce(
            (best, t) => threatScore(t) >= threatScore(best) ? t : best
          );
          tName    = target.document.name;
          tX       = target.document.x + (target.document.width  ?? 1) * gs / 2;
          tY       = target.document.y + (target.document.height ?? 1) * gs / 2;
          targetAC = target.actor?.system?.attributes?.ac?.value ?? null;
          try { target.setTarget(true, { user: game.user, releaseOthers: true }); } catch (_) {}
          notify(`Wall-blocked — redirecting attack to ${tName}`, "#f59e0b");
        } else if (i === 0) {
          await say(`${actor.name} — no valid target in range with clear LOS. Holding.`, "#64748b");
          return;
        } else {
          await say(`${actor.name} — no more valid targets in range. Multiattack ends.`, "#64748b");
          break;
        }
      }
    }

    // ── MidiQOL size-aware range boost ─────────────────────────────────────
    // MidiQOL validates range via centre-to-centre pixel distance.  When two
    // large tokens are positioned edge-to-edge (effectiveRingPx correctly
    // places them with bounding boxes just touching), their centres can be
    // further apart than the weapon's nominal reach — e.g. two 2×2 tokens
    // with 5 ft reach have centres 10 ft apart when adjacent.  MidiQOL then
    // rejects the attack as out-of-range even though measureFt (footprint
    // distance, same metric dnd5e uses) correctly shows 0 ft.
    // Fix: updateSource() boosts the item's range in-memory to the actual
    // centre distance so MidiQOL's check passes.  updateSource() edits
    // _source + resets the data model — no DB write, no persistence.
    // The finally block restores the original range regardless of errors,
    // so the live item is never left in a boosted state.
    {
      const _aw        = (token.document.width  ?? 1) * gs;
      const _tw        = (target.document.width ?? 1) * gs;
      const _centerFt  = (_aw + _tw) / 2 / gs * ftPerCell;
      const _origRangeFt = item.system?.range?.value ?? 5;
      const _boostTo   = _centerFt > _origRangeFt + ATTACK_SLACK_FT
        ? Math.ceil(_centerFt)
        : 0;
      if (_boostTo) {
        try {
          item.updateSource({"system.range.value": _boostTo});
          console.log(`[CombatStep] Range boost: ${item.name} ${_origRangeFt}ft → ${_boostTo}ft (centres ${_centerFt.toFixed(1)}ft apart)`);
        } catch (_e) {}
      }
      try {
        await doOneAttack(item, label);
      } finally {
        if (_boostTo) {
          try { item.updateSource({"system.range.value": _origRangeFt}); } catch (_e) {}
        }
      }
    }
    if (i < atkSeq.length - 1) await wait(pace);
  }
};

// ── Standalone entry ──────────────────────────────────────────────────────
(async () => {
  const tok = canvas.tokens?.controlled?.[0];
  if (!tok) { ui.notifications.warn("Select a token first."); return; }
  await window.CavrilCombatStep.run(tok, { pace: "fast" });
})();
