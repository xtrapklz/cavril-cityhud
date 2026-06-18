// cavril-importer.js — Settlement Importer v2
// Part of the CavrilCityHUD module for Foundry VTT
// Imports Fantasy Town Generator (FTG) exports: GeoJSON + JSON
// Call window.CavrilTools.importCity() to open the import dialog.

(function () {
  'use strict';

  // ─── CONSTANTS ───────────────────────────────────────────────────────────────

  // Mutable so the module-settings ready hook can replace it with a Forge asset library path.
  let ASSET_BASE = 'modules/cavril-cityhud/Assets';
  const GRID_SIZE = 20;            // px per scene grid square — kept at 20 independent of FIXED_SCALE
  const CHUNK_SIZE      = 500;     // documents per createEmbeddedDocuments call — 500 keeps server payload small while cutting round-trips
  const TILE_CHUNK_SIZE = 200;     // tiles per batch — larger safe because tiles have no sub-docs
  const TARGET_CANVAS_SIZE = 12000; // max canvas px — scenes are cropped to this if the settlement is larger
  // Fixed content scale: 5 px per GeoJSON unit (≈ 5 px/ft since FTG uses ~1 unit/ft).
  // Intentionally ~25% over true-scale so buildings and roads read clearly at city-overview zoom.
  // The Foundry scene grid is always set to 20 px regardless — it's a visual reference, not a
  // ruler, at this map scale. Settlements larger than TARGET_CANVAS_SIZE / FIXED_SCALE feet are
  // cropped to the central ~2400-foot window; the scale itself never changes.
  const FIXED_SCALE = 5.0;
  // All ROAD_COLORS widths, TRUNK_PX, and decoration sizes were tuned at FIXED_SCALE.
  // _importStrokeScale is always 1.0 with the fixed-scale approach; it exists so the
  // scale-aware expressions compile correctly if the approach is revisited later.
  let _importStrokeScale = 1.0;
  let _importPxPerFt     = FIXED_SCALE;
  let _importCanvasW     = 0;          // canvas pixel dimensions for viewport clipping
  let _importCanvasH     = 0;
  let _importIsCropped   = false;      // true only when settlement exceeds TARGET_CANVAS_SIZE
  const PEOPLE_PER_PAGE = 2000;    // people per journal page
  const BLDG_CHUNK_SIZE = 500;     // buildings per scene-flag chunk
  const ROAD_SNAP = 2;             // GeoJSON units — node snap threshold
  const TREE_ELEVATION = 20;       // feet — canopy tiles render above tokens

  // ─── BUILDING HEIGHTS ────────────────────────────────────────────────────────

  const BUILDING_HEIGHTS = {
    TAVERN: 2, INN: 3, MARKET: 1, SHOP: 2, RESIDENCE: 2,
    RELIGIOUS: 4, FACTION: 3, EDUCATIONAL: 3, INDUSTRIAL: 2,
    ARTISAN: 2, WAREHOUSE: 2, SERVICE: 2, FARM: 1, LAW_ENFORCEMENT: 3,
  };

  // ─── COLOR PALETTES ──────────────────────────────────────────────────────────

  // Building fill colors represent rooftop materials as seen from above (satellite view).
  // TAVERN/INN   — clay tile, warm terracotta
  // MARKET       — pale thatch or light stone, straw-yellow
  // SHOP         — wooden shingle, warm tan
  // RESIDENCE    — mixed thatch/shingle, earthy brown
  // RELIGIOUS    — pale limestone or whitewash, cool cream
  // FACTION      — dark slate or dressed stone, cold blue-gray
  // EDUCATIONAL  — aged stone with moss, green-gray
  // INDUSTRIAL   — dark iron/wood, near-black warm gray
  // ARTISAN      — warm wood shingle, medium tan
  // WAREHOUSE    — plain timber/plank, neutral gray-brown
  // SERVICE      — muted sage plaster
  // FARM         — sod/moss or pale board, cool green-tan
  // LAW          — cut stone, cool slate
  // Building rooftop colors: each type has a distinct hue/value identity so they're
  // glanceable at a glance on the map. Palette stays believable (aged clay, slate,
  // thatch, stone) while each type is unmistakable.
  // TAVERN = terracotta red · INN = amber · MARKET = straw yellow · SHOP = warm tan
  // RESIDENCE = cool gray-brown · RELIGIOUS = pale ivory · FACTION = slate blue
  // EDUCATIONAL = sage green · INDUSTRIAL = dark gray · ARTISAN = rich gold
  // WAREHOUSE = neutral gray · SERVICE = muted mint · FARM = olive green
  // LAW_ENFORCEMENT = blue-gray
  // Building fill = rooftop material from above. Muted naturalistic palette so the
  // icon pins pop against them. Each type has a distinct hue but stays believable
  // (aged clay, thatch, slate, limestone). Slight warmth bias across the whole palette
  // so all types feel like they belong in the same medieval city.
  // Building fill tones — same hue family as each type's icon but warmer and desaturated,
  // like aged stone, weathered timber, and faded plaster.  Icons pop because they are
  // 3-4× more saturated than the roof they float over.
  // Key distinction: ARTISAN leans sage-green (warm teal, G>B), RESIDENCE leans slate-blue (B>G).
  const BUILDING_COLORS = {
    TAVERN:          { DAY: '#a85840', DUSK: '#7e4230', NIGHT: '#572e21', DAWN: '#924d38' },  // terracotta orange clay tile
    INN:             { DAY: '#a07030', DUSK: '#785424', NIGHT: '#533a19', DAWN: '#8b612a' },  // warm amber shingle
    MARKET:          { DAY: '#908830', DUSK: '#6c6624', NIGHT: '#4b4719', DAWN: '#7d762a' },  // golden straw thatch
    SHOP:            { DAY: '#7c5870', DUSK: '#5d4254', NIGHT: '#402e3a', DAWN: '#6c4d61' },  // dusty mauve plaster (earthy magenta)
    RESIDENCE:       { DAY: '#586878', DUSK: '#424e5a', NIGHT: '#2e363e', DAWN: '#4d5a68' },  // blue-gray slate (cool, B>G)
    RELIGIOUS:       { DAY: '#c8bc98', DUSK: '#968d72', NIGHT: '#68624f', DAWN: '#aea484' },  // pale limestone/marble (deliberately lighter — temple stone)
    FACTION:         { DAY: '#4c4870', DUSK: '#393654', NIGHT: '#28253a', DAWN: '#423f61' },  // warm indigo-gray dressed stone
    EDUCATIONAL:     { DAY: '#988070', DUSK: '#726054', NIGHT: '#4f433a', DAWN: '#846f61' },  // warm tan stone (parchment-earth)
    INDUSTRIAL:      { DAY: '#686058', DUSK: '#4e4842', NIGHT: '#36322e', DAWN: '#5b544d' },  // warm gray-brown scorched timber
    ARTISAN:         { DAY: '#607848', DUSK: '#485a36', NIGHT: '#323e25', DAWN: '#54683f' },  // sage-green timber (clearly G>B, distinct from RESIDENCE blue-gray)
    WAREHOUSE:       { DAY: '#706858', DUSK: '#544e42', NIGHT: '#3a362e', DAWN: '#615a4d' },  // warm khaki stone board
    SERVICE:         { DAY: '#558870', DUSK: '#406654', NIGHT: '#2c473a', DAWN: '#4a7661' },  // sage-teal plaster (earthy mint)
    FARM:            { DAY: '#507828', DUSK: '#3c5a1e', NIGHT: '#2a3e15', DAWN: '#466823' },  // earthy moss-green sod
    LAW_ENFORCEMENT: { DAY: '#783030', DUSK: '#5a2424', NIGHT: '#3e1919', DAWN: '#682a2a' },  // dark red-stone fortified
    DEFAULT:         { DAY: '#a89070', DUSK: '#806858', NIGHT: '#544238', DAWN: '#988060' },
  };

  const TERRAIN_COLORS = {
    // Open land — colors brightened ×1.15 to compensate for grass_bw.jpg multiply-blend darkening
    GRASS:             { DAY: '#8cc453', DUSK: '#557f37', NIGHT: '#304723', DAWN: '#689f43' },
    // Forest floor uses grass texture so brightened equally; canopy overlay renders on top
    FOREST:            { DAY: '#789340', DUSK: '#4e622b', NIGHT: '#2b3a17', DAWN: '#658137' },
    // Lush meadow / pasture
    MEADOW:            { DAY: '#81c153', DUSK: '#558137', NIGHT: '#304a25', DAWN: '#6eaf40' },
    PASTURE:           { DAY: '#78b845', DUSK: '#51812e', NIGHT: '#2e471c', DAWN: '#68a637' },
    // Growing crops — earthy-straw tones; dirt texture so NOT brightened for grass texture
    FARMLAND:          { DAY: '#c0b060', DUSK: '#988840', NIGHT: '#5e5828', DAWN: '#b0a050' },
    FIELD:             { DAY: '#c0b060', DUSK: '#988840', NIGHT: '#5e5828', DAWN: '#b0a050' },
    WHEAT_FIELD:       { DAY: '#c8b858', DUSK: '#a09038', NIGHT: '#606020', DAWN: '#b8a848' },
    FALLOW:            { DAY: '#b4a050', DUSK: '#8c7838', NIGHT: '#585020', DAWN: '#a49040' },
    STUBBLE:           { DAY: '#b89848', DUSK: '#907830', NIGHT: '#585020', DAWN: '#a88838' },
    CROP:              { DAY: '#a8a850', DUSK: '#808038', NIGHT: '#4c4c20', DAWN: '#989840' },
    // Plowed / tilled earth — warm bare soil; dirt texture so NOT brightened
    PLOWED:            { DAY: '#a08060', DUSK: '#786040', NIGHT: '#483828', DAWN: '#907050' },
    PLOWED_FIELD:      { DAY: '#a08060', DUSK: '#786040', NIGHT: '#483828', DAWN: '#907050' },
    TILLED:            { DAY: '#a08060', DUSK: '#786040', NIGHT: '#483828', DAWN: '#907050' },
    // Orchards — dirt texture so NOT brightened
    ORCHARD:           { DAY: '#6aaa40', DUSK: '#487030', NIGHT: '#284018', DAWN: '#5a9a30' },
    // Rough / wild ground — grass texture, brightened ×1.15
    HEATH:             { DAY: '#9fa653', DUSK: '#6e6e37', NIGHT: '#434025', DAWN: '#8c9340' },
    SCRUBLAND:         { DAY: '#7f934a', DUSK: '#5a6537', NIGHT: '#353c25', DAWN: '#6c8137' },
    MARSH:             { DAY: '#789860', DUSK: '#507040', NIGHT: '#304028', DAWN: '#688850' },
    // Bare earth — dirt texture so NOT brightened
    DIRT:              { DAY: '#a08368', DUSK: '#786045', NIGHT: '#4e3a2a', DAWN: '#887058' },
    SAND:              { DAY: '#d4c090', DUSK: '#a89060', NIGHT: '#706040', DAWN: '#c0ac78' },
    // Hardscape — stone texture so NOT brightened
    STONE:             { DAY: '#989088', DUSK: '#706860', NIGHT: '#464040', DAWN: '#888078' },
    COBBLESTONE:       { DAY: '#8c8480', DUSK: '#645c58', NIGHT: '#403c38', DAWN: '#7c7470' },
    PAVED:             { DAY: '#b0a898', DUSK: '#887870', NIGHT: '#585048', DAWN: '#a09888' },
    // Water — own texture so NOT brightened
    WATER:             { DAY: '#4a7aaa', DUSK: '#305268', NIGHT: '#1c2e42', DAWN: '#3a6898' },
    WATERFRONT:        { DAY: '#4882b0', DUSK: '#325a78', NIGHT: '#1e3452', DAWN: '#3870a0' },
    // Manicured lawn — grass texture, brightened ×1.15
    LAWN_TEXTURE_TYPE: { DAY: '#a3dd5e', DUSK: '#6e9340', NIGHT: '#405325', DAWN: '#91ca4e' },
    DEFAULT:           { DAY: '#8cc453', DUSK: '#557f37', NIGHT: '#304723', DAWN: '#689f43' },
  };

  // All road/path types share one colour palette so intersections between different widths
  // are seamless. Warm sandy-beige packed earth — the dominant road material in a medieval town.
  // WOOD_PIER gets a slightly warmer wood-plank tone; STONE_PIER a cooler gray.
  // STONE_FENCE and STONE_WALL are structural — warm quarried stone, not cold neutral gray.
  const _RD   = { DAY: '#c4b082', DUSK: '#9e8860', NIGHT: '#6a5a38', DAWN: '#b4a072' };
  const _PIER = { DAY: '#b8a070', DUSK: '#906050', NIGHT: '#604030', DAWN: '#a88e60' };
  const ROAD_COLORS = {
    MAIN_ROAD:   { ..._RD,   width: 18 },
    ROAD:        { ..._RD,   width: 14 },
    SMALL_ROAD:  { ..._RD,   width: 11 },
    TRAIL:       { ..._RD,   width: 7  },
    DIRT_ROAD:   { ..._RD,   width: 11 },
    WOOD_PIER:   { ..._PIER, width: 22 },
    STONE_PIER:  { DAY: '#a09888', DUSK: '#787068', NIGHT: '#504848', DAWN: '#908878', width: 22 },
    // Bridge deck — slightly wider than MAIN_ROAD so the parapet edge is visible
    // against the road surface beneath. Warm quarried-stone tone matches the road palette.
    BRIDGE:      { DAY: '#b0a07c', DUSK: '#887860', NIGHT: '#5a5038', DAWN: '#a0906c', width: 20 },
    // Fences: warm field-stone (lighter than wall so they read as low boundary features)
    STONE_FENCE: { DAY: '#b0a898', DUSK: '#887870', NIGHT: '#585048', DAWN: '#a09888', width: 3  },
    // Walls: warm quarried limestone/sandstone — NOT cold gray
    STONE_WALL:  { DAY: '#a09080', DUSK: '#786860', NIGHT: '#504438', DAWN: '#907870', width: 16 },
    BORDER:      { DAY: '#908880', DUSK: '#686058', NIGHT: '#403830', DAWN: '#807870', width: 14 },
  };

  // Edge types that must render ABOVE the water layer (sort:18-19).
  // Piers project over water by design; bridge decks span rivers at road crossings.
  // Both need sort:25 — same level as the procedural bridge-deck rectangles.
  const PIER_BRIDGE_EDGE_TYPES = new Set(['WOOD_PIER', 'STONE_PIER', 'BRIDGE']);

  const NAVIGABLE_EDGE_TYPES = new Set([
    'MAIN_ROAD', 'ROAD', 'SMALL_ROAD', 'TRAIL', 'DIRT_ROAD', 'WOOD_PIER', 'STONE_PIER',
  ]);

  const LIGHT_BUILDING_TYPES = new Set([
    'TAVERN', 'INN', 'RELIGIOUS', 'MARKET', 'FACTION', 'LAW_ENFORCEMENT',
  ]);

  // All lights use warm lamp-oil colors — they absorb the polygon color beneath them.
  // Colors stay in the amber/gold range; type-specific shifts are subtle warmth variations.
  const LIGHT_CONFIGS = {
    TAVERN:          { color: '#ffa040', bright: 2, dim: 4 },
    INN:             { color: '#ffb858', bright: 2, dim: 4 },
    RELIGIOUS:       { color: '#ffeaa0', bright: 3, dim: 6 },
    MARKET:          { color: '#ffd870', bright: 2, dim: 4 },
    FACTION:         { color: '#ffc850', bright: 2, dim: 4 },
    LAW_ENFORCEMENT: { color: '#ffe8b0', bright: 2, dim: 4 },
  };

  // ─── TREE ASSETS ─────────────────────────────────────────────────────────────
  // Builder kept separate so the ready hook can rebuild after reading the
  // assetBase module setting (needed for Forge-hosted asset libraries).
  function _buildTreeAssets(base) {
    return {
      canopy: {
        broadleaf: {
          large:  [1, 2, 3].map(n => `${base}/tree-broadleaf-large-green-${n}.png`),
          medium: [1, 2, 3].map(n => `${base}/tree-broadleaf-medium-green-${n}.png`),
          small:  [1, 2, 3].map(n => `${base}/tree-broadleaf-small-green-${n}.png`),
        },
        coniferous: {
          large: [1, 2, 3].map(n => `${base}/tree-coniferous-large-green-${n}.png`),
          small: [1, 2, 3].map(n => `${base}/tree-coniferous-small-green-${n}.png`),
        },
        bare: {
          large:  [`${base}/tree-bare-large.png`],
          medium: [`${base}/tree-bare-medium.png`],
          small:  [`${base}/tree-bare-small.png`],
        },
      },
      trunk: [`${base}/tree-shade-small.png`],
    };
  }

  let { canopy: TREE_CANOPY, trunk: TREE_TRUNK_ASSETS } = _buildTreeAssets(ASSET_BASE);

  // Canopy tile sizes in px. treeTileData applies ±20% random scale per tile.
  const CANOPY_PX = { large: 22, medium: 16, small: 10 };
  const TRUNK_PX          = { large: 10, medium: 7, small: 5 };

  const TREE_DENSITY = {
    GRASS:             0.0004,  // grassland — mostly open, perimeter line + sparse scatter
    LAWN_TEXTURE_TYPE: 0.002,
    FOREST:            0.007,
    MEADOW:            0.0003,
    PASTURE:           0.0003,
    ORCHARD:           0.0016,
    HEATH:             0.0004,
    SCRUBLAND:         0.0004,
    // Farm types intentionally omitted — they get perimeter hedgerow trees instead
  };

  // Grassland terrain: gets a sparse perimeter treeline + very limited interior scatter.
  // Distinct from FARM_PERIMETER_TYPES (farms get hedgerows, grassland gets open-meadow feel).
  const GRASSLAND_TYPES = new Set(['GRASS', 'MEADOW', 'PASTURE', 'LAWN_TEXTURE_TYPE']);

  // ─── TERRAIN TEXTURES ────────────────────────────────────────────────────────
  // B&W textures that get tinted by fillColor at render time.
  // All paths are relative to Foundry's public/ folder (app static files).
  // Files marked (NEEDED) must be created by the user — see CLAUDE.md for the list.
  // B&W texture paths — all relative to Foundry's public/ root.
  // fillType:2 (PATTERN) tiles the texture; fillColor acts as a multiply tint on the B&W image.
  const _TEX = {
    GRASS:       'ui/tiles/grass_bw.jpg',
    DIRT:        'ui/tiles/dirt_bw.jpg',
    WATER:       'ui/tiles/water_bw.jpg',
    FOREST:      'ui/tiles/forest_floor_bw.jpg',
    STONE:       'ui/tiles/stone_bw.jpg',
    MARSH:       'ui/tiles/marsh_bw.jpg',
    ROOF:        'ui/tiles/roof_bw.jpg',
  };
  const TERRAIN_TEXTURES = {
    // ── Grass family ─────────────────────────────────────────────────────────
    GRASS:             _TEX.GRASS,
    MEADOW:            _TEX.GRASS,
    PASTURE:           _TEX.GRASS,
    LAWN_TEXTURE_TYPE: _TEX.GRASS,
    GRASSLAND:         _TEX.GRASS,  // FTG sometimes emits GRASSLAND as backgroundType
    HEATH:             _TEX.GRASS,
    SCRUBLAND:         _TEX.GRASS,
    // ── Forest floor — uses grass texture until a dedicated forest_floor_bw.jpg exists ──
    FOREST:            _TEX.GRASS,
    // ── Soil / Farm ──────────────────────────────────────────────────────────
    DIRT:              _TEX.DIRT,
    SAND:              _TEX.DIRT,
    FARMLAND:          _TEX.DIRT,
    FIELD:             _TEX.DIRT,
    PLOWED:            _TEX.DIRT,
    PLOWED_FIELD:      _TEX.DIRT,
    TILLED:            _TEX.DIRT,
    FALLOW:            _TEX.DIRT,
    STUBBLE:           _TEX.DIRT,
    WHEAT_FIELD:       _TEX.DIRT,
    CROP:              _TEX.DIRT,
    ORCHARD:           _TEX.DIRT,  // orchard floor is exposed earth between trees
    // ── Water ────────────────────────────────────────────────────────────────
    WATER:             _TEX.WATER,
    WATERFRONT:        _TEX.WATER,
    // ── Stone / hardscape ────────────────────────────────────────────────────
    STONE:             _TEX.STONE,
    COBBLESTONE:       _TEX.STONE,
    PAVED:             _TEX.STONE,
    // ── Wetland ──────────────────────────────────────────────────────────────
    MARSH:             _TEX.MARSH,
    SWAMP:             _TEX.MARSH,
    // ── Fallback ─────────────────────────────────────────────────────────────
    // Any background polygon without a recognized backgroundType falls to 'DEFAULT'.
    // Use grass so unclassified green areas get surface detail rather than a flat fill.
    DEFAULT:           _TEX.GRASS,
  };

  // Farm polygon types that get perimeter (hedgerow) trees rather than interior scatter.
  // This excludes ORCHARD which gets interior scatter (like a forest).
  const FARM_PERIMETER_TYPES = new Set([
    'FARMLAND', 'FIELD', 'WHEAT_FIELD', 'FALLOW', 'STUBBLE', 'CROP',
    'PLOWED', 'PLOWED_FIELD', 'TILLED',
  ]);

  // All farm types get crop row lines — even plowed/tilled fields show furrow rows.
  const FARM_ROW_TYPES = new Set([
    'FARMLAND', 'FIELD', 'WHEAT_FIELD', 'FALLOW', 'STUBBLE', 'CROP',
    'PLOWED', 'PLOWED_FIELD', 'TILLED',
  ]);

  // Seasonal crop row appearance — colour and stroke width reflect the real
  // agricultural cycle: plowing → planting → growing → ripening → harvest → fallow.
  //   color:  visible row line (furrow shadow or standing crop silhouette)
  //   width:  px — narrow for bare furrows, widest for tall standing crops
  const CROP_ROW_SEASONAL = {
    // Deep winter → Late winter: soil plowed or fallow, barely any structure
    EARLY_WINTER: { color: '#4a3018', width: 3 },
    MID_WINTER:   { color: '#402810', width: 3 },
    LATE_WINTER:  { color: '#4a3018', width: 3 },
    // Early spring: fresh plowing, dark damp earth furrows, very narrow
    EARLY_SPRING: { color: '#5a3e20', width: 3 },
    // Mid-spring: seeds in, damp dark soil, first green tinge between rows
    MID_SPRING:   { color: '#585830', width: 4 },
    // Late spring: seedlings up, green rows starting to show
    LATE_SPRING:  { color: '#688040', width: 4 },
    // Early summer: young crops knee-high, clearly green rows
    EARLY_SUMMER: { color: '#608038', width: 5 },
    // Mid-summer: full growth, dense lush green canopy rows
    MID_SUMMER:   { color: '#508030', width: 6 },
    // Late summer: crops ripening, rows turn golden-green
    LATE_SUMMER:  { color: '#90a030', width: 6 },
    // Early autumn: harvest-ready golden stalks, widest visible rows
    EARLY_AUTUMN: { color: '#c0a028', width: 7 },
    // Mid-autumn: harvested stubble, rows still wide but golden-brown
    MID_AUTUMN:   { color: '#b08830', width: 6 },
    // Late autumn: fields stripped, tilling starts again
    LATE_AUTUMN:  { color: '#806828', width: 4 },
    // Aliases
    SPRING: { color: '#688040', width: 4 },
    SUMMER: { color: '#508030', width: 6 },
    AUTUMN: { color: '#c0a028', width: 4 },
    WINTER: { color: '#402810', width: 1 },
  };

  // Crop row line colors — same family as field fill but darker (shadow between rows).
  const FARM_ROW_COLORS = {
    FARMLAND:    '#a89030',  // darker gold-straw
    FIELD:       '#a89030',
    WHEAT_FIELD: '#b09020',  // deeper wheat gold
    FALLOW:      '#906820',  // darker fallow
    STUBBLE:     '#906020',  // stubble furrow
    CROP:        '#9a9c30',  // deeper crop green-yellow
    PLOWED:      '#806030',  // deep soil furrow
    PLOWED_FIELD:'#806030',
    TILLED:      '#806030',
  };

  // Per-field color variants — 4 clearly-distinct tones per type, picked by centroid hash.
  // Kept olive/earthy so they don't pop harshly against the surrounding grass.
  const FARM_COLOR_VARIANTS = {
    FARMLAND:    ['#c8b860', '#b8a450', '#a89040', '#987838'],  // muted straw → warm brown
    FIELD:       ['#c0b058', '#b09848', '#a08840', '#907838'],
    WHEAT_FIELD: ['#ccc060', '#bcac50', '#ac9838', '#9c8830'],
    FALLOW:      ['#b8a058', '#a89048', '#988038', '#887030'],
    STUBBLE:     ['#c0a050', '#b09040', '#a08030', '#907028'],
    CROP:        ['#b8b858', '#a8a848', '#98983a', '#888830'],
    PLOWED:      ['#a88860', '#987850', '#886840', '#785830'],  // sandy soil → dark earth
    PLOWED_FIELD:['#a88860', '#987850', '#886840', '#785830'],
    TILLED:      ['#a08058', '#907050', '#806040', '#705030'],
  };

  // Per-polygon crop-row stroke colors — each field picks one by centroid hash.
  // Distinct hues imply different crops: golden grain, leafy brassica, root veg,
  // legumes, and pale fallow so fields read immediately as different crop types.
  const CROP_ROW_STYLES = [
    '#c89018',  // golden grain — wheat/barley/oats (vivid amber-gold, pops on straw bg)
    '#487820',  // leafy green — brassicas/cabbages (deeper forest green, reads on earth)
    '#d06020',  // vivid orange-red — root veg/carrots (was dull terracotta, now carrot-vivid)
    '#909018',  // olive-yellow — legumes/beans/peas (brighter, reads on sandy soil)
    '#a07838',  // warm tan — fallow/mixed stubble (lifted from #806850 for contrast)
  ];

  // Canopy tile tint by [timeOfDay][season] — 12 sub-seasons + legacy aliases.
  // Summer = pure white (no tint). Spring = fresh yellow-green. Autumn = amber-rust.
  // Winter = desaturated cool gray-blue (trees are bare so tint matters less).
  const CANOPY_TINTS = {
    DAY: {
      EARLY_SPRING:'#d8f8d0', MID_SPRING:'#e4f8e0', LATE_SPRING:'#f0fce8',
      EARLY_SUMMER:'#ffffff', MID_SUMMER:'#ffffff', LATE_SUMMER:'#fefde8',
      EARLY_AUTUMN:'#ffec98', MID_AUTUMN:'#ffc855', LATE_AUTUMN:'#f09030',
      EARLY_WINTER:'#d0dce0', MID_WINTER:'#c4d0d8', LATE_WINTER:'#ccd4dc',
      SPRING:'#e4f8e0', SUMMER:'#ffffff', AUTUMN:'#ffc855', WINTER:'#c4d0d8',
    },
    DUSK: {
      EARLY_SPRING:'#d08840', MID_SPRING:'#d08840', LATE_SPRING:'#d08840',
      EARLY_SUMMER:'#d08840', MID_SUMMER:'#d08840', LATE_SUMMER:'#c87830',
      EARLY_AUTUMN:'#c07830', MID_AUTUMN:'#b86820', LATE_AUTUMN:'#a85810',
      EARLY_WINTER:'#a89090', MID_WINTER:'#988090', LATE_WINTER:'#9880a0',
      SPRING:'#d08840', SUMMER:'#d08840', AUTUMN:'#b86820', WINTER:'#988090',
    },
    NIGHT: {
      EARLY_SPRING:'#2e3e5a', MID_SPRING:'#2e3e5a', LATE_SPRING:'#2e3e5a',
      EARLY_SUMMER:'#2e3e5a', MID_SUMMER:'#2e3e5a', LATE_SUMMER:'#2e3e5a',
      EARLY_AUTUMN:'#282e48', MID_AUTUMN:'#222848', LATE_AUTUMN:'#1c2040',
      EARLY_WINTER:'#262e48', MID_WINTER:'#262e48', LATE_WINTER:'#262e48',
      SPRING:'#2e3e5a', SUMMER:'#2e3e5a', AUTUMN:'#222848', WINTER:'#262e48',
    },
    DAWN: {
      EARLY_SPRING:'#ffc880', MID_SPRING:'#ffc880', LATE_SPRING:'#ffc880',
      EARLY_SUMMER:'#ffc880', MID_SUMMER:'#ffc880', LATE_SUMMER:'#ffb870',
      EARLY_AUTUMN:'#ffa860', MID_AUTUMN:'#ff9840', LATE_AUTUMN:'#f08030',
      EARLY_WINTER:'#a09090', MID_WINTER:'#9888a0', LATE_WINTER:'#a090b0',
      SPRING:'#ffc880', SUMMER:'#ffc880', AUTUMN:'#ff9840', WINTER:'#9888a0',
    },
  };

  // ─── SEEDED RNG ──────────────────────────────────────────────────────────────

  function strHash(str) {
    let h = 0x12345678;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h << 5) | (h >>> 27);
      h ^= str.charCodeAt(i);
    }
    return h >>> 0;
  }

  function mulberry32(seed) {
    return function () {
      seed |= 0;
      seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ─── GEOMETRY UTILITIES ──────────────────────────────────────────────────────

  function polyArea(coords) {
    let area = 0;
    const n = coords.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      area += (coords[j][0] + coords[i][0]) * (coords[j][1] - coords[i][1]);
    }
    return Math.abs(area / 2);
  }

  function polyCentroid(coords) {
    let cx = 0, cy = 0, area = 0;
    const n = coords.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const f = coords[j][0] * coords[i][1] - coords[i][0] * coords[j][1];
      area += f;
      cx += (coords[j][0] + coords[i][0]) * f;
      cy += (coords[j][1] + coords[i][1]) * f;
    }
    area /= 2;
    if (Math.abs(area) < 1e-10) {
      return [
        coords.reduce((s, p) => s + p[0], 0) / n,
        coords.reduce((s, p) => s + p[1], 0) / n,
      ];
    }
    return [cx / (6 * area), cy / (6 * area)];
  }

  function pip(point, coords) {
    const [px, py] = point;
    let inside = false;
    const n = coords.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [xi, yi] = coords[i];
      const [xj, yj] = coords[j];
      if ((yi > py) !== (yj > py) &&
          px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) {
        inside = !inside;
      }
    }
    return inside;
  }

  function polyBbox(coords) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [x, y] of coords) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    return { minX, minY, maxX, maxY };
  }

  // Returns true if (px, py) is within distance m of any edge of ring.
  // Used for margin-based exclusion zones — pip alone only tests inside/outside.
  function ptNearPoly(px, py, ring, m) {
    const m2 = m * m;
    const n  = ring.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const [ax, ay] = ring[i];
      const [bx, by] = ring[j];
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      if (len2 < 1e-12) {
        const ex = px - ax, ey = py - ay;
        if (ex * ex + ey * ey < m2) return true;
      } else {
        const t  = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        const cx = ax + t * dx - px;
        const cy = ay + t * dy - py;
        if (cx * cx + cy * cy < m2) return true;
      }
    }
    return false;
  }

  // Returns true if (px, py) is within distance m of any segment of an OPEN polyline.
  // Unlike ptNearPoly, does not check the closing edge between last and first point.
  function ptNearLine(px, py, coords, m) {
    const m2 = m * m;
    for (let i = 0; i < coords.length - 1; i++) {
      const [ax, ay] = coords[i];
      const [bx, by] = coords[i + 1];
      const dx = bx - ax, dy = by - ay;
      const len2 = dx * dx + dy * dy;
      if (len2 < 1e-12) {
        const ex = px - ax, ey = py - ay;
        if (ex * ex + ey * ey < m2) return true;
      } else {
        const t  = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        const cx = ax + t * dx - px;
        const cy = ay + t * dy - py;
        if (cx * cx + cy * cy < m2) return true;
      }
    }
    return false;
  }

  // ─── POLYGON INSET ───────────────────────────────────────────────────────────
  // Offsets each polygon edge inward by `amount` pixels using the miter/intersection
  // method.  Unlike centroid-push, this moves vertices along the LOCAL edge bisector,
  // which correctly handles concave polygons (e.g., a forest that wraps around a
  // settlement) — every boundary shrinks inward toward the polygon interior rather
  // than toward the global centroid.
  // Winding is auto-detected from the signed area: for CW polygons in Foundry's
  // y-down screen space (the typical result of GeoJSON→transform.tc()) the inward
  // normal of edge (dx,dy) is (dy, -dx); for CCW it is (-dy, dx).
  function insetPolyFlat(flatPts, amount) {
    const n = flatPts.length / 2;
    if (n < 3) return flatPts;

    // Signed area (shoelace) to detect winding in screen coords.
    let area2 = 0;
    for (let i = 0; i < n; i++) {
      const ax = flatPts[i * 2],          ay = flatPts[i * 2 + 1];
      const bx = flatPts[((i + 1) % n) * 2], by = flatPts[((i + 1) % n) * 2 + 1];
      area2 += ax * by - bx * ay;
    }
    // CW in screen (area2 > 0, typical for GeoJSON after y-down transform):
    //   inward normal of edge (ex, ey) = (ey, -ex)  [right-hand perpendicular]
    // CCW in screen (area2 < 0):
    //   inward normal of edge (ex, ey) = (-ey, ex)  [left-hand perpendicular]
    const sign = area2 >= 0 ? 1 : -1;

    const result = [];
    for (let i = 0; i < n; i++) {
      const pi = (i + n - 1) % n;
      const ni = (i + 1) % n;

      const [px, py] = [flatPts[pi * 2], flatPts[pi * 2 + 1]];
      const [cx, cy] = [flatPts[i  * 2], flatPts[i  * 2 + 1]];
      const [nx2, ny2] = [flatPts[ni * 2], flatPts[ni * 2 + 1]];

      // Unit vectors for the two adjacent edges
      let e1x = cx - px, e1y = cy - py;
      const l1 = Math.sqrt(e1x * e1x + e1y * e1y) || 1;
      e1x /= l1; e1y /= l1;

      let e2x = nx2 - cx, e2y = ny2 - cy;
      const l2 = Math.sqrt(e2x * e2x + e2y * e2y) || 1;
      e2x /= l2; e2y /= l2;

      // Inward normals for each edge
      const n1x =  sign * e1y, n1y = -sign * e1x;
      const n2x =  sign * e2y, n2y = -sign * e2x;

      // Offset edges: each is the original edge shifted inward by `amount`
      const a1x = px + n1x * amount, a1y = py + n1y * amount;
      const b1x = cx + n1x * amount, b1y = cy + n1y * amount;
      const a2x = cx + n2x * amount, a2y = cy + n2y * amount;
      const b2x = nx2 + n2x * amount, b2y = ny2 + n2y * amount;

      // New vertex = intersection of the two offset lines
      const rdx = b1x - a1x, rdy = b1y - a1y;
      const sdx = b2x - a2x, sdy = b2y - a2y;
      const denom = rdx * sdy - rdy * sdx;
      if (Math.abs(denom) < 1e-9) {
        // Parallel edges — straight corridor, just offset the vertex directly
        result.push(cx + n1x * amount, cy + n1y * amount);
      } else {
        const t = ((a2x - a1x) * sdy - (a2y - a1y) * sdx) / denom;
        result.push(a1x + t * rdx, a1y + t * rdy);
      }
    }
    return result;
  }

  // ─── WAVY EDGE ───────────────────────────────────────────────────────────────
  // Subdivides each edge of a flat [x,y,x,y…] polygon and displaces each intermediate
  // point perpendicular to the edge by a seeded random amount. Creates an organic,
  // hand-drawn silhouette — used for forest polygons so they don't look laser-cut.

  function applyWavyEdge(absPts, rng, amplitude, subdivideLen) {
    const amp    = amplitude    || 13;  // px — max displacement each side
    const subLen = subdivideLen || 20;  // target px distance between midpoints
    const n      = absPts.length / 2;
    const result = [];

    for (let i = 0; i < n; i++) {
      const j  = (i + 1) % n;
      const x0 = absPts[i * 2],     y0 = absPts[i * 2 + 1];
      const x1 = absPts[j * 2],     y1 = absPts[j * 2 + 1];
      const dx = x1 - x0,           dy = y1 - y0;
      const len = Math.sqrt(dx * dx + dy * dy);

      result.push(x0, y0);

      if (len < subLen * 1.5) continue; // too short to subdivide

      const nx = -dy / len, ny = dx / len;         // edge normal
      const steps = Math.floor(len / subLen);

      for (let s = 1; s < steps; s++) {
        const t  = s / steps;
        const mx = x0 + dx * t, my = y0 + dy * t;
        const d  = (rng() - 0.5) * 2 * amp;        // random ± amp
        result.push(mx + nx * d, my + ny * d);
      }
    }
    return result;
  }

  // ─── COLOR UTILITIES ─────────────────────────────────────────────────────────

  function hexToRgb(h) {
    // Foundry V13 may return Color objects or numbers for texture.tint — coerce to string first.
    if (typeof h !== 'string') h = '#' + Math.round(+h || 0xffffff).toString(16).padStart(6, '0');
    const n = parseInt(h.replace('#', ''), 16);
    return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
  }
  function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(v => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
  }
  function blendColor(hexA, hexB, t) {
    const [ar, ag, ab] = hexToRgb(hexA);
    const [br, bg, bb] = hexToRgb(hexB);
    return rgbToHex(ar + (br - ar) * t, ag + (bg - ag) * t, ab + (bb - ab) * t);
  }

  // Terrain types that receive the seasonal foliage blend (SEASONAL_BLEND).
  // Includes bare-earth types so snow covers plowed fields, dirt paths, etc.
  const SEASONAL_FOLIAGE = new Set([
    'GRASS', 'MEADOW', 'PASTURE', 'LAWN_TEXTURE_TYPE',
    'FARMLAND', 'FIELD', 'WHEAT_FIELD', 'CROP', 'FALLOW', 'STUBBLE',
    'PLOWED', 'PLOWED_FIELD', 'TILLED',
    'ORCHARD', 'HEATH', 'SCRUBLAND', 'MARSH', 'DIRT',
  ]);

  // 12 sub-seasons. Summer = base palette (no blend). Winter blends aggressively
  // toward near-white to produce snow coverage. Autumn/Spring are vivid.
  const SEASONAL_BLEND = {
    // Spring: surge of fresh yellow-green over the winter palette
    EARLY_SPRING: ['#78f040', 0.32], MID_SPRING: ['#78f040', 0.20], LATE_SPRING: ['#78f040', 0.09],
    // Summer: base palette is summer-tuned — no tint needed
    EARLY_SUMMER: null,              MID_SUMMER: null,               LATE_SUMMER: ['#d0b840', 0.07],
    // Autumn: vivid amber → deep rust
    EARLY_AUTUMN: ['#d07818', 0.22], MID_AUTUMN: ['#c05010', 0.40], LATE_AUTUMN: ['#a03808', 0.58],
    // Winter: blends toward near-white to simulate snow coverage
    EARLY_WINTER: ['#d0e8f0', 0.55], // light frost / first dusting
    MID_WINTER:   ['#f0f4f8', 0.88], // thick snow — near-white
    LATE_WINTER:  ['#c8d8e4', 0.58], // melting / dirty snow
    // Backwards-compat 4-season aliases
    SPRING: ['#78f040', 0.20], SUMMER: null,
    AUTUMN: ['#c05010', 0.40], WINTER: ['#f0f4f8', 0.88],
  };

  // Forest-specific seasonal blend: autumn goes rusty-brown, winter goes gray (bare branches),
  // spring gets a fresh green surge. Overrides general SEASONAL_BLEND for FOREST type.
  const FOREST_SEASONAL_BLEND = {
    EARLY_SPRING: ['#a0d060', 0.18],
    MID_SPRING:   ['#78e040', 0.10],
    LATE_SPRING:  null,
    EARLY_SUMMER: null, MID_SUMMER: null, LATE_SUMMER: null,
    EARLY_AUTUMN: ['#c07018', 0.20],
    MID_AUTUMN:   ['#a04808', 0.38],
    LATE_AUTUMN:  ['#705030', 0.55],
    EARLY_WINTER: ['#888880', 0.52],
    MID_WINTER:   ['#909090', 0.68],
    LATE_WINTER:  ['#888888', 0.48],
    SPRING: ['#78e040', 0.12], SUMMER: null,
    AUTUMN: ['#a04808', 0.38], WINTER: ['#909090', 0.68],
  };

  // Buildings: subtle frost/amber — rooftops change less than open ground.
  const BUILDING_SEASONAL_BLEND = {
    EARLY_SPRING: null, MID_SPRING: null, LATE_SPRING: null,
    EARLY_SUMMER: null, MID_SUMMER: null, LATE_SUMMER: null,
    EARLY_AUTUMN: ['#d07818', 0.05], MID_AUTUMN: ['#c05010', 0.08], LATE_AUTUMN: ['#a03808', 0.12],
    EARLY_WINTER: ['#d0e8f0', 0.14], MID_WINTER: ['#f0f4f8', 0.22], LATE_WINTER: ['#c8d8e4', 0.15],
    SPRING: null, SUMMER: null, AUTUMN: ['#c05010', 0.08], WINTER: ['#f0f4f8', 0.22],
  };

  // Water stays clearly blue in every season — only hue/value shifts, never goes amber.
  // Rivers/lakes (WATER) and coastal shallow water (WATERFRONT) have separate tables.
  // Bank stroke colors change too: muddy spring, mossy summer, darker autumn, icy winter.
  const WATER_SEASONAL = {
    EARLY_SPRING: { fill: '#4878a8', stroke: '#6a8068' },  // cold spring melt, murky banks
    MID_SPRING:   { fill: '#487aaa', stroke: '#728870' },
    LATE_SPRING:  { fill: '#4a7aaa', stroke: '#7a8870' },
    EARLY_SUMMER: { fill: '#4a7aaa', stroke: '#7a8870' },
    MID_SUMMER:   { fill: '#4a7aaa', stroke: '#7a8870' },  // base
    LATE_SUMMER:  { fill: '#487888', stroke: '#788060' },
    EARLY_AUTUMN: { fill: '#487090', stroke: '#707060' },  // darker, clearly water still
    MID_AUTUMN:   { fill: '#446888', stroke: '#686858' },
    LATE_AUTUMN:  { fill: '#426080', stroke: '#606050' },
    EARLY_WINTER: { fill: '#5888b0', stroke: '#8898a8' },  // icy blue
    MID_WINTER:   { fill: '#6898c0', stroke: '#98b0bc' },  // bright ice-blue
    LATE_WINTER:  { fill: '#5888b0', stroke: '#8898a8' },
    SPRING:       { fill: '#487aaa', stroke: '#728870' },
    SUMMER:       { fill: '#4a7aaa', stroke: '#7a8870' },
    AUTUMN:       { fill: '#446888', stroke: '#686858' },
    WINTER:       { fill: '#6898c0', stroke: '#98b0bc' },
  };
  const WATERFRONT_SEASONAL = {
    EARLY_SPRING: { fill: '#4880b0', stroke: '#c0b068' },  // cool sand
    MID_SPRING:   { fill: '#4882b0', stroke: '#c8bc70' },
    LATE_SPRING:  { fill: '#4882b0', stroke: '#d0c078' },
    EARLY_SUMMER: { fill: '#4882b0', stroke: '#d0c080' },
    MID_SUMMER:   { fill: '#4882b0', stroke: '#d0c080' },  // base
    LATE_SUMMER:  { fill: '#4882b0', stroke: '#c8b878' },
    EARLY_AUTUMN: { fill: '#487098', stroke: '#b09870' },  // cooler water, drier sand
    MID_AUTUMN:   { fill: '#446890', stroke: '#a08868' },
    LATE_AUTUMN:  { fill: '#426088', stroke: '#907858' },
    EARLY_WINTER: { fill: '#507298', stroke: '#a0b4b8' },  // frosted beach
    MID_WINTER:   { fill: '#5878a8', stroke: '#b0c4cc' },  // ice-edged coast
    LATE_WINTER:  { fill: '#4e7098', stroke: '#98acb0' },
    SPRING:       { fill: '#4882b0', stroke: '#c8bc70' },
    SUMMER:       { fill: '#4882b0', stroke: '#d0c080' },
    AUTUMN:       { fill: '#446890', stroke: '#a08868' },
    WINTER:       { fill: '#5878a8', stroke: '#b0c4cc' },
  };

  function applySeasonBlend(hex, type, season, blendTable) {
    // FOREST uses its own seasonal table: goes gray in winter (bare branches), not white (snow).
    if (!blendTable && type === 'FOREST') {
      const entry = FOREST_SEASONAL_BLEND[season];
      return entry ? blendColor(hex, entry[0], entry[1]) : hex;
    }
    const entry = (blendTable || SEASONAL_BLEND)[season];
    if (!entry) return hex;
    if (blendTable === SEASONAL_BLEND && !SEASONAL_FOLIAGE.has(type)) return hex;
    return blendColor(hex, entry[0], entry[1]);
  }

  // ─── COORDINATE TRANSFORM ────────────────────────────────────────────────────

  // Rotate all GeoJSON coordinates by 0/90/180/270° CW around their collective centroid.
  // Used to recalibrate north before import.
  function rotateGeoJSON(features, degrees) {
    const deg = ((degrees % 360) + 360) % 360;
    if (deg === 0) return features;

    // Find global centre (average of all coordinate bounds)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    function scanCoords(c) {
      if (typeof c[0] === 'number') {
        if (c[0] < minX) minX = c[0]; if (c[1] < minY) minY = c[1];
        if (c[0] > maxX) maxX = c[0]; if (c[1] > maxY) maxY = c[1];
      } else { for (const s of c) scanCoords(s); }
    }
    for (const f of features) { if (f.geometry?.coordinates) scanCoords(f.geometry.coordinates); }
    const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;

    function rotPt(x, y) {
      const dx = x - cx, dy = y - cy;
      switch (deg) {
        case 90:  return [cx + dy, cy - dx]; // 90° CW
        case 180: return [cx - dx, cy - dy]; // 180°
        case 270: return [cx - dy, cy + dx]; // 270° CW
        default:  return [x, y];
      }
    }
    function rotCoords(c) {
      if (typeof c[0] === 'number') return rotPt(c[0], c[1]);
      return c.map(rotCoords);
    }
    return features.map(f => {
      if (!f.geometry?.coordinates) return f;
      return { ...f, geometry: { ...f.geometry, coordinates: rotCoords(f.geometry.coordinates) } };
    });
  }

  // Find or create a Foundry Folder by name + document type.
  async function getOrCreateFolder(name, type) {
    const existing = game.folders.find(f => f.name === name && f.type === type);
    if (existing) return existing;
    return Folder.create({ name, type, color: '#3d6624', flags: { world: { cavrilFolder: true } } });
  }

  /**
   * Auto-detect the feet-per-GeoJSON-unit ratio from RESIDENCE building geometry.
   * FTG doesn't embed explicit scale metadata, so we use building sizes as the signal:
   * a typical medieval residence is ~25 feet on its short axis.
   * Falls back to `defaultFeet` (from import dialog) if no RESIDENCE features found.
   */
  function detectFeetPerUnit(features, jsonData, defaultFeet) {
    // Check companion JSON for a top-level size hint (FTG sometimes exports { size: N })
    const jsonSize = jsonData?.size ?? jsonData?.radius ?? jsonData?.mapSize;
    if (typeof jsonSize === 'number' && jsonSize > 0) {
      // jsonSize is likely the map radius in the same GeoJSON units.
      // We don't know the real-world radius but can use it to cross-check building sizes.
      // For now, log it and continue to building heuristic.
      console.log(`[CavrilImport] FTG JSON size hint: ${jsonSize} units`);
    }

    // Building short-axis heuristic: collect RESIDENCE bounding box short dimensions
    const shortSides = [];
    for (const f of features) {
      if (f.properties?.type !== 'BACKGROUND') continue;
      if (f.properties?.backgroundType) continue;          // terrain, not building
      if (f.properties?.buildingType !== 'RESIDENCE') continue;
      const ring = f.geometry?.coordinates?.[0];
      if (!ring || ring.length < 3) continue;
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      for (const [x, y] of ring) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
      const w = maxX - minX, h = maxY - minY;
      if (w > 0.5 && h > 0.5) shortSides.push(Math.min(w, h));
    }

    // Also try BUILDING features (FTG may encode building outlines separately)
    if (shortSides.length === 0) {
      for (const f of features) {
        if (f.properties?.type !== 'BUILDING') continue;
        const bt = f.properties?.buildingType || f.properties?.type;
        if (bt !== 'RESIDENCE') continue;
        const ring = f.geometry?.coordinates?.[0];
        if (!ring || ring.length < 3) continue;
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (const [x, y] of ring) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
        const w = maxX - minX, h = maxY - minY;
        if (w > 0.5 && h > 0.5) shortSides.push(Math.min(w, h));
      }
    }

    if (shortSides.length === 0) {
      console.log(`[CavrilImport] Scale auto-detect: no RESIDENCE features found, using fallback (${defaultFeet} ft/unit)`);
      return defaultFeet;
    }

    shortSides.sort((a, b) => a - b);
    const median = shortSides[Math.floor(shortSides.length / 2)];
    // FTG residences measure ~14–18 units on their short side; 16 ft is the correct assumed width
    // for cramped medieval row-housing, giving feetPerUnit ≈ 1.0 (1 GeoJSON unit = 1 foot).
    const detected = 16 / median;
    console.log(`[CavrilImport] Scale auto-detect: ${shortSides.length} residences, median short side ${median.toFixed(2)} units → ${detected.toFixed(3)} ft/unit`);
    return detected;
  }

  function buildTransform(features) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

    function scanCoords(c) {
      if (typeof c[0] === 'number') {
        if (c[0] < minX) minX = c[0];
        if (c[1] < minY) minY = c[1];
        if (c[0] > maxX) maxX = c[0];
        if (c[1] > maxY) maxY = c[1];
      } else {
        for (const sub of c) scanCoords(sub);
      }
    }

    for (const f of features) {
      if (f.geometry && f.geometry.coordinates) scanCoords(f.geometry.coordinates);
    }

    const rangeX = maxX - minX;
    const rangeY = maxY - minY;
    if (rangeX <= 0 || rangeY <= 0) throw new Error('GeoJSON has no valid geometry bounds.');

    // Fixed scale: 4 px/unit = 4 px/ft = 20 px per 5-ft square, always.
    const scale = FIXED_SCALE;

    // Full canvas the settlement would need at this scale.
    const fullW = rangeX * scale;
    const fullH = rangeY * scale;

    // Crop to TARGET_CANVAS_SIZE, centered on the settlement.
    // Large cities show only their central district; multiple imports can cover different areas.
    const cropW    = Math.min(fullW, TARGET_CANVAS_SIZE);
    const cropH    = Math.min(fullH, TARGET_CANVAS_SIZE);
    const canvasW  = Math.ceil(cropW / GRID_SIZE) * GRID_SIZE;
    const canvasH  = Math.ceil(cropH / GRID_SIZE) * GRID_SIZE;
    const isCropped = fullW > TARGET_CANVAS_SIZE || fullH > TARGET_CANVAS_SIZE;

    // Pixel offset so the visible window is centered on the settlement bounding box.
    const pxOffsetX = (fullW - cropW) / 2;
    const pxOffsetY = (fullH - cropH) / 2;

    // GeoJSON Y increases upward; Foundry Y increases downward → flip.
    // Subtract pixel offset so the center of the settlement lands at the center of the canvas.
    function tc(x, y) {
      return [
        (x - minX) * scale - pxOffsetX,
        (maxY - y) * scale - pxOffsetY,
      ];
    }

    return { minX, minY, maxX, maxY, scale, canvasW, canvasH, tc, isCropped, pxOffsetX, pxOffsetY };
  }

  // ─── DRAWING HELPER ──────────────────────────────────────────────────────────
  // Foundry Drawing: x/y = world origin; shape.points are RELATIVE to that origin.

  function makePolygonDrawing(absPts, isClosed, fillColor, fillAlpha, strokeColor, strokeWidth, strokeAlpha, flags) {
    let minX = Infinity, minY = Infinity;
    for (let i = 0; i < absPts.length; i += 2) {
      if (absPts[i]     < minX) minX = absPts[i];
      if (absPts[i + 1] < minY) minY = absPts[i + 1];
    }
    const relPts = absPts.map((v, i) => (i % 2 === 0 ? v - minX : v - minY));
    return {
      x: minX,
      y: minY,
      shape: { type: 'p', points: relPts, isClosed: !!isClosed },
      fillType:    fillColor ? 1 : 0,
      fillColor:   fillColor  || '#000000',
      fillAlpha:   fillAlpha  != null ? fillAlpha  : 1.0,
      strokeWidth: strokeWidth != null ? strokeWidth : 0,
      strokeColor: strokeColor || '#000000',
      strokeAlpha: strokeAlpha != null ? strokeAlpha : 0,
      flags:       flags || {},
    };
  }

  // ─── VIEWPORT CLIPPING HELPERS ───────────────────────────────────────────────
  // Prevent Foundry from clamping Drawing origins when polygons straddle the crop
  // boundary. Only active when a large settlement is cropped (_importIsCropped=true).
  //
  // Cohen-Sutherland line segment clip against [0,0]→[cW,cH].
  function _clipSegCS(x1, y1, x2, y2, cW, cH) {
    const L=1, R=2, B=4, T=8;
    const code = (x, y) => (x<0?L:0)|(x>cW?R:0)|(y<0?B:0)|(y>cH?T:0);
    let c1=code(x1,y1), c2=code(x2,y2);
    for (let _g=0; _g<20; _g++) {
      if (!(c1|c2)) return [x1,y1,x2,y2];
      if (c1&c2)   return null;
      const dx=x2-x1, dy=y2-y1, c=c1||c2;
      let x, y;
      if      (c&T) { x=x1+dx*(cH-y1)/dy; y=cH; }
      else if (c&B) { x=x1+dx*(0 -y1)/dy; y=0;  }
      else if (c&R) { y=y1+dy*(cW-x1)/dx; x=cW; }
      else          { y=y1+dy*(0 -x1)/dx; x=0;  }
      if (c===c1) { x1=x; y1=y; c1=code(x1,y1); }
      else        { x2=x; y2=y; c2=code(x2,y2); }
    }
    return null;
  }
  // Clip open polyline (flat [x,y,...]) — stitches consecutive visible segments.
  function clipPolylineToCanvas(flat, cW, cH) {
    if (flat.length < 4) return null;
    const out = [];
    for (let i=0; i+2<flat.length; i+=2) {
      const seg = _clipSegCS(flat[i], flat[i+1], flat[i+2], flat[i+3], cW, cH);
      if (!seg) continue;
      const [sx,sy,ex,ey] = seg;
      // Stitch onto previous point if it matches, otherwise start new run
      if (out.length>=2 && Math.abs(out[out.length-2]-sx)<0.5 && Math.abs(out[out.length-1]-sy)<0.5) {
        out.push(ex, ey);
      } else {
        out.push(sx, sy, ex, ey);
      }
    }
    return out.length >= 4 ? out : null;
  }
  // Sutherland-Hodgman closed polygon clip against [0,0]→[cW,cH].
  function clipPolygonToCanvas(flat, cW, cH) {
    if (flat.length < 6) return null;
    let pts = [];
    for (let i=0; i<flat.length; i+=2) pts.push([flat[i], flat[i+1]]);
    function shClip(poly, inside, intersect) {
      if (!poly.length) return [];
      const out = [];
      let s = poly[poly.length - 1];
      for (const e of poly) {
        if (inside(e))      { if (!inside(s)) out.push(intersect(s,e)); out.push(e); }
        else if (inside(s)) { out.push(intersect(s,e)); }
        s = e;
      }
      return out;
    }
    const lerp = (a, b, t) => [a[0]+t*(b[0]-a[0]), a[1]+t*(b[1]-a[1])];
    pts = shClip(pts, p=>p[0]>=0,  (a,b)=>lerp(a,b,  a[0]        /(a[0]-b[0])));
    pts = shClip(pts, p=>p[0]<=cW, (a,b)=>lerp(a,b, (cW-a[0])    /(b[0]-a[0])));
    pts = shClip(pts, p=>p[1]>=0,  (a,b)=>lerp(a,b,  a[1]        /(a[1]-b[1])));
    pts = shClip(pts, p=>p[1]<=cH, (a,b)=>lerp(a,b, (cH-a[1])    /(b[1]-a[1])));
    if (pts.length < 3) return null;
    return pts.flatMap(p=>[p[0], p[1]]);
  }

  // ─── ROAD GRAPH BUILDER ──────────────────────────────────────────────────────

  function buildRoadGraph(features) {
    const navTypes = [...NAVIGABLE_EDGE_TYPES];
    const nodes    = [];
    const nodeMap  = new Map();
    const edges    = [];

    function snapKey(x, y) {
      return `${Math.round(x / ROAD_SNAP)},${Math.round(y / ROAD_SNAP)}`;
    }

    function getOrAdd(x, y) {
      const k = snapKey(x, y);
      if (nodeMap.has(k)) return nodeMap.get(k);
      const idx = nodes.length;
      nodes.push({ x, y });
      nodeMap.set(k, idx);
      return idx;
    }

    for (const f of features) {
      if (f.properties?.type !== 'EDGE') continue;
      const et = f.properties.edgeType;
      if (!NAVIGABLE_EDGE_TYPES.has(et)) continue;
      const coords  = f.geometry.coordinates;
      const typeIdx = navTypes.indexOf(et);
      for (let i = 0; i < coords.length - 1; i++) {
        const [ax, ay] = coords[i];
        const [bx, by] = coords[i + 1];
        const a = getOrAdd(ax, ay);
        const b = getOrAdd(bx, by);
        if (a === b) continue;
        const dx = bx - ax, dy = by - ay;
        edges.push([a, b, Math.sqrt(dx * dx + dy * dy), typeIdx]);
      }
    }

    return {
      nodeArr:  nodes.flatMap(n => [n.x, n.y]),
      edgeArr:  edges.flat(),
      navTypes,
    };
  }

  // ─── BRIDGE DECK GENERATOR ───────────────────────────────────────────────────
  // Procedural fallback: detects where road polylines cross WATER polygon boundaries
  // and stamps a filled stone-coloured rectangle over each crossing at sort:25.
  // In practice FTG emits explicit BRIDGE edgeType features so this typically
  // produces 0 results, but is kept as a safety net for older exports.
  function buildBridgeDrawings(features, transform) {
    // Returns t on segment AB (0–1) where it intersects segment CD, or null.
    function segT(ax, ay, bx, by, cx, cy, dx2, dy2) {
      const rdx = bx - ax, rdy = by - ay;
      const sdx = dx2 - cx, sdy = dy2 - cy;
      const denom = rdx * sdy - rdy * sdx;
      if (Math.abs(denom) < 1e-9) return null;
      const t = ((cx - ax) * sdy - (cy - ay) * sdx) / denom;
      const u = ((cx - ax) * rdy - (cy - ay) * rdx) / denom;
      if (t >= -1e-6 && t <= 1 + 1e-6 && u >= -1e-6 && u <= 1 + 1e-6)
        return Math.max(0, Math.min(1, t));
      return null;
    }

    // Pre-build pixel-space rings for all WATER polygon features.
    // Rivers/lakes appear in TWO feature categories:
    //   1. type === 'WATER'    — standalone water features
    //   2. type === 'BACKGROUND' + backgroundType === 'WATER'/'WATERFRONT' — terrain water
    // Both need checking so bridges appear regardless of how the source data encodes rivers.
    const waterRings = [];
    for (const f of features) {
      const ft = f.properties?.type;
      const bt2 = f.properties?.backgroundType;
      const isWater = ft === 'WATER' ||
                      (ft === 'BACKGROUND' && (bt2 === 'WATER' || bt2 === 'WATERFRONT'));
      if (!isWater) continue;
      const ring = f.geometry.coordinates[0];
      if (!ring) continue;
      waterRings.push(ring.map(([gx, gy]) => transform.tc(gx, gy)));
    }
    console.log(`[CavrilImport] Bridge detection: ${waterRings.length} water rings found`);
    if (waterRings.length === 0) return [];

    const drawings = [];
    for (const f of features) {
      if (f.properties?.type !== 'EDGE') continue;
      const et = f.properties.edgeType;
      if (WALL_TYPES.has(et)) continue;
      const cfg = ROAD_COLORS[et];
      if (!cfg) continue;

      const coords = f.geometry.coordinates;
      for (let si = 0; si < coords.length - 1; si++) {
        const [ax, ay] = transform.tc(coords[si][0],     coords[si][1]);
        const [bx, by] = transform.tc(coords[si + 1][0], coords[si + 1][1]);
        const segDx = bx - ax, segDy = by - ay;
        const segLen = Math.sqrt(segDx * segDx + segDy * segDy);
        if (segLen < 1) continue;

        // Find all t values where this segment crosses any water polygon edge.
        const crossings = [];
        for (let ri = 0; ri < waterRings.length; ri++) {
          const ring = waterRings[ri];
          const n = ring.length;
          for (let i = 0, j = n - 1; i < n; j = i++) {
            const [cx, cy]   = ring[i];
            const [dx2, dy2] = ring[j];
            const t = segT(ax, ay, bx, by, cx, cy, dx2, dy2);
            if (t !== null) crossings.push({ t, ri });
          }
        }
        if (crossings.length < 2) continue;
        crossings.sort((a, b) => a.t - b.t);

        // Pair adjacent crossings.  Verify midpoint is inside water → bridge.
        for (let ci = 0; ci + 1 < crossings.length; ci += 2) {
          const t0 = crossings[ci].t, t1 = crossings[ci + 1].t;
          const mx = ax + (t0 + t1) * 0.5 * segDx;
          const my = ay + (t0 + t1) * 0.5 * segDy;
          if (!waterRings.some(ring => pip([mx, my], ring))) continue;

          const p1x = ax + t0 * segDx, p1y = ay + t0 * segDy;
          const p2x = ax + t1 * segDx, p2y = ay + t1 * segDy;
          const spanDx = p2x - p1x, spanDy = p2y - p1y;
          const spanLen = Math.sqrt(spanDx * spanDx + spanDy * spanDy);
          if (spanLen < 2) continue;

          const nx  = spanDx / spanLen, ny  = spanDy / spanLen; // forward unit
          const px2 = -ny,             py2 = nx;                // perpendicular
          const overhang = Math.round(cfg.width * _importStrokeScale * 0.7);
          const hw       = Math.max(2, Math.round((cfg.width / 2 + 4) * _importStrokeScale));

          const e1x = p1x - nx * overhang, e1y = p1y - ny * overhang;
          const e2x = p2x + nx * overhang, e2y = p2y + ny * overhang;

          const absPts = [
            e1x + px2 * hw, e1y + py2 * hw,
            e2x + px2 * hw, e2y + py2 * hw,
            e2x - px2 * hw, e2y - py2 * hw,
            e1x - px2 * hw, e1y - py2 * hw,
          ];
          const bd = makePolygonDrawing(
            absPts, true,
            '#a09070', 1.0,    // warm stone fill, opaque
            '#706040', 2, 1.0, // darker stone edge
            { world: { cavrilBridge: true, edgeType: et } }
          );
          bd.sort = 27; bd.z = 27;
          drawings.push(bd);
        }
      }
    }
    return drawings;
  }

  // ─── ROAD ELBOW CAPS ─────────────────────────────────────────────────────────
  // Place a filled circle at every road line endpoint/junction to cap the
  // raw line-end and smooth out intersections. Deduplicates by pixel position,
  // keeping the widest road type at each point.

  // onlyTypes: if provided, only process those edge types; if null, process all except walls/fences
  const WALL_TYPES = new Set(['STONE_FENCE', 'STONE_WALL', 'BORDER']);

  // widthMod:      extra pixels added to cfg.width for the elbow radius (+8 for bed pass, -6 for surface pass)
  // colorOverride: use this color instead of cfg.DAY (ROAD_BED_COLOR for bed pass)
  // alphaOverride: fill alpha (default 1.0; bed pass should also be 1.0 for fully opaque outline)
  // deadEndShape: when provided ('r' = rectangle), dead-end endpoints are included and
  // rendered as that shape instead of the default circle.  Used for the bed pass so
  // road termini get a square kerb cap instead of a circle or nothing.
  function buildRoadElbows(features, transform, onlyTypes, sortVal = 5, excludeTypes = null,
                           widthMod = 0, colorOverride = null, alphaOverride = 1.0, deadEndShape = null) {
    // Pre-pass: count how many ROAD features share each endpoint key.
    // A key that appears only once is a dead-end — shape controlled by deadEndShape.
    // Keys that appear 2+ times are junctions — get circular elbow caps.
    // Walls always get elbows at every vertex (they're always joints/corners),
    // so we only do this count for non-wall road types.
    const endpointCount = new Map();
    for (const f of features) {
      if (f.properties?.type !== 'EDGE') continue;
      const et = f.properties.edgeType;
      if (!ROAD_COLORS[et] || WALL_TYPES.has(et)) continue;
      const coords = f.geometry.coordinates;
      for (const [gx, gy] of [coords[0], coords[coords.length - 1]]) {
        const [px, py] = transform.tc(gx, gy);
        const key = `${Math.round(px)},${Math.round(py)}`;
        endpointCount.set(key, (endpointCount.get(key) || 0) + 1);
      }
    }

    // pointMap key → { px, py, width, color, et, isDeadEnd }
    const pointMap = new Map();

    for (const f of features) {
      if (f.properties?.type !== 'EDGE') continue;
      const et  = f.properties.edgeType;
      const cfg = ROAD_COLORS[et];
      if (!cfg) continue;

      if (excludeTypes && excludeTypes.has(et)) continue;  // e.g. skip piers/bridges in normal pass

      if (onlyTypes) {
        if (!onlyTypes.has(et)) continue;
        // STONE_FENCE gets circle elbows (small dots at corners); STONE_WALL gets them too.
        // No exclusion — squares are produced only by buildWallDecorations for STONE_WALL.
      } else {
        if (WALL_TYPES.has(et)) continue; // walls handled in their own pass
      }

      const coords = f.geometry.coordinates;
      // For roads: build (endpoint, adjacentPoint) pairs so dead-end caps can be
      // rotated to align with the road direction. Walls use all vertices, no direction needed.
      const endpointPairs = WALL_TYPES.has(et)
        ? coords.map(c => ({ pt: c, adjPt: null }))
        : [
            { pt: coords[0],                 adjPt: coords.length > 1 ? coords[1]                 : null },
            { pt: coords[coords.length - 1], adjPt: coords.length > 1 ? coords[coords.length - 2] : null },
          ];

      for (const { pt: [gx, gy], adjPt } of endpointPairs) {
        const [px, py] = transform.tc(gx, gy);
        const key      = `${Math.round(px)},${Math.round(py)}`;
        const isDeadEnd = !WALL_TYPES.has(et) && (endpointCount.get(key) || 0) < 2;
        // Skip dead-end endpoints unless this pass explicitly handles them (deadEndShape set).
        if (isDeadEnd && !deadEndShape) continue;

        // For dead-end rectangle caps: compute the road angle so the square can be
        // rotated to align with the road direction at that terminus.
        let angle = 0;
        if (isDeadEnd && deadEndShape && adjPt) {
          const [apx, apy] = transform.tc(adjPt[0], adjPt[1]);
          // Direction: from adjacent interior point toward the dead-end terminus.
          angle = Math.atan2(py - apy, px - apx) * 180 / Math.PI;
        }

        const effectiveWidth = Math.max(1, Math.round((cfg.width + widthMod) * _importStrokeScale));
        const existing = pointMap.get(key);
        if (!existing || effectiveWidth > existing.width) {
          pointMap.set(key, { px, py, width: effectiveWidth, color: colorOverride || cfg.DAY, et, isDeadEnd, angle });
        }
      }
    }

    const elbows = [];
    for (const { px, py, width, color, et, isDeadEnd, angle } of pointMap.values()) {
      const r = width / 2;
      // Junctions get circles ('e'); dead-ends get the caller's requested shape ('r' = square).
      const shapeType = (isDeadEnd && deadEndShape) ? deadEndShape : 'e';
      // Dead-end rectangle: thin in the road direction (width, which aligns with road after rotation)
      // so the terminus cap matches the side border thickness, not the full bed half-width.
      // widthMod is the extra width added to the road bed over the surface (e.g. 8px → 4px per side).
      // Using widthMod as the cap's road-direction span makes the end look the same weight as the sides.
      const capW = (isDeadEnd && deadEndShape === 'r')
        ? Math.max(2, Math.round(Math.max(6, widthMod > 0 ? widthMod : 8) * _importStrokeScale))
        : r * 2;
      elbows.push({
        x:           px - capW / 2,
        y:           py - r,
        shape:       { type: shapeType, width: capW, height: r * 2 },
        rotation:    (isDeadEnd && deadEndShape) ? (angle || 0) : 0,
        fillType:    1,
        fillColor:   color,
        fillAlpha:   alphaOverride,
        strokeWidth: 0,
        strokeAlpha: 0,
        // sort matches the road bed layer — ensures elbow caps stay flush with the road.
        sort: sortVal, z: sortVal,
        flags: { world: { cavrilRoadElbow: true, edgeType: et, ...(colorOverride ? { _bedElbow: true, _bedColor: colorOverride } : {}) } },
      });
    }
    return elbows;
  }

  // ─── WALL DECORATIONS ────────────────────────────────────────────────────────
  // Guard towers at STONE_WALL vertices + gate openings where roads pass through walls.

  function segmentIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
    const denom = (ax - bx) * (cy - dy) - (ay - by) * (cx - dx);
    if (Math.abs(denom) < 1e-10) return null;
    const t = ((ax - cx) * (cy - dy) - (ay - cy) * (cx - dx)) / denom;
    const u = -((ax - bx) * (ay - cy) - (ay - by) * (ax - cx)) / denom;
    if (t > 0.02 && t < 0.98 && u > 0.02 && u < 0.98) {
      return { gx: ax + t * (bx - ax), gy: ay + t * (by - ay), roadT: u };
    }
    return null;
  }

  function buildWallDecorations(features, waterPolyFeatures, transform, hour) {
    const towers = [], gates = [], aquaducts = [], towerShadows = [];

    // Collect all wall segments (GeoJSON space) and their pixel-space equivalents
    const wallSegs = [];
    for (const f of features) {
      if (f.properties?.type !== 'EDGE') continue;
      const et = f.properties.edgeType;
      if (!WALL_TYPES.has(et)) continue;
      const cfg = ROAD_COLORS[et];
      if (!cfg) continue;
      const coords = f.geometry.coordinates;
      for (let i = 0; i < coords.length - 1; i++) {
        const [_wpx0, _wpy0] = transform.tc(coords[i][0],   coords[i][1]);
        const [_wpx1, _wpy1] = transform.tc(coords[i+1][0], coords[i+1][1]);
        wallSegs.push({
          gx0: coords[i][0],   gy0: coords[i][1],
          gx1: coords[i+1][0], gy1: coords[i+1][1],
          wpx0: _wpx0, wpy0: _wpy0, wpx1: _wpx1, wpy1: _wpy1,
          wallWidth: Math.max(1, Math.round(cfg.width * _importStrokeScale)), et,
        });
      }
    }

    // Collect road segments for gate detection
    const roadSegs = [];
    for (const f of features) {
      if (f.properties?.type !== 'EDGE') continue;
      const et = f.properties.edgeType;
      if (!NAVIGABLE_EDGE_TYPES.has(et)) continue;
      const cfg = ROAD_COLORS[et];
      if (!cfg) continue;
      const coords = f.geometry.coordinates;
      for (let i = 0; i < coords.length - 1; i++) {
        const [cpx0, cpy0] = transform.tc(coords[i][0], coords[i][1]);
        const [cpx1, cpy1] = transform.tc(coords[i+1][0], coords[i+1][1]);
        roadSegs.push({
          gx0: coords[i][0], gy0: coords[i][1],
          gx1: coords[i+1][0], gy1: coords[i+1][1],
          cpx0, cpy0, cpx1, cpy1,
          width: Math.max(1, Math.round(cfg.width * _importStrokeScale)),
        });
      }
    }

    // ── Unified proximity dedup ──────────────────────────────────────────────────
    // All gate / aqueduct / tower placements share one dedup array so none can
    // spawn within MIN_STRUCT_DIST px of another structure of any type.
    const MIN_STRUCT_DIST   = Math.max(8, Math.round(24 * _importStrokeScale));  // px, scales with settlement
    const placedStructurePx = [];  // [[px, py], ...]
    function structureTooClose(px, py) {
      const d2 = MIN_STRUCT_DIST * MIN_STRUCT_DIST;
      return placedStructurePx.some(([sx, sy]) => {
        const dx = px - sx, dy = py - sy;
        return dx * dx + dy * dy < d2;
      });
    }

    // ── Gates: wherever a road genuinely crosses a STONE_WALL or BORDER ──
    // STONE_FENCE excluded — fenced farm roads must not get gates.
    // Endpoint-snap fallback removed — road must actually intersect the wall line;
    // a road that terminates at the wall (dead-end) does not get a gate.
    for (const ws of wallSegs.filter(ws => ws.et !== 'STONE_FENCE')) {
      for (const rs of roadSegs) {
        const hit = segmentIntersect(ws.gx0, ws.gy0, ws.gx1, ws.gy1,
                                     rs.gx0, rs.gy0, rs.gx1, rs.gy1);
        if (!hit) continue;

        const [ix, iy] = transform.tc(hit.gx, hit.gy);
        if (structureTooClose(ix, iy)) continue;
        placedStructurePx.push([ix, iy]);

        // Gate orientation follows the wall face, not the road direction.
        const _wdx = ws.wpx1 - ws.wpx0, _wdy = ws.wpy1 - ws.wpy0;
        const _wlen = Math.sqrt(_wdx * _wdx + _wdy * _wdy) || 1;
        const pwx = _wdx / _wlen, pwy = _wdy / _wlen;  // along wall face
        const rdx = -pwy,         rdy =  pwx;           // through wall (perpendicular)

        // Gate: spans full road opening; thickness = tower half-size so gates and towers feel like one system
        const wallTowerSize = Math.max(Math.round(14 * _importStrokeScale), ws.wallWidth * 1.6);
        const halfSpan  = rs.width + Math.max(1, Math.round(8 * _importStrokeScale));
        const halfThick = Math.max(Math.round(7 * _importStrokeScale), wallTowerSize * 0.55);
        const gatePts = [
          ix + pwx * halfSpan - rdx * halfThick,  iy + pwy * halfSpan - rdy * halfThick,
          ix + pwx * halfSpan + rdx * halfThick,  iy + pwy * halfSpan + rdy * halfThick,
          ix - pwx * halfSpan + rdx * halfThick,  iy - pwy * halfSpan + rdy * halfThick,
          ix - pwx * halfSpan - rdx * halfThick,  iy - pwy * halfSpan - rdy * halfThick,
        ];
        // Gray stone gate — reads as a portcullis / arch rather than a timber door
        const gd = makePolygonDrawing(
          gatePts, true, '#848078', 1.0, '#484440', 2, 1.0,
          { world: { cavrilWallGate: true } }
        );
        gd.sort = 350; gd.z = 350;
        gd.fillType = 2; gd.texture = _TEX.STONE;
        gates.push(gd);
        // Gate shadow — same footprint shifted by shadow vector, below walls at sort 149
        { const { sx: _gsx, sy: _gsy } = getShadowVec(hour);
          const gShadowPts = [];
          for (let _gi = 0; _gi < gatePts.length; _gi += 2)
            gShadowPts.push(gatePts[_gi] + _gsx, gatePts[_gi + 1] + _gsy);
          const gs = makePolygonDrawing(
            gShadowPts, true, '#20201a', 0.22, null, 0, 0,
            // basePts = gatePts before offset — stored so updateTOD can rebuild
            { world: { cavrilShadow: true, cavrilGateShadow: true, basePts: [...gatePts] } }
          );
          gs.sort = 149; gs.z = 149;
          towerShadows.push(gs); }
      }
    }

    // ── Vertex-snap gates: roads that terminate exactly at a wall vertex ──────
    // FTG routes roads to wall vertices (dead-ends at the wall), so segmentIntersect
    // misses them (t≈0 or t≈1). Check road endpoints within GATE_VERTEX_SNAP px of
    // any STONE_WALL/BORDER vertex and place a wider gate there, replacing the tower.
    {
      const GATE_VERTEX_SNAP = Math.max(6, Math.round(18 * _importStrokeScale)); // px, scales with settlement
      // Deduplicate wall vertices into a map keyed by snapped pixel coords
      const wvMap = new Map();
      for (const ws of wallSegs) {
        if (ws.et === 'STONE_FENCE') continue;
        const _wdx = ws.wpx1 - ws.wpx0, _wdy = ws.wpy1 - ws.wpy0;
        const _wl  = Math.sqrt(_wdx * _wdx + _wdy * _wdy) || 1;
        for (const [gx, gy] of [[ws.gx0, ws.gy0], [ws.gx1, ws.gy1]]) {
          const [px, py] = transform.tc(gx, gy);
          const k = `${Math.round(px / 3)},${Math.round(py / 3)}`;
          if (!wvMap.has(k)) wvMap.set(k, { px, py, wallWidth: ws.wallWidth, sinSum: 0, cosSum: 0 });
          const v = wvMap.get(k);
          if (ws.wallWidth > v.wallWidth) v.wallWidth = ws.wallWidth;
          v.sinSum += _wdy / _wl; v.cosSum += _wdx / _wl;
        }
      }
      const snapD2 = GATE_VERTEX_SNAP * GATE_VERTEX_SNAP;
      for (const wv of wvMap.values()) {
        if (structureTooClose(wv.px, wv.py)) continue; // already a gate/aqueduct here
        let placed = false;
        for (const rs of roadSegs) {
          if (placed) break;
          // Check both road endpoints
          for (const [epx, epy, opx, opy] of [
            [rs.cpx0, rs.cpy0, rs.cpx1, rs.cpy1],
            [rs.cpx1, rs.cpy1, rs.cpx0, rs.cpy0],
          ]) {
            const ddx = epx - wv.px, ddy = epy - wv.py;
            if (ddx * ddx + ddy * ddy > snapD2) continue;
            // Gate orientation follows the wall face at this vertex (averaged from adjacent segments).
            const _vAngle = Math.atan2(wv.sinSum, wv.cosSum);
            const pwx = Math.cos(_vAngle), pwy = Math.sin(_vAngle); // along wall face
            const rdx = -pwy,             rdy =  pwx;               // through wall
            const wallTowerSize = Math.max(14, wv.wallWidth * 1.6);
            const halfSpan  = rs.width + 16;               // wider than regular gate
            const halfThick = Math.max(7, wallTowerSize * 0.55);
            const gatePts = [
              wv.px + pwx * halfSpan - rdx * halfThick,  wv.py + pwy * halfSpan - rdy * halfThick,
              wv.px + pwx * halfSpan + rdx * halfThick,  wv.py + pwy * halfSpan + rdy * halfThick,
              wv.px - pwx * halfSpan + rdx * halfThick,  wv.py - pwy * halfSpan + rdy * halfThick,
              wv.px - pwx * halfSpan - rdx * halfThick,  wv.py - pwy * halfSpan - rdy * halfThick,
            ];
            const gd = makePolygonDrawing(
              gatePts, true, '#848078', 1.0, '#484440', 2, 1.0,
              { world: { cavrilWallGate: true, cavrilVertexGate: true } }
            );
            gd.sort = 350; gd.z = 350;
            gd.fillType = 2; gd.texture = _TEX.STONE;
            gates.push(gd);
            // Gate shadow — vertex-snap variant, same shadow logic
            { const { sx: _gsx, sy: _gsy } = getShadowVec(hour);
              const gShadowPts = [];
              for (let _gi = 0; _gi < gatePts.length; _gi += 2)
                gShadowPts.push(gatePts[_gi] + _gsx, gatePts[_gi + 1] + _gsy);
              const gs = makePolygonDrawing(
                gShadowPts, true, '#20201a', 0.22, null, 0, 0,
                { world: { cavrilShadow: true, cavrilGateShadow: true, cavrilVertexGate: true, basePts: [...gatePts] } }
              );
              gs.sort = 149; gs.z = 149;
              towerShadows.push(gs); }
            placedStructurePx.push([wv.px, wv.py]); // suppress tower at this vertex
            placed = true;
            break;
          }
        }
      }
    }

    // ── Aqueducts: FTG bakes a gap into the wall where rivers flow through. ──
    // We detect these gaps by finding "loose-end" wall endpoints — segment endpoints
    // that don't connect to any other segment — that sit near a water polygon.
    // Pairs of loose ends within MAX_GAP px are bridged with a gray aqueduct rectangle
    // that visually fills the break and reads as a culvert or portcullis-style opening.

    // Count how many wall segments share each endpoint (snap to 3px grid)
    const _epCount = new Map();
    const _epData  = new Map();
    for (const ws of wallSegs) {
      for (const [gx, gy] of [[ws.gx0, ws.gy0], [ws.gx1, ws.gy1]]) {
        const [px, py] = transform.tc(gx, gy);
        const k = `${Math.round(px / 3)},${Math.round(py / 3)}`;
        _epCount.set(k, (_epCount.get(k) || 0) + 1);
        if (!_epData.has(k)) _epData.set(k, { px, py, gx, gy, wallWidth: ws.wallWidth });
      }
    }
    // Loose ends = endpoints appearing only once = not continued by another segment
    const looseEnds = [];
    for (const [k, cnt] of _epCount) { if (cnt === 1) looseEnds.push(_epData.get(k)); }

    const MAX_WALL_GAP = 80; // px — max gap across a river at city-wall scale

    for (let i = 0; i < looseEnds.length; i++) {
      const a = looseEnds[i];
      for (let j = i + 1; j < looseEnds.length; j++) {
        const b = looseEnds[j];
        const dx   = b.px - a.px, dy = b.py - a.py;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist > MAX_WALL_GAP || dist < 4) continue;

        // Check that the gap midpoint sits inside or very near a water polygon
        const midGx = (a.gx + b.gx) / 2, midGy = (a.gy + b.gy) / 2;
        const waterProximity = (waterPolyFeatures || []).some(wf => {
          const ring = wf.geometry?.coordinates?.[0];
          if (!ring) return false;
          if (pip([midGx, midGy], ring)) return true;
          return ptNearPoly(midGx, midGy, ring, 8 / transform.scale);
        });
        if (!waterProximity) continue;

        const midX = (a.px + b.px) / 2, midY = (a.py + b.py) / 2;
        if (structureTooClose(midX, midY)) continue;
        // Mark all three points so towers don't spawn at aqueduct endpoints or midpoint
        placedStructurePx.push([a.px, a.py], [b.px, b.py], [midX, midY]);

        // Gap direction (A → B) = along the wall (both endpoints share the same wall line)
        const gapDirX = dx / dist, gapDirY = dy / dist;
        const perpX   = -gapDirY,  perpY   = gapDirX;  // perpendicular = river direction

        const wTowerSize = Math.max(14, a.wallWidth * 1.6);
        const halfSpan   = dist / 2 + 5;                   // spans gap + overlap with wall ends
        const halfThick  = Math.max(7, wTowerSize * 0.55); // matches gate thickness

        const aqPts = [
          midX + gapDirX * halfSpan - perpX * halfThick,  midY + gapDirY * halfSpan - perpY * halfThick,
          midX + gapDirX * halfSpan + perpX * halfThick,  midY + gapDirY * halfSpan + perpY * halfThick,
          midX - gapDirX * halfSpan + perpX * halfThick,  midY - gapDirY * halfSpan + perpY * halfThick,
          midX - gapDirX * halfSpan - perpX * halfThick,  midY - gapDirY * halfSpan - perpY * halfThick,
        ];
        const ad = makePolygonDrawing(
          aqPts, true, '#848078', 1.0, '#484440', 1, 1.0,
          { world: { cavrilAquaduct: true } }
        );
        ad.sort = 350; ad.z = 350;
        ad.fillType = 2; ad.texture = _TEX.ROOF;
        aquaducts.push(ad);
      }
    }

    // ── Guard towers: one at EVERY STONE_WALL/BORDER vertex, rotated along wall ──
    // STONE_FENCE excluded — no towers on fences.
    // Towers that fall within (towerSize) px of a gate opening are suppressed so the gate
    // stands alone without a square overlapping it.
    const towerMap = new Map();
    for (const f of features) {
      if (f.properties?.type !== 'EDGE') continue;
      const et = f.properties.edgeType;
      if (et === 'STONE_FENCE') continue;
      if (!WALL_TYPES.has(et)) continue;
      const cfg = ROAD_COLORS[et];
      if (!cfg) continue;
      const towerSize = Math.max(14, cfg.width * 1.6); // reduced from 2.2×
      const coords = f.geometry.coordinates;
      for (let i = 0; i < coords.length; i++) {
        const [gx, gy] = coords[i];
        const [px, py] = transform.tc(gx, gy);
        const key = `${Math.round(px / 3)},${Math.round(py / 3)}`;
        if (!towerMap.has(key)) towerMap.set(key, { px, py, size: towerSize, sinSum: 0, cosSum: 0 });
        const td = towerMap.get(key);
        if (towerSize > td.size) td.size = towerSize;
        if (i > 0) {
          const [px0, py0] = transform.tc(coords[i-1][0], coords[i-1][1]);
          const a = Math.atan2(py - py0, px - px0);
          td.sinSum += Math.sin(a); td.cosSum += Math.cos(a);
        }
        if (i < coords.length - 1) {
          const [px1, py1] = transform.tc(coords[i+1][0], coords[i+1][1]);
          const a = Math.atan2(py1 - py, px1 - px);
          td.sinSum += Math.sin(a); td.cosSum += Math.cos(a);
        }
      }
    }
    for (const { px, py, size, sinSum, cosSum } of towerMap.values()) {
      // Skip tower if it's within MIN_STRUCT_DIST of a gate or aqueduct
      if (structureTooClose(px, py)) continue;
      placedStructurePx.push([px, py]);

      const wallAngle = Math.atan2(sinSum, cosSum);
      const h = size / 2;
      const c = Math.cos(wallAngle), s = Math.sin(wallAngle);
      const towerPts = [
        px + h*c - h*s,  py + h*s + h*c,
        px + h*c + h*s,  py + h*s - h*c,
        px - h*c + h*s,  py - h*s - h*c,
        px - h*c - h*s,  py - h*s + h*c,
      ];
      const td = makePolygonDrawing(
        towerPts, true, '#887868', 1.0, '#50403a', 2, 1.0,
        { world: { cavrilWallTower: true } }
      );
      td.sort = 350; td.z = 350;
      td.fillType = 2; td.texture = _TEX.ROOF;
      towers.push(td);

      // Tower shadow — shifted polygon at low opacity (0.20 keeps junction overlaps clean).
      {
        const { sx: tsx, sy: tsy } = getShadowVec(hour || 12);
        const shadowPts = [
          towerPts[0] + tsx, towerPts[1] + tsy,
          towerPts[2] + tsx, towerPts[3] + tsy,
          towerPts[4] + tsx, towerPts[5] + tsy,
          towerPts[6] + tsx, towerPts[7] + tsy,
        ];
        const ts = makePolygonDrawing(
          shadowPts, true, '#20201a', 0.20, null, 0, 0,
          // basePts = towerPts before shadow offset — stored so updateTOD can rebuild
          { world: { cavrilShadow: true, cavrilTowerShadow: true, basePts: [...towerPts] } }
        );
        ts.sort = 149; ts.z = 149;
        towerShadows.push(ts);
      }
    }

    return { towers, gates, aquaducts, towerShadows };
  }

  // ─── BUILDING DATA PACKER ────────────────────────────────────────────────────

  function packBuildings(features, jsonBuildings, transform) {
    const jsonMap = new Map();
    if (jsonBuildings) {
      for (const b of jsonBuildings) jsonMap.set(b.id, b);
    }

    const packed = [];
    for (const f of features) {
      if (f.properties?.type !== 'BUILDING') continue;
      const id     = f.properties.id;
      const btype  = f.properties.buildingType || 'DEFAULT';
      const ring   = f.geometry.coordinates[0];
      const geoC   = polyCentroid(ring);
      const [cx, cy] = transform.tc(geoC[0], geoC[1]);

      const polyPx = [];
      for (const [gx, gy] of ring) {
        const [px, py] = transform.tc(gx, gy);
        polyPx.push(px, py);
      }

      const j = jsonMap.get(id) || {};
      packed.push({
        id,
        name:         f.properties.name || j.name || j.specificBuildingType || btype,
        type:         btype,
        specificType: j.specificBuildingType || '',
        cx, cy,
        polyPx,
        openHour:  j.openingTimes?.openHour  ?? 8,
        closeHour: j.openingTimes?.closeHour ?? 20,
        material:  f.properties.material || '',
        height:    BUILDING_HEIGHTS[btype] || 2,
      });
    }
    return packed;
  }

  // ─── JOURNAL STORAGE ─────────────────────────────────────────────────────────

  async function storeCityInJournal(sceneName, jsonData, sceneId, packedBuildings) {
    const title = `CavrilCity: ${sceneName}`;

    const existing = game.journal.getName(title);
    if (existing) await existing.delete();

    // Prefer packedBuildings (has type, openHour, closeHour, cx, cy) over raw jsonData.buildings.
    const buildings        = packedBuildings || jsonData.buildings || [];
    const people           = jsonData.people    || [];
    const totalPeoplePages = Math.max(1, Math.ceil(people.length / PEOPLE_PER_PAGE));
    const pages            = [];

    // Page 0 — buildings
    pages.push({
      type: 'text',
      name: 'Buildings',
      text: { content: '' },
      flags: { world: { cavrilData: 'buildings', sceneId, buildings } },
    });

    // Pages 1+ — people in chunks
    for (let p = 0; p < totalPeoplePages; p++) {
      pages.push({
        type: 'text',
        name: `People ${p + 1}`,
        text: { content: '' },
        flags: {
          world: {
            cavrilData: 'people',
            sceneId,
            page: p,
            totalPages: totalPeoplePages,
            people: people.slice(p * PEOPLE_PER_PAGE, (p + 1) * PEOPLE_PER_PAGE),
          },
        },
      });
    }

    const journalFolder = await getOrCreateFolder('Cavril Settlements', 'JournalEntry');
    return JournalEntry.create({
      name: title,
      folder: journalFolder.id,
      pages,
      flags: {
        world: {
          cavrilImport: true,
          sceneId,
          peopleCount:   people.length,
          buildingCount: buildings.length,
          importedAt:    Date.now(),
        },
      },
    });
  }

  // ─── TREE GENERATOR ──────────────────────────────────────────────────────────

  /**
   * Place trees along the perimeter of a polygon at regular intervals.
   * Used for farm field hedgerows and forest belts.
   *
   * Inner rings (perpOffset > 0) walk an inset of the original polygon computed
   * with insetPolyFlat.  This correctly handles concave polygons — every tree is
   * at a consistent inward offset along the LOCAL edge bisector rather than being
   * pushed toward the global centroid (which overshoots at sharp or concave corners
   * and leaves visible gaps).  Direction is auto-verified: if insetPolyFlat returns
   * a ring that expands outward (winding edge case) the sign is flipped.
   * Outer ring (perpOffset = 0) scatters symmetrically around the boundary.
   *
   * IMPORTANT for callers: forest perimeter trees must be called with an
   * excludePolys that has BOTH forest polygons AND road lines removed.
   * Road margins are deliberately skipped for forest edges because the
   * treeline naturally sits at the road edge; removing the 12px road
   * clearance allows trees right up to (and across) the road boundary.
   */
  function generatePerimeterTrees(ring, excludePolys, rng, spacing, perpOffset, forestTint) {
    const trees = [];
    const n     = ring.length;

    // Determine the ring to walk.
    // For inner rings (perpOffset > 0) use insetPolyFlat so every tree is already
    // at the correct inward offset — handles concave polygons correctly.
    let walkRing = ring;
    if ((perpOffset || 0) > 0) {
      // Convert [[x,y],...] → flat [x,y,...] without the closing repeat vertex.
      const flat = [];
      for (let i = 0; i < n - 1; i++) flat.push(ring[i][0], ring[i][1]);
      let iFlat = insetPolyFlat(flat, perpOffset);

      // Direction verification: midpoint of first edge of the inset ring must lie
      // inside the original ring.  If it doesn't, insetPolyFlat expanded (wrong
      // winding assumption) — negate the offset to get the true inward shrink.
      if (iFlat.length >= 4) {
        const mid = [(iFlat[0] + iFlat[2]) / 2, (iFlat[1] + iFlat[3]) / 2];
        if (!pip(mid, ring)) iFlat = insetPolyFlat(flat, -perpOffset);
      }

      // Accept the inset only if it has ≥3 vertices AND its first mid-edge point
      // lies inside the original ring.  Acute miter angles can push an inset vertex
      // wildly outward so a final pip re-check catches that edge case.  On failure
      // fall back to walking the original outer ring rather than silently dropping
      // all trees on this polygon.
      const _insetOk = iFlat.length >= 6 &&
        pip([(iFlat[0] + iFlat[2]) / 2, (iFlat[1] + iFlat[3]) / 2], ring);

      if (_insetOk) {
        walkRing = [];
        for (let i = 0; i < iFlat.length; i += 2) walkRing.push([iFlat[i], iFlat[i + 1]]);
        walkRing.push([...walkRing[0]]);     // close the ring
      }
      // else: walkRing stays as `ring` (outer perimeter, perpOffset=0 behaviour)
    }

    // Continuous-path walk — arc-distance based placement so tree density is
    // uniform regardless of edge angle or polygon segmentation.
    const wn = walkRing.length;
    let totalDist = 0;
    for (let i = 0; i < wn - 1; i++) {
      const dx = walkRing[i + 1][0] - walkRing[i][0], dy = walkRing[i + 1][1] - walkRing[i][1];
      totalDist += Math.sqrt(dx * dx + dy * dy);
    }
    if (totalDist < spacing) return trees;

    // Small random start phase (≤15% of spacing) — enough variety between forests
    // to avoid an obvious repeating pattern, but not so large it creates a gap at
    // the start of every ring.  Tight jitter below keeps the belt gap-free.
    let nextDist = rng() * spacing * 0.15;
    let walked   = 0;

    for (let i = 0; i < wn - 1; i++) {
      const [x0, y0] = walkRing[i];
      const [x1, y1] = walkRing[i + 1];
      const dx = x1 - x0, dy = y1 - y0;
      const segLen = Math.sqrt(dx * dx + dy * dy);
      if (segLen < 1e-6) { walked += segLen; continue; }
      const ex = dx / segLen, ey = dy / segLen;
      const nx = -ey, ny = ex;   // perp — symmetric scatter both rings

      while (nextDist < walked + segLen) {
        const t      = (nextDist - walked) / segLen;
        // Always consume exactly 2 rng values here for a consistent stream.
        // Jitter reduced to ±9% of spacing (was ±25%) — keeps placement even but
        // avoids the mechanical look of pure grid while preventing large gaps.
        const jAlong = (rng() - 0.5) * spacing * 0.18;
        const jPerp  = (rng() - 0.5) * spacing * 0.18;

        // Position on the walk ring with symmetric jitter in both axes.
        // For inset rings the position is already interior — no pip check needed.
        // For outer ring the jitter scatters around the boundary naturally.
        const x = x0 + dx * t + ex * jAlong + nx * jPerp;
        const y = y0 + dy * t + ey * jAlong + ny * jPerp;

        let blocked = false;
        for (const ep of excludePolys) {
          const m = ep.margin;
          if (x < ep.bbox.minX - m || x > ep.bbox.maxX + m ||
              y < ep.bbox.minY - m || y > ep.bbox.maxY + m) continue;
          if (ep.isLine) {
            if (ptNearLine(x, y, ep.ring, m)) { blocked = true; break; }
          } else if (pip([x, y], ep.ring) || (m > 0 && ptNearPoly(x, y, ep.ring, m))) {
            blocked = true; break;
          }
        }

        if (!blocked) {
          const size = rng() < 0.35 ? 'small' : (rng() < 0.6 ? 'large' : 'medium');
          trees.push({ x, y, size, variety: 'broadleaf', forestTint: !!forestTint });
        }

        nextDist += spacing;
      }

      walked += segLen;
    }

    return trees;
  }

  /**
   * Generate crop row line drawings for a single farm polygon.
   * Each field gets a unique row angle (-40° to +40°) derived from its centroid hash
   * so fields look visually distinct. Uses rotated-scanline → un-rotate approach.
   */
  // wavyPxRing: optional pre-computed pixel-space ring (array of [x,y]) built from
  // the already-distorted polygon in the terrain loop.  When provided the rows
  // follow the organic wavy edge rather than the original straight GeoJSON edge,
  // which makes each field's crop margin look naturally irregular.
  function generateCropRowDrawings(feature, transform, rowSpacingPx, wavyPxRing) {
    const spacing  = rowSpacingPx || GRID_SIZE;
    const bt       = feature.properties.backgroundType;
    const ring     = feature.geometry.coordinates[0];
    const pxRing   = wavyPxRing || ring.map(([gx, gy]) => transform.tc(gx, gy));

    // Row stroke color: each polygon picks from CROP_ROW_STYLES so adjacent fields
    // read as different crop types (wheat, brassica, root veg, legumes, fallow).
    // Distinct hues are more legible than varying shades of the same base fill.
    const [gcx, gcy]      = polyCentroid(ring);
    const _cropStyleHash  = strHash(`cropstyle-${bt}-${Math.round(gcx * 10)}-${Math.round(gcy * 10)}`);
    const rowColor        = CROP_ROW_STYLES[_cropStyleHash % CROP_ROW_STYLES.length];

    // Centroid of polygon in px space
    let cx = 0, cy = 0;
    for (const [x, y] of pxRing) { cx += x; cy += y; }
    cx /= pxRing.length; cy /= pxRing.length;

    // Hash centroid → angle in [-40, +40] degrees
    const hash  = strHash(`cropangle-${Math.round(cx)}-${Math.round(cy)}`);
    const angle = ((hash % 1000) / 1000) * 80 - 40;
    const theta = angle * Math.PI / 180;
    const cosT  = Math.cos(theta), sinT = Math.sin(theta);

    // Rotate a point around (cx, cy)
    const rotPt = (x, y) => [
      cx + (x - cx) * cosT - (y - cy) * sinT,
      cy + (x - cx) * sinT + (y - cy) * cosT,
    ];
    // Un-rotate (inverse: negate theta)
    const unrotPt = (x, y) => [
      cx + (x - cx) * cosT + (y - cy) * sinT,
      cy - (x - cx) * sinT + (y - cy) * cosT,
    ];

    // Rotate polygon, then inset it by MARGIN px so rows don't reach the field edge.
    // Kept smaller (12) when wavyPxRing is supplied — the wavy edge itself creates
    // a naturally varying margin so we don't need as large a hard inset.
    const ROW_MARGIN = wavyPxRing ? 12 : 24;
    const rotRing = pxRing.map(([x, y]) => rotPt(x, y));

    // Inset: shrink each rotated vertex toward centroid by ROW_MARGIN px
    // (centroid in rotated space is still [cx, cy] since rotation is around cx,cy)
    const insetRing = rotRing.map(([x, y]) => {
      const dx = x - cx, dy = y - cy;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      return [x - dx / len * ROW_MARGIN, y - dy / len * ROW_MARGIN];
    });

    let minY = Infinity, maxY = -Infinity;
    for (const [, py] of insetRing) {
      if (py < minY) minY = py;
      if (py > maxY) maxY = py;
    }

    const drawings = [];
    const startY   = Math.ceil(minY / spacing) * spacing;
    const n        = insetRing.length;

    for (let y = startY; y < maxY; y += spacing) {
      const xs = [];
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const [xi, yi] = insetRing[i];
        const [xj, yj] = insetRing[j];
        if ((yi <= y && yj > y) || (yj <= y && yi > y)) {
          xs.push(xi + (y - yi) * (xj - xi) / (yj - yi));
        }
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const rx0 = xs[k], rx1 = xs[k + 1];
        if (rx1 - rx0 < 3) continue;
        // Un-rotate endpoints back to world space
        const [wx0, wy0] = unrotPt(rx0, y);
        const [wx1, wy1] = unrotPt(rx1, y);
        drawings.push({
          x: wx0, y: wy0,
          shape:       { type: 'p', points: [0, 0, wx1 - wx0, wy1 - wy0], isClosed: false },
          fillType:    0,
          fillAlpha:   0,
          strokeWidth: 5,
          strokeColor: rowColor,
          strokeAlpha: 1.0,
          sort:        14,   // above terrain polygons (sort:12), below water (sort:18)
          z:           14,
          locked:      true,
          flags: { world: { cavrilCropRow: true, terrainType: bt } },
        });
      }
    }
    return drawings;
  }

  function generateTrees(backgroundFeatures, buildingFeatures, waterFeatures, edgeFeatures, rng, transform, cropBox, densityMult = 1.0) {
    // Build exclusion lists: buildings + water bodies + farm fields + roads
    const excludePolys = [];

    // Exclude ALL buildings — both explicit BUILDING-type features and any
    // BACKGROUND features that carry a buildingType (some FTG variants encode
    // buildings that way).  buildingFeatures may be crop-box-filtered at the
    // call site, so we accept whatever is passed; callers should pass the full
    // building set so trees never spawn on top of buildings at the map edges.
    for (const f of buildingFeatures) {
      const t  = f.properties?.type;
      const bt = f.properties?.buildingType;
      // Accept: explicit BUILDING features, or BACKGROUND features that name a
      // building type (but not pure terrain types like FOREST, GRASS, FIELD…).
      const isBldg = t === 'BUILDING' || (t === 'BACKGROUND' && bt && !FARM_COLOR_VARIANTS[bt]
        && bt !== 'FOREST' && bt !== 'GRASS' && bt !== 'MEADOW' && bt !== 'PASTURE'
        && bt !== 'FIELD'  && bt !== 'FARMLAND' && bt !== 'CROP'  && bt !== 'ORCHARD'
        && bt !== 'HEATH'  && bt !== 'SCRUBLAND' && bt !== 'MARSH' && bt !== 'WATER'
        && bt !== 'WATERFRONT' && bt !== 'LAWN_TEXTURE_TYPE' && bt !== 'GRASSLAND');
      if (!isBldg) continue;
      const ring = f.geometry.coordinates[0];
      excludePolys.push({ bbox: polyBbox(ring), ring, margin: 8 });
    }

    // Exclude water bodies
    for (const f of waterFeatures) {
      const ring = f.geometry.coordinates[0];
      excludePolys.push({ bbox: polyBbox(ring), ring, margin: 7 });
    }
    for (const f of backgroundFeatures) {
      const bt = f.properties?.backgroundType || '';
      if (bt === 'WATER' || bt === 'WATERFRONT') {
        const ring = f.geometry.coordinates[0];
        excludePolys.push({ bbox: polyBbox(ring), ring, margin: 7 });
      }
    }

    // Exclude farm-field interiors — perimeter-only trees
    for (const f of backgroundFeatures) {
      if (f.properties?.type !== 'BACKGROUND') continue;
      const bt = f.properties.backgroundType || '';
      if (FARM_PERIMETER_TYPES.has(bt)) {
        const ring = f.geometry.coordinates[0];
        excludePolys.push({ bbox: polyBbox(ring), ring, margin: 0 });
      }
    }

    // Exclude FOREST polygon interiors so grass/meadow scatter doesn't plant non-forest
    // trees inside forest areas. Forest perimeter trees are placed separately.
    for (const f of backgroundFeatures) {
      if (f.properties?.type !== 'BACKGROUND') continue;
      if (f.properties?.backgroundType === 'FOREST') {
        const ring = f.geometry.coordinates[0];
        excludePolys.push({ bbox: polyBbox(ring), ring, margin: 0, isForest: true });
      }
    }

    // Exclude road corridors and walls — trees must not spawn on or beside them.
    // Margin is in GeoJSON units: (visual half-width + extra clearance) / scale.
    for (const f of edgeFeatures) {
      const et = f.properties?.edgeType;
      const cfg = ROAD_COLORS[et];
      if (!cfg) continue;
      const coords = f.geometry.coordinates;
      if (NAVIGABLE_EDGE_TYPES.has(et)) {
        // Margin in GeoJSON units (= feet). Divide by FIXED_SCALE (not transform.scale)
        // so the physical clearance is the same regardless of settlement size.
        const margin = (cfg.width / 2 + 12) / FIXED_SCALE;
        excludePolys.push({ bbox: polyBbox(coords), ring: coords, margin, isLine: true });
      } else if (WALL_TYPES.has(et)) {
        const margin = (cfg.width / 2 + 22) / FIXED_SCALE;
        excludePolys.push({ bbox: polyBbox(coords), ring: coords, margin, isLine: true });
      }
    }

    // Pre-compute building centroids for size classification (interior scatter only)
    const bldgCentroids = buildingFeatures
      .filter(f => f.properties?.type === 'BUILDING')
      .map(f => polyCentroid(f.geometry.coordinates[0]));

    const trees = [];

    // Minimum spacing between scatter-placed trees — 60 canvas pixels.
    // Raised from 26 → 60 so trees don't stack on top of each other; gives each
    // canopy room to breathe and reads more like a real grove than a clump of dots.
    // Shared across all polygons so trees from adjacent areas also stay separated.
    const _sc            = transform ? transform.scale : 1;
    const _minTreeSep    = 60 / _sc;
    const _minTreeSep2   = _minTreeSep * _minTreeSep;
    const _placedTrees   = [];   // [x, y] in GeoJSON units — shared across all polygons

    // Perimeter spacing in GeoJSON units — targets ~40px apart on canvas.
    // Raised from 28→40 so settlement hedgerow/field-edge trees don't crowd each
    // other; combined with the 60px scatter minimum, trees feel hand-placed.
    const _dmSqrt      = Math.sqrt(Math.max(0.1, densityMult));
    const perimSpacing = 40 / (transform ? transform.scale : 1) / _dmSqrt;

    for (const f of backgroundFeatures) {
      if (f.properties?.type !== 'BACKGROUND') continue;
      const bt = f.properties.backgroundType || '';

      // Skip tree generation for features whose centroid falls outside the crop box.
      // This filters out giant background-fill polygons (e.g. the large GRASS polygon
      // that covers the whole map) without dropping real content.
      // FOREST is explicitly exempt: forest patches naturally sit at the settlement
      // perimeter, so their centroids always land in the outer 25% that the crop box
      // would otherwise reject.
      const ring0 = f.geometry.coordinates[0];
      if (cropBox && bt !== 'FOREST') {
        const [gcx, gcy] = polyCentroid(ring0);
        const [pcx, pcy] = transform.tc(gcx, gcy);
        if (pcx < cropBox.x0 || pcx > cropBox.x1 || pcy < cropBox.y0 || pcy > cropBox.y1) continue;
      }

      // ── Farm fields: hedgerow perimeter trees only, no interior scatter ──
      if (FARM_PERIMETER_TYPES.has(bt)) {
        const perimTrees = generatePerimeterTrees(ring0, excludePolys, rng, perimSpacing);
        trees.push(...perimTrees);
        continue;
      }

      // ── FOREST: 3-ring dense perimeter belt, no interior scatter ──────
      // Handled BEFORE the density guard so forest tree placement is never
      // blocked by a zero or missing TREE_DENSITY entry.
      // Three concentric rings at decreasing spacing build up a thick, layered
      // treeline.  Ring 2 and 3 are pushed progressively inward so the belt has
      // visible depth.  All forest perimeter trees carry forestTint:true →
      // green tint applied by applySeason.
      if (bt === 'FOREST') {
        const sc  = transform ? transform.scale : 1;
        // Spacing expressed in canvas pixels (÷ scale → GeoJSON units).
        // Raised from 20/23/26 → 32/38/44 px to leave visible negative space between
        // trees so the forest interior reads as navigable (paths visible, not a wall).
        const sp0 = 57 / sc / _dmSqrt;
        const sp1 = 69 / sc / _dmSqrt;
        const sp2 = 84 / sc / _dmSqrt;
        // Inward push per ring (canvas pixels → GeoJSON units).
        // Larger offsets keep trees from overhanging roads and walls at the forest edge.
        const in0 =  9 / sc;
        const in1 = 16 / sc;
        const in2 = 24 / sc;
        // Forest treeline: road + forest polygon excludes removed so trees can
        // hug the boundary.  Only buildings and water polygons block placement.
        const forestEdgeExclude = excludePolys.filter(ep => !ep.isForest && !ep.isLine);
        trees.push(...generatePerimeterTrees(ring0, forestEdgeExclude, rng, sp0, in0, true));
        trees.push(...generatePerimeterTrees(ring0, forestEdgeExclude, rng, sp1, in1, true));
        trees.push(...generatePerimeterTrees(ring0, forestEdgeExclude, rng, sp2, in2, true));
        continue;
      }

      // ── Natural / grassy terrain: interior random scatter ──────────────
      const density = (TREE_DENSITY[bt] || 0) * densityMult;
      if (!density) continue;

      const ring  = ring0;
      const bbox  = polyBbox(ring);

      // ── GRASSLAND: sparse perimeter treeline + very few interior trees ──
      // Open meadow / pasture feel: tree silhouette at the edges, mostly clear center.
      if (GRASSLAND_TYPES.has(bt)) {
        const grassEdgeSpacing = 44 / (transform ? transform.scale : 1) / _dmSqrt;
        trees.push(...generatePerimeterTrees(ring, excludePolys, rng, grassEdgeSpacing));
        // Interior scatter — no hard cap; spacing (60px minTreeSep) naturally limits
        // density. Same approach as other terrain types so grass reads consistently.
        const grassCount = Math.round(polyArea(ring) * density * densityMult);
        for (let i = 0; i < grassCount; i++) {
          let placed = false;
          for (let attempt = 0; attempt < 30 && !placed; attempt++) {
            const x = bbox.minX + rng() * (bbox.maxX - bbox.minX);
            const y = bbox.minY + rng() * (bbox.maxY - bbox.minY);
            if (!pip([x, y], ring)) continue;
            let blocked = false;
            for (const ep of excludePolys) {
              const m = ep.margin;
              if (x < ep.bbox.minX - m || x > ep.bbox.maxX + m ||
                  y < ep.bbox.minY - m || y > ep.bbox.maxY + m) continue;
              if (ep.isLine) {
                if (ptNearLine(x, y, ep.ring, m)) { blocked = true; break; }
              } else if (pip([x, y], ep.ring) || (m > 0 && ptNearPoly(x, y, ep.ring, m))) {
                blocked = true; break;
              }
            }
            if (blocked) continue;
            // Minimum distance to any already-placed tree (prevents dense clumps).
            let _tooClose = false;
            for (const [_tx, _ty] of _placedTrees) {
              const _dx = x - _tx, _dy = y - _ty;
              if (_dx*_dx + _dy*_dy < _minTreeSep2) { _tooClose = true; break; }
            }
            if (_tooClose) continue;
            _placedTrees.push([x, y]);
            trees.push({ x, y, size: 'small', variety: 'broadleaf' });
            placed = true;
          }
        }
        continue; // skip general interior scatter below
      }

      const count = Math.round(polyArea(ring) * density);
      if (count === 0) continue;

      for (let i = 0; i < count; i++) {
        let placed = false;
        for (let attempt = 0; attempt < 30 && !placed; attempt++) {
          const x = bbox.minX + rng() * (bbox.maxX - bbox.minX);
          const y = bbox.minY + rng() * (bbox.maxY - bbox.minY);

          if (!pip([x, y], ring)) continue;

          let blocked = false;
          for (const ep of excludePolys) {
            const m = ep.margin;
            if (x < ep.bbox.minX - m || x > ep.bbox.maxX + m ||
                y < ep.bbox.minY - m || y > ep.bbox.maxY + m) continue;
            if (ep.isLine) {
              if (ptNearLine(x, y, ep.ring, m)) { blocked = true; break; }
            } else if (pip([x, y], ep.ring) || (m > 0 && ptNearPoly(x, y, ep.ring, m))) {
              blocked = true; break;
            }
          }
          if (blocked) continue;

          // Distance to nearest building centroid → tree size
          let minDist = Infinity;
          for (const [bcx, bcy] of bldgCentroids) {
            const dx = x - bcx, dy = y - bcy;
            const d  = dx * dx + dy * dy;
            if (d < minDist) minDist = d;
          }
          minDist = Math.sqrt(minDist);

          let size = 'small';
          if (minDist >= 15) size = 'large';
          else if (minDist >= 5) size = 'medium';

          const variety = (bt === 'FOREST' && rng() < 0.85) ? 'coniferous' : 'broadleaf';

          // Minimum distance to any already-placed scatter tree.
          let _tooClose = false;
          for (const [_tx, _ty] of _placedTrees) {
            const _dx = x - _tx, _dy = y - _ty;
            if (_dx*_dx + _dy*_dy < _minTreeSep2) { _tooClose = true; break; }
          }
          if (_tooClose) continue;
          _placedTrees.push([x, y]);
          trees.push({ x, y, size, variety });
          placed = true;
        }
      }
    }

    // When the settlement is cropped, forest polygon clipping creates synthetic edges
    // along the canvas boundary. Perimeter trees placed on those edges appear as a
    // line of trees along the ocean/void at the scene edge. Filter them out here.
    if (transform && transform.isCropped) {
      const _pad = 30 / transform.scale;   // 30px canvas margin in GeoJSON units
      const _gx0 = transform.minX + (transform.pxOffsetX + _pad) / transform.scale;
      const _gx1 = transform.minX + (transform.pxOffsetX + transform.canvasW - _pad) / transform.scale;
      // Y is inverted: canvas y=0 → maxY, canvas y=canvasH → minY direction
      const _gy1 = transform.maxY - (transform.pxOffsetY + _pad) / transform.scale;
      const _gy0 = transform.maxY - (transform.pxOffsetY + transform.canvasH - _pad) / transform.scale;
      return trees.filter(t => t.x >= _gx0 && t.x <= _gx1 && t.y >= _gy0 && t.y <= _gy1);
    }

    return trees;
  }

  // Returns a single canopy Tile object (trunks removed for now).
  function treeTileData(tree, transform, rng, feetPerUnit) {
    const [px, py] = transform.tc(tree.x, tree.y);

    let pool;
    if (tree.variety === 'coniferous') {
      pool = TREE_CANOPY.coniferous[tree.size] || TREE_CANOPY.coniferous.large;
    } else {
      pool = TREE_CANOPY.broadleaf[tree.size] || TREE_CANOPY.broadleaf.large;
    }
    const src        = pool[Math.floor(rng() * pool.length)];

    // Tree tile sizes scale with _importPxPerFt so canopy tiles stay proportional to buildings.
    // small ≈ 8 ft, medium ≈ 11 ft, large ≈ 14 ft; each gets ±20% jitter below.
    const _canopyPx = {
      small:  Math.max(8,  Math.round(_importPxPerFt *  8)),
      medium: Math.max(11, Math.round(_importPxPerFt * 11)),
      large:  Math.max(14, Math.round(_importPxPerFt * 14)),
    };
    const baseSize   = _canopyPx[tree.size] || _canopyPx.medium;
    const canopySize = Math.round(baseSize * (0.8 + rng() * 0.4));

    const tint = '#ffffff';

    // In Foundry V12, TileDocument.x,y is the CENTER of the tile (anchor changed from V11
    // top-left to center). Pass px,py directly so the canopy renders centred on the
    // GeoJSON tree position. Do NOT subtract canopySize/2 here.
    return {
      texture:   { src, tint },
      x:         px,
      y:         py,
      width:     canopySize,
      height:    canopySize,
      rotation:  Math.floor(rng() * 360),
      elevation: TREE_ELEVATION,
      overhead:  true,
      occlusion: { mode: 1 }, // 1 = FADE — canopy fades when a token walks under it
      flags: {
        world: {
          cavrilTree:       true,
          cavrilForestTree: !!tree.forestTint,  // green-tint blend in applySeason
          treeSize:         tree.size,
          treeVariety:      tree.variety,
          originalSrc:      src,  // stored so winter swap can restore summer image
        },
      },
    };
  }

  // Returns a trunk tile placed just above ground level (elevation 2) so it renders
  // above terrain drawings but below the canopy (elevation 20) and tokens.
  function treeTrunkData(tree, transform, rng) {
    const [px, py] = transform.tc(tree.x, tree.y);
    const src       = TREE_TRUNK_ASSETS[Math.floor(rng() * TREE_TRUNK_ASSETS.length)];
    // ±20% size jitter matching canopy variation; scale with settlement size
    const baseSize  = Math.max(2, Math.round((TRUNK_PX[tree.size] || 7) * _importStrokeScale));
    const trunkSize = Math.round(baseSize * (0.8 + rng() * 0.4));
    // V12: tile x,y = center (see treeTileData comment)
    return {
      texture:   { src, tint: '#ffffff' },
      x:         px,
      y:         py,
      width:     trunkSize,
      height:    trunkSize,
      rotation:  Math.floor(rng() * 360),
      elevation: 2,    // above terrain drawings, below canopy (elevation 20)
      overhead:  true,
      occlusion: { mode: 1 }, // FADE — valid in V14, fades when token underneath
      flags: { world: { cavrilTrunk: true, treeSize: tree.size } },
    };
  }

  // ─── SHADOW GEOMETRY HELPER ─────────────────────────────────────────────────
  // Single source of truth for shadow direction + distance across the full 24h cycle.
  //
  //   Hour | Light    | Shadow dir | Distance
  //   ─────────────────────────────────────────
  //    0   | Moon     | South ↓    | 10–14 px
  //    6   | Sunrise  | West  ←    | 16 px (max)
  //   12   | Noon     | North ↑    | 8 px  (min)
  //   18   | Sunset   | East  →    | 16 px (max)
  //   24   | Moon     | South ↓    | (same as 0)
  //
  // The continuous 360° rotation means players can always find a shadow angle to exploit.
  // Moon at night gives moderate shadows (~10–14 px) so nighttime isn't shadow-free.
  function getShadowVec(hour) {
    const h     = ((hour % 24) + 24) % 24;     // normalise [0, 24)
    const theta = 2 * Math.PI * h / 24;

    // Shadow direction: rotates full circle over 24h
    const dx = -Math.sin(theta);  // West at 6, North at 12, East at 18, South at 0/24
    const dy =  Math.cos(theta);

    // Distance: inversely proportional to light elevation.
    // Day (6–18): sun — shortest at noon, longest near horizon.
    // Night (18–6): moon — moderate, peaks at midnight.
    let dist;
    if (h >= 6 && h <= 18) {
      const sinEl = Math.max(0.12, Math.sin(Math.PI * (h - 6) / 12));
      dist = Math.min(16, Math.round(8 / sinEl));
    } else {
      const moonH  = h >= 18 ? h - 18 : h + 6;          // 0 at dusk, 6 at midnight, 12 at dawn
      const moonEl = Math.sin(Math.PI * moonH / 12);     // 0→1→0
      dist = Math.round(10 + moonEl * 4);                 // 10–14 px
    }

    return { dx, dy, dist, sx: Math.round(dx * dist), sy: Math.round(dy * dist) };
  }

  // ─── SHADOW POLYGON HELPERS ──────────────────────────────────────────────────
  // _perspShadowPoly — perspective shadow for a CLOSED polygon (forests, towers, gates).
  //   Works identically to buildingShadowData's silhouette algorithm: detects shadow-facing
  //   edges, walks from start-silhouette to end-silhouette along the original polygon then
  //   back along the projected copy.  The polygon under the object (covered by its own body
  //   at a higher sort) is invisible; only the extending "tail" shows.
  function _perspShadowPoly(poly, shx, shy) {
    if (!shx && !shy) return poly.slice();
    // GeoJSON rings repeat the first vertex at the end to close the ring.  That
    // zero-length closing edge always tests as NOT shadow-facing (cross product = 0),
    // which splits the shadow arc in two and corrupts startIdx/endIdx detection.
    const rawLen = poly.length;
    if (rawLen >= 4 && poly[rawLen - 2] === poly[0] && poly[rawLen - 1] === poly[1]) {
      return _perspShadowPoly(poly.slice(0, -2), shx, shy);
    }
    const n = rawLen / 2;
    if (n < 3) {
      const pts = [];
      for (let i = 0; i < poly.length; i += 2) pts.push(poly[i] + shx, poly[i + 1] + shy);
      return pts;
    }
    let area2 = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      area2 += poly[i * 2] * poly[j * 2 + 1] - poly[j * 2] * poly[i * 2 + 1];
    }
    const windSign = area2 >= 0 ? 1 : -1;
    const facesShadow = new Array(n);
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const dx = poly[j * 2] - poly[i * 2];
      const dy = poly[j * 2 + 1] - poly[i * 2 + 1];
      facesShadow[i] = windSign * (dy * shx - dx * shy) > 0;
    }
    let startIdx = -1, endIdx = -1, transCount = 0;
    for (let i = 0; i < n; i++) {
      const prev = (i + n - 1) % n;
      if (!facesShadow[prev] &&  facesShadow[i]) { startIdx = i; transCount++; }
      if ( facesShadow[prev] && !facesShadow[i]) { endIdx   = i; transCount++; }
    }
    // All-facing, none-facing, or multi-arc (concave polygon): simple translation fallback
    if (startIdx === -1 || endIdx === -1 || transCount > 2) {
      const pts = [];
      for (let i = 0; i < n; i++) pts.push(poly[i * 2] + shx, poly[i * 2 + 1] + shy);
      return pts;
    }
    const pts = [];
    let i = startIdx;
    for (;;) { pts.push(poly[i * 2], poly[i * 2 + 1]); if (i === endIdx) break; i = (i + 1) % n; }
    i = endIdx;
    for (;;) { pts.push(poly[i * 2] + shx, poly[i * 2 + 1] + shy); if (i === startIdx) break; i = (i - 1 + n) % n; }
    return pts;
  }

  // _lineShadowPoly — connected shadow for an OPEN polyline (walls, fences).
  //   Forward along the original line + backward along the shifted copy = closed filled ribbon
  //   that visually "connects" the wall/fence to the ground shadow it casts.
  function _lineShadowPoly(pts, shx, shy) {
    const out = pts.slice();   // original vertices forward
    for (let i = pts.length - 2; i >= 0; i -= 2)
      out.push(pts[i] + shx, pts[i + 1] + shy);   // shadow vertices backward
    return out;
  }

  // ─── BUILDING SHADOWS ────────────────────────────────────────────────────────
  // Casts a semi-transparent shadow shifted in the sun direction, scaled by
  // building height.  The shadow polygon is the SAME SHAPE as the building
  // footprint, just translated — this is correct visual behaviour at overworld
  // scale because the shadow of every wall projects in the same direction.
  // sort:150 — above terrain/roads and water, below buildings (sort:200) and
  // walls (sort:300).  Works at all 24 hours (moon casts at night).
  //
  // Height scale: 1-storey = 1×, 2-storey = 1.5×, 4-storey = 2.5× the base
  // shadow distance so taller buildings cast noticeably longer shadows.
  // ─── BUILDING PERSPECTIVE SHADOWS ────────────────────────────────────────────
  // Projects the building silhouette in the sun direction, then connects the
  // silhouette vertices (on the shadow side of the polygon) to their projected
  // counterparts. This creates a true perspective shadow wedge rather than a
  // simple translation: the side walls fan outward from the footprint corners
  // toward their cast positions on the ground.
  //
  // Algorithm:
  //   1. Detect polygon winding (CW or CCW in screen Y-down coords) from signed area.
  //   2. For each edge, test if its outward normal points toward the shadow direction.
  //      Those edges "face the shadow" — their vertices form the silhouette.
  //   3. Walk the shadow-facing vertices from the first silhouette transition to the
  //      second, then back along their projected copies to form a closed polygon.
  //   4. This polygon includes the part under the building (covered at sort:200) so
  //      only the extending "tail" is visible — exactly the perspective shadow.
  //
  // sort:150 — above terrain/roads/water, below buildings (sort:200) and walls (300).
  function buildingShadowData(building, hour) {
    const { sx, sy } = getShadowVec(hour);
    const heightFloors = BUILDING_HEIGHTS[building.type] || 2;
    const heightScale  = 1 + (heightFloors - 1) * 0.5;
    const shx = Math.round(sx * heightScale);
    const shy = Math.round(sy * heightScale);

    // GeoJSON rings repeat the first vertex at the end.  That zero-length closing
    // edge always tests as NOT shadow-facing (cross product = 0), splitting the
    // shadow arc in two and corrupting startIdx/endIdx detection.  Strip it.
    const rawPoly = building.polyPx;
    const rawLen  = rawPoly.length;
    const poly    = (rawLen >= 4 && rawPoly[rawLen - 2] === rawPoly[0] && rawPoly[rawLen - 1] === rawPoly[1])
      ? rawPoly.slice(0, -2) : rawPoly;
    const n = poly.length / 2;
    if (n < 3) return null;

    // No displacement (noon) — simple footprint copy acts as noon shadow stub
    if (shx === 0 && shy === 0) {
      const _noonPts = _importIsCropped
        ? clipPolygonToCanvas(poly.slice(), _importCanvasW, _importCanvasH)
        : poly.slice();
      if (!_noonPts) return null;
      const d = makePolygonDrawing(
        _noonPts, true, '#20201a', 0.22, null, 0, 0,
        { world: { cavrilShadow: true, cavrilBuildingShadow: true, buildingId: building.id } }
      );
      d.sort = 150; d.z = 150;
      return d;
    }

    // Signed area to detect winding.  area2 > 0 → CW in screen (Y-down).
    // CW outward normal of edge (dx,dy) = (dy, -dx).
    let area2 = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      area2 += poly[i * 2] * poly[j * 2 + 1] - poly[j * 2] * poly[i * 2 + 1];
    }
    const windSign = area2 >= 0 ? 1 : -1;

    // facesShadow[i] = true when edge i→(i+1) has outward normal pointing toward (shx,shy).
    // dot(outward_normal, shadow) = windSign*(dy*shx - dx*shy) > 0
    const facesShadow = new Array(n);
    for (let i = 0; i < n; i++) {
      const j  = (i + 1) % n;
      const dx = poly[j * 2]     - poly[i * 2];
      const dy = poly[j * 2 + 1] - poly[i * 2 + 1];
      facesShadow[i] = windSign * (dy * shx - dx * shy) > 0;
    }

    // Locate the two silhouette transitions:
    //   startIdx — vertex where the polygon transitions from sun-facing to shadow-facing
    //   endIdx   — vertex where it transitions back from shadow-facing to sun-facing
    // transCount > 2 means a concave polygon with multiple shadow arcs — fall through
    // to the projection fallback rather than producing a corrupt polygon.
    let startIdx = -1, endIdx = -1, transCount = 0;
    for (let i = 0; i < n; i++) {
      const prev = (i + n - 1) % n;
      if (!facesShadow[prev] &&  facesShadow[i]) { startIdx = i; transCount++; }
      if ( facesShadow[prev] && !facesShadow[i]) { endIdx   = i; transCount++; }
    }

    // Degenerate or multi-arc: project the whole footprint in the shadow direction.
    if (startIdx === -1 || endIdx === -1 || transCount > 2) {
      let pts = [];
      for (let i = 0; i < n; i++) pts.push(poly[i * 2] + shx, poly[i * 2 + 1] + shy);
      if (_importIsCropped) {
        pts = clipPolygonToCanvas(pts, _importCanvasW, _importCanvasH);
        if (!pts) return null;
      }
      const d = makePolygonDrawing(
        pts, true, '#20201a', 0.22, null, 0, 0,
        { world: { cavrilShadow: true, cavrilBuildingShadow: true, buildingId: building.id } }
      );
      d.sort = 150; d.z = 150;
      return d;
    }

    // Build the shadow polygon:
    //   Forward  — original vertices from startIdx → endIdx (shadow side)
    //   Backward — projected vertices from endIdx  → startIdx (shadow cap)
    const pts = [];
    let i = startIdx;
    for (;;) {
      pts.push(poly[i * 2], poly[i * 2 + 1]);
      if (i === endIdx) break;
      i = (i + 1) % n;
    }
    i = endIdx;
    for (;;) {
      pts.push(poly[i * 2] + shx, poly[i * 2 + 1] + shy);
      if (i === startIdx) break;
      i = (i - 1 + n) % n;
    }

    const _shadowPts = _importIsCropped
      ? clipPolygonToCanvas(pts, _importCanvasW, _importCanvasH)
      : pts;
    if (!_shadowPts) return null;
    const d = makePolygonDrawing(
      _shadowPts, true, '#20201a', 0.22, null, 0, 0,
      { world: { cavrilShadow: true, cavrilBuildingShadow: true, buildingId: building.id } }
    );
    d.sort = 150; d.z = 150;
    return d;
  }

  // ─── TREE SHADOW ────────────────────────────────────────────────────────────
  // centerX/centerY  = the canopy tile's actual center: tile.x + tile.width/2
  // tileWidth        = tile.width (drives shadow circle size)
  // hour             = game hour (0–23) for future directional offset
  //
  // Foundry x,y is ALWAYS the top-left corner of the bounding box.
  // To place a circle of radius r centered at (cx, cy):
  //   drawing.x = cx - r,  drawing.y = cy - r
  //   shape.width = shape.height = r * 2  (perfect circle)
  //
  // PHASE 1 — centering only (sx = sy = 0).
  // Once confirmed centered, PHASE 2 will add:
  //   const { sx, sy } = getShadowVec(hour);
  // and subtract from drawing.x / drawing.y so shadow shifts in sun direction.
  function treeShadowDrawing(centerX, centerY, tileWidth, hour, shadowAlpha) {
    const { dx, dy, dist } = getShadowVec(hour);
    const _sizeScale = Math.max(0.55, Math.min(1.4, tileWidth / 56));
    const treeDist   = Math.max(1, Math.round(dist * 0.75 * _sizeScale));
    const sx = Math.round(dx * treeDist);
    const sy = Math.round(dy * treeDist);

    // Organic blob shadow: roughCirclePts generates a jittered polygon so each
    // tree shadow has a slightly different irregular silhouette rather than a
    // perfect circle. Seed is derived from the tile position for determinism.
    const r    = Math.max(3, Math.round(tileWidth * 0.48));
    const seed = strHash(`tsh-${Math.round(centerX)}-${Math.round(centerY)}`);
    const rng  = mulberry32(seed);
    // 24 vertices, roughness 0.13 — enough variation to look natural, not jagged
    const blobPts = roughCirclePts(
      Math.round(centerX + sx),
      Math.round(centerY + sy),
      r, rng, 24, 0.13
    );
    // shadowAlpha: 0.22 default; callers pass a reduced value for leafless seasons
    const alpha = shadowAlpha ?? 0.22;
    const d = makePolygonDrawing(blobPts, true, '#20201a', alpha, null, 0, 0,
      { world: { cavrilShadow: true, cavrilTreeShadow: true } });
    d.sort = 148; d.z = 148;
    return d;
  }

  // ─── FOREST CANOPY TEXTURE ──────────────────────────────────────────────────
  // Generates a 256×256 seamless PNG using the same tree-canopy assets placed
  // elsewhere on the map, darkened with a 'source-atop' green tint pass so the
  // pattern reads as denser/shadier than the individual perimeter trees.
  // Tiling is seamless via toroidal wrapping (each tree drawn at all 9 ±SIZE offsets).
  // Falls back to circle blobs if the assets fail to load.
  // Must be awaited — image loading is async.
  // tintColor: CSS hex — applied as canvas `multiply` blend after trees are drawn,
  // matching Foundry's tile tint colour-multiply.  Pass '#ffffff' (default) for no tint.
  // Canvas is 512×512 but displayed at textureWidth/textureHeight:256 on the Drawing,
  // giving 2× pixel resolution at the same apparent tree size and density.
  async function generateForestTexture(seed, tintColor = '#ffffff', bare = false, gridSizePx = 20, pxPerFt = null) {
    // Tile size: scaled so one texture-pixel = one canvas-pixel, tiling across the forest polygon.
    // pxPerFt-aware sizing: compute r to match perimeter tree tile visuals, then size the tile
    // so circles appear at appropriate density.  The tile is kept small (≤512 px) so the pattern
    // repeats enough times to read as a forest rather than a single stamp.
    // When pxPerFt is not provided, fall back to gridSizePx heuristic for backward compat.
    const _baseR = pxPerFt
      ? Math.max(8, Math.min(36, Math.round(pxPerFt * 8)))           // match perimeter tree tile visual size
      : Math.max(8, Math.min(36, Math.round(gridSizePx * 0.28)));    // legacy gridSizePx path
    // Tile sized so spacing / circle diameter ≈ 2 → clear negative space between trees.
    // n=25 circles, spacing = SIZE/√25 = SIZE/5.  Gap = SIZE/5 - 2r.
    // Solve: SIZE/5 - 2r = r → SIZE = 15r.  Cap at 1024 to avoid huge PNGs.
    const SIZE = Math.max(128, Math.min(1024, _baseR * 15));         // circles occupy ~1/3 of spacing
    const rng  = mulberry32(seed || 0x4f726573);
    const cv   = document.createElement('canvas');
    cv.width   = SIZE;
    cv.height  = SIZE;
    const ctx  = cv.getContext('2d');
    ctx.clearRect(0, 0, SIZE, SIZE);

    // ── Load tree assets ────────────────────────────────────────────────────
    // In leaf seasons: coniferous 3:1 over broadleaf (mirrors 85% conif ratio used for tiles).
    // In winter (bare=true): bare small + bare medium — rotation randomises the silhouette
    // enough to avoid obvious repetition even though there's only one image per size.
    const _paths = bare ? [
      ...TREE_CANOPY.bare.small,   // 1 image × 3 weight — rotation varies look
      ...TREE_CANOPY.bare.small,
      ...TREE_CANOPY.bare.small,
      ...(TREE_CANOPY.bare.medium || TREE_CANOPY.bare.small),  // medium for scale variety
    ] : [
      ...TREE_CANOPY.coniferous.small,  // 3 images, weight ×3
      ...TREE_CANOPY.coniferous.small,
      ...TREE_CANOPY.coniferous.small,
      ...TREE_CANOPY.broadleaf.small,   // 3 images, weight ×1
    ];
    // fetch+blobURL avoids canvas-taint issues that cause new Image() with
    // relative module paths to fail silently inside Foundry's module context.
    const _load = async src => {
      try {
        const resp = await fetch(src);
        if (!resp.ok) return null;
        const blob    = await resp.blob();
        const blobUrl = URL.createObjectURL(blob);
        return await new Promise(res => {
          const img = new Image();
          img.onload  = () => { URL.revokeObjectURL(blobUrl); res(img); };
          img.onerror = () => { URL.revokeObjectURL(blobUrl); res(null); };
          img.src     = blobUrl;
        });
      } catch (_e) { return null; }
    };
    const _imgs = (await Promise.all(_paths.map(_load))).filter(Boolean);

    if (_imgs.length === 0) {
      // ── Circle-blob fallback if assets can't be resolved ──────────────────
      for (let i = 0; i < 40; i++) {
        const bx = rng() * SIZE, by = rng() * SIZE, br = 3 + rng() * 6;
        const ba = (0.18 + rng() * 0.14).toFixed(2);
        ctx.fillStyle = `rgba(18,38,8,${ba})`;
        for (const ox of [0, SIZE, -SIZE])
          for (const oy of [0, SIZE, -SIZE]) {
            ctx.beginPath(); ctx.arc(bx + ox, by + oy, br, 0, Math.PI * 2); ctx.fill();
          }
      }
      return cv.toDataURL('image/png');
    }

    // ── Place tree images with Poisson-disk min-distance enforcement ─────────
    // Pure random placement creates visible clumps and voids. Instead: try up to
    // 30 candidate positions per tree and accept the first that clears a minimum
    // toroidal distance from all already-placed trees. Fall back to best position
    // after 30 attempts so the loop always terminates.
    // Min distance ≈ 65% of the ideal even-spacing, allowing natural variation
    // while preventing tight stacking.
    // Low count → abundant negative space so each circle reads as a distinct canopy.
    // 25 trees per tile: spacing = SIZE/5; at SIZE = _baseR*15, gap ≈ _baseR per side.
    const nTrees  = 50;
    const minDist = (SIZE / Math.sqrt(nTrees)) * 0.65;
    const minDist2 = minDist * minDist;
    const _placed  = [];                                  // [bx, by] of accepted trees

    const _toroidalDist2 = (ax, ay, bx2, by2) => {
      const dx = Math.abs(ax - bx2), dy = Math.abs(ay - by2);
      const tdx = Math.min(dx, SIZE - dx), tdy = Math.min(dy, SIZE - dy);
      return tdx * tdx + tdy * tdy;
    };

    for (let i = 0; i < nTrees; i++) {
      let bx = rng() * SIZE, by = rng() * SIZE, bestDist2 = -1;
      for (let attempt = 0; attempt < 30; attempt++) {
        const cx = rng() * SIZE, cy = rng() * SIZE;
        const closest = _placed.reduce((min, [px, py]) =>
          Math.min(min, _toroidalDist2(cx, cy, px, py)), Infinity);
        if (closest >= minDist2) { bx = cx; by = cy; break; }   // good spot found
        if (closest > bestDist2) { bestDist2 = closest; bx = cx; by = cy; } // track best
      }
      _placed.push([bx, by]);


      // Tree radius: three size classes (small / medium / large) matching the
      // proportions used for perimeter tree tiles, plus a small per-tree jitter.
      // All bounds are relative to _baseR so variation survives at any scale.
      const _cls    = rng();
      const _factor = _cls < 0.35 ? 0.95 : _cls < 0.72 ? 1.0 : 1.14;   // subtle variation: sm nearly-base / med base / lg slight bump
      const r       = Math.max(3, Math.round(_baseR * (_factor + (rng() - 0.5) * 0.18)));
      const rot   = rng() * Math.PI * 2;
      const img   = _imgs[Math.floor(rng() * _imgs.length)];
      const alpha = 0.90 + rng() * 0.10;   // 90–100% — trees look like their original art
      for (const ox of [0, SIZE, -SIZE]) {
        for (const oy of [0, SIZE, -SIZE]) {
          ctx.save();
          ctx.globalAlpha = alpha;
          ctx.translate(bx + ox, by + oy);
          ctx.rotate(rot);
          ctx.drawImage(img, -r, -r, r * 2, r * 2);
          ctx.restore();
        }
      }
    }

    // Per-pixel colour-multiply tint — exactly mirrors how Foundry applies tile tints
    // (GPU colour-multiply shader: result = src_rgb × tint_rgb / 255).
    // ONLY modifies pixels with alpha > 0 (tree artwork); transparent gaps between
    // trees stay transparent so the sort:13 forest base polygon shows through them,
    // giving the same "tree artwork on dark-green forest floor" look as individual tiles.
    // Canvas `multiply` blend would fill transparent areas with solid tint — wrong.
    if (tintColor && tintColor.toLowerCase() !== '#ffffff') {
      const _tr = parseInt(tintColor.slice(1, 3), 16);
      const _tg = parseInt(tintColor.slice(3, 5), 16);
      const _tb = parseInt(tintColor.slice(5, 7), 16);
      const _id = ctx.getImageData(0, 0, SIZE, SIZE);
      const _d  = _id.data;
      for (let _pi = 0; _pi < _d.length; _pi += 4) {
        if (_d[_pi + 3] > 0) {
          _d[_pi]     = (_d[_pi]     * _tr) >> 8;
          _d[_pi + 1] = (_d[_pi + 1] * _tg) >> 8;
          _d[_pi + 2] = (_d[_pi + 2] * _tb) >> 8;
        }
      }
      ctx.putImageData(_id, 0, 0);
    }

    return cv.toDataURL('image/png');
  }

  // ─── TEXTURE UPLOAD HELPER ───────────────────────────────────────────────────
  // Converts a dataURL to a File and saves it to the Foundry userdata area.
  // Creates the target directory if it doesn't already exist.
  async function _uploadTex(dataURL, filePath) {
    const dir  = filePath.substring(0, filePath.lastIndexOf('/'));
    const name = filePath.substring(filePath.lastIndexOf('/') + 1);
    const [, b64] = dataURL.split(',');
    const bin  = atob(b64);
    const arr  = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    const file = new File([arr], name, { type: 'image/png' });
    // V13 moved FilePicker under foundry.applications.apps; fall back for V12.
    const _FP = foundry.applications?.apps?.FilePicker?.implementation ?? FilePicker;
    // On The Forge, uploads go to the Forge asset library ('forgevtt'), not local user data.
    const _src = (typeof ForgeVTT !== 'undefined' && ForgeVTT.usingTheForge) ? 'forgevtt' : 'data';
    await _FP.createDirectory(_src, dir).catch(() => {});
    await _FP.upload(_src, dir, file, {}, { notify: false });
    return filePath;
  }

  // ─── ROUGH CIRCLE HELPER ────────────────────────────────────────────────────
  // Generates an irregular blob polygon for organic tree shadow shapes.
  // nPts points around a circle, each with angle + radius jitter for a natural look.
  // Angle jitter is clamped to ±40% of the angular step between points so adjacent
  // vertices can never cross each other, preventing self-intersecting shadow polygons
  // that render as dark artifacts.
  function roughCirclePts(cx, cy, r, rng, nPts, roughness) {
    const n     = nPts     || 16;
    const rough = roughness || 0.12;
    const step  = (2 * Math.PI) / n;
    const pts   = [];
    for (let i = 0; i < n; i++) {
      const base = step * i;
      // Max jitter = 40% of angular step — guarantees no crossings
      const aJit = (rng() - 0.5) * step * 0.8;
      const rJit = 1.0 + (rng() - 0.5) * rough * 2;
      const rr   = r * Math.max(0.75, rJit);
      pts.push(cx + Math.cos(base + aJit) * rr, cy + Math.sin(base + aJit) * rr);
    }
    return pts;
  }

  // ─── WALL SHADOW ─────────────────────────────────────────────────────────────
  // Offset stroke behind STONE_WALL / BORDER segments.
  // wallPts (raw pixel coords before shadow offset) stored in flags so updateTOD
  // can rebuild the shadow at any sun angle without re-parsing GeoJSON.
  function wallShadowData(feature, hour, transform) {
    const et = feature.properties?.edgeType;
    if (et !== 'STONE_WALL' && et !== 'BORDER' && et !== 'STONE_FENCE') return null;
    const cfg = ROAD_COLORS[et];
    if (!cfg) return null;

    const { sx: _rawSx, sy: _rawSy } = getShadowVec(hour);
    // Fences are short — their shadow travels only 1/3 as far as a stone wall.
    const _wallScale = et === 'STONE_FENCE' ? 1 / 3 : 1;
    const sx = Math.round(_rawSx * _wallScale);
    const sy = Math.round(_rawSy * _wallScale);

    const coords  = feature.geometry.coordinates;
    const wallPts = [];   // raw (un-shifted) pixel coords
    for (const [gx, gy] of coords) {
      const [ppx, ppy] = transform.tc(gx, gy);
      wallPts.push(ppx, ppy);
    }
    // Fences: lighter alpha + shorter throw. Walls/Border: 0.20, Fence: 0.12.
    const _shadowAlpha = et === 'STONE_FENCE' ? 0.12 : 0.20;
    // Connected filled ribbon: original line forward + shadow line backward.
    // This makes the shadow visually attach to the wall/fence, matching how building
    // shadows extend from the footprint edge (not just a floating shifted copy).
    // wallEdgeType stored in flags so updateTOD can rebuild with the correct offset scale.
    const connPts = _lineShadowPoly(wallPts, sx, sy);
    const _wsPts = _importIsCropped
      ? clipPolygonToCanvas(connPts, _importCanvasW, _importCanvasH)
      : connPts;
    if (!_wsPts) return null;
    const d = makePolygonDrawing(
      _wsPts, true, '#20201a', _shadowAlpha, null, 0, 0,
      { world: { cavrilShadow: true, cavrilWallShadow: true, wallPts, wallWidth: Math.max(1, Math.round(cfg.width * _importStrokeScale)), wallEdgeType: et } }
    );
    d.sort = 149;
    d.z    = 149;
    return d;
  }

  // ─── AMBIENT LIGHT DATA ──────────────────────────────────────────────────────

  function buildingLightData(cx, cy, btype, sizeUnits) {
    const cfg   = LIGHT_CONFIGS[btype] || { color: '#ffd080', bright: 2, dim: 4 };
    // Scale radius by building footprint size (clamped to reasonable range)
    const scale = Math.max(0.6, Math.min(3.0, (sizeUnits || 1.5)));
    return {
      x:       cx,
      y:       cy,
      enabled: true,
      walls:   true,   // Constrained by walls and surfaces
      vision:  false,  // Does not provide vision
      config: {
        bright:      Math.round(cfg.bright * scale * 10) / 10,
        dim:         Math.round(cfg.dim    * scale * 10) / 10,
        color:       cfg.color,
        luminosity:  0.35,
        attenuation: 1.0,
        // Adaptive Luminance — read from Foundry's runtime constants (ID varies by version).
        coloration:  CONFIG?.Canvas?.colorationTechniques?.ADAPTIVE?.id ?? 1,
        saturation:  0,
        contrast:    0,
        shadows:     0,
        angle:       360,
        darkness:    { min: 0.35, max: 1.0 },
      },
      flags: { world: { cavrilLight: true, buildingType: btype } },
    };
  }

  // ─── CHUNKED CREATE ──────────────────────────────────────────────────────────

  async function chunkedCreate(scene, docType, docs, chunkSize, onProgress) {
    if (!docs || docs.length === 0) return [];
    let created = 0;
    const all = [];
    for (let i = 0; i < docs.length; i += chunkSize) {
      const isLast = (i + chunkSize) >= docs.length;
      // Suppress canvas re-render on every chunk except the last — Foundry V12 respects
      // { render: false } in the operation context, eliminating N-1 redundant layer draws.
      const batch = await scene.createEmbeddedDocuments(
        docType, docs.slice(i, i + chunkSize), { render: isLast }
      );
      if (batch) all.push(...batch);
      created += Math.min(chunkSize, docs.length - i);
      if (onProgress) onProgress(created, docs.length);
      await new Promise(r => setTimeout(r, 0));
    }
    return all;
  }

  // ─── IMPORT CITY DIALOG ──────────────────────────────────────────────────────

  class ImportCityDialog extends Application {
    static get defaultOptions() {
      return foundry.utils.mergeObject(super.defaultOptions, {
        id: 'cavril-import-city',
        title: 'Import City — Cavril CityHUD',
        width: 490,
        resizable: false,
        template: null,
      });
    }

    getData() { return {}; }

    async _renderInner(_data) {
      const wrap = document.createElement('div');
      wrap.innerHTML = `
<form style="padding:16px 20px;font-family:var(--font-primary,sans-serif);">
  <p style="margin:0 0 14px;color:#aaa;font-size:13px;">
    Select the Fantasy Town Generator export files for your settlement.
  </p>

  <div style="margin-bottom:12px;">
    <label style="display:block;margin-bottom:4px;font-size:12px;color:#888;">GeoJSON file (.geojson)</label>
    <input type="file" id="cavril-import-geojson" accept=".geojson,.json"
           style="width:100%;font-size:12px;color:#ccc;background:#1c1c1c;border:1px solid #444;padding:4px;border-radius:3px;">
  </div>

  <div style="margin-bottom:12px;">
    <label style="display:block;margin-bottom:4px;font-size:12px;color:#888;">City data file (.json)</label>
    <input type="file" id="cavril-import-json" accept=".json"
           style="width:100%;font-size:12px;color:#ccc;background:#1c1c1c;border:1px solid #444;padding:4px;border-radius:3px;">
  </div>

  <div style="margin-bottom:12px;">
    <label style="display:block;margin-bottom:4px;font-size:12px;color:#888;">Scene name</label>
    <input type="text" id="cavril-import-scene-name" value="New Settlement"
           style="width:100%;padding:5px 8px;background:#1c1c1c;border:1px solid #444;color:#eee;border-radius:3px;font-size:13px;box-sizing:border-box;">
  </div>

  <div style="margin-bottom:12px;">
    <label style="display:block;margin-bottom:4px;font-size:12px;color:#888;">Rotate north (CW)</label>
    <select id="cavril-import-rotate"
            style="width:100%;padding:5px 8px;background:#1c1c1c;border:1px solid #444;color:#eee;border-radius:3px;font-size:13px;box-sizing:border-box;">
      <option value="0"   selected>0° — no rotation</option>
      <option value="90" >90° CW — north → west</option>
      <option value="180">180° — flip north/south</option>
      <option value="270">270° CW — north → east</option>
    </select>
  </div>

  <div style="margin-bottom:10px;">
    <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#aaa;cursor:pointer;">
      <input type="checkbox" id="cavril-import-lights" checked>
      Place ambient lights on key buildings
    </label>
  </div>

  <div style="margin-bottom:12px;">
    <label style="display:flex;align-items:center;gap:8px;font-size:12px;color:#aaa;cursor:pointer;">
      <input type="checkbox" id="cavril-import-trees" checked>
      Generate procedural trees
    </label>
  </div>

  <div style="margin-bottom:12px;">
    <label style="display:block;margin-bottom:4px;font-size:12px;color:#888;">Scene crop — % of canvas used for buildings &amp; trees</label>
    <div style="display:flex;align-items:center;gap:10px;">
      <input type="range" id="cavril-import-crop" min="20" max="100" step="5" value="50"
             style="flex:1;accent-color:#5a9030;">
      <span id="cavril-import-crop-val" style="min-width:38px;text-align:right;color:#ccc;font-size:13px;font-variant-numeric:tabular-nums;">50%</span>
    </div>
    <p style="margin:3px 0 0;font-size:11px;color:#666;">100% = full canvas; 50% = center half (default)</p>
  </div>

  <div style="margin-bottom:18px;">
    <label style="display:block;margin-bottom:4px;font-size:12px;color:#888;">Tree density</label>
    <select id="cavril-import-tree-density"
            style="width:100%;padding:5px 8px;background:#1c1c1c;border:1px solid #444;color:#eee;border-radius:3px;font-size:13px;box-sizing:border-box;">
      <option value="0.25">0.25× — Very sparse</option>
      <option value="0.5" >0.5×  — Sparse</option>
      <option value="0.75">0.75× — Light</option>
      <option value="1.0"  selected>1.0×  — Normal (default)</option>
      <option value="1.5" >1.5×  — Dense</option>
      <option value="2.0" >2.0×  — Very dense</option>
      <option value="3.0" >3.0×  — Maximum</option>
    </select>
  </div>

  <div style="display:flex;gap:8px;justify-content:flex-end;">
    <button type="button" id="cavril-import-cancel"
            style="padding:6px 18px;background:#3a3a3a;border:1px solid #555;color:#ccc;border-radius:3px;cursor:pointer;font-size:13px;">
      Cancel
    </button>
    <button type="button" id="cavril-import-go"
            style="padding:6px 18px;background:#3d6624;border:1px solid #5a9030;color:#eee;border-radius:3px;cursor:pointer;font-size:13px;font-weight:bold;">
      Import
    </button>
  </div>
</form>`;
      return $(wrap);
    }

    activateListeners(html) {
      super.activateListeners(html);
      html.find('#cavril-import-cancel').click(() => this.close());
      html.find('#cavril-import-go').click(() => this._startImport());
      html.find('#cavril-import-crop').on('input', e => {
        html.find('#cavril-import-crop-val').text(e.target.value + '%');
      });
      html.find('form').on('submit', e => e.preventDefault());
      html.find('input').on('keydown', e => {
        if (e.key === 'Enter') e.preventDefault();
      });
    }

    async _startImport() {
      const el          = this.element[0];
      const geojsonFile = el.querySelector('#cavril-import-geojson')?.files?.[0];
      const jsonFile    = el.querySelector('#cavril-import-json')?.files?.[0];
      const sceneName   = (el.querySelector('#cavril-import-scene-name')?.value || '').trim() || 'New Settlement';
      const rotateNorth = parseInt(el.querySelector('#cavril-import-rotate')?.value || '0', 10);
      const withLights  = el.querySelector('#cavril-import-lights')?.checked ?? true;
      const withTrees       = el.querySelector('#cavril-import-trees')?.checked ?? true;
      const cropZoom        = parseInt(el.querySelector('#cavril-import-crop')?.value || '50', 10) || 50;
      const treeDensityMult = parseFloat(el.querySelector('#cavril-import-tree-density')?.value) || 1.0;

      if (!geojsonFile) { ui.notifications.warn('Please select a GeoJSON file.'); return; }
      if (!jsonFile)    { ui.notifications.warn('Please select a city data JSON file.'); return; }

      this.close();
      await runImport({ geojsonFile, jsonFile, sceneName, rotateNorth, withLights, withTrees, cropZoom, treeDensityMult });
    }
  }

  // ─── MAIN IMPORT PIPELINE ────────────────────────────────────────────────────

  async function runImport({ geojsonFile, jsonFile, sceneName, rotateNorth, withLights, withTrees, cropZoom = 50, treeDensityMult = 1.0 }) {
    class ImportProgressDialog extends Application {
      constructor(options = {}) {
        super(options);
        this._stage = 'Starting…';
        this._pct   = 0;
      }
      static get defaultOptions() {
        return foundry.utils.mergeObject(super.defaultOptions, {
          id: 'cavril-import-progress',
          title: 'Cavril City Import',
          width: 440,
          resizable: false,
          template: null,
        });
      }
      getData() { return {}; }
      async _renderInner(_data) {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'padding:18px 20px;font-family:var(--font-primary,sans-serif);';
        wrap.innerHTML = `
<div id="cavril-import-stage" style="margin-bottom:8px;font-size:13px;color:#ccc;">${this._stage}</div>
<div style="background:#222;border-radius:4px;height:18px;overflow:hidden;border:1px solid #444;">
  <div id="cavril-import-bar" style="height:100%;width:${this._pct}%;background:#6a9f3f;transition:width 0.25s ease;"></div>
</div>
<div id="cavril-import-pct" style="text-align:right;font-size:11px;color:#888;margin-top:4px;">${this._pct}%</div>
<div id="cavril-import-done" style="display:none;margin-top:12px;color:#8fcc5f;font-weight:bold;">✓ Import complete!</div>
<div id="cavril-import-error" style="display:none;margin-top:12px;color:#cc6060;"></div>`;
        return $(wrap);
      }
      setProgress(stage, pct) {
        this._stage = stage;
        this._pct   = Math.round(pct);
        const el   = this.element?.[0];
        if (!el) return;
        const bar  = el.querySelector('#cavril-import-bar');
        const stEl = el.querySelector('#cavril-import-stage');
        const pcEl = el.querySelector('#cavril-import-pct');
        if (bar)  bar.style.width  = this._pct + '%';
        if (stEl) stEl.textContent = this._stage;
        if (pcEl) pcEl.textContent = this._pct + '%';
      }
      markDone() {
        this.setProgress('Complete!', 100);
        const d = this.element?.[0]?.querySelector('#cavril-import-done');
        if (d) d.style.display = '';
        setTimeout(() => { try { this.close(); } catch (_) {} }, 3000);
      }
      markError(msg) {
        const d = this.element?.[0]?.querySelector('#cavril-import-error');
        if (d) { d.textContent = msg; d.style.display = ''; }
      }
    }
    const prog = new ImportProgressDialog();
    await prog.render(true);

    try {
      // 1. Parse files ────────────────────────────────────────────────────────
      prog.setProgress('Parsing GeoJSON…', 2);
      await new Promise(r => setTimeout(r, 0));
      const geojson      = JSON.parse(await geojsonFile.text());
      const rawFeatures  = geojson.features || [];

      prog.setProgress('Parsing city data…', 4);
      await new Promise(r => setTimeout(r, 0));
      const jsonData = JSON.parse(await jsonFile.text());

      // Apply north rotation (0/90/180/270°) before any transform is built.
      const features = rotateGeoJSON(rawFeatures, rotateNorth || 0);
      if (rotateNorth) console.log(`[CavrilImport] Rotated features ${rotateNorth}° CW`);

      console.log(`[CavrilImport] GeoJSON: ${features.length} features`);
      console.log(`[CavrilImport] City data: ${jsonData.buildings?.length ?? 0} buildings, ${jsonData.people?.length ?? 0} people`);

      // 2. Build transform ────────────────────────────────────────────────────
      prog.setProgress('Computing scene dimensions…', 6);
      await new Promise(r => setTimeout(r, 0));
      const transform = buildTransform(features);
      if (transform.isCropped) {
        const fullFt = Math.round(Math.max(
          (transform.maxX - transform.minX) * FIXED_SCALE,
          (transform.maxY - transform.minY) * FIXED_SCALE
        ));
        console.warn(`[CavrilImport] Settlement is ${fullFt}px at fixed scale — cropped to ${TARGET_CANVAS_SIZE}px central window. Import additional districts separately.`);
        ui.notifications?.warn(`[CavrilImport] Large settlement cropped to central ${TARGET_CANVAS_SIZE / FIXED_SCALE}-foot window.`);
      }
      console.log(`[CavrilImport] Canvas: ${transform.canvasW}\xd7${transform.canvasH}px  scale: ${transform.scale.toFixed(4)} (fixed)`);

      // Detect scale for logging only — feetPerUnit is not used to adjust scale.
      // Scale is always FIXED_SCALE (px/unit = px/ft since FTG ≈ 1 unit/ft).
      // _gridSizePx is derived so it stays in sync when FIXED_SCALE is tuned.
      const _feetPerUnit = detectFeetPerUnit(features, jsonData, 1.5);
      console.log(`[CavrilImport] Scale calibration: ${_feetPerUnit.toFixed(3)} ft/unit (detected, not applied — scale is fixed at ${FIXED_SCALE})`);

      // Scene grid is always 20 px — independent of FIXED_SCALE so the grid overlay
      // stays at the familiar 20 px spacing the user expects.
      const _gridSizePx = 20;
      _importStrokeScale = 1.0;           // all stroke widths are used as-is from ROAD_COLORS
      _importPxPerFt     = FIXED_SCALE;   // tree tiles always sized at 4 px/ft
      _importCanvasW     = transform.canvasW;
      _importCanvasH     = transform.canvasH;
      _importIsCropped   = transform.isCropped;
      console.log(`[CavrilImport] Grid: ${_gridSizePx}px per 5ft square (fixed)`);

      // 3. Create scene ───────────────────────────────────────────────────────
      prog.setProgress('Creating scene…', 8);
      await new Promise(r => setTimeout(r, 0));
      const sceneFolder = await getOrCreateFolder('Cavril Settlements', 'Scene');
      const scene = await Scene.create({
        name:           sceneName,
        folder:         sceneFolder.id,
        width:          transform.canvasW,
        height:         transform.canvasH,
        grid:           { type: 0, size: _gridSizePx, distance: 5, units: 'ft' },
        padding:        0,    // no padding — map fills the scene exactly, no top-left offset
        background:     { color: '#1a1a1a' },
        darkness:       0,
        tokenVision:    false,   // overworld — no token sight
        fogExploration: false,   // overworld — no fog of war
        globalLight:    true,    // Foundry V11/V12 global illumination field
        environment: {           // Foundry V13/V14 global illumination field
          globalLight: { enabled: true },
        },
        flags: { world: { cavrilImport: true, importedAt: Date.now(),
          // Store scale calibration so applySeason can recompute texture tile size.
          cavrilPxPerFt: _importPxPerFt } },
      });
      // Belt-and-suspenders: force global illumination via the path that works on the running version.
      await scene.update({ globalLight: true, darkness: 0 }).catch(() => {});
      await scene.update({ environment: { globalLight: { enabled: true } } }).catch(() => {});

      // Overlay tile removed — TOD atmospheric cast is handled by Foundry's native darkness
      // system (scene.darkness) alone. This avoids the partial-coverage artifact and the
      // Foundry-autosaved data-URL PNG that accumulated in worlds/assets/tiles.

      console.log(`[CavrilImport] Scene created: ${scene.id}`);

      // 4. Road graph ─────────────────────────────────────────────────────────
      prog.setProgress('Building road graph…', 10);
      await new Promise(r => setTimeout(r, 0));
      const roadGraph = buildRoadGraph(features);
      await scene.setFlag('world', 'roadGraph', {
        nodes:    roadGraph.nodeArr,
        edges:    roadGraph.edgeArr,
        navTypes: roadGraph.navTypes,
      });
      console.log(`[CavrilImport] Road graph: ${roadGraph.nodeArr.length / 2} nodes, ${roadGraph.edgeArr.length / 4} edges`);

      // 5. Pack + store building data ─────────────────────────────────────────
      prog.setProgress('Packing building data…', 13);
      await new Promise(r => setTimeout(r, 0));
      const packedBuildings = packBuildings(features, jsonData.buildings, transform);
      const chunkCount      = Math.ceil(packedBuildings.length / BLDG_CHUNK_SIZE);
      for (let i = 0; i < chunkCount; i++) {
        await scene.setFlag('world', `buildingsChunk${i}`,
          packedBuildings.slice(i * BLDG_CHUNK_SIZE, (i + 1) * BLDG_CHUNK_SIZE));
      }
      await scene.setFlag('world', 'buildingChunkCount', chunkCount);
      await scene.setFlag('world', 'buildingCount', packedBuildings.length);
      console.log(`[CavrilImport] Packed ${packedBuildings.length} buildings → ${chunkCount} flag chunks`);

      // 6. Journal storage ────────────────────────────────────────────────────
      prog.setProgress('Storing city data in journal…', 16);
      await new Promise(r => setTimeout(r, 0));
      const journal = await storeCityInJournal(sceneName, jsonData, scene.id, packedBuildings);
      await scene.setFlag('world', 'cityJournalId', journal.id);
      console.log(`[CavrilImport] Journal: ${journal.id}`);

      // 7. Background terrain drawings ────────────────────────────────────────
      prog.setProgress('Building terrain drawings…', 20);
      await new Promise(r => setTimeout(r, 0));

      // Crop box — limits BUILDINGS and TREE GENERATION to the city core.
      // Background terrain polygons are drawn for the WHOLE canvas (fills the scene with
      // ground cover) but only include buildings/trees if centroid is within this box.
      // EDGE features (roads, walls) are always kept in full.
      // cropZoom (20–100): percentage of canvas from center. 50% → 0.25–0.75 on each axis.
      const _cropHalf = (1 - Math.max(0.2, Math.min(1.0, cropZoom / 100))) / 2;
      const _cropX0 = transform.canvasW * _cropHalf,        _cropX1 = transform.canvasW * (1 - _cropHalf);
      const _cropY0 = transform.canvasH * _cropHalf,        _cropY1 = transform.canvasH * (1 - _cropHalf);
      function _inCropBox(ring) {
        const [gcx, gcy] = polyCentroid(ring);
        const [pcx, pcy] = transform.tc(gcx, gcy);
        return pcx >= _cropX0 && pcx <= _cropX1 && pcy >= _cropY0 && pcy <= _cropY1;
      }

      // Full canvas background and water — outer polygons fill the scene as ground cover.
      const backgroundFeatures = features.filter(f => f.properties?.type === 'BACKGROUND');
      const waterFeatures       = features.filter(f => f.properties?.type === 'WATER');
      // Buildings cropped to center 50% — far-outlying structures are excluded.
      const buildingFeatures = features.filter(f => {
        if (f.properties?.type !== 'BUILDING') return false;
        const ring = f.geometry?.coordinates?.[0];
        return ring ? _inCropBox(ring) : false;
      });

      // Calendar date / hour needed by forest shadow inside the terrain loop and
      // also passed to buildWallDecorations later — declare here so both can use it.
      const _importDate = _getCalendarDate();
      const _hr = _importDate.hour;
      const _ss = _getSubSeason(_importDate.month);

      // ── Forest canopy texture — generate once, upload, reuse for all FOREST polygons ──
      // A 128×128 seamless PNG blob pattern used as fillType:2 on each forest polygon.
      // Single Drawing per polygon = far fewer documents than per-circle approach.
      const _texDir = 'worlds/' + (game.world?.id || 'world') + '/cavril-gen';
      let _forestTexSrc = null;
      try {
        ui.notifications?.info('[CavrilImport] Generating forest canopy texture…', { permanent: false });
        // Generate neutral (no baked tint) — applySeason regenerates with the
        // correct seasonal tint so texture trees always match tile tree tints.
        const _fTexDataURL = await generateForestTexture(0x4f726573, '#ffffff', false, _gridSizePx, _importPxPerFt);
        await _uploadTex(_fTexDataURL, `${_texDir}/forest-canopy.png`);
        _forestTexSrc = `${_texDir}/forest-canopy.png`;
      } catch (_texErr) {
        console.warn('[CavrilImport] Forest canopy texture upload failed — canopy overlay skipped:', _texErr.message);
      }

      // Use module-level stroke tables (defined near bottom of file, hoisted by closure)
      const terrainRng    = mulberry32(strHash(sceneName + ':terrain'));
      const terrainDrawings = [];
      // Master drawing array — all Drawing documents collected here, then created in ONE batch
      // at the end of the generation phase. Eliminates 9+ separate createEmbeddedDocuments
      // calls (each triggers a full canvas re-render) in favour of one large batched call.
      const allDrawings = [];

      // ── Full-canvas grass base layer ──────────────────────────────────────────
      // A single rectangle covering the entire scene sits at sort:-10, below all
      // terrain polygons. Any gap (river/wall seam, FTG polygon edge, unrecognised
      // type) shows grass instead of the raw scene background.
      const _bgPts = [0, 0, transform.canvasW, 0, transform.canvasW, transform.canvasH, 0, transform.canvasH];
      const _bgDraw = makePolygonDrawing(
        _bgPts, true,
        TERRAIN_COLORS.GRASS.DAY, 1.0,
        null, 0, 0,
        { world: { cavrilTerrain: true, terrainType: 'GRASS', cavrilBaseLayer: true } }
      );
      _bgDraw.fillType = 2;
      _bgDraw.texture  = _TEX.GRASS;
      _bgDraw.sort   = -10;
      _bgDraw.z      = -10;
      _bgDraw.locked = true;
      terrainDrawings.push(_bgDraw);

      // Wavy pixel-space rings for farm features — populated in terrain loop so
      // generateCropRowDrawings can use the distorted polygon shape.
      const _wavyFarmPts = new Map();
      for (const f of backgroundFeatures) {
        const bt     = f.properties.backgroundType || 'DEFAULT';
        const ring   = f.geometry.coordinates[0];
        let absPts = [];
        for (const [gx, gy] of ring) {
          const [px, py] = transform.tc(gx, gy);
          absPts.push(px, py);
        }

        // Edge distortion: organic waviness so polygon silhouettes look hand-drawn
        // rather than laser-cut GeoJSON rectangles.
        //   FOREST:              amplitude 2, subdivide 4
        //   MEADOW/PASTURE:      amplitude 1, subdivide 8 — gentle natural boundary
        //   Farm fields:         amplitude 1, subdivide 6 — subtle soft edge
        //   Rivers/coast:        amplitude 1.5, subdivide 6 — gentle organic curve
        const _MEADOW_WAVE_TYPES = new Set(['MEADOW', 'PASTURE', 'SCRUBLAND', 'HEATH']);
        if (bt === 'FOREST') {
          const forestSeed = strHash(`forestwave-${Math.round(absPts[0])}-${Math.round(absPts[1])}`);
          const forestRng  = mulberry32(forestSeed);
          absPts = applyWavyEdge(absPts, forestRng, 2, 4);
        } else if (_MEADOW_WAVE_TYPES.has(bt)) {
          // Expand first so the wavy edge only grows outward — never exposes the
          // layer beneath by cutting inward below the original boundary.
          absPts = insetPolyFlat(absPts, -1);
          const _mwSeed = strHash(`meadwave-${bt}-${Math.round(absPts[0])}-${Math.round(absPts[1])}`);
          absPts = applyWavyEdge(absPts, mulberry32(_mwSeed), 1, 8);
        } else if (FARM_COLOR_VARIANTS[bt] || bt === 'WATER' || bt === 'WATERFRONT') {
          // Water amplitude lowered to 1.5 — visibly organic without severe distortion.
          const _wvAmp  = (bt === 'WATER' || bt === 'WATERFRONT') ? 1.5 : 1;
          const waveSeed = strHash(`terrawave-${bt}-${Math.round(absPts[0])}-${Math.round(absPts[1])}`);
          const waveRng  = mulberry32(waveSeed);
          absPts = applyWavyEdge(absPts, waveRng, _wvAmp, 6);
        }

        // Clip to visible canvas window after wavy processing — prevents Foundry
        // from clamping Drawing.x/y when the polygon straddles the crop boundary.
        if (transform.isCropped) {
          absPts = clipPolygonToCanvas(absPts, transform.canvasW, transform.canvasH);
          if (!absPts) continue;
        }

        // Farm: capture wavy pts so crop rows follow the distorted edge, not the
        // raw GeoJSON polygon.  Stored as [[x,y],...] for generateCropRowDrawings.
        if (FARM_COLOR_VARIANTS[bt]) {
          const _fwPts = [];
          for (let _i = 0; _i < absPts.length; _i += 2)
            _fwPts.push([absPts[_i], absPts[_i + 1]]);
          _wavyFarmPts.set(f, _fwPts);
        }

        // Forest: shadow uses the full wavy perimeter; base + canopy use the same pts.
        // No fill-polygon inset — the forest shape is left at its original size and
        // the perimeter trees sit on its edge.
        const _forestFullPts = bt === 'FOREST' ? [...absPts] : null;

        const palette = TERRAIN_COLORS[bt] || TERRAIN_COLORS.DEFAULT;

        // Per-field color variation — each farm polygon picks one of 4 tones via centroid hash.
        // Store the chosen color in flags so applySeason can preserve the variation on recolor.
        let fillColor      = palette.DAY;
        let farmBaseColor  = null;
        if (FARM_COLOR_VARIANTS[bt]) {
          const variants   = FARM_COLOR_VARIANTS[bt];
          const [gcx, gcy] = polyCentroid(ring);
          const hash       = strHash(`farmvar-${bt}-${Math.round(gcx * 10)}-${Math.round(gcy * 10)}`);
          fillColor        = variants[hash % variants.length];
          farmBaseColor    = fillColor; // persisted in drawing flags for seasonal recolor
        }

        // Background water polygon: opaque texture fill tinted #7ab0d4.
        // Bank stroke (#c0b060) ONLY on WATERFRONT (coastal beaches).
        // WATER (ocean / large water body) gets no stroke.
        if (bt === 'WATER' || bt === 'WATERFRONT') {
          const _bankStroke = bt === 'WATERFRONT' ? (TERRAIN_STROKE_COLOR_MAP.WATERFRONT || '#c0b060') : null;
          const _bankWidth  = bt === 'WATERFRONT' ? (TERRAIN_STROKE_WIDTH_MAP.WATERFRONT  || 12)       : 0;
          const waterD = makePolygonDrawing(
            absPts, true, '#7ab0d4', 1.0, _bankStroke, _bankWidth, _bankStroke ? 1.0 : 0,
            { world: { cavrilTerrain: true, terrainType: bt } }
          );
          waterD.sort   = 18; waterD.z = 18;
          waterD.locked = true;
          waterD.fillType = 2; waterD.texture = _TEX.WATER;
          terrainDrawings.push(waterD);
          continue;
        }

        // Stroke setup per terrain type:
        //   Farm fields:   width=5, same fill colour, alpha=0.5 — soft field-edge blend
        //   Forest base:   width=5, grass colour, alpha=0.5 — softens the grass→forest edge
        //   Meadow types:  width=8, same fill colour, alpha=0.2 — feathered transition to grass
        //   Everything else: table-driven or none
        let strokeW = TERRAIN_STROKE_WIDTH_MAP[bt] || 0;
        let strokeC = TERRAIN_STROKE_COLOR_MAP[bt]  || palette.DAY;
        if (FARM_COLOR_VARIANTS[bt]) {
          strokeW = 5;
          strokeC = fillColor;
        } else if (bt === 'FOREST') {
          strokeW = 5;
          strokeC = TERRAIN_COLORS.GRASS.DAY;   // updated to seasonal grass by applySeason
        } else if (bt === 'GRASS') {
          // Soft bright-green halo on the mid-green GRASS polygon edges — same colour as
          // the vivid LAWN_TEXTURE_TYPE areas so the border reads as a gradient bridge
          // between the two greens.  Width 15, alpha 0.5 so it blends without a hard line.
          strokeW = 12;
          strokeC = TERRAIN_COLORS.LAWN_TEXTURE_TYPE.DAY;  // '#8ec052'
        } else if (_MEADOW_WAVE_TYPES.has(bt)) {
          strokeW = 12;
          strokeC = fillColor;
        }
        // Farm/forest/grass: 50% stroke alpha; meadow types: 30% for feathered edge.
        const strokeAlpha = strokeW > 0
          ? (_MEADOW_WAVE_TYPES.has(bt) ? 0.3 : (FARM_COLOR_VARIANTS[bt] || bt === 'FOREST' || bt === 'GRASS') ? 0.5 : 1.0)
          : 0;

        const flags = { world: { cavrilTerrain: true, terrainType: bt } };
        if (farmBaseColor) flags.world.farmBaseColor = farmBaseColor;
        if (bt === 'FOREST') flags.world.cavrilForestBase = true; // for applySeason stroke update

        const _baseDrawing = makePolygonDrawing(
          absPts, true, fillColor, 1.0, strokeC, strokeW, strokeAlpha, flags
        );
        // Explicit sort values for all terrain types so Foundry never falls back to
        // an ambiguous default. Layer ordering: terrain(12) < water(18) < roads(22) <
        // forest-shadow(23) < forest-base(24) < forest-overlay(25) < piers(27).
        // Forest base (24) is above roads (22) so forest overlaps roads at boundaries.
        if (bt === 'FOREST') { _baseDrawing.sort = 24; _baseDrawing.z = 24; }
        else                  { _baseDrawing.sort = 12; _baseDrawing.z = 12; }
        // Lock all terrain polygons — prevents Foundry's Drawing tool hover/click
        // events from putting them into an interactive state that can suppress
        // texture fill rendering and get stuck. Terrain is procedurally generated
        // and shouldn't be interactively editable after import.
        _baseDrawing.locked = true;
        const _texSrc = TERRAIN_TEXTURES[bt] || _TEX.GRASS;
        _baseDrawing.fillType = 2; _baseDrawing.texture = _texSrc;
        terrainDrawings.push(_baseDrawing);

        // ── Forest shadow: shifted polygon cast on adjacent terrain ──────────
        // sort:23 — above roads (22) so the shadow falls on road surfaces at forest edges.
        // Below the forest base (sort:24) so the opaque body covers the overlap.
        // Still below water (sort:18 bank / 19 river) ... actually forest shadow at 23
        // will be above water; that's acceptable (shadow over river looks fine).
        // Uses _forestFullPts (pre-inset) so the shadow matches the real tree edge.
        if (bt === 'FOREST') {
          const { sx: fsx, sy: fsy } = getShadowVec(_hr);
          const _fshx = Math.round(fsx * 2.5);
          const _fshy = Math.round(fsy * 2.5);
          const _shSrc = _forestFullPts || absPts; // always the un-inset perimeter
          // Perspective shadow: silhouette algorithm connects the shadow-facing edge of the
          // forest perimeter to its projected copy, matching how building shadows work.
          const shadowPts = _perspShadowPoly(_shSrc, _fshx, _fshy);
          const _fsdPts = transform.isCropped
            ? clipPolygonToCanvas(shadowPts, transform.canvasW, transform.canvasH)
            : shadowPts;
          if (_fsdPts) {
            const fsd = makePolygonDrawing(
              _fsdPts, true, '#20201a', 0.15, null, 0, 0,
              { world: { cavrilShadow: true, cavrilForestShadow: true, basePts: [..._shSrc], shadowScale: 2.5 } }
            );
            fsd.sort = 23; fsd.z = 23; fsd.locked = true;
            terrainDrawings.push(fsd);
          }
        }

        // ── Forest canopy overlay (fillType:2 pattern fill) ──────────────────
        // A single polygon Drawing per forest area uses the tiling 128×128 PNG blob
        // texture as its fill — seamlessly repeating dark circles that read as dense
        // canopy. One Drawing per polygon (not hundreds of ellipses) → much faster
        // to create and render.
        // sort:25 — on top of the forest base (sort:24), well above shadow (sort:23).
        // Falls back gracefully to no overlay if texture upload failed at import start.
        if (bt === 'FOREST' && _forestTexSrc) {
          const _foFlags = { world: { cavrilForestCanopy: true, terrainType: 'FOREST' } };
          // fillColor #ffffff = no tint on the pattern texture (matches tree tile tint).
          // Foundry multiplies fillColor onto the texture — white = neutral, no colour shift.
          const _fod = makePolygonDrawing(absPts, true, '#ffffff', 1.0, null, 0, 0, _foFlags);
          _fod.fillType = 2;    // PATTERN — overrides solid fill set by makePolygonDrawing

          // Use string form for texture — Foundry V12 migration converts it to { src }
          // internally.  Object form { src, scaleX, scaleY } passed to Drawing.create()
          // fails silently in V12 (texture disappears entirely).  Circle size is instead
          // controlled at texture-generation time via _gridSizePx (minimum r=12 now).
          _fod.texture = _forestTexSrc;
          _fod.sort = 25; _fod.z = 25; _fod.locked = true;
          terrainDrawings.push(_fod);
        }
      }
      for (const f of waterFeatures) {
        const ring = f.geometry.coordinates[0];
        let absPts = [];
        for (const [gx, gy] of ring) {
          const [px, py] = transform.tc(gx, gy);
          absPts.push(px, py);
        }
        // Gentle wavy edge — amplitude 1.5 for subtle organic waterline curvature.
        const _wvSeed = strHash(`terrawave-WATER-${Math.round(absPts[0])}-${Math.round(absPts[1])}`);
        absPts = applyWavyEdge(absPts, mulberry32(_wvSeed), 1.5, 6);

        if (transform.isCropped) {
          absPts = clipPolygonToCanvas(absPts, transform.canvasW, transform.canvasH);
          if (!absPts) continue;
        }

        // Two-layer river system — prevents the "bank crossing" artifact at branching
        // river junctions where a single-layer bank stroke bleeds across the join:
        //   Layer 1 (sort:17, background): solid opaque dirt fill + 12px bank stroke (same colour).
        //   Layer 2 (sort:18, primary): opaque water texture tinted #7ab0d4, no stroke.
        //           The opaque Layer 2 body covers any bank-stroke bleed from adjacent polygons.
        const riverBg = makePolygonDrawing(
          absPts, true, '#9a8468', 1.0, '#9a8468', 12, 1.0,
          { world: { cavrilTerrain: true, terrainType: 'WATER', cavrilRiverBank: true } }
        );
        riverBg.sort = 17; riverBg.z = 17; riverBg.locked = true;
        terrainDrawings.push(riverBg);

        const waterD2 = makePolygonDrawing(
          absPts, true, '#7ab0d4', 1.0, null, 0, 0,
          { world: { cavrilTerrain: true, terrainType: 'WATER' } }
        );
        waterD2.sort = 18; waterD2.z = 18; waterD2.locked = true;
        waterD2.fillType = 2; waterD2.texture = _TEX.WATER;
        terrainDrawings.push(waterD2);
      }

      allDrawings.push(...terrainDrawings);
      console.log(`[CavrilImport] Terrain: ${terrainDrawings.length} drawings (deferred)`);

      // 7b. Crop row drawings (farm fields) ───────────────────────────────────
      prog.setProgress('Building crop rows…', 32);
      await new Promise(r => setTimeout(r, 0));

      const cropRowDrawings = [];
      for (const f of backgroundFeatures) {
        const bt = f.properties?.backgroundType || '';
        if (FARM_ROW_TYPES.has(bt)) {
          // Pass the wavy pixel ring so rows follow the distorted edge shape.
          cropRowDrawings.push(...generateCropRowDrawings(f, transform, undefined, _wavyFarmPts.get(f)));
        }
      }
      allDrawings.push(...cropRowDrawings);
      console.log(`[CavrilImport] Crop rows: ${cropRowDrawings.length} row segments (deferred)`);

      // 8. Road drawings ──────────────────────────────────────────────────────
      prog.setProgress('Building road drawings…', 34);
      await new Promise(r => setTimeout(r, 0));

      const ROAD_BED_COLOR = '#7a6e50';   // clearly darker warm tan — same family as road surface (#c4b082) but 23pts darker
      const roadDrawings = [];
      for (const f of features) {
        if (f.properties?.type !== 'EDGE') continue;
        const et  = f.properties.edgeType;
        if (WALL_TYPES.has(et)) continue; // walls drawn after buildings for correct z-order
        const cfg = ROAD_COLORS[et];
        if (!cfg) continue;
        const coords = f.geometry.coordinates;
        let absPts = [];
        for (const [gx, gy] of coords) {
          const [px, py] = transform.tc(gx, gy);
          absPts.push(px, py);
        }
        if (transform.isCropped) {
          absPts = clipPolylineToCanvas(absPts, transform.canvasW, transform.canvasH);
          if (!absPts) continue;
        }

        const _scaledW = Math.max(1, Math.round(cfg.width * _importStrokeScale));
        const _rd = makePolygonDrawing(
          absPts, false, null, 0, cfg.DAY, _scaledW, 1.0,
          { world: { cavrilRoad: true, edgeType: et } }
        );
        // Roads: sort:22 — above water (sort:18-19) so roads crossing rivers are visible.
        // Piers and bridges: sort:27 — above forest (sort:23-25) so bridges cross over trees.
        const _rdSort = PIER_BRIDGE_EDGE_TYPES.has(et) ? 27 : 22;
        _rd.sort = _rdSort; _rd.z = _rdSort;
        roadDrawings.push(_rd);
      }

      allDrawings.push(...roadDrawings);
      console.log(`[CavrilImport] Roads: ${roadDrawings.length} drawings (deferred)`);

      // 8b. Road elbow caps ───────────────────────────────────────────────────
      // Three passes:
      //   sort:20 — road BED shoulder (width+8, ROAD_BED_COLOR, alpha 0.65) fills
      //             the gaps where dirt shoulders meet at intersections
      //   sort:22 — normal road surface caps
      //   sort:27 — pier + bridge caps
      prog.setProgress('Adding road caps…', 45);
      await new Promise(r => setTimeout(r, 0));
      // Road elbow passes — mirror the two-layer road stroke system exactly:
      //   sort:20 BED  — circle at junctions (diameter = cfg.width + 8), square at dead-ends.
      //                   Dead-end squares extend the bed border past the terminus like a kerb.
      //   sort:22 SURFACE — circles at junctions only; dead-ends get no surface cap (bed only).
      //                   Sits centred on top of the bed cap, capping the surface layer.
      //   Together the two shapes reproduce the road cross-section at junctions:
      //   a lighter-beige disc surrounded by a darker-beige ring, matching the road body.
      //   sort:27 PIERS/BRIDGES — above forest (25).
      const elbowDrawings = [
        ...buildRoadElbows(features, transform, null, 22, PIER_BRIDGE_EDGE_TYPES, 0),
        ...buildRoadElbows(features, transform, PIER_BRIDGE_EDGE_TYPES, 27),
      ];
      allDrawings.push(...elbowDrawings);
      console.log(`[CavrilImport] Road caps: ${elbowDrawings.length} (deferred)`);

      // 8c. Bridge decks ─────────────────────────────────────────────────────
      prog.setProgress('Building bridges…', 46);
      await new Promise(r => setTimeout(r, 0));
      const bridgeDrawings = buildBridgeDrawings(features, transform);
      allDrawings.push(...bridgeDrawings);
      console.log(`[CavrilImport] Bridges: ${bridgeDrawings.length} (deferred)`);

      // 8d. Shadows: buildings, city walls, guard towers ──────────────────────
      // _hr / _ss declared earlier (before terrain loop) so both steps can share them.
      prog.setProgress('Adding shadows…', 46);
      await new Promise(r => setTimeout(r, 0));

      {
        const shadowDrawings = [];
        for (const b of packedBuildings) {
          const sd = buildingShadowData(b, _hr);
          if (sd) shadowDrawings.push(sd);
        }
        for (const f of features) {
          if (f.properties?.type !== 'EDGE') continue;
          const ws = wallShadowData(f, _hr, transform);
          if (ws) shadowDrawings.push(ws);
        }
        allDrawings.push(...shadowDrawings);
        console.log(`[CavrilImport] Shadows: ${shadowDrawings.length} (deferred)`);
      }

      // 9. Building drawings ──────────────────────────────────────────────────
      prog.setProgress('Building polygon drawings…', 48);
      await new Promise(r => setTimeout(r, 0));

      const bldgDrawings = [];
      for (const b of packedBuildings) {
        const _bPolyPx = transform.isCropped
          ? clipPolygonToCanvas(b.polyPx, transform.canvasW, transform.canvasH)
          : b.polyPx;
        if (!_bPolyPx) continue;
        const palette = BUILDING_COLORS[b.type] || BUILDING_COLORS.DEFAULT;
        const bd = makePolygonDrawing(
          _bPolyPx, true, palette.DAY, 1.0, '#404040', 3, 1.0,
          {
            world: {
              cavrilBuilding:    true,
              buildingId:        b.id,
              buildingType:      b.type,
              buildingName:      b.name,
              isBuildingOutline: true,
            },
          }
        );
        bd.sort = 200;
        bd.z    = 200;
        bd.fillType = 2; bd.texture = _TEX.ROOF;  // roof tile texture tinted by building palette
        bldgDrawings.push(bd);
      }

      allDrawings.push(...bldgDrawings);
      console.log(`[CavrilImport] Buildings: ${bldgDrawings.length} drawings (deferred)`);

      // 9b. Walls + fences + tower shadows (drawn AFTER buildings for correct z-order) ──
      prog.setProgress('Drawing walls & fences…', 61);
      await new Promise(r => setTimeout(r, 0));

      const wallDrawings = [];
      const wallShadows  = [];
      for (const f of features) {
        if (f.properties?.type !== 'EDGE') continue;
        const et  = f.properties.edgeType;
        if (!WALL_TYPES.has(et)) continue;
        const cfg = ROAD_COLORS[et];
        if (!cfg) continue;
        const coords = f.geometry.coordinates;
        let absPts = [];
        for (const [gx, gy] of coords) {
          const [px, py] = transform.tc(gx, gy);
          absPts.push(px, py);
        }
        if (transform.isCropped) {
          absPts = clipPolylineToCanvas(absPts, transform.canvasW, transform.canvasH);
          if (!absPts) continue;
        }
        const wd = makePolygonDrawing(
          absPts, false, null, 0, cfg.DAY, Math.max(1, Math.round(cfg.width * _importStrokeScale)), 1.0,
          { world: { cavrilRoad: true, edgeType: et } }
        );
        wd.sort = 300;
        wd.z    = 300;
        wallDrawings.push(wd);
        const ws = wallShadowData(f, _hr, transform);
        if (ws) wallShadows.push(ws);
      }
      const wallElbows = buildRoadElbows(features, transform, WALL_TYPES, 300);
      // Pass water polygons so aqueduct markers are placed where rivers cross walls.
      // Pass current hour so buildWallDecorations can generate tower shadows.
      const waterPolyFeatures = [
        ...waterFeatures,
        ...backgroundFeatures.filter(f =>
          f.properties?.backgroundType === 'WATER' ||
          f.properties?.backgroundType === 'WATERFRONT'),
      ];
      const { towers, gates, aquaducts, towerShadows } = buildWallDecorations(features, waterPolyFeatures, transform, _hr);
      const allWallDocs = [...towerShadows, ...wallShadows, ...wallDrawings, ...wallElbows, ...towers, ...gates, ...aquaducts];
      allDrawings.push(...allWallDocs);
      console.log(`[CavrilImport] Walls: ${wallDrawings.length} segs, ${wallElbows.length} caps, ${towers.length} towers, ${gates.length} gates, ${aquaducts.length} aqueducts, ${towerShadows.length} tower shadows, ${wallShadows.length} wall shadows (deferred)`);

      // 10 + 11. Trees — generation only (creates happen in the batch below) ───
      // Generating shadows from canopyTiles directly (not from scene.tiles after tile
      // creation) avoids the read-back dependency and lets tree shadows join the main
      // drawing batch. canopyTiles.x/y/width are the same values that Foundry stores.
      let canopyTiles = [];
      if (withTrees) {
        prog.setProgress('Generating tree positions…', 62);
        await new Promise(r => setTimeout(r, 0));

        const treeRng  = mulberry32(strHash(sceneName + ':trees'));
        const assetRng = mulberry32(strHash(sceneName + ':tree-assets'));
        const edgeFeatures = features.filter(f => f.properties?.type === 'EDGE');
        // When the settlement is cropped, the canvas edge filter inside generateTrees()
        // gates placement to the visible region — no separate cropBox needed. The centroid
        // filter would wrongly skip large background polygons (e.g. the settlement-wide
        // GRASS polygon) whose centroids sit outside the cropped canvas window.
        const _treeCropBox = transform.isCropped ? null : { x0: _cropX0, y0: _cropY0, x1: _cropX1, y1: _cropY1 };
        // Pass ALL building features (not just crop-box subset) so trees are excluded
        // from buildings at the settlement edges that lie outside the crop box.
        const allBuildingFeatures = features.filter(f => f.properties?.type === 'BUILDING');
        const trees    = generateTrees(backgroundFeatures, allBuildingFeatures, waterFeatures, edgeFeatures, treeRng, transform, _treeCropBox, treeDensityMult);

        console.log(`[CavrilImport] Trees: ${trees.length} positions generated`);
        // Canopy tiles only — trunks removed (computation savings; overworld scale)
        canopyTiles = trees.map(t => treeTileData(t, transform, assetRng, _feetPerUnit));

        // Generate tree shadows from canopyTiles (same x/y/width as stored docs)
        const treeShadowDrawings = [];
        for (const tileData of canopyTiles) {
          const tf = tileData.flags?.world || {};
          if (tf.cavrilForestTree) continue;  // forest perimeter — no individual shadow
          // V12: tile x,y IS the center (see treeTileData comment)
          const sd = treeShadowDrawing(tileData.x, tileData.y, tileData.width, _hr);
          if (sd) treeShadowDrawings.push(sd);
        }
        allDrawings.push(...treeShadowDrawings);
        console.log(`[CavrilImport] Tree shadows: ${treeShadowDrawings.length} (deferred)`);
      }

      // ─── MAIN DRAWING BATCH ───────────────────────────────────────────────
      // Terrain + crop rows + roads + elbows + bridges + shadows + buildings +
      // walls + tree shadows — all in ONE createEmbeddedDocuments sweep.
      // CHUNK_SIZE=100 reduces total server round-trips 5× vs the old value of 20.
      prog.setProgress(`Creating ${allDrawings.length} scene drawings…`, 64);
      await new Promise(r => setTimeout(r, 0));
      if (allDrawings.length) {
        const _createdDocs = await chunkedCreate(scene, 'Drawing', allDrawings, CHUNK_SIZE, (done, total) => {
          prog.setProgress(`Drawings (${done}/${total})…`, 64 + (done / total) * 22);
        });
        // Index shadow drawing IDs into a scene flag so updateTOD can find them in O(1)
        // instead of scanning all drawings every rebuild. The flag is updated on each
        // shadow rebuild to stay current as IDs change.
        const _shadowIds = _createdDocs
          .filter(d => (d?.flags?.world || {}).cavrilShadow)
          .map(d => d.id);
        if (_shadowIds.length) {
          await scene.setFlag('world', 'cavrilShadowIds', _shadowIds);
        }
      }
      console.log(`[CavrilImport] Total drawings created: ${allDrawings.length}`);

      // ─── LIGHTS ───────────────────────────────────────────────────────────
      if (withLights) {
        prog.setProgress('Placing ambient lights…', 86);
        await new Promise(r => setTimeout(r, 0));

        const lights = [];
        for (const b of packedBuildings) {
          if (!LIGHT_BUILDING_TYPES.has(b.type)) continue;
          // Compute building footprint size in grid units from packed polygon bbox
          let bMinX = Infinity, bMaxX = -Infinity, bMinY = Infinity, bMaxY = -Infinity;
          for (let i = 0; i < b.polyPx.length; i += 2) {
            bMinX = Math.min(bMinX, b.polyPx[i]);   bMaxX = Math.max(bMaxX, b.polyPx[i]);
            bMinY = Math.min(bMinY, b.polyPx[i+1]); bMaxY = Math.max(bMaxY, b.polyPx[i+1]);
          }
          const sizeUnits = Math.max(bMaxX - bMinX, bMaxY - bMinY) / GRID_SIZE;
          lights.push(buildingLightData(b.cx, b.cy, b.type, sizeUnits));
        }
        await chunkedCreate(scene, 'AmbientLight', lights, CHUNK_SIZE, (done, total) => {
          prog.setProgress(`Lights (${done}/${total})…`, 86 + (done / total) * 4);
        });
        console.log(`[CavrilImport] Lights: ${lights.length} placed`);
      }

      // ─── TILES ────────────────────────────────────────────────────────────
      if (withTrees && canopyTiles.length) {
        prog.setProgress(`Placing ${canopyTiles.length} trees…`, 90);
        await new Promise(r => setTimeout(r, 0));
        await chunkedCreate(scene, 'Tile', canopyTiles, TILE_CHUNK_SIZE, (done, total) => {
          prog.setProgress(`Trees (${done}/${total})…`, 90 + (done / total) * 4);
        });
        console.log(`[CavrilImport] Trees placed: ${canopyTiles.length} canopy tiles`);
      }

      // 14. Activate scene ────────────────────────────────────────────────────
      prog.setProgress('Activating scene…', 96);
      await new Promise(r => setTimeout(r, 0));
      await scene.activate();

      // Apply initial time-of-day + season palette based on current in-game clock
      prog.setProgress('Applying initial colors…', 97);
      try {
        const _d = _getCalendarDate();
        const _tod = _getTOD(_d.hour);
        const _ss  = _getSubSeason(_d.month);
        await window.CavrilTools.updateSceneColors(scene, _tod, _ss);
      } catch (e) {
        console.warn('[CavrilImport] Initial color pass failed (non-fatal):', e.message);
      }

      prog.markDone();
      ui.notifications.info(`✓ "${sceneName}" imported successfully!`);
      console.log(`[CavrilImport] Complete — scene ${scene.id}`);

    } catch (err) {
      console.error('[CavrilImport] Import failed:', err);
      prog.markError(`Import failed: ${err.message}`);
      ui.notifications.error(`City import failed: ${err.message}`);
    }
  }

  // ─── CALENDAR HELPERS ────────────────────────────────────────────────────────

  function _getCalendarDate() {
    // Hour always comes from raw worldTime — standard 3600s/hr, 24hr/day is
    // invariant even in fantasy calendars that change only the month/day structure.
    // This makes TOD and shadow direction immune to calendar API quirks.
    const seconds  = game?.time?.worldTime || 0;
    const totalHrs = Math.floor(seconds / 3600);
    const hour     = ((totalHrs % 24) + 24) % 24;

    // Month comes from the calendar API so custom month-lengths are respected
    // (affects only season — tree color, water hue, etc.).
    const sc = window.SimpleCalendar;
    if (sc?.api) {
      const attempts = [
        () => sc.api.currentDateTime?.(),
        () => sc.api.currentDateTimeSimpleCalendar?.(),
        () => sc.api.timestampToDate?.(game?.time?.worldTime),
      ];
      for (const fn of attempts) {
        try {
          const d = fn();
          if (d && Number.isFinite(d.month)) {
            return { month: d.month + 1, day: (d.day || 0) + 1, hour };
          }
        } catch (_) {}
      }
    }
    // Fallback month: assume 30 days/month (only affects season colour, not shadows/TOD).
    const days  = Math.floor(totalHrs / 24);
    const month = (Math.floor(days / 30) % 12) + 1;
    return { month, day: (days % 30) + 1, hour };
  }

  /**
   * Debug helper — run in Foundry console to diagnose season/calendar detection.
   * Usage: CavrilTools.debugCalendar()
   */
  window.CavrilTools.debugCalendar = function () {
    const sc = window.SimpleCalendar;
    console.group('[CavrilTools] Calendar Debug');
    console.log('game.time.worldTime:', game?.time?.worldTime);

    // Simple Calendar
    console.log('SimpleCalendar present:', !!sc, '/ api present:', !!(sc?.api));
    if (sc?.api) {
      console.log('SC API keys:', Object.keys(sc.api));
      try { console.log('  currentDateTime():', sc.api.currentDateTime?.()); } catch(e) { console.log('  currentDateTime error:', e.message); }
      try { console.log('  currentDateTimeSimpleCalendar():', sc.api.currentDateTimeSimpleCalendar?.()); } catch(e) { console.log('  currentDateTimeSimpleCalendar error:', e.message); }
      try { console.log('  timestampToDate(worldTime):', sc.api.timestampToDate?.(game?.time?.worldTime)); } catch(e) { console.log('  timestampToDate error:', e.message); }
    }

    // Seasons & Stars
    const ss = game?.modules?.get?.('seasons-and-stars');
    console.log('Seasons & Stars present:', !!(ss?.active));
    if (ss?.active) {
      console.log('  window["seasons-and-stars"]:', typeof window['seasons-and-stars']);
      try { console.log('  S&S API:', window['seasons-and-stars']?.api); } catch(e) {}
    }

    // About Time
    const at = game?.modules?.get?.('about-time');
    console.log('About Time present:', !!(at?.active));

    // SmallTime (shows time but doesn't have an advanced calendar API)
    console.log('SmallTime present:', !!(game?.modules?.get?.('smalltime')?.active));

    // Raw worldTime → naive 24h decode
    const secs = game?.time?.worldTime || 0;
    const naiveHour = ((Math.floor(secs / 3600) % 24) + 24) % 24;
    console.log('Naive worldTime → hour:', naiveHour, '(assumes 3600s/hr, 24h/day — wrong for custom calendars)');

    const d = _getCalendarDate();
    const hourValid = Number.isFinite(d.hour) && d.hour >= 0;
    console.log('Resolved date:', d,
      '→ hour valid:', hourValid,
      '/ season:', _getSubSeason(d.month),
      '/ TOD:', _getTOD(d.hour));
    if (!hourValid) {
      console.error('[CavrilTools] PROBLEM: resolved hour is invalid (' + d.hour + '). ' +
        'Shadow rebuilds will fire every worldTime tick, stacking shadows. ' +
        'The calendar module is not exposing an API that _getCalendarDate() recognises.');
    }
    console.groupEnd();
  };

  function _getTOD(hour) {
    if (hour >= 6  && hour < 9)  return 'DAWN';
    if (hour >= 9  && hour < 18) return 'DAY';
    if (hour >= 18 && hour < 21) return 'DUSK';
    return 'NIGHT';
  }

  function _getSubSeason(month) {
    const m = ((month - 1 + 12) % 12) + 1;
    if (m ===  3) return 'EARLY_SPRING';
    if (m ===  4) return 'MID_SPRING';
    if (m ===  5) return 'LATE_SPRING';
    if (m ===  6) return 'EARLY_SUMMER';
    if (m ===  7) return 'MID_SUMMER';
    if (m ===  8) return 'LATE_SUMMER';
    if (m ===  9) return 'EARLY_AUTUMN';
    if (m === 10) return 'MID_AUTUMN';
    if (m === 11) return 'LATE_AUTUMN';
    if (m === 12) return 'EARLY_WINTER';
    if (m ===  1) return 'MID_WINTER';
    return 'LATE_WINTER';
  }

  // ─── PUBLIC API ───────────────────────────────────────────────────────────────

  window.CavrilTools = window.CavrilTools || {};

  /** Open the city import dialog. */
  window.CavrilTools.importCity = function () {
    new ImportCityDialog().render(true);
  };

  /** Exported palettes — available for runtime recoloring from CityHUD. */
  window.CavrilTools.BUILDING_COLORS = BUILDING_COLORS;
  window.CavrilTools.TERRAIN_COLORS  = TERRAIN_COLORS;
  window.CavrilTools.ROAD_COLORS     = ROAD_COLORS;

  // Scene darkness values by time of day.
  // Lights have config.darkness.min = 0.35 so they activate automatically at DUSK/NIGHT.
  const DARKNESS_BY_TOD = { DAY: 0, DAWN: 0.2, DUSK: 0.6, NIGHT: 0.85 };

  // TOD atmosphere is handled entirely by scene.darkness (set in updateTOD).
  // The cavrilTODOverlay Tile system has been removed — it caused quadrant coloration
  // artifacts and was visually redundant with Foundry's global darkness setting.

  /**
   * Lightweight TOD update — darkness + shadow rebuild.
   * Called automatically on worldTime changes (no per-drawing terrain churn).
   * @param {Scene}  scene
   * @param {string} timeOfDay  'DAY'|'DAWN'|'DUSK'|'NIGHT'
   * @param {number} [hour]     if set, rebuilds building shadows
   * @param {string} [season]   sub-season key for correct shadow color (default 'MID_SUMMER')
   */
  window.CavrilTools.updateTOD = async function (scene, timeOfDay, hour, season, rebuildTreeShadows = true) {
    const tod = timeOfDay || 'DAY';
    const sea = season    || 'MID_SUMMER';

    // Shadow opacity scales down as trees lose leaves — applies to both individual
    // tree blob shadows and the forest polygon cast shadow.
    // LATE_AUTUMN: leaves mostly gone, partial bare branches cast lighter shadows.
    // Winter: bare branches only, very faint shadow.
    const _shadowScale = sea === 'LATE_AUTUMN'                  ? 0.50
                       : sea === 'MID_AUTUMN'                   ? 0.75
                       : sea.includes('WINTER')                 ? 0.30
                       : 1.0;
    const darkness = DARKNESS_BY_TOD[tod] ?? 0;
    await scene.update({ darkness }).catch(() => {});

    // TOD atmospheric tinting is handled entirely by scene.darkness (set above).
    // The per-tile overlay was removed — it caused partial-coverage artifacts (quadrant
    // coloration) due to unreliable canvas.dimensions values and was visually redundant.

    if (hour != null) {
      try {
        // ── Collect stored geometry from wall/tower/gate/forest shadows BEFORE deleting.
        // Building and tree shadows are rebuilt from live scene data (no stored geometry needed).
        // All other shadow types store their base polygon in flags.basePts / flags.wallPts
        // so they can be shifted to any new sun angle without re-parsing GeoJSON.
        const wallShadowStore  = [];  // { wallPts, wallWidth }
        const polyShadowStore  = [];  // { basePts, alpha, sort, shadowFlags }
        const shadowIds        = [];

        // Fast path: scene flag stores the IDs written at import time (and updated each
        // rebuild), avoiding a full O(N) scan of all scene drawings to find shadow docs.
        const _savedIds = scene.flags?.world?.cavrilShadowIds;
        const _shadowCandidates = _savedIds
          ? _savedIds.map(id => scene.drawings.get(id)).filter(Boolean)
          : [...scene.drawings].filter(d => d.flags?.world?.cavrilShadow);

        for (const d of _shadowCandidates) {
          const f = d.flags?.world || {};
          if (!f.cavrilShadow) continue;
          // Tree shadows are expensive to rebuild (require scanning all scene tiles).
          // When rebuildTreeShadows=false (clock-tick auto-updates), leave them in place.
          if (!rebuildTreeShadows && f.cavrilTreeShadow) continue;
          shadowIds.push(d.id);

          if (f.cavrilWallShadow && f.wallPts?.length) {
            wallShadowStore.push({ wallPts: f.wallPts, wallWidth: f.wallWidth || 4, wallEdgeType: f.wallEdgeType || 'STONE_WALL' });

          } else if (f.basePts?.length) {
            // Tower, gate, or forest polygon — all reconstruct from a shifted base polygon.
            // Forest shadows scale with _shadowScale so leafless winters cast near-invisible shade.
            const baseAlpha = f.cavrilForestShadow ? 0.15
                            : f.cavrilGateShadow   ? 0.22
                            :                        0.20;   // tower/default
            const alpha = f.cavrilForestShadow
              ? Math.round(baseAlpha * _shadowScale * 1000) / 1000
              : baseAlpha;
            const sort  = f.cavrilForestShadow ? 23 : 149;
            // Preserve original flags (including basePts) so the rebuilt drawing is also rebuildable.
            // shadowScale is forwarded so forest shadows apply the 2.5× multiplier on rebuild.
            polyShadowStore.push({ basePts: f.basePts, alpha, sort,
              shadowFlags: { ...f, cavrilShadow: true, shadowScale: f.shadowScale || 1 } });
          }
          // cavrilBuildingShadow / cavrilTreeShadow: just delete here, rebuilt from scene data below
        }

        // Suppress canvas re-render on delete — the layer will redraw once after the
        // new shadows are created, not twice (delete-flash then re-add).
        if (shadowIds.length) await scene.deleteEmbeddedDocuments('Drawing', shadowIds, { render: false });

        // ── New shadow vector at the requested hour ──────────────────────────────
        const { sx, sy } = getShadowVec(hour);
        const newShadows = [];

        // ── Building shadows ─────────────────────────────────────────────────────
        const buildings = window.CavrilTools.getSceneBuildingData(scene);
        for (const b of buildings) {
          const sd = buildingShadowData(b, hour);
          if (sd) newShadows.push(sd);
        }

        // ── Tree shadows — skipped on clock-tick auto-updates (rebuildTreeShadows=false)
        // because they are the dominant draw-count (one per canopy tile) and their
        // position barely shifts per hour. applySeason always passes true to rebuild fully.
        const _treeShadowAlpha = Math.round(0.22 * _shadowScale * 1000) / 1000;
        if (rebuildTreeShadows) {
          for (const tile of scene.tiles) {
            const tf = tile.flags?.world || {};
            if (!tf.cavrilTree || tf.cavrilForestTree) continue;
            const sd = treeShadowDrawing(tile.x, tile.y, tile.width, hour, _treeShadowAlpha);
            if (sd) newShadows.push(sd);
          }
        }

        // ── Wall shadows — connected ribbon from wall to shadow ──────────────────
        for (const { wallPts, wallWidth, wallEdgeType } of wallShadowStore) {
          const _wScale = wallEdgeType === 'STONE_FENCE' ? 1 / 3 : 1;
          const _wsx = Math.round(sx * _wScale);
          const _wsy = Math.round(sy * _wScale);
          const _wAlpha = wallEdgeType === 'STONE_FENCE' ? 0.12 : 0.20;
          const connPts = _lineShadowPoly(wallPts, _wsx, _wsy);
          const d = makePolygonDrawing(connPts, true, '#20201a', _wAlpha, null, 0, 0,
            { world: { cavrilShadow: true, cavrilWallShadow: true, wallPts, wallWidth, wallEdgeType } });
          d.sort = 149; d.z = 149;
          newShadows.push(d);
        }

        // ── Tower / gate / forest polygon shadows ────────────────────────────────
        // Forest shadows use the perspective silhouette algorithm (connects shadow-facing
        // perimeter to its projection). Tower/gate shadows use simple shift (they're
        // smaller and often fully shadow-facing, so perspective rarely changes the result).
        for (const { basePts, alpha, sort, shadowFlags } of polyShadowStore) {
          const _scale = shadowFlags.shadowScale || 1;
          const _psx = Math.round(sx * _scale);
          const _psy = Math.round(sy * _scale);
          const shadowPts = shadowFlags.cavrilForestShadow
            ? _perspShadowPoly(basePts, _psx, _psy)
            : basePts.map((v, i) => i % 2 === 0 ? v + _psx : v + _psy);
          const d = makePolygonDrawing(shadowPts, true, '#20201a', alpha, null, 0, 0,
            { world: shadowFlags });
          d.sort = sort; d.z = sort;
          newShadows.push(d);
        }

        // Create new shadows with render suppression on all but the last chunk,
        // then update the scene-flag index so the next rebuild uses fast path too.
        const _newShadowDocs = [];
        for (let i = 0; i < newShadows.length; i += CHUNK_SIZE) {
          const isLast = (i + CHUNK_SIZE) >= newShadows.length;
          const _batch = await scene.createEmbeddedDocuments(
            'Drawing', newShadows.slice(i, i + CHUNK_SIZE), { render: isLast }
          );
          if (_batch) _newShadowDocs.push(..._batch);
          await new Promise(r => setTimeout(r, 0));
        }
        // Keep the shadow ID index current so the next call hits the fast path.
        const _newIds = _newShadowDocs.map(d => d.id);
        if (_newIds.length) await scene.setFlag('world', 'cavrilShadowIds', _newIds).catch(() => {});
        console.log(`[CavrilTools] Shadow rebuild: ${newShadows.length} total `
          + `(bldg/tree + walls:${wallShadowStore.length} + polys:${polyShadowStore.length})`);
      } catch (e) { console.warn('[CavrilTools] Shadow rebuild failed:', e.message, e.stack); }
    }
  };

  /**
   * Full season + TOD recolor — updates every terrain/building/road drawing.
   * Call this from macros. TOD is auto-detected from the current world clock.
   *
   * @param {Scene}  scene
   * @param {string} season   sub-season key, e.g. 'EARLY_WINTER', 'MID_SUMMER'
   * @param {string} [tod]    optional override 'DAY'|'DUSK'|'NIGHT'|'DAWN' (default: from clock)
   * @param {number} [hour]   optional override for shadow rebuild (default: from clock)
   */
  window.CavrilTools.applySeason = async function (scene, season, tod, hour) {
    const _d   = _getCalendarDate();
    const _tod = tod  || _getTOD(_d.hour);
    const _hr  = hour != null ? hour : _d.hour;
    const _sea = season || 'MID_SUMMER';

    // 1. Darkness + shadows (shadows use current season for correct ground color)
    await window.CavrilTools.updateTOD(scene, _tod, _hr, _sea);

    // 2. Per-drawing terrain / building / road colors
    const drawingUpdates = [];
    for (const drawing of scene.drawings) {
      const f = drawing.flags?.world || {};
      if (f.cavrilBuilding) {
        const p    = BUILDING_COLORS[f.buildingType] || BUILDING_COLORS.DEFAULT;
        const base = p.DAY;
        drawingUpdates.push({ _id: drawing.id, fillColor: applySeasonBlend(base, f.buildingType, _sea, BUILDING_SEASONAL_BLEND) });

      } else if (f.cavrilTerrain) {
        // Water types: season-specific color tables (never go amber/white — always blue).
        // Two-layer water: bank layer (cavrilWaterBank) gets the bank/shore color;
        // river layer (no bank flag) gets the blue fill color. Both use their respective
        // seasonal values so forks and branches recolor seamlessly.
        if (f.terrainType === 'WATER' || f.terrainType === 'WATERFRONT') {
          if (f.cavrilWaterBank) {
            // Bank stays consistently dirt-colored — no seasonal hue shift on shores
            drawingUpdates.push({ _id: drawing.id, fillColor: '#c0b060', strokeColor: '#c0b060' });
          }
          // River layer: tint is always white so the texture's own color shows through.
          // Seasonal variation on water is a later opt-in; for now the texture carries the look.
          continue;
        }

        // All other terrain
        const p = TERRAIN_COLORS[f.terrainType] || TERRAIN_COLORS.DEFAULT;
        // Always use DAY base colours — scene.darkness handles TOD visuals globally.
        // Baking _tod into per-drawing colours causes stale tints when the clock ticks
        // without a matching applySeason call (e.g. orange terrain at dusk).
        const base = f.farmBaseColor || p.DAY;
        const c = applySeasonBlend(base, f.terrainType, _sea, null);
        // Farm stroke = same as fill (soft perimeter, not a hard outline)
        let sc = c;
        if (FARM_COLOR_VARIANTS[f.terrainType]) {
          sc = c;
        } else if (TERRAIN_STROKE_WIDTH_MAP[f.terrainType]) {
          sc = TERRAIN_STROKE_COLOR_MAP[f.terrainType] || c;
        }
        drawingUpdates.push({ _id: drawing.id, fillColor: c, strokeColor: sc });

      } else if (f.cavrilRoad) {
        const cfg = ROAD_COLORS[f.edgeType];
        if (cfg) drawingUpdates.push({ _id: drawing.id, strokeColor: cfg.DAY });

      } else if (f.cavrilRoadElbow) {
        const cfg = ROAD_COLORS[f.edgeType];
        if (cfg) {
          // Bed elbows (sort:20) store their original color in _bedColor — preserve it.
          // Surface elbows (sort:22) use cfg.DAY like the surface road stroke.
          const targetColor = f._bedElbow ? (f._bedColor || '#7a6e50') : cfg.DAY;
          drawingUpdates.push({ _id: drawing.id, fillColor: targetColor });
        }

      } else if (f.cavrilForestCanopy) {
        // Forest canopy overlay (PNG texture): fade toward winter by scaling fillAlpha.
        // The base drawing was created at 0.72 opacity; seasonal factor thins it out
        // naturally so bare-branch winters show a much lighter canopy density.
        const _fcFactor = {
          EARLY_SPRING: 0.50, MID_SPRING:  0.70, LATE_SPRING:  0.90,
          EARLY_SUMMER: 1.00, MID_SUMMER:  1.00, LATE_SUMMER:  0.95,
          EARLY_AUTUMN: 0.75, MID_AUTUMN:  0.55, LATE_AUTUMN:  0.30,
          EARLY_WINTER: 0.20, MID_WINTER:  0.15, LATE_WINTER:  0.20,
          SPRING: 0.70, SUMMER: 1.00, AUTUMN: 0.55, WINTER: 0.15,
        };
        // Base alpha is 0.92 (set at import time); fall back to that if ever missing
        const baseAlpha = drawing.fillAlpha ?? 1.0;
        const factor    = _fcFactor[_sea] ?? 1.0;
        drawingUpdates.push({ _id: drawing.id, fillAlpha: Math.round(baseAlpha * factor * 1000) / 1000 });

      } else if (f.cavrilCropRow) {
        // Crop rows cycle through the agricultural year — bare furrows in winter/
        // planting season, green growing crops in summer, gold at harvest.
        const _cr = CROP_ROW_SEASONAL[_sea] || CROP_ROW_SEASONAL.SUMMER;
        drawingUpdates.push({ _id: drawing.id, strokeColor: _cr.color, strokeWidth: _cr.width });

      } else if (f.cavrilForestBase) {
        // Update the forest base polygon stroke to the current seasonal grass colour
        // so the grass→forest boundary blends naturally regardless of season.
        const _grassColor = TERRAIN_COLORS.GRASS.DAY || '#8cc453';
        drawingUpdates.push({ _id: drawing.id, strokeColor: _grassColor });
      }
    }
    for (let i = 0; i < drawingUpdates.length; i += 200) {
      await scene.updateEmbeddedDocuments('Drawing', drawingUpdates.slice(i, i + 200));
      await new Promise(r => setTimeout(r, 0));
    }

    // 3a. Regenerate forest canopy texture with seasonal tint and ensure fillColor stays
    //     #ffffff (neutral) so Foundry's pattern-fill colour multiply doesn't darken the art.
    //     In winter, swap to bare-tree assets so the texture matches the individual tile trees.
    // isWinter declared here (before the try block) — using const inside try after this point
    // would be a TDZ ReferenceError since it's also needed in 3b below.
    const isWinter = _sea.includes('WINTER');
    try {
      const _fTint       = CANOPY_TINTS.DAY[_sea] || '#ffffff';
      // Use stored pxPerFt so texture circles match perimeter tree tile scale at import.
      const _fTexGridPx  = scene.grid?.size || 20;
      const _sSeasPxPerFt = scene.flags?.world?.cavrilPxPerFt || null;
      const _fTexURL  = await generateForestTexture(0x4f726573, _fTint, isWinter, _fTexGridPx, _sSeasPxPerFt);
      const _fTexPath = `worlds/${game.world?.id || 'world'}/cavril-gen/forest-canopy.png`;
      await _uploadTex(_fTexURL, _fTexPath);

      // Update the texture src only — dot notation avoids Foundry V12's broken
      // object-form Drawing.update() path that can silently drop custom scaleX/Y.
      // Circle size was baked into the PNG at import time; just swap the seasonal file.
      const _canopyUpdates = scene.drawings
        .filter(d => d.flags?.world?.cavrilForestCanopy)
        .map(d => ({ _id: d.id,
          'texture.src': _fTexPath,
          fillColor: '#ffffff' }));
      for (let i = 0; i < _canopyUpdates.length; i += 200)
        await scene.updateEmbeddedDocuments('Drawing', _canopyUpdates.slice(i, i + 200));
    } catch (_fTexErr) {
      console.warn('[CavrilImport] applySeason: forest texture regeneration failed', _fTexErr.message);
    }

    // 3b. Tree canopy tint + winter bare swap
    const tint = CANOPY_TINTS.DAY[_sea] || '#ffffff';
    // Forest trees blend the standard season tint with their base green so they
    // always read darker/greener than open-field canopies.
    // In summer (tint = #ffffff) the forest green '#c8e078' shows through cleanly.
    // In autumn (tint = amber) blending partially warms the forest edge.
    const FOREST_BASE_TINT = '#c8e078';
    const tileUpdates = [];
    for (const tile of scene.tiles) {
      const f = tile.flags?.world || {};
      if (!f.cavrilTree) continue;
      let src;
      if (isWinter) {
        const barePool = TREE_CANOPY.bare[f.treeSize] || TREE_CANOPY.bare.small;
        src = barePool[0];
      } else {
        src = f.originalSrc || tile.texture?.src;
      }
      tileUpdates.push({ _id: tile.id, texture: { src, tint } });
    }
    for (let i = 0; i < tileUpdates.length; i += 200) {
      await scene.updateEmbeddedDocuments('Tile', tileUpdates.slice(i, i + 200));
      await new Promise(r => setTimeout(r, 0));
    }

    console.log(`[CavrilTools] Season applied: ${_sea} / ${_tod} — ${drawingUpdates.length} drawings, ${tileUpdates.length} canopies`);
  };

  // Keep updateSceneColors as alias for backwards-compat (macros may call it)
  window.CavrilTools.updateSceneColors = function (scene, tod, sea, hour) {
    return window.CavrilTools.applySeason(scene, sea, tod, hour);
  };

  // ── canvasReady: clean up legacy TOD overlay objects ────────────────────────────
  // History:
  //   v1 — data-URL Tile (flag: cavrilOverlay)         ← delete always
  //   v2 — Drawing (flag: cavrilTODOverlay)            ← delete always (no V12 elevation)
  //   v3 — overhead Tile (flag: cavrilTODOverlay)      ← delete always (system removed)
  Hooks.on('canvasReady', () => {
    try {
      const scene = canvas?.scene;
      if (!scene) return;

      // v2 migration: Drawing TOD overlays exist on ANY scene (no cavrilImport flag required).
      // DrawingDocument has no working elevation field in V12 — delete unconditionally so the
      // next applySeason call creates the replacement overhead Tile at elevation:9999.
      const ovDrawings = scene.drawings.filter(d => d.flags?.world?.cavrilTODOverlay);
      if (ovDrawings.length) {
        scene.deleteEmbeddedDocuments('Drawing', ovDrawings.map(d => d.id))
          .then(() => console.log(`[CavrilTools] Removed ${ovDrawings.length} legacy TOD Drawing overlay(s)`))
          .catch(() => {});
      }

      // The remaining cleanup only matters on Cavril-imported scenes.
      if (!scene.getFlag?.('world', 'cavrilImport')) return;

      // v1: legacy data-URL tiles (cavrilOverlay flag).
      const ovTilesLegacy = scene.tiles.filter(t => t.flags?.world?.cavrilOverlay);
      if (ovTilesLegacy.length) {
        scene.deleteEmbeddedDocuments('Tile', ovTilesLegacy.map(t => t.id))
          .then(() => console.log(`[CavrilTools] Removed ${ovTilesLegacy.length} legacy overlay tile(s)`))
          .catch(() => {});
      }

      // v3: TOD overlay Tiles are no longer used — delete all of them.
      // TOD atmosphere is handled entirely by scene.darkness; the per-tile overlay
      // was removed because it caused partial-coverage (quadrant) coloration artifacts.
      const ovTilesTOD = scene.tiles.filter(t => t.flags?.world?.cavrilTODOverlay);
      if (ovTilesTOD.length) {
        scene.deleteEmbeddedDocuments('Tile', ovTilesTOD.map(t => t.id))
          .then(() => console.log(`[CavrilTools] Removed ${ovTilesTOD.length} legacy TOD overlay Tile(s)`))
          .catch(() => {});
      }
    } catch (_) {}
  });

  // Lightweight auto-update on clock tick: only darkness, overlay, and shadows.
  // Full seasonal recolor is done manually via CavrilTools.applySeason() macros.
  let _colorUpdateTimer = null;
  let _lastShadowHour   = -1;
  Hooks.on('updateWorldTime', () => {
    clearTimeout(_colorUpdateTimer);
    _colorUpdateTimer = setTimeout(() => {
      try {
        const scene = game.scenes?.active;
        if (!scene?.getFlag?.('world', 'cavrilImport')) return;
        const d   = _getCalendarDate();
        const tod = _getTOD(d.hour);
        const sea = _getSubSeason(d.month);
        const hrBucket = Math.floor(d.hour);
        // Guard: if the calendar returned an invalid hour (NaN, Infinity, or out of
        // range), skip the rebuild entirely. Without this guard, NaN !== anything is
        // always true, causing every worldTime tick to trigger a shadow rebuild and
        // stacking duplicate shadows — the symptom the user sees with custom calendars.
        if (!Number.isFinite(hrBucket) || hrBucket < 0) {
          console.warn('[CavrilTools] updateWorldTime: invalid hour from calendar (' + d.hour + '). ' +
            'Skipping shadow rebuild this tick. Run CavrilTools.debugCalendar() to diagnose.');
          // Still update ambient lighting/darkness (cheap, no geometry) even without a valid hour.
          window.CavrilTools.updateTOD(scene, tod, null, sea, false)
            .catch(e => console.warn('[CavrilTools] TOD update failed:', e.message));
          return;
        }
        // Rebuild shadows whenever we cross into a new integer hour — forward OR backward.
        // No day/night gate: getShadowVec handles the full 360° rotation (moon at night).
        const rebuildShadows = hrBucket !== _lastShadowHour;
        window.CavrilTools.updateTOD(scene, tod, rebuildShadows ? d.hour : null, sea, false)
          .catch(e => console.warn('[CavrilTools] TOD update failed:', e.message));
        if (rebuildShadows) _lastShadowHour = hrBucket;
      } catch (e) {
        console.warn('[CavrilTools] updateWorldTime hook error:', e.message);
      }
    }, 800);
  });

  // Terrain fills have no stroke — only building drawings get outlines.
  // Riverbank and coastal shore strokes.
  // WATER (rivers/lakes) → muddy olive-stone fringe matching the new water hue.
  // WATERFRONT (coastal) → sandy beach fringe.
  // Both must be in these maps so updateSceneColors never overwrites with the blue fill.
  const TERRAIN_STROKE_WIDTH_MAP = { WATER: 14, WATERFRONT: 12 };
  const TERRAIN_STROKE_COLOR_MAP = { WATER: '#c0b060', WATERFRONT: '#c0b060' };

  /**
   * Convenience helper — derive timeOfDay and sub-season from hour + month, then recolor.
   * @param {Scene}  scene
   * @param {number} hour   0–23
   * @param {number} month  1–12
   */
  window.CavrilTools.applyTimeAndSeason = function (scene, hour, month) {
    return window.CavrilTools.updateSceneColors(scene, _getTOD(hour), _getSubSeason(month));
  };

  /**
   * Read current Foundry world time (+ Simple Calendar if present), then recolor.
   * @param {Scene} scene
   */
  window.CavrilTools.applyCurrentDateTime = function (scene) {
    const d = _getCalendarDate();
    return window.CavrilTools.updateSceneColors(scene, _getTOD(d.hour), _getSubSeason(d.month));
  };

  /**
   * SEASONAL MACROS — paste one of these into a Foundry macro (Type: Script).
   * Time-of-day is read automatically from the world clock; no TOD arg needed.
   *
   *   CavrilTools.applySeason(game.scenes.active, 'EARLY_SPRING')
   *   CavrilTools.applySeason(game.scenes.active, 'MID_SPRING')
   *   CavrilTools.applySeason(game.scenes.active, 'LATE_SPRING')
   *   CavrilTools.applySeason(game.scenes.active, 'EARLY_SUMMER')
   *   CavrilTools.applySeason(game.scenes.active, 'MID_SUMMER')
   *   CavrilTools.applySeason(game.scenes.active, 'LATE_SUMMER')
   *   CavrilTools.applySeason(game.scenes.active, 'EARLY_AUTUMN')
   *   CavrilTools.applySeason(game.scenes.active, 'MID_AUTUMN')
   *   CavrilTools.applySeason(game.scenes.active, 'LATE_AUTUMN')
   *   CavrilTools.applySeason(game.scenes.active, 'EARLY_WINTER')
   *   CavrilTools.applySeason(game.scenes.active, 'MID_WINTER')
   *   CavrilTools.applySeason(game.scenes.active, 'LATE_WINTER')
   */

  /**
   * Return all packed building data from a scene's flags.
   * @param {Scene} scene
   * @returns {Array<{id,name,type,cx,cy,polyPx,openHour,closeHour,material,height}>}
   */
  window.CavrilTools.getSceneBuildingData = function (scene) {
    const n   = scene.getFlag('world', 'buildingChunkCount') || 0;
    const out = [];
    for (let i = 0; i < n; i++) {
      const chunk = scene.getFlag('world', `buildingsChunk${i}`) || [];
      out.push(...chunk);
    }
    return out;
  };

  /**
   * Return the road graph stored in a scene's flags.
   * @param {Scene} scene
   * @returns {{ nodes: number[], edges: number[], navTypes: string[] } | null}
   */
  window.CavrilTools.getSceneRoadGraph = function (scene) {
    return scene.getFlag('world', 'roadGraph') || null;
  };

  // Read the configured asset base path once settings are available, then rebuild
  // tree canopy + trunk paths. This is the mechanism that lets Forge users point
  // to their Forge asset library folder instead of the bundled module path.
  Hooks.once('ready', () => {
    try {
      const configured = game.settings.get('cavril-cityhud', 'assetBase');
      if (configured && configured !== ASSET_BASE) {
        ASSET_BASE = configured;
        const rebuilt = _buildTreeAssets(ASSET_BASE);
        TREE_CANOPY       = rebuilt.canopy;
        TREE_TRUNK_ASSETS = rebuilt.trunk;
        console.log('[CavrilImport] Asset base overridden by module setting:', ASSET_BASE);
      }
    } catch (_) {}
  });

  // Live-update tree asset paths when the setting is changed mid-session
  // (no reload needed — next import picks up the new path immediately).
  Hooks.on('updateSetting', setting => {
    if (setting.key === 'cavril-cityhud.assetBase') {
      ASSET_BASE = setting.value || 'modules/cavril-cityhud/Assets';
      const rebuilt = _buildTreeAssets(ASSET_BASE);
      TREE_CANOPY       = rebuilt.canopy;
      TREE_TRUNK_ASSETS = rebuilt.trunk;
    }
  });

  console.log('[CavrilImport] v2 loaded — call window.CavrilTools.importCity() to begin');

})();
