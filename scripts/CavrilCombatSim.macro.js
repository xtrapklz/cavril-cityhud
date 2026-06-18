/**
 * Cavril — Combat Sim Loop
 * ============================================================================
 * Click to START.  Click again to STOP.
 *
 * Requires:
 *   • CavrilCombatStep macro pasted/run first (registers window.CavrilCombatStep)
 *   • An active combat in Foundry's combat tracker (game.combat)
 *
 * Player-owned tokens → posts "Waiting…" in chat, pauses until GM clicks
 *   Next Turn in the tracker.
 * NPC tokens → CavrilCombatStep.run(token) fires automatically.
 * Dead tokens (HP ≤ 0 or Defeated flag) → skipped.
 * ============================================================================
 *
 * ── PACE ─────────────────────────────────────────────────────────────────
 * Controls the pause between major combat beats so you can narrate along.
 *
 *   "fast"     300 ms — brisk, good for scouting how a fight plays out
 *   "medium"   700 ms — default, comfortable narration pace
 *   "slow"    1200 ms — deliberate; each phase waits for your narration
 *   <number>        — exact milliseconds for fine-tuning
 *
 * Change SIM_PACE below and re-run the macro.
 * ─────────────────────────────────────────────────────────────────────────
 */
const SIM_PACE = "medium";   // ← CHANGE THIS to tune pacing

(async () => {

  // Toggle stop ──────────────────────────────────────────────────────────────
  if (window.CavrilSimRunning) {
    window.CavrilSimRunning = false;
    ui.notifications.info("[CombatSim] Stopping after current turn.");
    return;
  }

  // Pre-flight ───────────────────────────────────────────────────────────────
  if (!game.combat?.started) {
    ui.notifications.warn("[CombatSim] Start combat in the tracker first.");
    return;
  }
  if (!window.CavrilCombatStep?.run) {
    ui.notifications.warn("[CombatSim] Run the CombatStep macro first to register it.");
    return;
  }

  const wait = ms => new Promise(r => setTimeout(r, ms));

  async function post(html, color = "#a78bfa") {
    await ChatMessage.create({
      content: `<div style="padding:4px 10px;border-left:3px solid ${color};
                font-style:italic;font-size:.9em;">${html}</div>`,
    });
  }

  const isDead = c => {
    if (!c.actor || c.defeated) return true;
    const hp = c.actor.system?.attributes?.hp;
    return hp ? hp.value <= 0 : false;
  };

  const isPC = c =>
    c.actor && game.users.some(u => !u.isGM && u.active && c.actor.testUserPermission(u, "OWNER"));

  // Wait until GM advances the tracker (player turn) ─────────────────────────
  function waitForNextTurn() {
    return new Promise(resolve => {
      let id;
      // Safety timeout — 5 minutes, in case GM forgets
      const timeout = setTimeout(() => { Hooks.off("updateCombat", id); resolve(); }, 300_000);
      id = Hooks.on("updateCombat", (_combat, changes) => {
        if ("turn" in changes || "round" in changes) {
          clearTimeout(timeout);
          Hooks.off("updateCombat", id);
          resolve();
        }
      });
    });
  }

  // ── Main loop ──────────────────────────────────────────────────────────────
  window.CavrilSimRunning = true;
  const combat = game.combat;
  const MAX_ROUNDS = 50;    // hard safety cap — prevents accidental infinite run
  let roundsRun = 0;

  ui.notifications.info("[CombatSim] Running — click again to stop.");
  await post(`⚔️ <strong>Combat Sim started</strong> — Round ${combat.round}`, "#22c55e");

  while (window.CavrilSimRunning && combat.started && roundsRun < MAX_ROUNDS) {

    const c = combat.combatant;
    if (!c) { await wait(400); continue; }

    // Skip dead combatants silently.
    if (isDead(c)) {
      await combat.nextTurn().catch(() => {});
      await wait(200);
      continue;
    }

    // Player turn — pause and wait for manual advance.
    if (isPC(c)) {
      await post(`🎮 <strong>${c.name}</strong> — your turn!`, "#3b82f6");
      await waitForNextTurn();
      if (!window.CavrilSimRunning) break;
      await wait(200);
      continue;
    }

    // NPC turn — resolve canvas token and run a full step.
    const tok = c.token?.object ?? canvas.tokens.get(c.tokenId);
    if (!tok) {
      await combat.nextTurn().catch(() => {});
      await wait(200);
      continue;
    }

    // Pan camera to the acting token.
    await canvas.animatePan({
      x:      tok.document.x + (tok.document.width  ?? 1) * canvas.scene.grid.size / 2,
      y:      tok.document.y + (tok.document.height ?? 1) * canvas.scene.grid.size / 2,
      scale:  canvas.stage.scale.x,
      duration: 350,
    }).catch(() => {});
    await wait(150);

    // Run the turn.  autoRoll bypasses the dnd5e config dialog so rolls
    // fire immediately without waiting for a human to click OK.
    // pace is forwarded so every beat inside the turn respects SIM_PACE.
    try {
      await window.CavrilCombatStep.run(tok, { autoRoll: true, pace: SIM_PACE });
    } catch (e) {
      console.error(`[CombatSim] Error on ${c.name}:`, e);
    }

    if (!window.CavrilSimRunning) break;
    await wait(400);    // brief pause between combatants

    // Clear any lingering targets so they don't bleed into the next combatant.
    try { game.user.updateTokenTargets([]); } catch (_) {}

    const wasLast = combat.turn >= combat.turns.length - 1;
    await combat.nextTurn().catch(() => {});
    await wait(250);

    if (wasLast) {
      roundsRun++;
      if (combat.started) await post(`🔄 <strong>Round ${combat.round}</strong>`, "#a78bfa");
    }
  }

  // ── Done ──────────────────────────────────────────────────────────────────
  window.CavrilSimRunning = false;
  const why = !combat.started    ? "combat ended"
            : roundsRun >= MAX_ROUNDS ? `hit ${MAX_ROUNDS}-round safety limit`
            :                           "manually stopped";
  await post(`🏁 <strong>Sim stopped</strong> — ${why} (${roundsRun} full rounds)`, "#64748b");
  ui.notifications.info(`[CombatSim] Stopped — ${why}.`);

})();
