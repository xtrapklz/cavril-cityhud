/* eslint-disable */
/**
 * Cavril Exit Encounter v2 — module wrapper
 * ============================================================================
 * Returns from an encounter scene to the overworld.
 *
 * v2 — persists battlefield outcomes back to citizens before tearing the
 * scene down:
 *   • Reads each encounter token's actor HP
 *   • If actor HP went to 0 → tags the citizen `status:killed`
 *   • If HP fell below 50% max → tags the citizen `status:wounded`
 * These tags read by the headless sim engine + downstream UIs.
 *
 * Inventory + actor-level state already lives on the actor (which is world-
 * scoped, not scene-scoped) so HP-bar changes and items picked up during
 * combat survive the scene delete automatically. The wounded/killed tags
 * are the additional bookkeeping CityHUD needs to reflect the outcome.
 * ============================================================================
 */

window.CavrilTools = window.CavrilTools || {};
window.CavrilTools.exitEncounter = async function() {
  const encScene = canvas.scene;
  if (!encScene) { ui.notifications.error("No active scene"); return; }

  const isEncounter = encScene.getFlag("world", "isEncounterScene");
  if (!isEncounter) {
    ui.notifications.error("This is not an encounter scene. Use on a scene created by Build Scene.");
    return;
  }

  const overworldId = encScene.getFlag("world", "overworldSceneId");
  const returnView = encScene.getFlag("world", "viewCenter");

  const overworld = game.scenes.get(overworldId);
  if (!overworld) {
    ui.notifications.error("Overworld scene not found. Was it deleted?");
    return;
  }

  // Blur overlay so the GM sees we're working.
  const overlay = document.createElement("div");
  overlay.id = "cavril-exit-overlay";
  overlay.innerHTML = `<div style="position:fixed;inset:0;z-index:99999;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;transition:opacity 0.4s ease;">
    <div style="background:rgba(20,20,30,0.9);border:1px solid rgba(255,255,255,0.12);border-radius:14px;padding:32px 56px;color:#e8e4dc;font-family:Signika,sans-serif;text-align:center;box-shadow:0 12px 48px rgba(0,0,0,0.6);">
      <div style="font-size:20px;font-weight:700;margin-bottom:8px;">🏰 Returning to Overworld</div>
      <div style="font-size:13px;opacity:0.7;">Persisting changes...</div>
    </div></div>`;
  document.body.appendChild(overlay);
  await new Promise(r => setTimeout(r, 80));

  // ── Persist encounter outcomes to CityHUD citizens ──────────────────────
  // For every encounter token tagged with a citizenId, read the actor's
  // current HP and tag the citizen as wounded / killed accordingly.
  let woundedCount = 0, killedCount = 0;
  try {
    let store = window.cityhud?.app?.store;
    if (store) {
      let mutations = [];
      for (const tok of encScene.tokens.contents) {
        let cid = tok.flags?.world?.citizenId;
        if (!cid) continue;
        let actor = tok.actor || (tok.actorId ? game.actors.get(tok.actorId) : null);
        if (!actor) continue;
        let hp = actor.system?.attributes?.hp;
        let cur = parseInt(hp?.value);
        let max = parseInt(hp?.max);
        if (!Number.isFinite(cur) || !Number.isFinite(max) || max <= 0) continue;
        let existingTags = (store.getTagsForCitizen(cid) || []).map(t => String(t).toLowerCase());
        if (cur <= 0) {
          if (!existingTags.includes("status:killed")) {
            mutations.push({ kind: "tag.add", citizenId: cid, tag: "status:killed" });
            killedCount++;
          }
        } else if (cur < max * 0.5) {
          if (!existingTags.includes("status:wounded")) {
            mutations.push({ kind: "tag.add", citizenId: cid, tag: "status:wounded" });
            woundedCount++;
          }
        }
      }
      if (mutations.length > 0) await store.commitBatch(mutations);
    }
  } catch (e) {
    console.warn("[ExitEncounter v2] tag-persist failed:", e);
  }

  // ── Switch to overworld ──────────────────────────────────────────────────
  await overworld.activate();
  await overworld.view();

  if (returnView) {
    setTimeout(() => {
      canvas.animatePan({ x: returnView.x, y: returnView.y, duration: 500 });
    }, 500);
  }

  // ── Delete the encounter scene (disposable; Build Scene regenerates) ────
  // Tokens on the encounter scene go with it. The user explicitly asked
  // to "return to the overworld without any tokens" — deleting the scene
  // is what does that. Actors themselves are world-scoped and survive.
  try {
    await encScene.delete();
  } catch(e) { console.error("[ExitEncounter v2] scene delete failed", e); }

  const el = document.getElementById("cavril-exit-overlay");
  if (el) { el.firstElementChild.style.opacity = "0"; setTimeout(() => el.remove(), 400); }

  let bits = [];
  if (woundedCount > 0) bits.push(`${woundedCount} wounded`);
  if (killedCount > 0) bits.push(`${killedCount} killed`);
  let suffix = bits.length ? ` — ${bits.join(", ")} tagged` : "";
  ui.notifications.info(`🏰 Returned to overworld${suffix}.`);
};
