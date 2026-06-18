/* eslint-disable */
/**
 * Cavril Navigation v1 — road graph + pathfinding
 * ============================================================================
 * Extracts a navigable road graph from the road drawings on a scene,
 * persists it on a scene flag, and exposes A* pathfinding between
 * arbitrary world coordinates.
 *
 * Design notes
 * ------------
 * The graph is { nodes: [{id, x, y}], edges: [{a, b, length}] }.
 *
 * Endpoint snapping: any two road endpoints within SNAP_DIST_PX of each
 * other collapse to one node. This catches T-junctions, 4-way intersections,
 * and "two roads meant to connect but the import drift left them ~1 ft
 * apart" — without the snap, those would be unreachable from each other.
 *
 * Mid-segment intersections: handled at extract time. If a road segment
 * crosses another road segment at an interior point, both segments split
 * at the crossing and a shared node is inserted. Common in cities with
 * grid + diagonal streets.
 *
 * Persistence: the built graph is saved on `scene.flags.world.roadGraph`.
 * Cheap to write — a 2,000-road-segment city produces ~50KB of JSON.
 *
 * Public API
 * ----------
 *   Cavril.Navigation.extractRoadGraph(scene)
 *   Cavril.Navigation.getRoadGraph(scene)             — uses cache + flag
 *   Cavril.Navigation.snapToNearestNode(graph, x, y)
 *   Cavril.Navigation.pathBetween(scene, p1, p2)      — returns world waypoints
 *
 * Plus user-facing wrappers:
 *   CavrilTools.buildRoadGraph()        — extract + persist on active scene
 *   CavrilTools.visualizeRoadGraph()    — overlay nodes + edges as drawings
 *   CavrilTools.clearRoadGraphOverlay() — remove the debug overlay
 * ============================================================================
 */

window.Cavril = window.Cavril || {};
window.CavrilTools = window.CavrilTools || {};

(function () {
  // 8 px snap radius (≈ 2 ft on a 20px/5ft grid). Generous enough to
  // bridge gaps from import drift; tight enough that distinct
  // intersections don't collapse into one super-node.
  const SNAP_DIST_PX = 8;
  const SNAP_DIST_SQ = SNAP_DIST_PX * SNAP_DIST_PX;

  // Per-scene in-memory cache, keyed by scene.id. Invalidates when the
  // scene flag changes. Avoids re-parsing the flag on every query.
  const graphCache = new Map();

  function dist2(ax, ay, bx, by) {
    const dx = ax - bx, dy = ay - by;
    return dx * dx + dy * dy;
  }

  // Walk every road drawing on the scene and collect raw segments.
  // Returns [{x1, y1, x2, y2}].
  function collectRoadSegments(scene) {
    const out = [];
    for (const dwg of (scene.drawings?.contents || [])) {
      const f = dwg.flags?.world;
      if (!f?.isRoad || f.isRoadJoint) continue;
      const coords = f.srcCoords;
      if (!Array.isArray(coords) || coords.length < 2) continue;
      for (let i = 0; i < coords.length - 1; i++) {
        const [x1, y1] = coords[i];
        const [x2, y2] = coords[i + 1];
        if (!Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(x2) || !Number.isFinite(y2)) continue;
        if (x1 === x2 && y1 === y2) continue;   // skip degenerate
        out.push({ x1, y1, x2, y2 });
      }
    }
    return out;
  }

  // Segment-segment intersection. Returns {x, y, ta, tb} where ta/tb are
  // the parametric positions [0,1] along each segment, or null if they
  // don't intersect (or only meet at endpoints, which we ignore — endpoints
  // are handled by snapping).
  function segIntersect(a, b) {
    const x1 = a.x1, y1 = a.y1, x2 = a.x2, y2 = a.y2;
    const x3 = b.x1, y3 = b.y1, x4 = b.x2, y4 = b.y2;
    const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
    if (Math.abs(denom) < 1e-9) return null;
    const ta = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
    const tb = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;
    // Strict-interior crossing only: t in (eps, 1-eps).
    const eps = 0.001;
    if (ta < eps || ta > 1 - eps || tb < eps || tb > 1 - eps) return null;
    return {
      x: x1 + ta * (x2 - x1),
      y: y1 + ta * (y2 - y1),
      ta, tb
    };
  }

  // Split a flat segment list at all interior intersections. The output
  // segments share endpoints exactly at split points, so endpoint-snapping
  // (next pass) can fuse them into a single node.
  function splitAtIntersections(segments) {
    // Per-segment list of split-points (parametric position).
    const splits = segments.map(() => []);
    for (let i = 0; i < segments.length; i++) {
      for (let j = i + 1; j < segments.length; j++) {
        const hit = segIntersect(segments[i], segments[j]);
        if (!hit) continue;
        splits[i].push({ t: hit.ta, x: hit.x, y: hit.y });
        splits[j].push({ t: hit.tb, x: hit.x, y: hit.y });
      }
    }
    const out = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const cuts = splits[i].sort((a, b) => a.t - b.t);
      let lastX = seg.x1, lastY = seg.y1;
      for (const c of cuts) {
        out.push({ x1: lastX, y1: lastY, x2: c.x, y2: c.y });
        lastX = c.x; lastY = c.y;
      }
      out.push({ x1: lastX, y1: lastY, x2: seg.x2, y2: seg.y2 });
    }
    return out;
  }

  // Snap endpoints together into a shared node set. Returns
  // { nodes: [{id, x, y}], edges: [{a, b, length}] }. Uses a coarse
  // spatial grid so the snap pass is O(N) not O(N²) for large cities.
  function buildGraphFromSegments(segments) {
    const nodes = [];
    const grid = new Map();             // cellKey -> [nodeId,...]
    const cellSize = SNAP_DIST_PX * 4;  // larger cells fit a 3×3 neighborhood window
    const keyFor = (x, y) => `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`;

    function getOrCreateNode(x, y) {
      // Check the 9 cells around (x,y) for an existing snap candidate.
      const cx = Math.floor(x / cellSize), cy = Math.floor(y / cellSize);
      let bestId = -1, bestDsq = SNAP_DIST_SQ;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          const arr = grid.get(`${cx + dx},${cy + dy}`);
          if (!arr) continue;
          for (const id of arr) {
            const n = nodes[id];
            const d = dist2(x, y, n.x, n.y);
            if (d < bestDsq) { bestDsq = d; bestId = id; }
          }
        }
      }
      if (bestId >= 0) return bestId;
      const id = nodes.length;
      nodes.push({ id, x, y });
      const k = keyFor(x, y);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(id);
      return id;
    }

    const edgeSet = new Map();  // "min-max" key -> edge index
    const edges = [];
    for (const seg of segments) {
      const a = getOrCreateNode(seg.x1, seg.y1);
      const b = getOrCreateNode(seg.x2, seg.y2);
      if (a === b) continue;                          // collapsed by snap
      const k = a < b ? `${a}-${b}` : `${b}-${a}`;
      if (edgeSet.has(k)) continue;                   // dedupe parallel duplicates
      const len = Math.hypot(nodes[a].x - nodes[b].x, nodes[a].y - nodes[b].y);
      edges.push({ a, b, length: len });
      edgeSet.set(k, edges.length - 1);
    }

    return { nodes, edges };
  }

  // Build a spatial index so snapToNearestNode is O(1) average.
  // Lazy-built on first query, kept on the graph object.
  function ensureSpatialIndex(graph) {
    if (graph._index) return graph._index;
    const cellSize = 200;   // 200 px ≈ 50 ft cells — good for typical scene
    const grid = new Map();
    const keyFor = (x, y) => `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)}`;
    for (const n of graph.nodes) {
      const k = keyFor(n.x, n.y);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(n.id);
    }
    graph._index = { grid, cellSize, keyFor };
    return graph._index;
  }

  // Adjacency list, lazy-built.
  function ensureAdjacency(graph) {
    if (graph._adj) return graph._adj;
    const adj = new Map();
    for (let i = 0; i < graph.nodes.length; i++) adj.set(i, []);
    for (const e of graph.edges) {
      adj.get(e.a).push({ to: e.b, length: e.length });
      adj.get(e.b).push({ to: e.a, length: e.length });
    }
    graph._adj = adj;
    return adj;
  }

  // ── Public API ──────────────────────────────────────────────────────

  // Build a fresh graph from a scene's road drawings. Pure function — does
  // NOT persist; caller decides whether to save.
  function extractRoadGraph(scene) {
    if (!scene) return null;
    const raw = collectRoadSegments(scene);
    const split = splitAtIntersections(raw);
    return buildGraphFromSegments(split);
  }

  // Read the graph from cache → scene flag → rebuild as last resort.
  // The flag is the canonical persistence; cache is just a parse-skip.
  function getRoadGraph(scene) {
    if (!scene) return null;
    if (graphCache.has(scene.id)) return graphCache.get(scene.id);
    let g = scene.getFlag("world", "roadGraph");
    if (g && Array.isArray(g.nodes) && Array.isArray(g.edges)) {
      graphCache.set(scene.id, g);
      return g;
    }
    return null;   // call buildRoadGraph if you want to populate
  }

  // Persist a graph to the scene flag and refresh the cache.
  async function saveRoadGraph(scene, graph) {
    if (!scene || !graph) return;
    // Strip lazy fields before persisting — they rebuild on read.
    const persistable = { nodes: graph.nodes, edges: graph.edges };
    await scene.unsetFlag("world", "roadGraph");
    await scene.setFlag("world", "roadGraph", persistable);
    graphCache.set(scene.id, graph);
  }

  // Find the nearest graph node to a world point. Returns { id, x, y, dist }.
  function snapToNearestNode(graph, x, y) {
    if (!graph || !graph.nodes?.length) return null;
    const idx = ensureSpatialIndex(graph);
    const cx = Math.floor(x / idx.cellSize), cy = Math.floor(y / idx.cellSize);
    let best = null, bestDsq = Infinity;
    // Spiral outward through cells until we find something + verify the
    // next ring can't beat it. For graphs with sparse holes this can scan
    // a few rings; in practice 1-2 rings cover every reasonable query.
    for (let ring = 0; ring < 20; ring++) {
      let found = false;
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          const arr = idx.grid.get(`${cx + dx},${cy + dy}`);
          if (!arr) continue;
          for (const id of arr) {
            const n = graph.nodes[id];
            const d = dist2(x, y, n.x, n.y);
            if (d < bestDsq) { bestDsq = d; best = n; found = true; }
          }
        }
      }
      // Stop expanding once we've found something AND the next ring's
      // minimum possible distance can't beat our current best.
      if (best && ring * idx.cellSize > Math.sqrt(bestDsq)) break;
      if (!best && !found && ring > 3) break;   // sparse area, give up
    }
    return best ? { id: best.id, x: best.x, y: best.y, dist: Math.sqrt(bestDsq) } : null;
  }

  // A* between two nodes. Returns array of node ids OR null if unreachable.
  function aStar(graph, startId, goalId) {
    if (startId === goalId) return [startId];
    const adj = ensureAdjacency(graph);
    const nodes = graph.nodes;
    const goal = nodes[goalId];

    const open = new Map();           // nodeId -> fScore
    const cameFrom = new Map();
    const gScore = new Map();
    open.set(startId, 0);
    gScore.set(startId, 0);

    while (open.size > 0) {
      // Pop lowest-f from the open set. O(N) per pop — fine for graphs up
      // to a few thousand nodes; swap for a priority queue if cities grow.
      let curId = -1, curF = Infinity;
      for (const [id, f] of open) {
        if (f < curF) { curF = f; curId = id; }
      }
      if (curId < 0) break;
      if (curId === goalId) {
        // Reconstruct path
        const path = [curId];
        let n = curId;
        while (cameFrom.has(n)) { n = cameFrom.get(n); path.unshift(n); }
        return path;
      }
      open.delete(curId);
      const cur = nodes[curId];
      for (const edge of adj.get(curId)) {
        const tentative = gScore.get(curId) + edge.length;
        if (tentative < (gScore.get(edge.to) ?? Infinity)) {
          cameFrom.set(edge.to, curId);
          gScore.set(edge.to, tentative);
          const n = nodes[edge.to];
          const h = Math.hypot(n.x - goal.x, n.y - goal.y);   // Euclidean heuristic
          open.set(edge.to, tentative + h);
        }
      }
    }
    return null;
  }

  // Public path query. Snaps both points to road nodes, runs A*, returns
  // waypoints as [{x, y}, ...]. Returns null if no path exists.
  function pathBetween(scene, p1, p2) {
    const graph = getRoadGraph(scene);
    if (!graph) return null;
    const a = snapToNearestNode(graph, p1.x, p1.y);
    const b = snapToNearestNode(graph, p2.x, p2.y);
    if (!a || !b) return null;
    const path = aStar(graph, a.id, b.id);
    if (!path) return null;
    return path.map(id => ({ x: graph.nodes[id].x, y: graph.nodes[id].y }));
  }

  Cavril.Navigation = {
    extractRoadGraph,
    getRoadGraph,
    saveRoadGraph,
    snapToNearestNode,
    pathBetween,
    _aStar: aStar   // exposed for testing / debugging
  };

  // ── User-facing wrappers ────────────────────────────────────────────

  CavrilTools.buildRoadGraph = async function() {
    const scene = canvas.scene;
    if (!scene) { ui.notifications.error("No active scene"); return null; }
    const t0 = performance.now();
    const graph = extractRoadGraph(scene);
    if (!graph || graph.nodes.length === 0) {
      ui.notifications.warn("No road segments found on this scene.");
      return null;
    }
    await saveRoadGraph(scene, graph);
    const ms = Math.round(performance.now() - t0);
    const intersections = graph.nodes.filter(n => {
      const adj = ensureAdjacency(graph);
      return (adj.get(n.id) || []).length >= 3;
    }).length;
    ui.notifications.info(
      `Road graph: ${graph.nodes.length} nodes (${intersections} intersections) · ${graph.edges.length} edges · ${ms}ms`
    );
    console.log(`[Cavril Navigation] built graph for "${scene.name}":`, graph);
    return graph;
  };

  // Overlay every node as a small circle + every edge as a line. Saved
  // with a marker flag so clearRoadGraphOverlay can find + delete them.
  CavrilTools.visualizeRoadGraph = async function() {
    const scene = canvas.scene;
    if (!scene) { ui.notifications.error("No active scene"); return; }
    let graph = getRoadGraph(scene);
    if (!graph) graph = await CavrilTools.buildRoadGraph();
    if (!graph) return;

    // Clear any prior overlay first so re-runs don't pile up.
    await CavrilTools.clearRoadGraphOverlay();

    const Z = 950;   // above phase tint, below UI overlays
    const adj = ensureAdjacency(graph);
    const toCreate = [];

    // Edges: thin pink lines
    for (const e of graph.edges) {
      const a = graph.nodes[e.a], b = graph.nodes[e.b];
      const x0 = Math.min(a.x, b.x), y0 = Math.min(a.y, b.y);
      const w = Math.max(1, Math.abs(a.x - b.x));
      const h = Math.max(1, Math.abs(a.y - b.y));
      toCreate.push({
        x: x0, y: y0,
        shape: {
          type: "p",
          width: w, height: h,
          points: [a.x - x0, a.y - y0, b.x - x0, b.y - y0]
        },
        fillType: 0,
        strokeColor: "#ec4899",
        strokeWidth: 1.5,
        strokeAlpha: 0.85,
        z: Z, sort: Z,
        flags: { world: { isRoadGraphOverlay: true, kind: "edge" } }
      });
    }

    // Nodes: small filled circles, color-coded by degree
    //   degree 1 = dead-end (gray)
    //   degree 2 = midpoint (cyan)
    //   degree 3+ = intersection (yellow)
    for (const n of graph.nodes) {
      const deg = (adj.get(n.id) || []).length;
      const fill = deg >= 3 ? "#fbbf24" : deg === 1 ? "#71717a" : "#22d3ee";
      const radius = deg >= 3 ? 5 : 3;
      toCreate.push({
        x: n.x - radius, y: n.y - radius,
        shape: { type: "e", width: radius * 2, height: radius * 2 },
        fillType: 1,
        fillColor: fill,
        fillAlpha: 0.95,
        strokeColor: "#000000",
        strokeWidth: 0.5,
        strokeAlpha: 0.6,
        z: Z + 1, sort: Z + 1,
        flags: { world: { isRoadGraphOverlay: true, kind: "node", nodeId: n.id, degree: deg } }
      });
    }

    // Batch create
    const CHUNK = 400;
    for (let i = 0; i < toCreate.length; i += CHUNK) {
      try { await scene.createEmbeddedDocuments("Drawing", toCreate.slice(i, i + CHUNK)); }
      catch (e) { console.error("[Cavril Navigation] overlay chunk failed:", e); }
    }
    const intersections = graph.nodes.filter(n => (adj.get(n.id) || []).length >= 3).length;
    const deadEnds = graph.nodes.filter(n => (adj.get(n.id) || []).length === 1).length;
    ui.notifications.info(
      `Road overlay drawn — yellow=intersection (${intersections}), cyan=midpoint, gray=dead-end (${deadEnds}).`
    );
  };

  CavrilTools.clearRoadGraphOverlay = async function() {
    const scene = canvas.scene;
    if (!scene) return;
    const ids = scene.drawings.contents
      .filter(d => d.flags?.world?.isRoadGraphOverlay)
      .map(d => d.id);
    if (ids.length === 0) return;
    const CHUNK = 200;
    for (let i = 0; i < ids.length; i += CHUNK) {
      try { await scene.deleteEmbeddedDocuments("Drawing", ids.slice(i, i + CHUNK)); }
      catch (e) { console.error("[Cavril Navigation] overlay delete failed:", e); }
    }
  };

  // ── Bridge detection ────────────────────────────────────────────────
  // Walks every road segment, intersects it against every water/river
  // polygon's boundary edges, and emits a wooden bridge drawing for each
  // (enter, exit) pair. Idempotent: clears existing isBridge drawings
  // first so re-running gives a clean result.

  // Find every intersection of road segment (p1→p2) with a closed polygon's
  // edges. Returns [{x, y, t}] sorted by t (parametric position along p1→p2).
  // Endpoint hits (t≈0, t≈1) are kept; segment-on-edge (denom≈0) is skipped.
  function polySegIntersections(polyCoords, p1, p2) {
    const hits = [];
    const x1 = p1[0], y1 = p1[1], x2 = p2[0], y2 = p2[1];
    for (let i = 0; i < polyCoords.length; i++) {
      const a = polyCoords[i];
      const b = polyCoords[(i + 1) % polyCoords.length];
      const x3 = a[0], y3 = a[1], x4 = b[0], y4 = b[1];
      const denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
      if (Math.abs(denom) < 1e-9) continue;
      const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom;
      const u = -((x1 - x2) * (y1 - y3) - (y1 - y2) * (x1 - x3)) / denom;
      if (t < -1e-6 || t > 1 + 1e-6) continue;
      if (u < -1e-6 || u > 1 + 1e-6) continue;
      hits.push({ x: x1 + t * (x2 - x1), y: y1 + t * (y2 - y1), t });
    }
    hits.sort((a, b) => a.t - b.t);
    // Dedupe near-coincident hits (two polygon edges sharing a vertex
    // produce two hits at the same point — keep one).
    const out = [];
    for (const h of hits) {
      if (out.length && Math.abs(h.t - out[out.length - 1].t) < 1e-4) continue;
      out.push(h);
    }
    return out;
  }

  // Generic span builder used by both bridges and aqueducts. The
  // visual difference is just color, width, and z-order — all are
  // rectangles aligned to the source line direction.
  function buildSpanDrawing(from, to, strokeWidth, opts, flags) {
    const dx = to.x - from.x, dy = to.y - from.y;
    const len = Math.hypot(dx, dy);
    if (len < 1) return null;
    const ux = dx / len, uy = dy / len;
    const nx = -uy, ny = ux;
    const sw = strokeWidth || 20;
    const halfW = sw * (opts.widthScale || 0.75);
    const overhang = sw * (opts.overhangScale || 0.40);
    const ax = from.x - ux * overhang,  ay = from.y - uy * overhang;
    const bx = to.x   + ux * overhang,  by = to.y   + uy * overhang;
    const v1 = [ax - nx * halfW, ay - ny * halfW];
    const v2 = [bx - nx * halfW, by - ny * halfW];
    const v3 = [bx + nx * halfW, by + ny * halfW];
    const v4 = [ax + nx * halfW, ay + ny * halfW];
    const xs = [v1[0], v2[0], v3[0], v4[0]];
    const ys = [v1[1], v2[1], v3[1], v4[1]];
    const x0 = Math.min(...xs), y0 = Math.min(...ys);
    const w  = Math.max(...xs) - x0;
    const h  = Math.max(...ys) - y0;
    return {
      x: x0, y: y0,
      shape: {
        type: "p",
        width: Math.max(1, w),
        height: Math.max(1, h),
        points: [
          v1[0] - x0, v1[1] - y0,
          v2[0] - x0, v2[1] - y0,
          v3[0] - x0, v3[1] - y0,
          v4[0] - x0, v4[1] - y0,
          v1[0] - x0, v1[1] - y0
        ]
      },
      fillType: 1,
      fillColor: opts.fillColor,
      fillAlpha: 1.0,
      strokeColor: opts.strokeColor,
      strokeWidth: opts.strokeW ?? 1.5,
      strokeAlpha: 0.75,
      z: opts.z, sort: opts.z,
      flags
    };
  }

  function buildBridgeDrawing(from, to, strokeWidth, flags) {
    // Wooden plank, just above road (Z_ROADS=2), below shadow (Z=3)
    // so phase shadows still fall across the bridge correctly.
    return buildSpanDrawing(from, to, strokeWidth, {
      fillColor:   "#5a3a1a",
      strokeColor: "#2a1a08",
      widthScale:  0.75,    // ~1.5× road width
      overhangScale: 0.40,
      z: 2.5
    }, flags);
  }

  function buildAqueductDrawing(from, to, strokeWidth, flags) {
    // Lighter pale stone sitting just above the wall (Z_WALLS=300).
    // Wider than the wall so it visually reads as "this section is a
    // distinct structural feature, not just wall continuing through
    // water". No arch detail at overworld zoom — the wider band is
    // enough silhouette.
    return buildSpanDrawing(from, to, strokeWidth, {
      fillColor:   "#9aa0a5",   // pale slate / weathered limestone
      strokeColor: "#3a3e44",
      widthScale:  1.10,        // ~2.2× wall width — clearly thicker
      overhangScale: 0.50,
      z: 301
    }, flags);
  }

  // Point-in-polygon by ray casting. Used to detect road segments that
  // start, end, or live ENTIRELY inside water — those don't intersect
  // the boundary so the old "2+ hits per segment" rule missed them.
  function pointInPoly(x, y, polyCoords) {
    let inside = false;
    for (let i = 0, j = polyCoords.length - 1; i < polyCoords.length; j = i++) {
      const xi = polyCoords[i][0], yi = polyCoords[i][1];
      const xj = polyCoords[j][0], yj = polyCoords[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  // Color fallback for water detection. The importer's terrainType
  // flag isn't always populated (older imports or features that came
  // in without a backgroundType), but the fillColor is always set.
  // Water shades across all four seasons have higher B than R+10.
  function isWaterishColor(hex) {
    if (!hex || typeof hex !== "string" || hex.length < 7) return false;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) return false;
    return b > r + 10 && b > g - 10 && b < 200;   // blue-leaning, not pure white
  }

  // Collect water/river polygons on a scene. Primary detection by flag;
  // color-fallback handles imports where backgroundType drift mislabeled
  // a river as GRASS in flags but kept the water-blue fill.
  function collectWaterPolygons(scene) {
    const out = [];
    for (const d of scene.drawings.contents) {
      const f = d.flags?.world;
      if (!f) continue;
      const tt = String(f.terrainType || "").toUpperCase();
      let isWater = f.isWater || f.isRiver || tt === "WATER" || tt === "RIVER";
      if (!isWater && f.isTerrain && isWaterishColor(d.fillColor)) isWater = true;
      if (!isWater) continue;
      const coords = f.srcCoords;
      if (!Array.isArray(coords) || coords.length < 3) continue;
      out.push({ coords, id: d.id });
    }
    return out;
  }

  // Generic infrastructure-over-water detection. Walks every source
  // polyline (roads OR walls, controlled by `cfg`), classifies each
  // segment into in-water/out-of-water spans via boundary intersections
  // + endpoint containment, and emits a span drawing for each in-water
  // span. Idempotent — clears prior drawings of the same kind first.
  //
  // Handles all the topological cases the user actually encounters:
  //   • normal crossing (out → in → out): 2 hits, 1 span
  //   • polyline ends in water (out → in): 1 hit, 1 span
  //   • polyline lives entirely inside water (in → in): 0 hits, 1 full-segment span
  //   • crossing an island (out → in → out → in → out): multiple spans
  //
  // cfg = {
  //   kind:            internal identifier
  //   flagOnSource:    flag-name to match on candidate drawings (e.g. "isRoad", "isWall")
  //   excludeOnSource: skip flag-name (e.g. "isRoadJoint")
  //   flagOnOutput:    flag we stamp on the span drawing (e.g. "isBridge", "isAqueduct")
  //   build:           function(from, to, strokeWidth, flags) → span drawing
  //   label:           human-readable name for the toast
  //   emoji:           toast prefix
  // }
  async function detectInfrastructure(scene, cfg) {
    if (!scene) return { count: 0, cleared: 0, reason: "no-scene" };
    const waterPolys = collectWaterPolygons(scene);
    if (waterPolys.length === 0) return { count: 0, cleared: 0, reason: "no-water" };

    const toCreate = [];
    for (const d of scene.drawings.contents) {
      const f = d.flags?.world;
      if (!f?.[cfg.flagOnSource]) continue;
      if (cfg.excludeOnSource && f[cfg.excludeOnSource]) continue;
      const coords = f.srcCoords;
      if (!Array.isArray(coords) || coords.length < 2) continue;
      const strokeWidth = d.strokeWidth || 20;
      for (let i = 0; i < coords.length - 1; i++) {
        const p1 = coords[i], p2 = coords[i + 1];
        for (const water of waterPolys) {
          const hits = polySegIntersections(water.coords, p1, p2);
          const p1In = pointInPoly(p1[0], p1[1], water.coords);
          const p2In = pointInPoly(p2[0], p2[1], water.coords);
          if (!p1In && !p2In && hits.length === 0) continue;
          const breakpoints = [{ t: 0, x: p1[0], y: p1[1] }];
          for (const h of hits) breakpoints.push(h);
          breakpoints.push({ t: 1, x: p2[0], y: p2[1] });
          breakpoints.sort((a, b) => a.t - b.t);
          for (let bi = 0; bi + 1 < breakpoints.length; bi++) {
            const a = breakpoints[bi], b = breakpoints[bi + 1];
            if (Math.abs(b.t - a.t) < 1e-4) continue;
            const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
            if (!pointInPoly(mx, my, water.coords)) continue;
            const span = cfg.build(a, b, strokeWidth, {
              world: {
                [cfg.flagOnOutput]: true,
                sourceDrawingId: d.id,
                waterDrawingId: water.id
              }
            });
            if (span) toCreate.push(span);
          }
        }
      }
    }

    // Idempotent: clear prior outputs of this kind so re-runs don't stack
    const existingIds = scene.drawings.contents
      .filter(d => d.flags?.world?.[cfg.flagOnOutput])
      .map(d => d.id);
    if (existingIds.length > 0) {
      const CHUNK = 200;
      for (let i = 0; i < existingIds.length; i += CHUNK) {
        try { await scene.deleteEmbeddedDocuments("Drawing", existingIds.slice(i, i + CHUNK)); }
        catch (e) { console.error(`[Cavril Navigation] ${cfg.kind} clear failed:`, e); }
      }
    }

    if (toCreate.length > 0) {
      const CHUNK = 200;
      for (let i = 0; i < toCreate.length; i += CHUNK) {
        try { await scene.createEmbeddedDocuments("Drawing", toCreate.slice(i, i + CHUNK)); }
        catch (e) { console.error(`[Cavril Navigation] ${cfg.kind} create chunk failed:`, e); }
      }
    }
    return { count: toCreate.length, cleared: existingIds.length };
  }

  const BRIDGE_CFG = {
    kind: "bridge",
    flagOnSource:    "isRoad",
    excludeOnSource: "isRoadJoint",
    flagOnOutput:    "isBridge",
    build:           buildBridgeDrawing,
    label:           "bridge",
    emoji:           "🌉"
  };
  const AQUEDUCT_CFG = {
    kind: "aqueduct",
    flagOnSource:    "isWall",
    excludeOnSource: null,
    flagOnOutput:    "isAqueduct",
    build:           buildAqueductDrawing,
    label:           "aqueduct",
    emoji:           "🏛️"
  };

  CavrilTools.detectBridges = async function(opts = {}) {
    const scene = opts.scene || canvas.scene;
    if (!scene) { ui.notifications.error("No active scene"); return; }
    const r = await detectInfrastructure(scene, BRIDGE_CFG);
    if (!opts.quiet) {
      if (r.reason === "no-water") ui.notifications.warn("No water/river polygons on this scene.");
      else if (r.count === 0)      ui.notifications.info(`No bridges needed — no road crosses water${r.cleared ? ` (cleared ${r.cleared} stale)` : ""}.`);
      else                          ui.notifications.info(`${BRIDGE_CFG.emoji} ${r.count} bridge${r.count === 1 ? "" : "s"} placed.`);
    }
    return r;
  };

  CavrilTools.detectAqueducts = async function(opts = {}) {
    const scene = opts.scene || canvas.scene;
    if (!scene) { ui.notifications.error("No active scene"); return; }
    const r = await detectInfrastructure(scene, AQUEDUCT_CFG);
    if (!opts.quiet) {
      if (r.reason === "no-water") ui.notifications.warn("No water/river polygons on this scene.");
      else if (r.count === 0)      ui.notifications.info(`No aqueducts needed — no wall crosses water${r.cleared ? ` (cleared ${r.cleared} stale)` : ""}.`);
      else                          ui.notifications.info(`${AQUEDUCT_CFG.emoji} ${r.count} aqueduct${r.count === 1 ? "" : "s"} placed.`);
    }
    return r;
  };

  // Single entrypoint the importer calls at the end of city generation.
  // Builds + persists the road graph, then runs both span detectors
  // against the same scene. Idempotent across all three so it can also
  // be re-run later to "refresh" a scene after manual edits.
  CavrilTools.processSceneInfrastructure = async function(scene) {
    if (!scene) scene = canvas.scene;
    if (!scene) return { error: "no-scene" };
    let nodeCount = 0, edgeCount = 0;
    try {
      const graph = extractRoadGraph(scene);
      if (graph && graph.nodes.length > 0) {
        await saveRoadGraph(scene, graph);
        nodeCount = graph.nodes.length;
        edgeCount = graph.edges.length;
      }
    } catch (e) { console.warn("[Cavril Navigation] graph build during import failed:", e); }
    const bridges   = await CavrilTools.detectBridges({   scene, quiet: true });
    const aqueducts = await CavrilTools.detectAqueducts({ scene, quiet: true });
    const parts = [];
    if (nodeCount > 0) parts.push(`${nodeCount} road nodes`);
    if (bridges?.count   > 0) parts.push(`${bridges.count} bridges`);
    if (aqueducts?.count > 0) parts.push(`${aqueducts.count} aqueducts`);
    if (parts.length > 0) {
      ui.notifications.info(`🛣️ Infrastructure: ${parts.join(" · ")} on "${scene.name}".`);
    }
    return { graph: { nodes: nodeCount, edges: edgeCount }, bridges, aqueducts };
  };
})();
