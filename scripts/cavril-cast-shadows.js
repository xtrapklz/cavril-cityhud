/* eslint-disable */
/**
 * Cavril Cast Shadows v2 — module wrapper
 * ============================================================================
 * One-tap LOD: shadows + doors + windows + corner lines + phase tint.
 *
 * Wrapped in CavrilTools.castShadows so the CityHUD can trigger it
 * (toolbar button + hourly auto-cast on updateWorldTime).
 *
 * Pass {shiftHeld:true} in opts to force full-scene mode without an event.
 *
 * SHADOW ANGLE DESIGN (v3 — rogue gameplay):
 *   The four phases now point at the four cardinal directions on screen,
 *   evenly spaced 90° apart. This makes shadow play a navigable mechanic
 *   for stealth — the GM advances the clock, the cover map rotates a
 *   quarter turn, the rogue has fresh hiding lines.
 *
 *     dawn   →  shadows point LEFT  (sun rising in the east)
 *     midday →  shadows point DOWN  (sun nearly overhead, short)
 *     dusk   →  shadows point RIGHT (sun setting in the west)
 *     night  →  shadows point UP    (moonlight from below, medium length)
 *
 *   sunMult controls shadow length: long at dawn/dusk, short at midday,
 *   medium at night. This matches realistic sun-angle behaviour.
 * ============================================================================
 */

window.CavrilTools = window.CavrilTools || {};
window.CavrilTools.castShadows = async function(opts = {}) {
  const scene = canvas.scene;
  if (!scene) { ui.notifications.error("No active scene"); return; }

  // Shift-click for full-scene mode. Hourly auto-fire passes opts.auto=true
  // so it can be quieter in the console.
  const shiftHeld = !!(opts.shiftHeld || globalThis.event?.shiftKey);
  const MODE = shiftHeld ? "full" : "radius";
  const RADIUS_FT = 300;
  const CHUNK = 100;
  const DELAY = 50;

  // ── SHADOW ANGLES (v4 — continuous, hour-granular) ──────────────────────
  // Geometry is now a smooth function of hour-of-day:
  //
  //   sunAngle = (3 - h/6) * π/2     →  full 360° rotation over 24h
  //     h=0  (midnight): -π/2 (up)          h=6  (sunrise):  π   (left)
  //     h=12 (noon):     π/2 (down)         h=18 (sunset):   0   (right)
  //
  //   sunMult = 3.5 - 2.5 * sin((h-6) * π/12)   →  shadow length
  //     h=0  (midnight): 6.0   (long — moon overhead, ambient stretched)
  //     h=6  (sunrise):  3.5   (medium)
  //     h=12 (noon):     1.0   (short — sun overhead)
  //     h=18 (sunset):   3.5   (medium)
  //
  // Colors + tint still bucket to 4 phases (dawn/midday/dusk/night) for
  // visual variety; only the geometry is continuous. The rogue gets a
  // genuinely different cover map every hour — 24 distinct shadow
  // directions instead of 4.
  const PHASE_COLORS = {
    dawn:   { shadowColor: "#2a2a38", tintColor: "#ffb088", tintAlpha: 0.16 },
    midday: { shadowColor: "#2a2a2a", tintColor: null,      tintAlpha: 0    },
    dusk:   { shadowColor: "#382a2a", tintColor: "#d88a50", tintAlpha: 0.24 },
    night:  { shadowColor: "#1a1e2a", tintColor: "#1a2848", tintAlpha: 0.45 }
  };
  function bucketForHour(h) {
    if (h >= 5  && h < 10) return "dawn";
    if (h >= 10 && h < 16) return "midday";
    if (h >= 16 && h < 20) return "dusk";
    return "night";
  }
  function computePhase(rawHour) {
    const h = ((Number(rawHour) % 24) + 24) % 24;
    const sunAngle = (3 - h / 6) * (Math.PI / 2);
    // × 1.30 makes all shadows ~30% longer across the clock — noon goes
    // from 1.0 → 1.3, dawn/dusk 3.5 → 4.55, midnight 6.0 → 7.8.
    const sunMult  = (3.5 - 2.5 * Math.sin((h - 6) * Math.PI / 12)) * 1.30;
    const bucket = bucketForHour(h);
    const c = PHASE_COLORS[bucket];
    return {
      sunAngle,
      sunMult,
      shadowColor: c.shadowColor,
      shadowAlpha: 1.0,
      tintColor: c.tintColor,
      tintAlpha: c.tintAlpha,
      bucket
    };
  }
  const SEASONS_GRASS = { spring: "#82b14b", summer: "#5b7a40", autumn: "#8a7a3a", winter: "#b0b6bc" };
  // Full seasonal terrain table — used by the seasonal-recolor pass below.
  // Mirrors the table baked into the importer. Adding a season here is
  // enough to make castShadows recolor everything appropriately.
  const SEASONS_TERRAIN = {
    spring: { GRASS: "#82b14b", LAWN_TEXTURE_TYPE: "#8eba52", WHEAT: "#a89a4a", TILLED: "#6a4830", FOREST: "#3d5a28", WATER: "#4595af", RIVER: "#4595af" },
    summer: { GRASS: "#5b7a40", LAWN_TEXTURE_TYPE: "#67854a", WHEAT: "#c19a52", TILLED: "#7a5a40", FOREST: "#324726", WATER: "#3a7387", RIVER: "#3a7387" },
    autumn: { GRASS: "#8a7a3a", LAWN_TEXTURE_TYPE: "#a08a44", WHEAT: "#8a6a2a", TILLED: "#5a3a20", FOREST: "#a06820", WATER: "#456870", RIVER: "#456870" },
    winter: { GRASS: "#b0b6bc", LAWN_TEXTURE_TYPE: "#c0c5cb", WHEAT: "#a09a90", TILLED: "#7a7570", FOREST: "#283238", WATER: "#6a7681", RIVER: "#6a7681" }
  };
  const Z_SHADOW = 3, Z_LINES = 500, Z_DOORS = 600, Z_PHASE_TINT = 900;

  // ── Calendar read ────────────────────────────────────────────────────────
  function seasonForMonth(m) {
    if (m >= 3 && m <= 5) return "spring";
    if (m >= 6 && m <= 8) return "summer";
    if (m >= 9 && m <= 11) return "autumn";
    return "winter";
  }

  let currentHour, activeSeason;
  try {
    const tc = game.time?.components;
    if (tc && tc.hour != null && tc.month != null) {
      currentHour  = tc.hour;
      activeSeason = seasonForMonth(tc.month + 1);
    } else {
      // Older scenes stored only a bucket name; coerce to a representative hour
      // so the geometry calculation still has something to work with.
      const bucket = scene.getFlag("world", "activePhase") || "midday";
      currentHour  = bucket === "dawn" ? 7 : bucket === "midday" ? 12 : bucket === "dusk" ? 18 : 23;
      activeSeason = scene.getFlag("world", "activeSeason") || "summer";
    }
  } catch (e) {
    currentHour  = 12;
    activeSeason = scene.getFlag("world", "activeSeason") || "summer";
  }

  const phaseDef = computePhase(currentHour);
  const activePhase = phaseDef.bucket;
  const grassColor = SEASONS_GRASS[activeSeason] || SEASONS_GRASS.summer;

  const gridSize = scene.grid?.size ?? 100;
  const gridDist = scene.grid?.distance ?? 5;
  const pxPerFt = gridSize / gridDist;
  const radiusPx = RADIUS_FT * pxPerFt;
  const radiusPxSq = radiusPx * radiusPx;

  if (!opts.auto) console.log(`[CastShadows v3] phase=${activePhase}, season=${activeSeason}, mode=${MODE}`);

  // v65+: overworld scenes skip door/window/corner detail. Only shadows + tint.
  const sceneMode = scene.getFlag("world", "sceneMode") || "encounter";
  const isOverworld = (sceneMode === "overworld");

  // ── Blur overlay ─ skipped when auto-fired by the hour hook so the GM
  //    doesn't get a "scene updating" overlay every hour while playing.
  let overlay = null;
  if (!opts.auto) {
    overlay = document.createElement("div");
    overlay.id = "cavril-update-overlay";
    overlay.innerHTML = `
      <div style="
        position:fixed; inset:0; z-index:99999;
        backdrop-filter:blur(12px); -webkit-backdrop-filter:blur(12px);
        background:rgba(0,0,0,0.35);
        display:flex; align-items:center; justify-content:center;
        transition:opacity 0.3s ease;
      ">
        <div style="
          background:rgba(20,20,30,0.85); border:1px solid rgba(255,255,255,0.12);
          border-radius:12px; padding:28px 48px;
          color:#e8e4dc; font-family:Signika,sans-serif; text-align:center;
          box-shadow:0 8px 32px rgba(0,0,0,0.5);
        ">
          <div style="font-size:18px; font-weight:600; margin-bottom:6px;">
            ☀ Updating Scene
          </div>
          <div style="font-size:13px; opacity:0.7;">
            ${activePhase} · ${activeSeason} · ${MODE === "full" ? "full scene" : RADIUS_FT + "ft radius"}
          </div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    await new Promise(r => setTimeout(r, 60));
  }

  // ── View center ──────────────────────────────────────────────────────────
  function getViewCenter() {
    try {
      const rect = canvas.app.renderer.screen;
      const sc = new PIXI.Point(rect.width / 2, rect.height / 2);
      const wc = canvas.stage.toLocal(sc);
      if (Number.isFinite(wc.x) && Number.isFinite(wc.y)) return { x: wc.x, y: wc.y };
    } catch (e) { /* */ }
    return scene._viewPosition || { x: scene.dimensions.width/2, y: scene.dimensions.height/2 };
  }
  const viewCenter = getViewCenter();

  // ── Helpers ──────────────────────────────────────────────────────────────
  function mixColor(hex1, hex2, ratio) {
    const c1 = parseInt(hex1.slice(1), 16), c2 = parseInt(hex2.slice(1), 16);
    const r = Math.round(((c1>>16)&255)*(1-ratio) + ((c2>>16)&255)*ratio);
    const g = Math.round(((c1>>8)&255)*(1-ratio) + ((c2>>8)&255)*ratio);
    const b = Math.round((c1&255)*(1-ratio) + (c2&255)*ratio);
    return "#" + ((r<<16)|(g<<8)|b).toString(16).padStart(6, "0");
  }
  const softShadowColor = mixColor(phaseDef.shadowColor, grassColor, 0.30);

  function flattenPts(arr) { const out = []; for (const p of arr) out.push(p[0], p[1]); return out; }

  function createDrawing(flatPts, type, fillC, fillA, strokeC, strokeW, strokeA, z, flags = {}) {
    if (!flatPts || flatPts.length < 4) return null;
    const cp = [];
    for (let i = 0; i < flatPts.length; i++) {
      const p = Number(flatPts[i]);
      if (!Number.isFinite(p)) return null;
      cp.push(p);
    }
    if (cp.length % 2 !== 0) return null;
    let x0=Infinity, y0=Infinity, x1=-Infinity, y1=-Infinity;
    for (let i=0; i<cp.length; i+=2) {
      if (cp[i]<x0) x0=cp[i]; if (cp[i+1]<y0) y0=cp[i+1];
      if (cp[i]>x1) x1=cp[i]; if (cp[i+1]>y1) y1=cp[i+1];
    }
    const rp = [];
    for (let i=0; i<cp.length; i+=2) rp.push(cp[i]-x0, cp[i+1]-y0);
    return {
      x: x0, y: y0,
      shape: { type, width: Math.max(x1-x0,1), height: Math.max(y1-y0,1), points: rp },
      fillType: fillA > 0 ? 1 : 0, fillColor: fillC || "#000000", fillAlpha: fillA,
      strokeColor: strokeC, strokeWidth: strokeW, strokeAlpha: strokeA,
      z, sort: z, flags
    };
  }

  function getExtrudedShadow(pts, offX, offY) {
    if (!pts || pts.length < 3) return pts;
    let area = 0;
    for (let i = 0; i < pts.length; i++) area += (pts[i][0]*pts[(i+1)%pts.length][1] - pts[(i+1)%pts.length][0]*pts[i][1]);
    let wp = [...pts]; if (area/2 < 0) wp.reverse();
    const n = wp.length, mv = [];
    for (let i = 0; i < n; i++) {
      const p1=wp[i], p2=wp[(i+1)%n], dx=p2[0]-p1[0], dy=p2[1]-p1[1];
      mv.push((dy*offX + (-dx)*offY) > 0);
    }
    const sp = [];
    for (let i = 0; i < n; i++) {
      const prev=(i-1+n)%n, p=wp[i];
      if (mv[i]) {
        if (!mv[prev]) { sp.push([p[0],p[1]]); sp.push([p[0]+offX,p[1]+offY]); }
        else sp.push([p[0]+offX,p[1]+offY]);
      } else {
        if (mv[prev]) { sp.push([p[0]+offX,p[1]+offY]); sp.push([p[0],p[1]]); }
        else sp.push([p[0],p[1]]);
      }
    }
    if (sp.length > 0) sp.push(sp[0]);
    return sp;
  }

  function subdivideAndNotchStochastic(pts, stepPx, depthPx) {
    if (!pts || pts.length < 2) return pts;
    const out = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const p1=pts[i], p2=pts[i+1], dx=p2[0]-p1[0], dy=p2[1]-p1[1];
      const len = Math.hypot(dx, dy);
      out.push(p1);
      if (len === 0 || len < stepPx * 1.5) continue;
      const bumps = Math.floor(len / stepPx);
      const ux=dx/len, uy=dy/len, nx=-uy, ny=ux;
      const so = (len - bumps*stepPx) / 2;
      for (let b = 0; b < bumps; b++) {
        const sT=so+b*stepPx, eT=sT+stepPx;
        const sx=p1[0]+ux*sT, sy=p1[1]+uy*sT, ex=p1[0]+ux*eT, ey=p1[1]+uy*eT;
        if (Math.random() > 0.30) {
          const d = (Math.random()>0.5?1:-1), nX=nx*depthPx*d, nY=ny*depthPx*d;
          out.push([sx,sy],[sx+nX,sy+nY],[ex+nX,ey+nY],[ex,ey]);
        } else out.push([ex,ey]);
      }
    }
    out.push(pts[pts.length-1]);
    return out;
  }

  function buildEdgeShadows(coords, offX, offY) {
    if (!coords || coords.length < 2) return [];
    const cl = coords[0][0]===coords[coords.length-1][0] && coords[0][1]===coords[coords.length-1][1];
    const w = cl ? coords.slice(0,-1) : coords;
    if (w.length < 2) return [];
    let area = 0;
    if (cl) for (let i=0;i<w.length;i++){const a=w[i],b=w[(i+1)%w.length]; area+=a[0]*b[1]-b[0]*a[1];}
    const cw = area > 0;
    const quads = [], ec = cl ? w.length : w.length-1;
    for (let i = 0; i < ec; i++) {
      const a=w[i], b=w[(i+1)%w.length], dx=b[0]-a[0], dy=b[1]-a[1];
      const onx=cw?-dy:dy, ony=cw?dx:-dx;
      if (cl ? (onx*-offX+ony*-offY)>0 : true)
        quads.push([a[0],a[1],b[0],b[1],b[0]+offX,b[1]+offY,a[0]+offX,a[1]+offY,a[0],a[1]]);
    }
    return quads;
  }

  function getPerspectivePoly(p1, p2, cx, cy, t, wPx, sBot, sTop) {
    const dx=p2[0]-p1[0], dy=p2[1]-p1[1], el=Math.hypot(dx,dy);
    if (el===0) return null;
    const ux=dx/el, uy=dy/el;
    const mx=p1[0]+dx*t, my=p1[1]+dy*t;
    const o1x=mx-ux*(wPx/2), o1y=my-uy*(wPx/2), o2x=mx+ux*(wPx/2), o2y=my+uy*(wPx/2);
    return [
      cx+(o1x-cx)*sBot, cy+(o1y-cy)*sBot,
      cx+(o2x-cx)*sBot, cy+(o2y-cy)*sBot,
      cx+(o2x-cx)*sTop, cy+(o2y-cy)*sTop,
      cx+(o1x-cx)*sTop, cy+(o1y-cy)*sTop
    ];
  }

  function pickDoorEdges(edges) {
    if (!edges || edges.length === 0) return [];
    const perimFt = edges.reduce((s,e)=>s+e.len,0) / pxPerFt;
    const max = perimFt < 80 ? 1 : 2;
    const chosen = [];
    for (const e of edges) {
      if (chosen.length >= max) break;
      const dx=e.p2[0]-e.p1[0], dy=e.p2[1]-e.p1[1], l=Math.hypot(dx,dy)||1;
      const nx=dx/l, ny=dy/l;
      let par = false;
      for (const c of chosen) {
        const cdx=c.p2[0]-c.p1[0], cdy=c.p2[1]-c.p1[1], cl=Math.hypot(cdx,cdy)||1;
        if (Math.abs(nx*(cdx/cl)+ny*(cdy/cl)) > 0.9) { par=true; break; }
      }
      if (!par) chosen.push(e);
    }
    return chosen;
  }

  // ── Seasonal terrain recolor ──────────────────────────────────────────
  // Repaints every terrain drawing to match the current season. Cast
  // Shadows owns "is everything visually consistent with the world
  // clock?", so this runs every time it's called (including the
  // auto-fire on hour change).
  //
  // Why color-based detection instead of the flag-based approach? The
  // importer stores `terrainType: bgType` where bgType defaults to
  // "GRASS" when the source GeoJSON omits backgroundType. For water/
  // river features that DON'T have backgroundType set, the flag ends
  // up "GRASS" even though the fill is correctly water-blue. A flag-
  // based recolor would then repaint water as grass — disaster.
  //
  // The fillColor on import IS reliable (the importer special-cases
  // water/river even when the bgType flag is wrong). So we reverse-
  // lookup: for each terrain drawing, find which (terrainType,
  // any-season) palette entry its current fillColor matches, then
  // repaint to the SAME terrain type in the ACTIVE season.
  //
  // Side benefit: this works on any city imported with any importer
  // version, regardless of how the terrainType flag was populated.
  let nRecolored = 0;
  try {
    // Build reverse lookup: lower-case color → terrain type. Every
    // (season × type) pair maps to a unique color across the whole table.
    const COLOR_TO_TYPE = new Map();
    for (const palette of Object.values(SEASONS_TERRAIN)) {
      for (const [type, color] of Object.entries(palette)) {
        COLOR_TO_TYPE.set(String(color).toLowerCase(), type);
      }
    }
    const seasonPalette = SEASONS_TERRAIN[activeSeason] || SEASONS_TERRAIN.summer;
    const updates = [];
    for (const dwg of scene.drawings.contents) {
      const f = dwg.flags?.world;
      if (!f?.isTerrain) continue;
      const curColor = String(dwg.fillColor || "").toLowerCase();
      if (!curColor) continue;
      // Identify terrain type by reverse-lookup against current color.
      // If color isn't in the palette, the drawing has been hand-edited
      // or comes from a different art system — leave it alone.
      let resolvedType = COLOR_TO_TYPE.get(curColor);
      if (!resolvedType) {
        // Fallback: trust the flag IF the flag's type is in our palette.
        // This catches the case where a season-skipped drawing has a
        // custom-ish fill but the flag is correct.
        const tt = String(f.terrainType || "").toUpperCase();
        if (seasonPalette[tt]) resolvedType = tt;
      }
      if (!resolvedType) continue;
      const target = seasonPalette[resolvedType];
      if (!target) continue;
      if (curColor === target.toLowerCase()) continue;
      updates.push({ _id: dwg.id, fillColor: target });
    }
    if (updates.length > 0) {
      const CHUNK_T = 200;
      for (let i = 0; i < updates.length; i += CHUNK_T) {
        try { await scene.updateEmbeddedDocuments("Drawing", updates.slice(i, i + CHUNK_T)); }
        catch (e) { console.warn("[CastShadows v4] terrain recolor chunk failed:", e); }
      }
      nRecolored = updates.length;
    }
    // Scene background: matches the GRASS color of the active season.
    // Only nudge if it's currently set to a SEASONS_GRASS color
    // (avoid clobbering hand-customized backgrounds).
    const grassValues = Object.values(SEASONS_GRASS).map(c => c.toLowerCase());
    const curBg = String(scene.backgroundColor || "").toLowerCase();
    if (curBg && grassValues.includes(curBg) && curBg !== grassColor.toLowerCase()) {
      try { await scene.update({ backgroundColor: grassColor }); }
      catch (e) { /* defensive — scene update can race with view */ }
    }
  } catch (e) {
    console.warn("[CastShadows v4] seasonal recolor pass failed:", e);
  }

  const outlinesById = new Map();
  const wallsAndFences = [];
  const detailByBuildingId = new Map();
  const existingShadowIds = [];
  const existingPhaseTintIds = [];

  for (const dwg of scene.drawings.contents) {
    const f = dwg.flags?.world;
    if (!f) continue;
    if (f.isShadow || f.isBuildingShadow || f.isWallShadow || f.isFenceShadow) {
      existingShadowIds.push(dwg.id); continue;
    }
    if (f.isPhaseTint) { existingPhaseTintIds.push(dwg.id); continue; }
    if (f.isBuildingOutline && f.srcCoords && f.buildingId != null) {
      outlinesById.set(f.buildingId, dwg); continue;
    }
    if ((f.isWall || f.isFence) && f.srcCoords) { wallsAndFences.push({f}); continue; }
    if ((f.isDoor || f.isWindow || f.isBuildingCornerLine) && f.buildingId) {
      if (!detailByBuildingId.has(f.buildingId)) detailByBuildingId.set(f.buildingId, []);
      detailByBuildingId.get(f.buildingId).push(dwg);
    }
  }

  if (outlinesById.size === 0) {
    if (overlay) overlay.remove();
    if (!opts.auto) ui.notifications.error("No building outlines. Import with v64+ first.");
    return;
  }

  const inRangeIds = new Set(), outRangeIds = new Set();
  for (const [bId, dwg] of outlinesById) {
    const f = dwg.flags.world;
    const cx = f.srcCx ?? (dwg.x + (dwg.shape?.width??0)/2);
    const cy = f.srcCy ?? (dwg.y + (dwg.shape?.height??0)/2);
    const dx = cx - viewCenter.x, dy = cy - viewCenter.y;
    if (MODE === "full" || dx*dx + dy*dy <= radiusPxSq) inRangeIds.add(bId);
    else outRangeIds.add(bId);
  }

  const toDelete = [...existingShadowIds, ...existingPhaseTintIds];
  for (const bId of outRangeIds) {
    const arr = detailByBuildingId.get(bId);
    if (arr) for (const d of arr) toDelete.push(d.id);
  }

  const toCreate = [];
  const pSC = "#000000", pSW = 1, pSA = 0.5;
  let nShadow = 0, nDetail = 0, nSkipDetail = 0;

  for (const bId of inRangeIds) {
    const outline = outlinesById.get(bId);
    const f = outline.flags.world;
    if (!f.srcCoords) continue;

    const cx = f.srcCx, cy = f.srcCy;
    const FT = f.srcFtToPx || pxPerFt;
    const coords = f.srcCoords;
    const stories = f.srcStories || 1;

    // Detect pier/deck building types — flat waterfront structures.
    const _PIER_KW = ["PIER","DOCK","DOCKYARD","WHARF","JETTY","QUAY",
                       "HARBOR","HARBOUR","LANDING","GANGWAY","BOARDWALK"];
    const btype = String(f.buildingType || "").toUpperCase();
    const isPier = _PIER_KW.some(k => btype.includes(k));

    // Overworld shadow-length curve: raised floor so noon shadows have
    // real presence at settlement scale (even small 1-story buildings
    // cast a visible shadow instead of a sub-pixel smear).
    //
    //   encounter sunMult at noon:     1.30   →  5 px  (20px grid, 1 story)
    //   overworld effSunMult at noon:  3.68   → 15 px  (≈3× longer, clearly visible)
    //   overworld effSunMult at midnight: 7.58 → 30 px (moderate, won't cover neighbors)
    //
    // The old × 0.25 overworldScale is removed — it cancelled out the raised
    // floor and produced sub-pixel (<4 px) shadows that never appeared.
    let effSunMult = phaseDef.sunMult;
    if (isOverworld) {
      // Linear rescale: keeps noon reasonably short, midnight not excessive.
      // formula: effective = base * 0.6 + 2.9
      effSunMult = phaseDef.sunMult * 0.6 + 2.9;
    }
    // Piers/docks are flat at water level — their shadow hugs the deck
    // tightly (0.25× normal) rather than projecting across neighbouring
    // buildings. The shorter offset with tight density gives a subtle
    // depth cue without a long streaking shadow.
    const pierScale = isPier ? 0.25 : 1.0;
    const shadowDist = stories * effSunMult * FT * pierScale;
    const sOffX = Math.cos(phaseDef.sunAngle) * shadowDist;
    const sOffY = Math.sin(phaseDef.sunAngle) * shadowDist;

    if (isOverworld) {
      // Piers on overworld: same shifted-polygon approach but already
      // short via pierScale — no further reduction needed.
      const shifted = coords.map(([x,y]) => [x + sOffX, y + sOffY]);
      const sPts = flattenPts(shifted); sPts.push(sPts[0], sPts[1]);
      const dwg = createDrawing(sPts, "p", softShadowColor, 1.0, "#000", 0, 0, Z_SHADOW,
        { world: { isShadow: true, isBuildingShadow: true, buildingId: bId, phase: activePhase } });
      if (dwg) { toCreate.push(dwg); nShadow++; }
    } else {
      // Encounter piers: use the extruded-shadow shape (same as buildings)
      // but skip the stochastic notch since piers have straight plank edges.
      // Normal buildings keep their notch/jitter for a hand-drawn feel.
      const shadowBase = getExtrudedShadow(coords, sOffX, sOffY);
      if (shadowBase && shadowBase.length >= 3) {
        const shadowPts = isPier
          ? flattenPts(shadowBase)   // tight straight edge, no notch
          : flattenPts(subdivideAndNotchStochastic(shadowBase, 4.0*FT, 0.2*FT));
        const dwg = createDrawing(shadowPts, "p", softShadowColor, phaseDef.shadowAlpha, "#000", 0, 0, Z_SHADOW,
          { world: { isShadow: true, isBuildingShadow: true, buildingId: bId, phase: activePhase } });
        if (dwg) { toCreate.push(dwg); nShadow++; }
      }
    }

    if (isOverworld) continue;
    if (detailByBuildingId.has(bId)) { nSkipDetail++; continue; }

    const edges = f.srcValidEdges;
    const trimColor = f.srcTrimColor;
    const centerColor = f.srcCenterColor;
    if (!edges || edges.length === 0 || !trimColor || !centerColor) continue;

    const doorColor   = mixColor(trimColor,   "#000000", 0.25);
    const winColor    = mixColor(centerColor, "#d8c4a0", 0.25);
    const cornerColor = mixColor(trimColor,   "#000000", 0.30);
    const doorEdges   = pickDoorEdges(edges);

    for (const edge of doorEdges) {
      const ts = edge.len > 50*FT ? [0.46, 0.54] : [0.5];
      for (const t of ts) {
        const poly = getPerspectivePoly(edge.p1, edge.p2, cx, cy, t, 4.5*FT, 0.85, 0.92);
        const d = createDrawing(poly, "p", doorColor, 1.0, pSC, pSW, pSA, Z_DOORS,
          { world: { isDoor: true, buildingId: bId } });
        if (d) toCreate.push(d);
      }
    }

    for (const edge of edges) {
      const isDoorEdge = doorEdges.includes(edge);
      let nw = Math.floor(edge.len / (18*FT));
      if (nw === 0 && edge.len >= 12*FT) nw = 1;
      if (nw === 0) continue;
      const step = 1.0 / (nw + 1);
      for (let w = 1; w <= nw; w++) {
        if (isDoorEdge && Math.abs(w*step - 0.5) < 0.25) continue;
        const poly = getPerspectivePoly(edge.p1, edge.p2, cx, cy, w*step, 3.5*FT, 0.89, 0.96);
        const d = createDrawing(poly, "p", winColor, 1.0, pSC, pSW, pSA, Z_DOORS,
          { world: { isWindow: true, buildingId: bId } });
        if (d) toCreate.push(d);
      }
    }

    for (let i = 0; i < coords.length; i++) {
      const ox = coords[i][0], oy = coords[i][1];
      const ix = cx + (ox-cx)*0.85, iy = cy + (oy-cy)*0.85;
      if (Math.hypot(ox-ix, oy-iy) < 1) continue;
      const d = createDrawing([ox,oy,ix,iy], "p", "#000000", 0, cornerColor, 1, 1.0, Z_LINES,
        { world: { isBuildingCornerLine: true, buildingId: bId } });
      if (d) toCreate.push(d);
    }
    nDetail++;
  }

  for (const wf of wallsAndFences) {
    const f = wf.f;
    const hf = f.srcHeightFactor || (f.isWall ? 8 : 0.7);
    const sd = hf * phaseDef.sunMult * pxPerFt;
    const ox = Math.cos(phaseDef.sunAngle)*sd, oy = Math.sin(phaseDef.sunAngle)*sd;
    for (const q of buildEdgeShadows(f.srcCoords, ox, oy)) {
      const d = createDrawing(q, "p", softShadowColor, phaseDef.shadowAlpha, "#000", 0, 0, Z_SHADOW,
        { world: { isShadow: true, [f.isWall?"isWallShadow":"isFenceShadow"]: true, phase: activePhase } });
      if (d) toCreate.push(d);
    }
  }

  if (phaseDef.tintColor && phaseDef.tintAlpha > 0) {
    const sw = scene.dimensions.width, sh = scene.dimensions.height;
    const t = createDrawing([0,0,sw,0,sw,sh,0,sh,0,0], "p", phaseDef.tintColor, phaseDef.tintAlpha, "#000", 0, 0, Z_PHASE_TINT,
      { world: { isPhaseTint: true, phase: activePhase } });
    if (t) toCreate.push(t);
  }

  if (toDelete.length > 0) {
    for (let i = 0; i < toDelete.length; i += CHUNK) {
      try { await scene.deleteEmbeddedDocuments("Drawing", toDelete.slice(i, i+CHUNK)); await new Promise(r=>setTimeout(r,DELAY)); }
      catch (e) { console.error("[CastShadows v3] del", e); }
    }
  }
  if (toCreate.length > 0) {
    for (let i = 0; i < toCreate.length; i += CHUNK) {
      try { await scene.createEmbeddedDocuments("Drawing", toCreate.slice(i, i+CHUNK)); await new Promise(r=>setTimeout(r,DELAY)); }
      catch (e) { console.error("[CastShadows v3] create", e); }
    }
  }

  try {
    if (scene.getFlag("world","activePhase")!==activePhase) await scene.setFlag("world","activePhase",activePhase);
    if (scene.getFlag("world","activeSeason")!==activeSeason) await scene.setFlag("world","activeSeason",activeSeason);
  } catch(e){}

  if (overlay) {
    overlay.firstElementChild.style.opacity = "0";
    setTimeout(() => overlay.remove(), 350);
  }

  if (!opts.auto) {
    ui.notifications.info(
      `${activePhase}/${activeSeason} · ${MODE}${isOverworld ? " (overworld)" : ""} · ${nShadow} shadows · ${nDetail} detailed (+${nSkipDetail} cached) · −${toDelete.length} cleaned · +${toCreate.length} created${nRecolored > 0 ? ` · ${nRecolored} recolored` : ""}`
    );
  }
};
