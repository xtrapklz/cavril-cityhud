// ─── CAVRIL: Reset Shadows to Current Time ─────────────────────────────────
//
// Paste this entire script into a Foundry macro (Type: Script) and run it.
// It deduplicates any accumulated shadow drawings, then does a full clean
// rebuild for the current game time. Safe to run multiple times.
// ─────────────────────────────────────────────────────────────────────────────

const scene = canvas.scene;
if (!scene) { ui.notifications.warn("[ShadowReset] No active scene."); return; }
if (!window.CavrilTools?.updateTOD) {
  ui.notifications.warn("[ShadowReset] Cavril importer is not loaded — open a Cavril scene and try again.");
  return;
}

// ── Step 1: collect ALL shadow drawings from the scene ──────────────────────
const allShadows = scene.drawings.contents.filter(d => d.flags?.world?.cavrilShadow);
const total = allShadows.length;
console.log(`[ShadowReset] Found ${total} shadow drawing(s) on scene.`);

if (total === 0) {
  ui.notifications.info("[ShadowReset] No shadows found — rebuilding from scratch for current time.");
} else {
  // ── Step 2: fingerprint each shadow and find duplicates ─────────────────
  // Building shadows key by buildingId (rebuilt from scene data, not stored geom).
  // Tree shadows key by position+size.
  // Wall/tower/gate/forest shadows key by their stored geometry (wallPts / basePts).
  const seen    = new Map();   // fp → first drawing id (the "canonical" one we keep)
  const toDelete = [];

  for (const d of allShadows) {
    const f  = d.flags.world;
    let fp;
    if (f.cavrilBuildingShadow) {
      fp = `bldg:${f.buildingId}`;
    } else if (f.cavrilTreeShadow) {
      // Trees: round position to nearest pixel so float drift doesn't split identical trees.
      fp = `tree:${Math.round(d.x)}:${Math.round(d.y)}:${Math.round(d.shape?.width || 0)}:${Math.round(d.shape?.height || 0)}`;
    } else if (f.cavrilWallShadow && f.wallPts?.length) {
      // Wall: first two points identify the edge uniquely (wall geometry is stable).
      const p0 = f.wallPts[0] || [], p1 = f.wallPts[1] || [];
      fp = `wall:${Math.round(p0[0])}:${Math.round(p0[1])}-${Math.round(p1[0])}:${Math.round(p1[1])}:${f.wallEdgeType || ''}`;
    } else if (f.basePts?.length) {
      // Tower / gate / forest polygon: first point + sort tier identifies uniquely.
      const p0 = f.basePts[0] || [];
      fp = `poly:${Math.round(p0[0])}:${Math.round(p0[1])}:${d.sort || 0}`;
    } else {
      fp = `unk:${d.id}`;  // unknown type — never merge
    }

    if (seen.has(fp)) {
      toDelete.push(d.id);  // duplicate — mark for deletion
    } else {
      seen.set(fp, d.id);
    }
  }

  const dupCount = toDelete.length;
  const keepCount = total - dupCount;
  console.log(`[ShadowReset] ${keepCount} unique shadows, ${dupCount} duplicate(s) to remove.`);

  if (dupCount > 0) {
    ui.notifications.info(`[ShadowReset] Removing ${dupCount} duplicate shadow(s)…`);
    await scene.deleteEmbeddedDocuments('Drawing', toDelete, { render: false });
    console.log(`[ShadowReset] Deleted ${dupCount} duplicate(s).`);
  }
}

// ── Step 3: resolve current time and season ─────────────────────────────────
const _date = (() => {
  // Hour always from raw worldTime — immune to fantasy calendar API quirks.
  const secs      = game.time.worldTime || 0;
  const totalHrs  = Math.floor(secs / 3600);
  const hour      = ((totalHrs % 24) + 24) % 24;

  // Month from Simple Calendar if available (respects custom month lengths for season).
  const sc = window.SimpleCalendar;
  if (sc?.api) {
    for (const fn of [
      () => sc.api.currentDateTime?.(),
      () => sc.api.currentDateTimeSimpleCalendar?.(),
      () => sc.api.timestampToDate?.(game.time.worldTime),
    ]) {
      try {
        const r = fn();
        if (r && Number.isFinite(r.month))
          return { month: r.month + 1, hour };
      } catch (_) {}
    }
  }
  // Fallback month: 30-day assumption (only affects season colour).
  const month = (Math.floor(totalHrs / 24 / 30) % 12) + 1;
  return { month, hour };
})();

const tod = _date.hour >=  6 && _date.hour <  9 ? 'DAWN'
          : _date.hour >=  9 && _date.hour < 18 ? 'DAY'
          : _date.hour >= 18 && _date.hour < 21 ? 'DUSK'
          : 'NIGHT';

const SEASON_MAP = {
   1: 'EARLY_WINTER',  2: 'MID_WINTER',  3: 'LATE_WINTER',
   4: 'EARLY_SPRING',  5: 'MID_SPRING',  6: 'LATE_SPRING',
   7: 'EARLY_SUMMER',  8: 'MID_SUMMER',  9: 'LATE_SUMMER',
  10: 'EARLY_AUTUMN', 11: 'MID_AUTUMN', 12: 'LATE_AUTUMN',
};
const season = SEASON_MAP[_date.month] || 'MID_SUMMER';

console.log(`[ShadowReset] Rebuilding: hour=${_date.hour} tod=${tod} season=${season}`);
ui.notifications.info(`[ShadowReset] Rebuilding shadows — ${tod}, hour ${_date.hour}…`);

// ── Step 4: full rebuild including tree shadows ─────────────────────────────
// updateTOD(scene, timeOfDay, hour, season, rebuildTreeShadows)
// Passing rebuildTreeShadows=true so trees are included in the reset.
try {
  await window.CavrilTools.updateTOD(scene, tod, _date.hour, season, true);
  ui.notifications.info("✅ [ShadowReset] Shadows reset to current time.");
  console.log("[ShadowReset] Done.");
} catch (e) {
  ui.notifications.error("[ShadowReset] updateTOD failed — see console.");
  console.error("[ShadowReset] updateTOD error:", e);
}
