/* eslint-disable */
/**
 * Cavril Transit v3 — passive road-decoration system
 * ============================================================================
 * Replaces the v2 animated-walking approach. Instead of rendering each
 * citizen actually moving from A to B in real time (which required the
 * token to be visible/active and burned through token updates every 10s),
 * v3 does a much cheaper "snapshot" pass:
 *
 *   For every building with present citizens on the active scene, pluck
 *   ~20% of them and relocate their tokens onto a nearby road point with
 *   slight lateral + longitudinal jitter so they don't look gridded.
 *   Tag each relocated token with a `transitDeco` flag so the hover
 *   bubble (in cavril-cityhud.js) can render "Traveling to <destination>"
 *   in place of their normal activity.
 *
 * Deterministic per (building, day, hour) — re-running the shuffle within
 * the same game hour produces an identical result, so a scene swap or
 * F5 reload doesn't jitter every "in transit" citizen to a fresh
 * position. Position jitter for each citizen is seeded by citizen id +
 * day + hour, same property.
 *
 * Auto-triggers
 * -------------
 *   • Hourly hook in cavril-cityhud.js (game-time → real-time bridge)
 *   • canvasReady (scene swap) → 1.5s delay → shuffle
 *
 * Works equally well on overworld OR encounter maps. Any scene whose
 * road graph has been built and whose buildings carry the standard
 * `isBuildingFloor`/`isBuildingOutline` + `buildingId` flags will
 * participate.
 *
 * Storage
 * -------
 * Per-token flag (lives on the token document, scene-local):
 *   tok.flags.world.transitDeco = {
 *     destinationBuildingId,   // building the citizen "should be at"
 *     destinationLabel,        // pre-computed display label
 *     setAtHour, setAtDay      // when this assignment was made
 *   }
 *
 * Restoration: when a token's hour changes and it's no longer in the
 * 20% transit set, the next shuffle pass samples a fresh interior point
 * of its currently-scheduled building and snaps the token back inside,
 * then clears the deco flag.
 *
 * Public API
 * ----------
 *   Cavril.Transit.shuffleSceneDecoration(scene)
 *   Cavril.Transit.isDecorated(tokenDoc)
 *   Cavril.Transit.getDestinationLabel(tokenDoc)
 *
 *   CavrilTools.shuffleTransitDecoration()  — wraps the active scene
 * ============================================================================
 */

window.Cavril = window.Cavril || {};
window.CavrilTools = window.CavrilTools || {};

(function () {
  // Fraction of present citizens per building that should appear "on the
  // road" at any given hour. Bumped 0.20 → 0.25 per user request for a
  // bit more street life. Above ~30% the city starts to look more like
  // a parade than a working population, so this is near the sweet spot.
  const TRANSIT_FRACTION = 0.25;

  // Jitter when placing a token on a road. Small lateral (so they stay
  // on narrow roads) + generous along-road so two citizens picking the
  // same edge don't stack at the exact same parametric position. Total
  // displacement caps around ±20px / ±5ft per user feedback ("a little
  // bit of variance by 20 pixels in any direction").
  const ROAD_LATERAL_JITTER_FT      = 1;
  const ROAD_LONGITUDINAL_JITTER_FT = 5;

  // How far from the building the road point may be. Tightened from
  // 120ft to 60ft — a citizen "stepping out the door" should appear
  // adjacent to their building, not down the block. If a building has
  // no road within 60ft, the citizen stays inside (sparse-road graceful
  // degrade).
  const NEARBY_ROAD_RADIUS_FT = 60;

  // Minimum distance between a road-placed token and any building's
  // polygon edge. Stops "marginal wall space" placements where the
  // citizen ends up pressed against a building's outside wall. 5ft
  // (~20px) gives them enough breathing room to read as on-the-road
  // rather than against-the-wall.
  const ROAD_BUILDING_CLEARANCE_FT = 5;

  // After jittering, retry up to this many times if the candidate lands
  // inside another building's polygon OR too close to one. Buildings
  // hug roads tightly so even small lateral jitter can push a citizen
  // into the wall margin.
  const ANTI_BUILDING_RETRIES = 8;

  // Delay before the canvasReady shuffle fires — the canvas swap event
  // arrives before the token layer is fully rendered, and decorating
  // mid-render can race the renderer.
  const CANVAS_READY_DELAY_MS = 1500;

  // ── Geometry / scene helpers ────────────────────────────────────────

  function ftToPx(scene, ft) {
    const gs = scene.grid?.size ?? 100;
    const gd = scene.grid?.distance ?? 5;
    return ft * (gs / gd);
  }

  function tokenCenter(scene, tok) {
    const gs = scene.grid?.size ?? 100;
    return {
      x: tok.x + ((tok.width ?? 1) * gs) / 2,
      y: tok.y + ((tok.height ?? 1) * gs) / 2
    };
  }

  function polyCentroid(coords) {
    let sx = 0, sy = 0;
    for (const [x, y] of coords) { sx += x; sy += y; }
    const n = Math.max(1, coords.length);
    return { x: sx / n, y: sy / n };
  }

  function pointInPoly(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1];
      const xj = poly[j][0], yj = poly[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  // Tiny seeded RNG. Mirrors Domain.RPCues._seed semantics so this
  // module stays usable even if cityhud isn't fully loaded yet (e.g.
  // canvasReady fires before the app is ready). Falls back to the
  // shared one when available so determinism is bit-identical to the
  // rest of the codebase.
  function makeSeededRng(seedStr) {
    const shared = window.cityhud?.Domain?.RPCues?._seed;
    if (typeof shared === "function") {
      try { return shared(seedStr); } catch (e) { /* fall through */ }
    }
    let h = 2166136261 >>> 0;
    for (let i = 0; i < seedStr.length; i++) {
      h ^= seedStr.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return function rng() {
      h += 0x6D2B79F5;
      let t = h;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ── Building polygon access ─────────────────────────────────────────

  // Prefer floor (encounter-scene smaller polygon) over outline
  // (overworld larger polygon). Used both for centroid lookup and
  // for the restoration interior sample.
  function getBuildingPoly(scene, buildingId) {
    if (!scene || buildingId == null) return null;
    const bid = String(buildingId);
    let chosen = null;
    for (const d of scene.drawings.contents) {
      const f = d.flags?.world;
      if (!f) continue;
      if (String(f.buildingId) !== bid) continue;
      if (f.isBuildingFloor) { chosen = d; break; }     // prefer floor
      if (f.isBuildingOutline && !chosen) chosen = d;   // outline as fallback
    }
    if (!chosen) return null;
    const coords = chosen.flags?.world?.srcCoords;
    if (!Array.isArray(coords) || coords.length < 3) return null;
    return { coords, drawingId: chosen.id };
  }

  // Random interior point of a building polygon — used to snap a
  // restored token back inside the building it belongs in. Insets the
  // bounding box so we don't sample right on the wall, then ray-cast
  // tests until we hit an interior cell (up to 30 tries, then bbox
  // center as fallback).
  function sampleBuildingInterior(scene, buildingId, fallbackXY) {
    const poly = getBuildingPoly(scene, buildingId);
    if (!poly) return fallbackXY;
    const coords = poly.coords;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of coords) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    const insetX = (maxX - minX) * 0.10;
    const insetY = (maxY - minY) * 0.10;
    for (let i = 0; i < 30; i++) {
      const tx = (minX + insetX) + Math.random() * Math.max(1, (maxX - minX) - 2 * insetX);
      const ty = (minY + insetY) + Math.random() * Math.max(1, (maxY - minY) - 2 * insetY);
      if (pointInPoly(tx, ty, coords)) return { x: tx, y: ty };
    }
    return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
  }

  // ── Road graph point sampling ───────────────────────────────────────

  // Closest point on segment [a,b] to point p — returns both the world
  // point and the parametric t in [0,1] so callers can compose offsets
  // along the edge.
  function projectOntoSegment(a, b, p) {
    const dx = b.x - a.x, dy = b.y - a.y;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return { x: a.x, y: a.y, t: 0 };
    let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    return { x: a.x + t * dx, y: a.y + t * dy, t };
  }

  // Pick a road point near `originXY`. Returns { x, y, tx, ty } where
  // (x, y) is somewhere ALONG the chosen road edge, biased near the
  // projection of `originXY` so it stays close to the building. (tx,
  // ty) is the edge's tangent direction (used for sidewalk-perpendicular
  // jitter downstream). Null if no edge's projection is within
  // `radiusPx` of the origin.
  //
  // Why a t-offset around the projection rather than the projection
  // itself: when a building is hard against a road, the projection
  // point lands right at the building's wall — the citizen reads as
  // "standing at the door", not "walking down the road". A small
  // along-edge offset (±0.15 t) pushes them down the road in one
  // direction or the other so they look like they're traveling.
  function pickRoadPointNear(scene, originXY, radiusPx, rng) {
    const nav = window.Cavril?.Navigation;
    if (!nav?.getRoadGraph) return null;
    let graph = nav.getRoadGraph(scene);
    // Defensive fallback — some scenes have road drawings but no
    // persisted graph (encounter scenes built before infra wiring,
    // hand-edited scenes, stale flag, etc). Build on the fly so the
    // decoration still works. This is cheap for a single scene.
    if ((!graph || !graph.edges?.length) && nav.extractRoadGraph) {
      try {
        graph = nav.extractRoadGraph(scene);
        if (graph && graph.edges?.length && nav.saveRoadGraph) {
          // Best-effort persist so subsequent shuffles skip the rebuild.
          nav.saveRoadGraph(scene, graph).catch(() => {});
        }
      } catch (e) { /* ignore — fall through to null */ }
    }
    if (!graph || !graph.edges?.length) return null;
    const r2 = radiusPx * radiusPx;
    const candidates = [];
    for (const e of graph.edges) {
      const a = graph.nodes[e.a], b = graph.nodes[e.b];
      if (!a || !b) continue;
      const proj = projectOntoSegment(a, b, originXY);
      const dx = proj.x - originXY.x, dy = proj.y - originXY.y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= r2) candidates.push({ a, b, proj, d2 });
    }
    if (candidates.length === 0) return null;
    // Pick from the 3 closest edges — small pool keeps citizens hugging
    // their building. RNG selects which of the 3 to dampen "always the
    // same road" stacking when multiple citizens leave the same building.
    candidates.sort((c1, c2) => c1.d2 - c2.d2);
    const pool = candidates.slice(0, Math.min(3, candidates.length));
    const pick = pool[Math.floor(rng() * pool.length)];
    // Slide the sample point ±0.15 t-units along the edge from the
    // projection. Clamped to [0.05, 0.95] so we don't sit on top of
    // an intersection node. Result: citizen is ~5-10 ft up or down
    // the road from the perpendicular point — visibly "on the road",
    // not "at the door".
    const offset = (rng() - 0.5) * 0.3;       // [-0.15, 0.15]
    const t = Math.max(0.05, Math.min(0.95, pick.proj.t + offset));
    return {
      x: pick.a.x + (pick.b.x - pick.a.x) * t,
      y: pick.a.y + (pick.b.y - pick.a.y) * t,
      tx: pick.b.x - pick.a.x,
      ty: pick.b.y - pick.a.y
    };
  }

  // Add perpendicular (sidewalk) + longitudinal (along-road) jitter to
  // a road point so citizens don't all snap to the road centerline.
  function jitterRoadPoint(scene, roadXY, rng) {
    const lateral = ftToPx(scene, ROAD_LATERAL_JITTER_FT);
    const longi   = ftToPx(scene, ROAD_LONGITUDINAL_JITTER_FT);
    const tlen = Math.hypot(roadXY.tx, roadXY.ty) || 1;
    const ux = roadXY.tx / tlen, uy = roadXY.ty / tlen;   // unit tangent
    const nx = -uy, ny = ux;                                // unit normal
    const off   = (rng() - 0.5) * 2;     // [-1, 1]
    const along = (rng() - 0.5) * 2;
    return {
      x: roadXY.x + nx * off * lateral + ux * along * longi,
      y: roadXY.y + ny * off * lateral + uy * along * longi
    };
  }

  // ── Building-collision filter ───────────────────────────────────────
  // Collect every building polygon on the scene with a precomputed
  // bounding box so isPointInAnyBuilding can fast-reject most candidates
  // via cheap bbox tests before the polygon ray-cast. Prefers floor over
  // outline when both exist for the same building (floor is tighter so
  // the boundary check is more conservative — we want to keep citizens
  // OFF building floors, not just away from the wider outline).
  function collectBuildingPolygons(scene) {
    const byBid = new Map();
    for (const d of scene.drawings.contents) {
      const f = d.flags?.world;
      if (!f) continue;
      if (!(f.isBuildingFloor || f.isBuildingOutline)) continue;
      if (f.buildingId == null) continue;
      const coords = f.srcCoords;
      if (!Array.isArray(coords) || coords.length < 3) continue;
      let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
      for (const [x, y] of coords) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      const bid = String(f.buildingId);
      const existing = byBid.get(bid);
      // Prefer floor (tighter polygon) over outline when both exist.
      if (!existing || (f.isBuildingFloor && !existing.isFloor)) {
        byBid.set(bid, { bid, coords, minX, minY, maxX, maxY, isFloor: !!f.isBuildingFloor });
      }
    }
    return [...byBid.values()];
  }

  // Bbox-prefiltered point-in-poly test against every building except
  // the citizen's own destination (allowed — they're "outside on the
  // way in"). Returns true if the point is inside any OTHER building.
  function isPointInAnyOtherBuilding(buildingPolys, x, y, excludeBid) {
    const excl = excludeBid != null ? String(excludeBid) : null;
    for (const p of buildingPolys) {
      if (excl && p.bid === excl) continue;
      if (x < p.minX || x > p.maxX || y < p.minY || y > p.maxY) continue;
      if (pointInPoly(x, y, p.coords)) return true;
    }
    return false;
  }

  // Squared point-to-segment distance — cheap form used inside the
  // hot building-clearance loop so we don't sqrt per edge per token.
  function segDistSq(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) {
      const ex = px - ax, ey = py - ay;
      return ex * ex + ey * ey;
    }
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    const qx = ax + t * dx, qy = ay + t * dy;
    const ex = px - qx, ey = py - qy;
    return ex * ex + ey * ey;
  }

  // Is (x, y) within `clearancePx` of ANY building's polygon edge?
  // Used by the road-placement pass to keep transit citizens off the
  // "marginal wall space" — the strip just outside a building's wall
  // that's technically not inside the polygon but reads as pressed
  // against masonry. Bbox-expanded by clearancePx for fast reject.
  function isPointNearAnyBuilding(buildingPolys, x, y, clearancePx) {
    const c2 = clearancePx * clearancePx;
    for (const p of buildingPolys) {
      // Bbox prefilter — expand by clearancePx so we don't reject
      // points just outside the strict bbox that are still within
      // clearance of an edge.
      if (x < p.minX - clearancePx || x > p.maxX + clearancePx) continue;
      if (y < p.minY - clearancePx || y > p.maxY + clearancePx) continue;
      const coords = p.coords;
      for (let i = 0; i < coords.length; i++) {
        const a = coords[i];
        const b = coords[(i + 1) % coords.length];
        if (segDistSq(x, y, a[0], a[1], b[0], b[1]) < c2) return true;
      }
    }
    return false;
  }

  // ── Public helpers ──────────────────────────────────────────────────

  function isDecorated(tokDoc) {
    return !!tokDoc?.flags?.world?.transitDeco;
  }

  function getDestinationLabel(tokDoc) {
    return tokDoc?.flags?.world?.transitDeco?.destinationLabel || null;
  }

  // ── Main shuffle ────────────────────────────────────────────────────

  // Idempotent, batched, scene-local. Runs in roughly O(tokens + buildings
  // + nearbyRoadEdges) which is comfortable even at large scale because
  // the per-citizen decision is constant-time (one RNG roll + one road
  // pick if needed).
  //
  // Returns { updated, restored, kept } for diagnostic logging.
  async function shuffleSceneDecoration(scene) {
    if (!scene) return { updated: 0, reason: "no-scene" };
    const store = window.cityhud?.app?.store;
    if (!store?.getCurrentLocation) return { updated: 0, reason: "no-store" };

    const day  = game?.time?.components?.day  ?? 0;
    const hour = game?.time?.components?.hour ?? 12;

    // Which building IDs are physically on this scene? A token whose
    // scheduled building isn't here can't decorate "to that building"
    // because we have no centroid / road context for it.
    const sceneBldIds = new Set();
    for (const d of scene.drawings.contents) {
      const f = d.flags?.world;
      if (!f) continue;
      if ((f.isBuildingFloor || f.isBuildingOutline) && f.buildingId != null) {
        sceneBldIds.add(String(f.buildingId));
      }
    }

    // Group tokens by scheduled current building. Skip tokens whose
    // scheduled building isn't on this scene — they're handled by their
    // own scene when it's active.
    const byBuilding = new Map();   // bid -> [{ tok, loc, cid }]
    for (const tok of scene.tokens.contents) {
      const cid = tok.flags?.world?.citizenId;
      if (!cid) continue;
      const loc = store.getCurrentLocation(cid);
      const bid = loc?.building?.id;
      if (bid == null) continue;
      const key = String(bid);
      if (!sceneBldIds.has(key)) continue;
      if (!byBuilding.has(key)) byBuilding.set(key, []);
      byBuilding.get(key).push({ tok, loc, cid });
    }

    const updates = [];
    let movedToRoad = 0, restored = 0, kept = 0;

    // Pre-collect building polygons once per shuffle so the post-jitter
    // building-collision check is cheap. Bbox prefilter makes the test
    // O(near-buildings) per candidate rather than O(all-buildings).
    const buildingPolys = collectBuildingPolygons(scene);

    for (const [bid, members] of byBuilding) {
      // Per-building shuffle, seeded by (bid, day, hour). The same
      // hour produces the same set of "on-road" citizens for this
      // building so re-running shuffleSceneDecoration mid-hour
      // (canvas swap, manual fire) doesn't visibly disturb anyone.
      const pickerRng = makeSeededRng(`deco-pick-${bid}-${day}-${hour}`);
      const shuffled = members.slice();
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(pickerRng() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
      }
      const transitCount = Math.max(0, Math.floor(members.length * TRANSIT_FRACTION));
      const inTransitTokIds = new Set(shuffled.slice(0, transitCount).map(m => m.tok.id));

      // Building centroid — used as the road-search origin so the
      // citizen ends up "near this building" rather than near where
      // the token currently happens to sit (which could already be a
      // road point from last hour's pass).
      const bldPoly = getBuildingPoly(scene, bid);
      const bldCentroid = bldPoly ? polyCentroid(bldPoly.coords) : null;
      const radiusPx = ftToPx(scene, NEARBY_ROAD_RADIUS_FT);
      const gs = scene.grid?.size ?? 100;

      for (const { tok, loc, cid } of members) {
        const currentDeco  = tok.flags?.world?.transitDeco;
        const shouldBeOnRoad = inTransitTokIds.has(tok.id);

        // Stable: already on the road for the right destination this hour.
        if (shouldBeOnRoad
            && currentDeco
            && String(currentDeco.destinationBuildingId) === bid
            && currentDeco.setAtHour === hour
            && currentDeco.setAtDay === day) {
          kept++;
          continue;
        }

        if (shouldBeOnRoad) {
          // Move to a road. Per-citizen seeded RNG keeps position
          // bit-identical across re-shuffles within the hour.
          const posRng = makeSeededRng(`deco-pos-${cid}-${day}-${hour}`);
          const originXY = bldCentroid || tokenCenter(scene, tok);
          const roadXY = pickRoadPointNear(scene, originXY, radiusPx, posRng);
          if (!roadXY) {
            // No road within range — leave the citizen in the building.
            // (They'll show their normal "Working at X" bubble instead
            // of "Traveling".) This is the right degrade for scenes with
            // sparse road coverage.
            continue;
          }
          // Apply jitter, then verify the candidate is BOTH not inside
          // another building AND not too close to one. Retry up to
          // ANTI_BUILDING_RETRIES with fresh jitter; if every attempt
          // lands in the marginal wall space, fall back to the un-
          // jittered road point.
          const clearancePx = ftToPx(scene, ROAD_BUILDING_CLEARANCE_FT);
          let final = null;
          for (let attempt = 0; attempt < ANTI_BUILDING_RETRIES; attempt++) {
            const cand = jitterRoadPoint(scene, roadXY, posRng);
            if (isPointInAnyOtherBuilding(buildingPolys, cand.x, cand.y, bid)) continue;
            if (isPointNearAnyBuilding(buildingPolys, cand.x, cand.y, clearancePx)) continue;
            final = cand;
            break;
          }
          if (!final) {
            // All jitter attempts hit the marginal space. Use the
            // un-jittered closest-point-on-road as a safe fallback,
            // unless even that's too close to a building (rare — would
            // mean the road literally hugs the wall).
            if (!isPointInAnyOtherBuilding(buildingPolys, roadXY.x, roadXY.y, bid)
                && !isPointNearAnyBuilding(buildingPolys, roadXY.x, roadXY.y, clearancePx * 0.5)) {
              final = { x: roadXY.x, y: roadXY.y };
            } else {
              continue;   // skip — leave them in their building
            }
          }
          // Face the direction of travel — toward the destination
          // building's centroid. Foundry's rotation: 0=up/north,
          // increases clockwise. dnd5e portrait sprites have their
          // visible "front" at the bottom of the image (the chin/feet
          // face south by default), so we add 180° to the atan2 result
          // to flip the formula from "facing away" → "facing toward".
          let facingDeg = 0;
          if (bldCentroid) {
            const fdx = bldCentroid.x - final.x;
            const fdy = bldCentroid.y - final.y;
            if (fdx !== 0 || fdy !== 0) {
              let raw = (Math.atan2(fdx, -fdy) * 180 / Math.PI) + 180;
              facingDeg = ((raw % 360) + 360) % 360;
            }
          }
          const halfW = ((tok.width ?? 1) * gs) / 2;
          const halfH = ((tok.height ?? 1) * gs) / 2;
          updates.push({
            _id: tok.id,
            x: final.x - halfW,
            y: final.y - halfH,
            rotation: facingDeg,
            "flags.world.transitDeco": {
              destinationBuildingId: bid,
              destinationLabel: loc?.building?.name || loc?.label || "their destination",
              setAtHour: hour,
              setAtDay:  day
            }
          });
          movedToRoad++;
        } else if (currentDeco) {
          // Was decorated, shouldn't be anymore — restore inside the
          // building. Sample a fresh interior point so successive
          // restorations don't all land at the same spot.
          const fallback = bldCentroid || tokenCenter(scene, tok);
          const interior = sampleBuildingInterior(scene, bid, fallback);
          const halfW = ((tok.width ?? 1) * gs) / 2;
          const halfH = ((tok.height ?? 1) * gs) / 2;
          updates.push({
            _id: tok.id,
            x: interior.x - halfW,
            y: interior.y - halfH,
            "flags.world.-=transitDeco": null
          });
          restored++;
        } else {
          // Should be in building, currently in building, no flag — no-op.
          kept++;
        }
      }
    }

    if (updates.length > 0) {
      // Chunk in case a large scene fires hundreds of updates at once.
      // `teleport: true` + `animate: false` skip the smooth-walk animation
      // AND its wall-collision validation. Without this, Foundry tries
      // to "walk" each token from its current position to the new one,
      // and if that path crosses a building wall (very common in tight
      // city blocks), the token gets stuck against the wall mid-walk
      // even though the document update itself succeeded. Teleport mode
      // honors the document update verbatim and skips the visual walk
      // entirely — citizens just appear at their new spots.
      const CHUNK = 200;
      const updateOpts = { teleport: true, animate: false, animation: { duration: 0 } };
      for (let i = 0; i < updates.length; i += CHUNK) {
        try { await scene.updateEmbeddedDocuments("Token", updates.slice(i, i + CHUNK), updateOpts); }
        catch (e) { console.warn("[Cavril Transit] shuffle chunk failed:", e); }
      }
    }
    return { updated: updates.length, movedToRoad, restored, kept };
  }

  // ── Public API ──────────────────────────────────────────────────────

  window.Cavril.Transit = {
    TRANSIT_FRACTION,
    NEARBY_ROAD_RADIUS_FT,
    shuffleSceneDecoration,
    isDecorated,
    getDestinationLabel
  };

  // ── User wrapper ────────────────────────────────────────────────────

  CavrilTools.shuffleTransitDecoration = async function() {
    const r = await shuffleSceneDecoration(canvas.scene);
    if (r?.updated > 0) {
      ui.notifications?.info?.(`🚶 Transit shuffle: ${r.movedToRoad} → road, ${r.restored} restored.`);
    }
    return r;
  };

  // ── canvasReady auto-fire ───────────────────────────────────────────
  // Scene swap → after a brief delay (tokens need a moment to render),
  // run the shuffle so the user sees the road decoration immediately
  // without having to advance time. Guarded by a tick counter so
  // re-loading the sidecar doesn't stack multiple hooks.
  if (!window.Cavril._transitCanvasReadyHooked) {
    window.Cavril._transitCanvasReadyHooked = true;
    Hooks.on("canvasReady", (cvs) => {
      const scene = cvs?.scene || canvas?.scene;
      if (!scene) return;
      setTimeout(() => {
        try { shuffleSceneDecoration(scene); }
        catch (e) { console.warn("[Cavril Transit] canvasReady shuffle failed:", e); }
      }, CANVAS_READY_DELAY_MS);
    });
  }
})();
