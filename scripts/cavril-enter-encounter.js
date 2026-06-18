/**
 * Cavril Enter Encounter v2
 * ============================================================================
 * Creates a fully-detailed encounter scene from the GM's overworld view.
 *
 * v2 CHANGES:
 *   - Bigger radius (300ft default, generous margin)
 *   - WHOLESOME EXCLUSION: objects must be ENTIRELY within the encounter
 *     bbox. Partial buildings/roads/terrain at the perimeter are excluded.
 *     This prevents cut-off artifacts at the edges.
 *   - Roads get natural jitter distortion
 *   - Trees + bushes scattered on grass away from structures
 *   - Foundry terrain Walls on building exterior (roof overhang effect)
 *   - Foundry normal Walls on building interior (floor edge)
 * ============================================================================
 *
 * Wrapped in CavrilTools.enterEncounter so the CityHUD title-bar button
 * can trigger it on demand instead of the IIFE firing at world load.
 */

window.CavrilTools = window.CavrilTools || {};
window.CavrilTools.enterEncounter = async function() {
(async () => {
  const scene = canvas.scene;
  if (!scene) { ui.notifications.error("No active scene"); return; }

  // ╔═══════════════════════════════════════════════════════════╗
  // ║  ENCOUNTER SETTINGS                                      ║
  // ╚═══════════════════════════════════════════════════════════╝
  // v4: bumped to 240×200ft (~48×40 squares on a 5ft grid) so there's
  // more breathing room around the buildings + trees scatter across
  // the whole scene rather than packing into the centerline.
  const ENCOUNTER_WIDTH_FT  = 400;
  const ENCOUNTER_HEIGHT_FT = 400;
  const CHUNK = 500;
  const DELAY = 10;
  // Vegetation counts halved — old values gave a forest-cluster feel
  // around buildings; the new scene wants subtle landscaping.
  const TREE_COUNT = 40;
  const BUSH_COUNT = 25;
  const TREE_MIN_DIST_FT = 14;   // min distance from buildings/roads/water
  const BUSH_MIN_DIST_FT = 10;

  const PHASES = {
    // v3: cardinal-direction angles, evenly spaced for rogue gameplay.
    // dawn=left, midday=down (short), dusk=right, night=up (moonlight).
    dawn:   { sunAngle: Math.PI,         sunMult: 6.5, shadowColor: "#2a2a38", tintColor: "#ffb088", tintAlpha: 0.16 },
    midday: { sunAngle: Math.PI * 0.5,   sunMult: 2.0, shadowColor: "#2a2a2a", tintColor: null,      tintAlpha: 0    },
    dusk:   { sunAngle: 0,               sunMult: 6.5, shadowColor: "#382a2a", tintColor: "#d88a50", tintAlpha: 0.24 },
    night:  { sunAngle: -Math.PI * 0.5,  sunMult: 4.0, shadowColor: "#1a1e2a", tintColor: "#1a2848", tintAlpha: 0.45 }
  };
  const SEASONS_GRASS = { spring: "#82b14b", summer: "#5b7a40", autumn: "#8a7a3a", winter: "#b0b6bc" };
  const SEASONS_FOREST = { spring: "#3d5a28", summer: "#324726", autumn: "#a06820", winter: "#283238" };
  const Z_BG=0, Z_TERRAIN=1, Z_WATER=1.5, Z_ROADS=2, Z_SHADOW=3, Z_COVER=4, Z_WALLS=300, Z_FLOORS=400, Z_LINES=500, Z_DOORS=600, Z_TINT=900;

  const gridSize = scene.grid?.size ?? 100;
  const gridDist = scene.grid?.distance ?? 5;
  const pxPerFt = gridSize / gridDist;
  const halfWPx = (ENCOUNTER_WIDTH_FT  / 2) * pxPerFt;
  const halfHPx = (ENCOUNTER_HEIGHT_FT / 2) * pxPerFt;

  // ── Calendar ─────────────────────────────────────────────────────────────
  function phaseForHour(h){return h>=5&&h<10?"dawn":h>=10&&h<16?"midday":h>=16&&h<20?"dusk":"night";}
  function seasonForMonth(m){return m>=3&&m<=5?"spring":m>=6&&m<=8?"summer":m>=9&&m<=11?"autumn":"winter";}
  let activePhase,activeSeason,currentHour=12;
  try{const tc=game.time?.components;if(tc&&tc.hour!=null&&tc.month!=null){currentHour=tc.hour;activePhase=phaseForHour(tc.hour);activeSeason=seasonForMonth(tc.month+1);}
  else{activePhase=scene.getFlag("world","activePhase")||"midday";activeSeason=scene.getFlag("world","activeSeason")||"summer";}}
  catch(e){activePhase="midday";activeSeason="summer";}
  const phaseDef=PHASES[activePhase];

  function getViewCenter(){try{const r=canvas.app.renderer.screen,sc=new PIXI.Point(r.width/2,r.height/2),wc=canvas.stage.toLocal(sc);if(Number.isFinite(wc.x)&&Number.isFinite(wc.y))return wc;}catch(e){}return scene._viewPosition||{x:scene.dimensions.width/2,y:scene.dimensions.height/2};}
  const viewCenter=getViewCenter();

  // ── Blur overlay ─────────────────────────────────────────────────────────
  const overlay=document.createElement("div");overlay.id="cavril-enc-overlay";
  overlay.innerHTML=`<div style="position:fixed;inset:0;z-index:99999;backdrop-filter:blur(14px);background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;transition:opacity 0.4s ease;"><div style="background:rgba(20,20,30,0.9);border:1px solid rgba(255,255,255,0.12);border-radius:14px;padding:32px 56px;color:#e8e4dc;font-family:Signika,sans-serif;text-align:center;box-shadow:0 12px 48px rgba(0,0,0,0.6);"><div style="font-size:20px;font-weight:700;margin-bottom:8px;">⚔ Building Encounter</div><div style="font-size:13px;opacity:0.7;">${activePhase} · ${activeSeason} · ${ENCOUNTER_WIDTH_FT}×${ENCOUNTER_HEIGHT_FT}ft</div></div></div>`;
  document.body.appendChild(overlay);await new Promise(r=>setTimeout(r,80));

  // ── Helpers ──────────────────────────────────────────────────────────────
  function mixColor(h1,h2,r){const c1=parseInt(h1.slice(1),16),c2=parseInt(h2.slice(1),16);const r1=Math.round(((c1>>16)&255)*(1-r)+((c2>>16)&255)*r);const g=Math.round(((c1>>8)&255)*(1-r)+((c2>>8)&255)*r);const b=Math.round((c1&255)*(1-r)+(c2&255)*r);return"#"+((r1<<16)|(g<<8)|b).toString(16).padStart(6,"0");}
  function flattenPts(a){const o=[];for(const p of a)o.push(p[0],p[1]);return o;}
  function createDrawing(fp,type,fC,fA,sC,sW,sA,z,flags={}){if(!fp||fp.length<4)return null;const cp=[];for(let i=0;i<fp.length;i++){const p=Number(fp[i]);if(!Number.isFinite(p))return null;cp.push(p);}if(cp.length%2!==0)return null;let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;for(let i=0;i<cp.length;i+=2){if(cp[i]<x0)x0=cp[i];if(cp[i+1]<y0)y0=cp[i+1];if(cp[i]>x1)x1=cp[i];if(cp[i+1]>y1)y1=cp[i+1];}const rp=[];for(let i=0;i<cp.length;i+=2)rp.push(cp[i]-x0,cp[i+1]-y0);return{x:x0,y:y0,shape:{type,width:Math.max(x1-x0,1),height:Math.max(y1-y0,1),points:rp},fillType:fA>0?1:0,fillColor:fC||"#000000",fillAlpha:fA,strokeColor:sC,strokeWidth:sW,strokeAlpha:sA,z,sort:z,flags};}

  function subdivideAndNotchStochastic(pts,step,depth){if(!pts||pts.length<2)return pts;const out=[];for(let i=0;i<pts.length-1;i++){const p1=pts[i],p2=pts[i+1],dx=p2[0]-p1[0],dy=p2[1]-p1[1],len=Math.hypot(dx,dy);out.push(p1);if(len===0||len<step*1.5)continue;const bumps=Math.floor(len/step),ux=dx/len,uy=dy/len,nx=-uy,ny=ux,so=(len-bumps*step)/2;for(let b=0;b<bumps;b++){const sT=so+b*step,eT=sT+step,sx=p1[0]+ux*sT,sy=p1[1]+uy*sT,ex=p1[0]+ux*eT,ey=p1[1]+uy*eT;if(Math.random()>0.30){const d=Math.random()>0.5?1:-1,nX=nx*depth*d,nY=ny*depth*d;out.push([sx,sy],[sx+nX,sy+nY],[ex+nX,ey+nY],[ex,ey]);}else out.push([ex,ey]);}}out.push(pts[pts.length-1]);return out;}
  function subdivideAndNotch(pts,step,depth){if(!pts||pts.length<2)return pts;const out=[pts[0]];let ph=0;for(let i=0;i<pts.length-1;i++){const p1=pts[i],p2=pts[i+1],dx=p2[0]-p1[0],dy=p2[1]-p1[1],len=Math.hypot(dx,dy);if(len===0)continue;const ux=dx/len,uy=dy/len,nx=-uy,ny=ux,ds=0.6+Math.random()*0.6,ld=depth*ds,bumps=Math.max(2,Math.floor(len/step));for(let b=1;b<=bumps;b++){const t=b/bumps,px=p1[0]+ux*len*t,py=p1[1]+uy*len*t,s=(b+ph)%2===0?1:-1;out.push([px+nx*ld*s,py+ny*ld*s]);}ph=(ph+(Math.random()>0.5?1:0))%2;}return out;}
  function subdivideAndJitter(pts,step,jPx){if(!pts||pts.length<2)return pts;const out=[];for(let i=0;i<pts.length-1;i++){const p1=pts[i],p2=pts[i+1],dx=p2[0]-p1[0],dy=p2[1]-p1[1],len=Math.hypot(dx,dy);out.push(p1);if(len<step*2)continue;const segs=Math.floor(len/step),ux=dx/len,uy=dy/len,nx=-uy,ny=ux;for(let s=1;s<segs;s++){const t=s/segs,jit=(Math.random()-0.5)*2*jPx;out.push([p1[0]+dx*t+nx*jit,p1[1]+dy*t+ny*jit]);}}out.push(pts[pts.length-1]);return out;}

  function getExtrudedShadow(pts,oX,oY){if(!pts||pts.length<3)return pts;let area=0;for(let i=0;i<pts.length;i++)area+=(pts[i][0]*pts[(i+1)%pts.length][1]-pts[(i+1)%pts.length][0]*pts[i][1]);let wp=[...pts];if(area/2<0)wp.reverse();const n=wp.length,mv=[];for(let i=0;i<n;i++){const p1=wp[i],p2=wp[(i+1)%n],dx=p2[0]-p1[0],dy=p2[1]-p1[1];mv.push((dy*oX+(-dx)*oY)>0);}const sp=[];for(let i=0;i<n;i++){const prev=(i-1+n)%n,p=wp[i];if(mv[i]){if(!mv[prev]){sp.push([p[0],p[1]]);sp.push([p[0]+oX,p[1]+oY]);}else sp.push([p[0]+oX,p[1]+oY]);}else{if(mv[prev]){sp.push([p[0]+oX,p[1]+oY]);sp.push([p[0],p[1]]);}else sp.push([p[0],p[1]]);}}if(sp.length>0)sp.push(sp[0]);return sp;}
  function buildEdgeShadows(c,oX,oY){if(!c||c.length<2)return[];const cl=c[0][0]===c[c.length-1][0]&&c[0][1]===c[c.length-1][1];const w=cl?c.slice(0,-1):c;if(w.length<2)return[];let a=0;if(cl)for(let i=0;i<w.length;i++){const aa=w[i],bb=w[(i+1)%w.length];a+=aa[0]*bb[1]-bb[0]*aa[1];}const cw=a>0,q=[],ec=cl?w.length:w.length-1;for(let i=0;i<ec;i++){const aa=w[i],bb=w[(i+1)%w.length],dx=bb[0]-aa[0],dy=bb[1]-aa[1],onx=cw?-dy:dy,ony=cw?dx:-dx;if(cl?(onx*-oX+ony*-oY)>0:true)q.push([aa[0],aa[1],bb[0],bb[1],bb[0]+oX,bb[1]+oY,aa[0]+oX,aa[1]+oY,aa[0],aa[1]]);}return q;}

  function getPerspectivePoly(p1,p2,cx,cy,t,wPx,sBot,sTop){const dx=p2[0]-p1[0],dy=p2[1]-p1[1],el=Math.hypot(dx,dy);if(el===0)return null;const ux=dx/el,uy=dy/el,mx=p1[0]+dx*t,my=p1[1]+dy*t;const o1x=mx-ux*(wPx/2),o1y=my-uy*(wPx/2),o2x=mx+ux*(wPx/2),o2y=my+uy*(wPx/2);return[cx+(o1x-cx)*sBot,cy+(o1y-cy)*sBot,cx+(o2x-cx)*sBot,cy+(o2y-cy)*sBot,cx+(o2x-cx)*sTop,cy+(o2y-cy)*sTop,cx+(o1x-cx)*sTop,cy+(o1y-cy)*sTop];}
  function pickDoorEdges(edges,ft){if(!edges||edges.length===0)return[];const p=edges.reduce((s,e)=>s+e.len,0)/ft,m=p<80?1:2,ch=[];for(const e of edges){if(ch.length>=m)break;const dx=e.p2[0]-e.p1[0],dy=e.p2[1]-e.p1[1],l=Math.hypot(dx,dy)||1,nx=dx/l,ny=dy/l;let par=false;for(const c of ch){const cd=c.p2[0]-c.p1[0],cdy=c.p2[1]-c.p1[1],cl=Math.hypot(cd,cdy)||1;if(Math.abs(nx*(cd/cl)+ny*(cdy/cl))>0.9){par=true;break;}}if(!par)ch.push(e);}return ch;}

  // Point-in-polygon check (ray casting)
  function pointInPoly(px,py,poly){let inside=false;for(let i=0,j=poly.length-1;i<poly.length;j=i++){const xi=poly[i][0],yi=poly[i][1],xj=poly[j][0],yj=poly[j][1];if(((yi>py)!==(yj>py))&&(px<(xj-xi)*(py-yi)/(yj-yi)+xi))inside=!inside;}return inside;}

  // Check if ALL vertices of coords are inside bbox
  function allInside(coords,minX,minY,maxX,maxY){
    for(const[x,y]of coords){if(x<minX||x>maxX||y<minY||y>maxY)return false;}return true;
  }

  // Sutherland-Hodgman polygon clip to an axis-aligned rectangle.
  // Works correctly for convex clip regions (rectangles) against any
  // subject polygon — including the non-convex river/canal shapes FTG
  // produces. Returns an array of [x,y] pairs (empty if fully outside).
  // Used to clip water polygons to the encounter/full-map bounds so the
  // drawing anchor stays near the scene instead of thousands of px away,
  // which prevents Foundry's renderer from silently discarding the drawing.
  function clipPolygonToRect(verts, minX, minY, maxX, maxY) {
    function clip(poly, inside, isect) {
      if (!poly.length) return [];
      const out = [], n = poly.length;
      for (let i = 0; i < n; i++) {
        const c = poly[i], p = poly[(i - 1 + n) % n];
        const ci = inside(c), pi = inside(p);
        if (ci) { if (!pi) out.push(isect(p,c)); out.push(c); }
        else if (pi) out.push(isect(p,c));
      }
      return out;
    }
    function ix(x,a,b){const t=(x-a[0])/(b[0]-a[0]);return[x,a[1]+(b[1]-a[1])*t];}
    function iy(y,a,b){const t=(y-a[1])/(b[1]-a[1]);return[a[0]+(b[0]-a[0])*t,y];}
    let p=verts;
    p=clip(p,v=>v[0]>=minX,(a,b)=>ix(minX,a,b));
    p=clip(p,v=>v[0]<=maxX,(a,b)=>ix(maxX,a,b));
    p=clip(p,v=>v[1]>=minY,(a,b)=>iy(minY,a,b));
    p=clip(p,v=>v[1]<=maxY,(a,b)=>iy(maxY,a,b));
    return p;
  }

  // ── Pass 1: Define the encounter box (or full-map bounds), gather everything
  // Encounter mode: box centered on the GM's current view, sized by ENCOUNTER_*_FT.
  // Full-map mode: box = entire overworld scene → every building and feature included.
  const eMinX = viewCenter.x - halfWPx;
  const eMaxX = viewCenter.x + halfWPx;
  const eMinY = viewCenter.y - halfHPx;
  const eMaxY = viewCenter.y + halfHPx;

  // Helper: any vertex of `coords` falls inside the encounter/full-map box.
  function anyInside(coords) {
    for (const [x, y] of coords) {
      if (x >= eMinX && x <= eMaxX && y >= eMinY && y <= eMaxY) return true;
    }
    return false;
  }

  const candidateBuildings = [];
  for (const dwg of scene.drawings.contents) {
    const f = dwg.flags?.world;
    if (!f || !f.isBuildingOutline || !f.srcCoords || f.buildingId == null) continue;
    // Strict all-vertices-inside rule prevents half-clipped buildings at the perimeter.
    if (!allInside(f.srcCoords, eMinX, eMinY, eMaxX, eMaxY)) continue;
    candidateBuildings.push({ dwg, f });
  }
  if (candidateBuildings.length === 0) {
    overlay.remove();
    ui.notifications.error(`No buildings in the ${ENCOUNTER_WIDTH_FT}×${ENCOUNTER_HEIGHT_FT}ft area.`);
    return;
  }
  const buildingsInRadius = candidateBuildings;   // variable name kept for compatibility below

  const PADDING = 100;
  const offX = PADDING - eMinX, offY = PADDING - eMinY;
  const encW = Math.ceil(eMaxX - eMinX + PADDING*2), encH = Math.ceil(eMaxY - eMinY + PADDING*2);
  function txCoords(c){return c.map(([x,y])=>[x+offX,y+offY]);}
  function txEdges(edges){return edges.map(e=>({p1:[e.p1[0]+offX,e.p1[1]+offY],p2:[e.p2[0]+offX,e.p2[1]+offY],len:e.len}));}

  // ── Pass 2: Gather non-building elements ────────────────────────────────
  // Water/river drawings must render UNDER roads (Z_ROADS=2) regardless
  // of the z-value they had on the overworld. Detection covers all naming
  // conventions: explicit flags (isWater/isRiver), terrainType strings, and
  // a fill-color heuristic for imports that lost the flag but kept the blue.
  // isWaterishFill — detects blue-leaning fill colors that indicate water.
  // Handles three formats Foundry may hand back:
  //   "#rrggbb"   — standard 6-digit hex string (V12 default)
  //   "#aarrggbb" — 8-digit with alpha prefix (some V13 paths)
  //   number      — packed RGB integer (Foundry stores colors as 0xRRGGBB in some contexts)
  function isWaterishFill(raw) {
    if (!raw && raw !== 0) return false;
    let r, g, b;
    if (typeof raw === "number") {
      r = (raw >> 16) & 0xff; g = (raw >> 8) & 0xff; b = raw & 0xff;
    } else if (typeof raw === "string") {
      const s = raw.replace(/^#/, "");
      const off = s.length === 8 ? 2 : 0;   // skip AA prefix for 8-digit
      r = parseInt(s.slice(off,   off+2), 16);
      g = parseInt(s.slice(off+2, off+4), 16);
      b = parseInt(s.slice(off+4, off+6), 16);
    } else { return false; }
    return Number.isFinite(b) && b > r + 10 && b < 200;   // blue-leaning, not sky-white
  }
  const wallsToRebuild=[],fencesToRebuild=[],roadsToRebuild=[],copyDrawings=[];
  for(const dwg of scene.drawings.contents){
    const f=dwg.flags?.world; if(!f)continue;
    if(f.isBuildingOutline||f.isBuildingFloor||f.isDoor||f.isWindow||f.isBuildingCornerLine)continue;
    if(f.isShadow||f.isBuildingShadow||f.isWallShadow||f.isFenceShadow||f.isPhaseTint)continue;
    if(f.terrainType==="BACKGROUND")continue;

    // ── Feature inclusion strategy ─────────────────────────────────────────
    //
    // TWO different tests used depending on how the feature is processed:
    //
    // bboxHits  — drawing's own bounding box overlaps the encounter rect.
    //   Used for ROADS, WALLS, FENCES, and WATER because those features
    //   are subsequently clipped (roads/walls/fences via clipPolylineToScene;
    //   water is fine as a raw polygon since it's designed to span the full
    //   map). A straight pier road whose endpoints are both outside the
    //   encounter box DOES have a bbox that overlaps it — bboxHits catches it;
    //   anyInside would silently drop it.
    //
    // anyInside — at least one srcCoord vertex falls inside the encounter rect.
    //   Used for TERRAIN POLYGONS that are simply offset-copied without any
    //   further clipping. bboxHits on terrain is too permissive: large LAWN /
    //   grass wedge polygons between canal branches have bboxes that span the
    //   whole settlement — they would be included and their full unclamped
    //   shapes would paint large coloured triangles over the encounter.
    //   anyInside naturally excludes them (vertices are at the outer tips of
    //   the wedge, outside the encounter box) while still catching compact
    //   cobblestone quay terrain whose canal-edge vertices sit inside.
    function bboxHits(d) {
      const dx=d.x, dy=d.y, dw=d.shape?.width??0, dh=d.shape?.height??0;
      return !(dx+dw<eMinX || dx>eMaxX || dy+dh<eMinY || dy>eMaxY);
    }

    if(f.isWall&&f.srcCoords){if(bboxHits(dwg))wallsToRebuild.push({dwg,f});continue;}
    if(f.isFence&&f.srcCoords){if(bboxHits(dwg))fencesToRebuild.push({dwg,f});continue;}
    if(f.isRoad&&!f.isRoadJoint&&f.srcCoords){if(bboxHits(dwg))roadsToRebuild.push({dwg,f});continue;}
    if(f.isRoadJoint)continue;

    // WATER / RIVERS — Sutherland-Hodgman clip to scene bounds, then create
    // a clean new drawing. Raw copy-and-offset doesn't work: the unclamped
    // water polygon's anchor (dwg.x) can be thousands of pixels off-scene,
    // which causes Foundry's renderer to silently discard the drawing even
    // though part of the polygon passes through the encounter area.
    const tt=String(f.terrainType||"").toUpperCase();
    const isWaterDrawing = f.isWater || f.isRiver || tt==="WATER" || tt==="RIVER" ||
                           (f.isTerrain && isWaterishFill(dwg.fillColor));
    if(isWaterDrawing){
      if(bboxHits(dwg)){
        // Reconstruct encounter-space absolute vertices from the drawing's
        // relative shape.points and its overworld anchor (dwg.x, dwg.y).
        const pts = dwg.shape?.points ?? [];
        const encVerts = [];
        for(let i=0; i+1<pts.length; i+=2)
          encVerts.push([dwg.x + offX + pts[i], dwg.y + offY + pts[i+1]]);
        // Remove the importer's closing-vertex duplicate (last point == first).
        // The SH clipper treats the polygon as implicitly closed; feeding it a
        // pre-closed polygon creates a degenerate zero-length seam edge that
        // can corrupt the clipped output.
        if(encVerts.length > 1){
          const f0=encVerts[0], fL=encVerts[encVerts.length-1];
          if(Math.abs(f0[0]-fL[0])<0.1 && Math.abs(f0[1]-fL[1])<0.1) encVerts.pop();
        }
        console.log(`[Enc water] dwg ${dwg.id} → ${encVerts.length} verts | anchor(${Math.round(dwg.x)},${Math.round(dwg.y)}) sz(${Math.round(dwg.shape?.width??0)}×${Math.round(dwg.shape?.height??0)}) | fill=${JSON.stringify(dwg.fillColor)}`);
        if(encVerts.length >= 3){
          // Segment water into horizontal strips so each drawing's anchor
          // stays within scene bounds regardless of how far the original
          // polygon extends off-scene upstream/downstream.
          // Critically: each strip is a closed polygon (PIXI requires the
          // first point repeated at the end of shape.points for fill).
          const ov = 2 * pxPerFt;
          const STRIP_H = 10 * pxPerFt; // 10ft strips = 2 grid squares
          const numStrips = Math.ceil((encH + 2*ov) / STRIP_H) + 1;
          let stripsHit = 0;
          for(let s = 0; s < numStrips; s++){
            const sy  = s * STRIP_H - ov;
            const sy2 = sy + STRIP_H;
            const strip = clipPolygonToRect(encVerts, -ov, sy, encW+ov, sy2);
            if(strip.length < 3) continue;
            const sFlat = flattenPts(strip);
            sFlat.push(sFlat[0], sFlat[1]); // close polygon — Foundry/PIXI fill requires first point repeated
            const wDwg = createDrawing(sFlat, "p",
              dwg.fillColor, dwg.fillAlpha ?? 1.0,
              dwg.strokeColor || "#000", dwg.strokeWidth || 0, dwg.strokeAlpha || 0,
              Z_WATER, {world:{isWater:true, terrainType:"WATER"}});
            if(wDwg){ copyDrawings.push(wDwg); stripsHit++; }
          }
          console.log(`[Enc water]   → ${stripsHit}/${numStrips} strips produced drawings`);
        }
      }
      continue;
    }

    // TERRAIN POLYGONS — skip entirely.
    // Terrain polys (LAWN, COBBLESTONE, GRASS patches, etc.) are BACKGROUND
    // fills that are larger than or equal to the encounter region. Copy-and-
    // offset without geometry clipping means the full unclamped polygon gets
    // sent to Foundry — which then renders huge coloured triangles and wedges
    // that dominate the scene (canal-flanking LAWN polygons, tilled-field
    // patches, etc.). The encounter already has everything it needs:
    //   • Fresh grass background polygon (line ~260)
    //   • Roads rebuilt from srcCoords + clipped to scene
    //   • Water copied permissively with bboxHits
    //   • Buildings fully redrawn from srcCoords
    // Adding raw terrain copies only introduces artifacts. If a cobblestone
    // quay is needed in future, generate it procedurally (e.g. buffer the
    // water bbox by the road stroke width, fill with stone colour).
    if(f.isTerrain)continue;

    // Non-terrain structures (gate towers, misc markers) — compact and safe
    // to offset-copy directly. Use srcCoords vertex check where available.
    if(f.srcCoords){
      if(!anyInside(f.srcCoords))continue;
    } else {
      if(!bboxHits(dwg))continue;
    }
    const copy=dwg.toObject();copy.x+=offX;copy.y+=offY;delete copy._id;copyDrawings.push(copy);
  }
  // Second pass: blue-fill drawings with NO flags.world — strip-segmented clip.
  // Same strip approach as the main water pass: horizontal bands keep each
  // drawing's anchor in-scene and ensure closed polygon shape for PIXI fill.
  for(const dwg of scene.drawings.contents){
    if(dwg.flags?.world)continue;
    if(!isWaterishFill(dwg.fillColor))continue;
    const dx=dwg.x,dy=dwg.y,dw=dwg.shape?.width??0,dh=dwg.shape?.height??0;
    if(dx+dw<eMinX||dx>eMaxX||dy+dh<eMinY||dy>eMaxY)continue;
    const pts=dwg.shape?.points??[];
    const ev=[];for(let i=0;i+1<pts.length;i+=2)ev.push([dx+offX+pts[i],dy+offY+pts[i+1]]);
    if(ev.length<3)continue;
    const ov=2*pxPerFt;
    const STRIP_H=10*pxPerFt;
    const numStrips=Math.ceil((encH+2*ov)/STRIP_H)+1;
    for(let s=0;s<numStrips;s++){
      const sy=s*STRIP_H-ov,sy2=sy+STRIP_H;
      const cl=clipPolygonToRect(ev,-ov,sy,encW+ov,sy2);
      if(cl.length<3)continue;
      const sFlat=flattenPts(cl);sFlat.push(sFlat[0],sFlat[1]);
      const wD=createDrawing(sFlat,"p",dwg.fillColor,dwg.fillAlpha??1.0,
        dwg.strokeColor||"#000",dwg.strokeWidth||0,dwg.strokeAlpha||0,
        Z_WATER,{world:{isWater:true,terrainType:"WATER"}});
      if(wD)copyDrawings.push(wD);
    }
  }

  // ── Create encounter scene ───────────────────────────────────────────────
  const grassColor=SEASONS_GRASS[activeSeason]||"#5b7a40";
  const forestColor=SEASONS_FOREST[activeSeason]||"#324726";
  const softShadowColor=mixColor(phaseDef.shadowColor,grassColor,0.30);
  const FT=pxPerFt;

  const sceneFolder=game.folders.find(f=>f.type==="Scene"&&f.name==="Encounters (Generated)")||await Folder.create({name:"Encounters (Generated)",type:"Scene",color:"#c0392b"});
  // Delete the previous generated encounter so the folder doesn't fill up.
  const oldEnc=game.scenes.find(s=>s.getFlag("world","isEncounterScene"));if(oldEnc)try{await oldEnc.delete();}catch(e){}

  const FOG_COLOR = "#342618";
  const encScene=await Scene.create({
    name: `Encounter — ${buildingsInRadius.length} buildings`,
    folder:sceneFolder.id,
    // padding:0 keeps the scene's coordinate origin at the playable
    // top-left so the rendered area isn't visually offset. Long
    // polylines (roads/walls/fences) that extend past the scene are
    // clipped explicitly below to a slightly-overhanging rectangle so
    // their drawing bboxes stay bounded — that's what stops Foundry's
    // renderer from doing weird things with off-scene geometry. The
    // previous padding=0.25 approach worked but made the scene read
    // as top-left justified inside an enlarged canvas; clipping in
    // code is the centered alternative.
    width:encW,height:encH,padding:0,
    grid:{size:20,distance:5,units:"ft",type:0,alpha:0,style:"solidLines",thickness:1,color:"#000000"},
    backgroundColor:FOG_COLOR,
    tokenVision:true,
    environment:{
      darknessLevel:0, darknessLock:false,
      globalLight:{enabled:true,alpha:0.5,bright:false,color:null,coloration:1,luminosity:0,saturation:0,contrast:0,shadows:0},
      cycle:true
    },
    fog:{mode:2,colors:{explored:FOG_COLOR,unexplored:FOG_COLOR}},
    navigation:false,
    flags:{
      world:{isEncounterScene:true,overworldSceneId:scene.id,sceneMode:"encounter",
        viewCenter:{x:viewCenter.x,y:viewCenter.y},activePhase,activeSeason,offsetX:offX,offsetY:offY},
      "wgtgm-mini-calendar":{enableDarkness:false,enableWeather:true}
    }
  });

  // Link CityHUD to the same master journal so citizen/building lookups work
  const cityJournalId = scene.getFlag("world", "cityJournalId");
  if (cityJournalId) await encScene.setFlag("world", "cityJournalId", cityJournalId);

  // ── Build drawings ───────────────────────────────────────────────────────
  const toCreate=[];
  const pSC="#000000",pSW=1,pSA=0.5;

  // BACKGROUND
  const bg=createDrawing([0,0,encW,0,encW,encH,0,encH,0,0],"p",grassColor,1.0,"#000",0,0,Z_BG,{world:{isTerrain:true,terrainType:"BACKGROUND"}});
  if(bg)toCreate.push(bg);

  // COPIED (water + compact non-terrain structures like gate towers)
  // Terrain polygons are excluded upstream (see "TERRAIN POLYGONS — skip"
  // comment). copyDrawings now contains only water drawings and the
  // occasional non-terrain structure.
  toCreate.push(...copyDrawings);

  // Polyline-to-rect clipper (Liang-Barsky per segment). Returns an
  // array of sub-polylines [[[x,y],…], …] where each sub-polyline is
  // a contiguous portion of the input that lies inside the rect. Off-
  // scene portions get dropped at the boundary so each resulting
  // drawing's bbox stays bounded — that's the key to keeping Foundry's
  // renderer from doing weird things with hundreds-of-feet-off-scene
  // geometry. Open-polyline input only (don't pre-close the loop;
  // closed shapes need Sutherland-Hodgman).
  //
  // OVERHANG = small overshoot past the scene edge so clipped ends
  // butt up cleanly against the boundary rather than stopping a hair
  // short of it.
  const OVERHANG = 2 * FT;
  function clipPolylineToScene(coords) {
    if (!Array.isArray(coords) || coords.length < 2) return [];
    const minX = -OVERHANG, minY = -OVERHANG;
    const maxX = encW + OVERHANG, maxY = encH + OVERHANG;
    function clipSeg(p1, p2) {
      let x1=p1[0], y1=p1[1], x2=p2[0], y2=p2[1];
      const dx=x2-x1, dy=y2-y1;
      const p=[-dx, dx, -dy, dy];
      const q=[x1-minX, maxX-x1, y1-minY, maxY-y1];
      let u1=0, u2=1;
      for (let i=0; i<4; i++) {
        if (p[i] === 0) { if (q[i] < 0) return null; continue; }
        const t = q[i] / p[i];
        if (p[i] < 0) { if (t > u2) return null; if (t > u1) u1 = t; }
        else          { if (t < u1) return null; if (t < u2) u2 = t; }
      }
      return [[x1+u1*dx, y1+u1*dy], [x1+u2*dx, y1+u2*dy]];
    }
    const out = [];
    let current = [];
    const eq = (a,b) => Math.abs(a[0]-b[0])<0.001 && Math.abs(a[1]-b[1])<0.001;
    for (let i=0; i<coords.length-1; i++) {
      const seg = clipSeg(coords[i], coords[i+1]);
      if (!seg) {
        if (current.length >= 2) out.push(current);
        current = [];
        continue;
      }
      if (current.length === 0) current.push(seg[0], seg[1]);
      else if (eq(current[current.length-1], seg[0])) current.push(seg[1]);
      else {
        if (current.length >= 2) out.push(current);
        current = [seg[0], seg[1]];
      }
    }
    if (current.length >= 2) out.push(current);
    return out;
  }

  // ROADS — with jitter for natural feel.
  //
  // Each road's transformed polyline is clipped to the scene rect
  // (with a tiny overhang) so partially-off-scene roads contribute
  // only their in-scene portion. Each surviving sub-polyline becomes
  // its own road drawing, and stores its CLIPPED srcCoords so the
  // road graph extracted later matches what's actually rendered.
  //
  // Wedge fix: jittered polylines have lots of small bends. At each
  // bend the constant-width stroke creates a pie-shaped wedge on the
  // outside of the turn that reveals the grass underneath. Drop a
  // road-colored circle at every ORIGINAL vertex (sharp bends) plus
  // every 4th jittered intermediate (sparse mid-segment safety) to
  // plug those gaps. Bump sort by +0.01 so joints render just above
  // their road's stroke.
  const ROAD_COLOR="#8c6e4a";
  const jointZ = Z_ROADS + 0.01;
  function pushRoadJoint(pt, sw, color) {
    toCreate.push({
      x:pt[0]-sw/2, y:pt[1]-sw/2,
      shape:{type:"e",width:sw,height:sw},
      fillType:1, fillColor:color, fillAlpha:1.0,
      strokeWidth:0, strokeColor:"#000", strokeAlpha:0,
      z:jointZ, sort:jointZ,
      flags:{world:{isRoad:true,isRoadJoint:true}}
    });
  }
  for(const rd of roadsToRebuild){
    const coords=txCoords(rd.f.srcCoords);
    const sw = rd.dwg.strokeWidth||10;
    const roadColor = rd.dwg.strokeColor||ROAD_COLOR;
    for (const seg of clipPolylineToScene(coords)) {
      const jittered=subdivideAndJitter(seg,1.0*FT,0.15*FT);
      const fPts=flattenPts(jittered);
      const rDwg=createDrawing(fPts,"p",null,0,roadColor,sw,1.0,Z_ROADS,{world:{isRoad:true,srcCoords:seg}});
      if(rDwg)toCreate.push(rDwg);
      // Only place joints at the original polyline vertices (true segment
      // intersections). The old mid-segment loop (every 4th jitter point)
      // created a visible dotted-line pattern along the entire road.
      for (const pt of seg) pushRoadJoint(pt, sw, roadColor);
    }
  }

  // WALLS — clipped, notched, 1.5× thicker, + shadows
  for(const w of wallsToRebuild){
    const coords=txCoords(w.f.srcCoords);
    const sw = Math.round(w.dwg.strokeWidth*1.5);
    const hf = w.f.srcHeightFactor||8;
    const sd = hf*phaseDef.sunMult*FT;
    const sox = Math.cos(phaseDef.sunAngle)*sd;
    const soy = Math.sin(phaseDef.sunAngle)*sd;
    for (const seg of clipPolylineToScene(coords)) {
      const notched=subdivideAndNotch(seg,3.5*FT,0.4*FT);
      const wPts=flattenPts(notched);
      const wDwg=createDrawing(wPts,"p",null,0,w.dwg.strokeColor,sw,1.0,Z_WALLS,{world:{isWall:true,srcCoords:seg,srcHeightFactor:hf}});
      if(wDwg)toCreate.push(wDwg);
      for(const q of buildEdgeShadows(seg,sox,soy)){
        const d=createDrawing(q,"p",softShadowColor,1.0,"#000",0,0,Z_SHADOW,{world:{isShadow:true,isWallShadow:true,phase:activePhase}});
        if(d)toCreate.push(d);
      }
    }
  }

  // FENCES — clipped, notched + shadows
  for(const fe of fencesToRebuild){
    const coords=txCoords(fe.f.srcCoords);
    const hf = fe.f.srcHeightFactor||0.7;
    const sd = hf*phaseDef.sunMult*FT;
    const sox = Math.cos(phaseDef.sunAngle)*sd;
    const soy = Math.sin(phaseDef.sunAngle)*sd;
    for (const seg of clipPolylineToScene(coords)) {
      const notched=subdivideAndNotchStochastic(seg,1.5*FT,0.3*FT);
      const fPts=flattenPts(notched);
      const fDwg=createDrawing(fPts,"p",null,0,fe.dwg.strokeColor,fe.dwg.strokeWidth,0.95,Z_WALLS,{world:{isFence:true,srcCoords:seg}});
      if(fDwg)toCreate.push(fDwg);
      for(const q of buildEdgeShadows(seg,sox,soy)){
        const d=createDrawing(q,"p",softShadowColor,1.0,"#000",0,0,Z_SHADOW,{world:{isShadow:true,isFenceShadow:true,phase:activePhase}});
        if(d)toCreate.push(d);
      }
    }
  }

  // Collect building polys for tree exclusion
  const allBuildingPolys=[];
  const allRoadPolys=[];
  const foundryWalls=[];

  // ── Pier / bridge detection ─────────────────────────────────────────────────
  // Keyword list (keep in sync with cavril-importer.js _PIER_KW).
  const PIER_KW=["PIER","DOCK","DOCKYARD","WHARF","JETTY","QUAY","HARBOR","HARBOUR",
                  "LANDING","GANGWAY","BOARDWALK","BRIDGE","FOOTBRIDGE","PONTOON",
                  "VIADUCT","CAUSEWAY","DRAWBRIDGE","CROSSING"];
  function isBldgPierType(bType){
    if(!bType)return false;
    const t=String(bType).toUpperCase();
    return PIER_KW.some(k=>t.includes(k));
  }

  // Collect encounter-space water polygon coords for geometric pier fallback.
  // Buildings whose centroid is over water are bridges/piers regardless of
  // how the overworld import labelled their buildingType.
  const _encWaterPolys=[];
  for(const dwg of scene.drawings.contents){
    const f=dwg.flags?.world; if(!f)continue;
    const tt=String(f.terrainType||"").toUpperCase();
    if(!(f.isWater||f.isRiver||tt==="WATER"||tt==="RIVER"))continue;
    const pts=dwg.shape?.points??[];
    if(pts.length<6)continue;
    const poly=[];
    for(let i=0;i+1<pts.length;i+=2) poly.push([dwg.x+offX+pts[i],dwg.y+offY+pts[i+1]]);
    if(poly.length>=3)_encWaterPolys.push(poly);
  }

  // BUILDINGS — full detail (regular) or flat-deck (pier/bridge types)
  for(const b of buildingsInRadius){
    const f=b.f,bId=f.buildingId;
    const coords=txCoords(f.srcCoords);
    const cx=f.srcCx+offX,cy=f.srcCy+offY;
    const stories=f.srcStories||1;
    const trimColor=f.srcTrimColor||"#444444";
    const centerColor=f.srcCenterColor||"#888888";
    // Tier 1: keyword match
    let isPier=isBldgPierType(f.buildingType);
    // Tier 2: geometric fallback — centroid over water = bridge/pier
    if(!isPier && _encWaterPolys.length>0){
      for(const wp of _encWaterPolys){
        if(pointInPoly(cx,cy,wp)){isPier=true;break;}
      }
    }

    allBuildingPolys.push(coords);

    // OUTLINE with notch — same for all building types.
    // Pier/bridge: no stroke (pSW=0, pSA=0) — timber edges need no framing line.
    // Regular: thin semi-transparent outline (pSW=1, pSA=0.5).
    const oSW=isPier?0:pSW, oSA=isPier?0:pSA;
    const notchedOutline=subdivideAndNotchStochastic(coords,2.5*FT,0.2*FT);
    const closedOutline=[...notchedOutline];closedOutline.push(closedOutline[0]);
    const oPts=flattenPts(closedOutline);
    const oDwg=createDrawing(oPts,"p",trimColor,1.0,pSC,oSW,oSA,Z_WALLS,
      {world:{isBuildingOutline:true,buildingId:bId,buildingType:f.buildingType,buildingName:f.buildingName,
        srcCoords:coords,srcStories:stories,srcCx:cx,srcCy:cy,srcTrimColor:trimColor,srcCenterColor:centerColor,
        srcValidEdges:txEdges(f.srcValidEdges||[]),srcFtToPx:FT}});
    if(oDwg)toCreate.push(oDwg);

    if(isPier){
      // Pier/bridge/dock — flat open deck: no floor inset, no doors/windows,
      // no corner lines, no shadow (water-level structures cast negligible shadow),
      // no Foundry vision walls (tokens can cross freely).
      // The notched outline above is the entire visual — weathered timber edges.
      continue;
    }

    // FLOOR (0.85 inset)
    const floorCoords=coords.map(([x,y])=>[cx+(x-cx)*0.85,cy+(y-cy)*0.85]);
    const fPts=flattenPts(floorCoords);fPts.push(fPts[0],fPts[1]);
    const flDwg=createDrawing(fPts,"p",centerColor,1.0,pSC,pSW,pSA,Z_FLOORS,{world:{isBuildingFloor:true,buildingId:bId}});
    if(flDwg)toCreate.push(flDwg);

    // SHADOW (extruded)
    const sd=stories*phaseDef.sunMult*FT,sOX=Math.cos(phaseDef.sunAngle)*sd,sOY=Math.sin(phaseDef.sunAngle)*sd;
    const shadowBase=getExtrudedShadow(coords,sOX,sOY);
    if(shadowBase&&shadowBase.length>=3){const ns=subdivideAndNotchStochastic(shadowBase,4.0*FT,0.2*FT);const sd2=createDrawing(flattenPts(ns),"p",softShadowColor,1.0,"#000",0,0,Z_SHADOW,{world:{isShadow:true,isBuildingShadow:true,buildingId:bId,phase:activePhase}});if(sd2)toCreate.push(sd2);}

    // DOORS + WINDOWS + CORNERS
    const edges=txEdges(f.srcValidEdges||[]);
    const doorColor=mixColor(trimColor,"#000000",0.25),winColor=mixColor(centerColor,"#d8c4a0",0.25),cornerColor=mixColor(trimColor,"#000000",0.30);
    const doorEdges=pickDoorEdges(edges,pxPerFt);

    for(const edge of doorEdges){const ts=edge.len>50*FT?[0.46,0.54]:[0.5];for(const t of ts){const poly=getPerspectivePoly(edge.p1,edge.p2,cx,cy,t,4.5*FT,0.85,0.92);const d=createDrawing(poly,"p",doorColor,1.0,pSC,pSW,pSA,Z_DOORS,{world:{isDoor:true,buildingId:bId}});if(d)toCreate.push(d);}}
    for(const edge of edges){const isDoorEdge=doorEdges.includes(edge);let nw=Math.floor(edge.len/(18*FT));if(nw===0&&edge.len>=12*FT)nw=1;if(nw===0)continue;const step=1.0/(nw+1);for(let w=1;w<=nw;w++){if(isDoorEdge&&Math.abs(w*step-0.5)<0.25)continue;const poly=getPerspectivePoly(edge.p1,edge.p2,cx,cy,w*step,3.5*FT,0.89,0.96);const d=createDrawing(poly,"p",winColor,1.0,pSC,pSW,pSA,Z_DOORS,{world:{isWindow:true,buildingId:bId}});if(d)toCreate.push(d);}}
    for(let i=0;i<coords.length;i++){const ox=coords[i][0],oy=coords[i][1],ix=cx+(ox-cx)*0.85,iy=cy+(oy-cy)*0.85;if(Math.hypot(ox-ix,oy-iy)<1)continue;const d=createDrawing([ox,oy,ix,iy],"p","#000000",0,cornerColor,1,1.0,Z_LINES,{world:{isBuildingCornerLine:true,buildingId:bId}});if(d)toCreate.push(d);}

    // FOUNDRY WALLS — one-directional so the trim/roof is always visible.
    // Exterior: blocks vision INWARD (outside can't see past into building)
    // Interior: blocks vision OUTWARD (inside can't see past to outside)
    // The strip between them (the roof overhang) is always visible from either side.
    for(let i=0;i<coords.length;i++){
      const a=coords[i],b=coords[(i+1)%coords.length];
      foundryWalls.push({c:[a[0],a[1],b[0],b[1]],move:20,sense:20,dir:1,door:0,ds:0});  // blocks from outside
    }
    for(let i=0;i<floorCoords.length;i++){
      const a=floorCoords[i],b=floorCoords[(i+1)%floorCoords.length];
      foundryWalls.push({c:[a[0],a[1],b[0],b[1]],move:20,sense:20,dir:2,door:0,ds:0});  // blocks from inside
    }
    // No door walls — just the two vision rings.
  }

  // TREES + BUSHES — scattered on grass, away from structures
  const treeMinDist=TREE_MIN_DIST_FT*FT,bushMinDist=BUSH_MIN_DIST_FT*FT;
  function isClearOfStructures(px,py,minDist){
    for(const poly of allBuildingPolys){
      for(const[bx,by]of poly){if(Math.hypot(px-bx,py-by)<minDist)return false;}
      if(pointInPoly(px,py,poly))return false;
    }
    for(const rd of roadsToRebuild){const coords=txCoords(rd.f.srcCoords);for(const[rx,ry]of coords){if(Math.hypot(px-rx,py-ry)<minDist)return false;}}
    for(const w of wallsToRebuild){const coords=txCoords(w.f.srcCoords);for(const[wx,wy]of coords){if(Math.hypot(px-wx,py-wy)<minDist)return false;}}
    return true;
  }
  const placedPositions=[];
  // v4: rectangle sampling across the whole scene. The old radius-based
  // sample concentrated foliage in the centerline; new version covers
  // edge-to-edge with proper PADDING insets, so corners and perimeter
  // don't read as suspiciously empty grass.
  function tryPlace(count,minDist,color,z,sizeMin,sizeMax){
    let placed=0;
    for(let attempt=0;attempt<count*12&&placed<count;attempt++){
      const px = PADDING + Math.random() * (encW - 2*PADDING);
      const py = PADDING + Math.random() * (encH - 2*PADDING);
      if(!isClearOfStructures(px,py,minDist))continue;
      let tooClose=false;for(const[ox,oy]of placedPositions){if(Math.hypot(px-ox,py-oy)<minDist*0.6){tooClose=true;break;}}
      if(tooClose)continue;
      const sz=sizeMin+(Math.random()*(sizeMax-sizeMin));
      const jc=mixColor(color,"#000000",Math.random()*0.15);
      toCreate.push({x:px-sz,y:py-sz,shape:{type:"e",width:sz*2,height:sz*2},fillType:1,fillColor:jc,fillAlpha:0.9,strokeWidth:0,strokeColor:"#000",strokeAlpha:0,z,sort:z,flags:{world:{isDecor:true}}});
      placedPositions.push([px,py]);placed++;
    }
    return placed;
  }
  // Trees + bushes sit BELOW the road layer (Z_ROADS=2) so a road
  // crossing a tree/bush region cuts cleanly through the canopy. Pushed
  // well below Z_ROADS (0.5 vs 2.0) because Foundry V13/V14 seems to
  // occasionally use creation order as a tiebreaker when sort values
  // are close — a wide spread guarantees roads always paint over.
  const Z_TREES = 0.5;
  const Z_BUSHES = 0.4;
  const nTrees=tryPlace(TREE_COUNT,treeMinDist,forestColor,Z_TREES,2.5*FT,4.5*FT);
  const bushColor=mixColor(grassColor,forestColor,0.5);
  const nBushes=tryPlace(BUSH_COUNT,bushMinDist,bushColor,Z_BUSHES,1.2*FT,2.2*FT);

  // PHASE TINT
  if(phaseDef.tintColor&&phaseDef.tintAlpha>0){const t=createDrawing([0,0,encW,0,encW,encH,0,encH,0,0],"p",phaseDef.tintColor,phaseDef.tintAlpha,"#000",0,0,Z_TINT,{world:{isPhaseTint:true,phase:activePhase}});if(t)toCreate.push(t);}

  console.log(`[Encounter v2] ${buildingsInRadius.length} bldg, ${wallsToRebuild.length} walls, ${roadsToRebuild.length} roads, ${nTrees} trees, ${nBushes} bushes, ${foundryWalls.length} fWalls, ${toCreate.length} drawings`);

  // ── Batch create drawings ────────────────────────────────────────────────
  for(let i=0;i<toCreate.length;i+=CHUNK){try{await encScene.createEmbeddedDocuments("Drawing",toCreate.slice(i,i+CHUNK));await new Promise(r=>setTimeout(r,DELAY));}catch(e){console.error("[Enc v2] draw",e);}}

  // ── Foundry Walls ────────────────────────────────────────────────────────
  if(foundryWalls.length>0){
    for(let i=0;i<foundryWalls.length;i+=CHUNK){try{await encScene.createEmbeddedDocuments("Wall",foundryWalls.slice(i,i+CHUNK));await new Promise(r=>setTimeout(r,DELAY));}catch(e){console.error("[Enc v2] wall",e);}}
  }

  // ── Lights ───────────────────────────────────────────────────────────────
  // ── Tokens ───────────────────────────────────────────────────────────────
  const tokensToCreate=[];
  for(const token of scene.tokens.contents){const tx=token.x,ty=token.y;if(tx>=eMinX&&tx<=eMaxX&&ty>=eMinY&&ty<=eMaxY){const td=token.toObject();td.x+=offX;td.y+=offY;delete td._id;tokensToCreate.push(td);}}
  if(tokensToCreate.length>0)try{await encScene.createEmbeddedDocuments("Token",tokensToCreate);}catch(e){}

  // ── Activate ─────────────────────────────────────────────────────────────
  await encScene.activate();await encScene.view();
  const el=document.getElementById("cavril-enc-overlay");if(el){el.firstElementChild.style.opacity="0";setTimeout(()=>el.remove(),400);}

  // ── Auto-populate citizens ──────────────────────────────────────────────
  // After the encounter scene is live, ask CityHUD to spawn every citizen
  // whose CURRENT SCHEDULE places them inside one of the buildings on
  // this scene. CityHUD's spawn pipeline groups them by sub-location
  // (workers / residents / leisure-seekers / in-transit on roads) and
  // keeps a wall margin so tokens don't pack against masonry.
  //
  // The wait-for-canvas guard below is critical: encScene.view() resolves
  // before canvas.scene actually swaps in V14. Calling the spawn helper
  // too soon makes it operate on the OVERWORLD scene (with thousands of
  // buildings and citizens), producing a 450-token pile in the wrong place.
  // We poll canvas.scene.id up to 5s and only spawn once the encounter
  // is the live scene.
  let spawnSummary = "";
  try {
    let waited = 0;
    while (canvas?.scene?.id !== encScene.id && waited < 5000) {
      await new Promise(r => setTimeout(r, 100));
      waited += 100;
    }
    if (canvas?.scene?.id !== encScene.id) {
      console.warn("[Enc v3] canvas didn't switch to encounter scene within 5s; skipping auto-spawn to avoid populating the wrong scene.");
    } else if (typeof window.CavrilTools?.spawnAllCitizensOnCurrentScene === "function") {
      let res = await window.CavrilTools.spawnAllCitizensOnCurrentScene();
      if (res && res.spawned != null) spawnSummary = ` · ${res.spawned} citizens placed`;
    }
  } catch (e) { console.warn("[Enc v3] auto-spawn failed:", e); }

  // ── Build road graph + decorate with transit citizens ─────────────────────
  // The encounter scene's roads were freshly created above; the importer's
  // processSceneInfrastructure only ran on the OVERWORLD scene, so this
  // encounter has no road graph yet. Build one now so the transit shuffle
  // has something to sample.
  //
  // Order matters: spawn first (so there are tokens to decorate), then
  // build infra (so the graph is current), then shuffle (so ~20% land on
  // roads instead of in their building). The canvasReady-driven shuffle
  // in cavril-transit.js fires 1.5s after scene swap which is too early
  // for a freshly-built encounter (spawn is still running), so this
  // explicit call is the authoritative one for encounter scenes.
  try {
    if (typeof window.CavrilTools?.processSceneInfrastructure === "function") {
      await window.CavrilTools.processSceneInfrastructure(encScene);
    }
    if (typeof window.CavrilTools?.shuffleTransitDecoration === "function") {
      await window.CavrilTools.shuffleTransitDecoration();
    }
  } catch (e) { console.warn("[Enc v3] transit decoration failed:", e); }

  // ── Map notes per building (mirrors overworld notes) ───────────────────
  // For every building drawing on the encounter scene, find the matching
  // per-building JournalEntry from the city's import (flagged with
  // flags.world.buildingId) and drop a Note at the building's centroid.
  // The journal sheet itself gets the "Open in CityHUD" button injected
  // automatically by the renderJournalSheet hook in cavril-cityhud.js,
  // so opening a Note → journal → one click takes the GM straight to
  // the building's inspector. Idempotent: clears existing notes first.
  try {
    const bldgDrawings = encScene.drawings.contents.filter(d => {
      const f = d.flags?.world;
      return f?.isBuildingOutline && f?.buildingId != null;
    });
    if (bldgDrawings.length > 0 && game.journal) {
      // Build an id → journal index once so we don't rescan game.journal
      // per-building (could be 100+ buildings on a dense encounter).
      const journalByBldId = new Map();
      for (const j of game.journal.contents) {
        const jbid = j.getFlag?.("world", "buildingId");
        if (jbid != null) journalByBldId.set(String(jbid), j);
      }
      // Wipe any prior notes on this scene flagged as ours so re-running
      // Build Scene against the same encounter doesn't pile up duplicates.
      const stale = encScene.notes?.contents?.filter(n => n.flags?.world?.cavrilBldgNote) || [];
      if (stale.length > 0) {
        try { await encScene.deleteEmbeddedDocuments("Note", stale.map(n => n.id)); }
        catch (e) { console.warn("[Enc v3] stale note clear failed:", e); }
      }
      const notesData = [];
      for (const dwg of bldgDrawings) {
        const f = dwg.flags.world;
        const bid = String(f.buildingId);
        const journal = journalByBldId.get(bid);
        if (!journal) continue;   // building has no journal entry
        // srcCx/srcCy are already in encounter-scene coords (set during
        // the building loop above as f.srcCx+offX, f.srcCy+offY).
        const x = Number.isFinite(f.srcCx) ? f.srcCx : (dwg.x + (dwg.shape?.width  ?? 0) / 2);
        const y = Number.isFinite(f.srcCy) ? f.srcCy : (dwg.y + (dwg.shape?.height ?? 0) / 2);
        notesData.push({
          entryId:   journal.id,
          x, y,
          texture:   { src: "icons/svg/house.svg" },
          iconSize:  40,
          text:      journal.name,
          global:    true,
          textAnchor: CONST.TEXT_ANCHOR_POINTS?.CENTER || 1,
          flags:     { world: { cavrilBldgNote: true, buildingId: bid } }
        });
      }
      if (notesData.length > 0) {
        const CHUNK = 100;
        for (let i = 0; i < notesData.length; i += CHUNK) {
          try { await encScene.createEmbeddedDocuments("Note", notesData.slice(i, i + CHUNK)); }
          catch (e) { console.warn("[Enc v3] note create chunk failed:", e); }
        }
        console.log(`[Enc v3] Placed ${notesData.length} building map notes on encounter scene.`);
      }
    }
  } catch (e) { console.warn("[Enc v3] map note creation failed:", e); }

  ui.notifications.info(`⚔ Encounter: ${buildingsInRadius.length} bldg · ${toCreate.length} drawings · ${foundryWalls.length} walls · ${nTrees} trees${spawnSummary}`);
})();
};

