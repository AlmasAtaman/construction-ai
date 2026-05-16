/**
 * Label-anchored geodesic Voronoi room recovery.
 *
 * Problem: planar-graph face enumeration fails when walls have any
 * non-door break (column, archway, casework return). Rooms merge into
 * a "wraparound" face that swallows multiple GT rooms.
 *
 * Approach: forget closed faces. Use the room LABELS as seeds and do a
 * multi-source BFS through walkable space, with WALLS as barriers.
 * Each grid cell is assigned to the geodesically-nearest label. The
 * cells assigned to label L form room L's polygon.
 *
 * Properties:
 *   - Each label gets its OWN region. Wraparound is impossible.
 *   - Wall breaks (doors, archways, openings) don't merge rooms — when
 *     the BFS wavefronts meet inside a gap, they STOP each other.
 *   - Tiny rooms with one label, big corridors with one label all work
 *     because the label position is what defines ownership.
 *
 * Complexity: O(W × H) on grid cells; ~1 M cells = 10-50 ms in JS.
 *
 * Coordinate system: PDF user space (Y up, origin bottom-left).
 */

export interface ExpandSegment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface DoorBarrier {
  /** Center of the door symbol in PDF page space. */
  x: number;
  y: number;
  /** Door size (panel/arc extent) in PDF points. */
  size: number;
}

export interface ExpandLabel {
  /** Stable identifier so the caller can correlate the output. */
  id: string;
  /** Position in PDF page space. */
  x: number;
  y: number;
}

export interface ExpandedRoom {
  labelId: string;
  /** Bounding box in PDF page space. */
  bbox: { x: number; y: number; width: number; height: number };
  /** Approximate polygon (axis-aligned silhouette via marching squares). */
  polygon: { x: number; y: number }[];
  /** Area in PDF points². Multiply by (scale_pt_per_ft)⁻² to get sqft. */
  areaPt: number;
  /** Number of grid cells assigned to this label. */
  cellCount: number;
}

export interface ExpandOptions {
  /** Grid cell size in PDF points. Default 4 pt (~0.5 inch on a 1/8":1' plan). */
  cellSize?: number;
  /**
   * Minimum cell count for a room to be returned. Drops tiny regions
   * around stray labels inside walls. Default 25 cells (~1 sqft).
   */
  minCells?: number;
  /**
   * Thicken walls in the rasterization step to compensate for sub-pixel
   * gaps. Default 1 — every wall is at least 1 cell thick.
   */
  wallThickness?: number;
  /**
   * Door candidate positions. For each candidate, the algorithm paints
   * a small barrier (cross of size×size pt) into the wall raster. This
   * closes the wall gap at door openings so room-expansion BFS can't
   * escape through doors into adjacent rooms.
   */
  doorBarriers?: DoorBarrier[];
  /**
   * Maximum BFS distance from a seed, in PDF points. Caps how far a
   * single room can expand. Default 300 pt (~33 ft at 1/8":1' scale —
   * a generous cap that covers all but the longest corridors).
   * Long corridors should have multiple label seeds (e.g., "CORRIDOR
   * 105" + "EXIT" + "STAIR A") which keep their wavefronts confined.
   */
  maxRoomRadius?: number;
}

const DEFAULT_CELL = 4;
const DEFAULT_MIN_CELLS = 25;
const DEFAULT_WALL_THICKNESS = 1;
const DEFAULT_MAX_RADIUS = 600;

/**
 * Main entry point: take walls + labels, return one polygon per label.
 */
export function expandRoomsFromLabels(
  walls: ExpandSegment[],
  labels: ExpandLabel[],
  pageWidthPt: number,
  pageHeightPt: number,
  opts: ExpandOptions = {},
): ExpandedRoom[] {
  const cell = opts.cellSize ?? DEFAULT_CELL;
  const minCells = opts.minCells ?? DEFAULT_MIN_CELLS;
  const wallThickness = opts.wallThickness ?? DEFAULT_WALL_THICKNESS;
  const maxRadiusCells = Math.ceil(
    (opts.maxRoomRadius ?? DEFAULT_MAX_RADIUS) / (opts.cellSize ?? DEFAULT_CELL),
  );

  const W = Math.ceil(pageWidthPt / cell) + 2;
  const H = Math.ceil(pageHeightPt / cell) + 2;
  const totalCells = W * H;

  // 1. Rasterize walls.
  const blocked = new Uint8Array(totalCells);
  for (const w of walls) {
    rasterizeLine(
      w.x1 / cell,
      w.y1 / cell,
      w.x2 / cell,
      w.y2 / cell,
      W,
      H,
      blocked,
      wallThickness,
    );
  }

  // 1b. Paint door barriers. Each door candidate produces an axis-
  // aligned "+" cross of length `size` centered at the candidate. The
  // cross fills the door opening regardless of orientation — the wall
  // along one axis closes the gap, the other axis is harmless if no
  // wall is there.
  if (opts.doorBarriers) {
    let painted = 0;
    for (const d of opts.doorBarriers) {
      const reach = d.size / cell;
      const cx = d.x / cell;
      const cy = d.y / cell;
      // Paint a FILLED SQUARE of size d.size × d.size centered at the
      // door candidate. The candidate sits inside the door's swing path
      // (the half-circle the door panel sweeps through). Filling that
      // path with walls guarantees the wall opening on the wall side of
      // the candidate is plugged regardless of orientation.
      const r = Math.ceil(reach);
      for (let dy = -r; dy <= r; dy++) {
        const yy = Math.round(cy + dy);
        if (yy < 0 || yy >= H) continue;
        const row = yy * W;
        for (let dx = -r; dx <= r; dx++) {
          const xx = Math.round(cx + dx);
          if (xx < 0 || xx >= W) continue;
          if (!blocked[row + xx]) {
            blocked[row + xx] = 1;
            painted++;
          }
        }
      }
    }
    // eslint-disable-next-line no-console
    if (process.env.ROOM_EXPAND_DEBUG)
      console.log(`[room-expand] door barriers painted ${painted} new cells`);
  }

  // 2. Plant seeds at label positions.
  // Use Int16Array for assignment (supports up to 32767 labels — plenty).
  const assignment = new Int16Array(totalCells).fill(-1);
  // Track BFS step count per cell so we can cap room radius.
  const distance = new Int32Array(totalCells).fill(-1);
  const queue: number[] = [];
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    let cx = Math.floor(l.x / cell);
    let cy = Math.floor(l.y / cell);
    if (cx < 0) cx = 0;
    if (cy < 0) cy = 0;
    if (cx >= W) cx = W - 1;
    if (cy >= H) cy = H - 1;
    const seed = findUnblocked(cx, cy, W, H, blocked);
    if (seed < 0) continue;
    if (assignment[seed] >= 0) continue;
    assignment[seed] = i;
    distance[seed] = 0;
    queue.push(seed);
  }

  // 3. Multi-source BFS through unblocked cells, capped at maxRadiusCells.
  for (let head = 0; head < queue.length; head++) {
    const idx = queue[head];
    const x = idx % W;
    const y = (idx - x) / W;
    const li = assignment[idx];
    const d = distance[idx];
    if (d >= maxRadiusCells) continue;
    const nd = d + 1;
    if (x > 0) {
      const ni = idx - 1;
      if (!blocked[ni] && assignment[ni] < 0) {
        assignment[ni] = li;
        distance[ni] = nd;
        queue.push(ni);
      }
    }
    if (x < W - 1) {
      const ni = idx + 1;
      if (!blocked[ni] && assignment[ni] < 0) {
        assignment[ni] = li;
        distance[ni] = nd;
        queue.push(ni);
      }
    }
    if (y > 0) {
      const ni = idx - W;
      if (!blocked[ni] && assignment[ni] < 0) {
        assignment[ni] = li;
        distance[ni] = nd;
        queue.push(ni);
      }
    }
    if (y < H - 1) {
      const ni = idx + W;
      if (!blocked[ni] && assignment[ni] < 0) {
        assignment[ni] = li;
        distance[ni] = nd;
        queue.push(ni);
      }
    }
  }

  // 4. Collect cells per label.
  const cellsByLabel = new Map<number, number[]>();
  for (let i = 0; i < totalCells; i++) {
    const li = assignment[i];
    if (li < 0) continue;
    let list = cellsByLabel.get(li);
    if (!list) {
      list = [];
      cellsByLabel.set(li, list);
    }
    list.push(i);
  }

  // 5. Build per-label result with bbox + polygon outline.
  const cellArea = cell * cell;
  const out: ExpandedRoom[] = [];
  for (const [labelIdx, cells] of cellsByLabel) {
    if (cells.length < minCells) continue;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const idx of cells) {
      const x = idx % W;
      const y = (idx - x) / W;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    const bboxX = minX * cell;
    const bboxY = minY * cell;
    const bboxW = (maxX - minX + 1) * cell;
    const bboxH = (maxY - minY + 1) * cell;
    // Polygon: extract boundary via marching squares on the assignment
    // mask. For now, return the bbox as a 4-vertex polygon (good enough
    // for area + UI overlay). Marching squares is an optional refinement.
    const polygon = [
      { x: bboxX, y: bboxY },
      { x: bboxX + bboxW, y: bboxY },
      { x: bboxX + bboxW, y: bboxY + bboxH },
      { x: bboxX, y: bboxY + bboxH },
    ];
    out.push({
      labelId: labels[labelIdx].id,
      bbox: { x: bboxX, y: bboxY, width: bboxW, height: bboxH },
      polygon,
      areaPt: cells.length * cellArea,
      cellCount: cells.length,
    });
  }

  // Sort by area DESC for predictability.
  out.sort((a, b) => b.areaPt - a.areaPt);
  return out;
}

// ── Rasterization ─────────────────────────────────────────────────────────

/**
 * Bresenham line drawing onto the blocked grid, with optional thickening.
 * x0/y0/x1/y1 are in CELL coords (not PDF pt).
 */
function rasterizeLine(
  x0f: number,
  y0f: number,
  x1f: number,
  y1f: number,
  W: number,
  H: number,
  blocked: Uint8Array,
  thickness: number,
): void {
  let x0 = Math.round(x0f);
  let y0 = Math.round(y0f);
  const x1 = Math.round(x1f);
  const y1 = Math.round(y1f);
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    paintBlock(x0, y0, W, H, blocked, thickness);
    if (x0 === x1 && y0 === y1) break;
    const e2 = err * 2;
    if (e2 > -dy) {
      err -= dy;
      x0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      y0 += sy;
    }
  }
}

function paintBlock(
  x: number,
  y: number,
  W: number,
  H: number,
  blocked: Uint8Array,
  thickness: number,
): void {
  const r = Math.max(0, thickness - 1);
  for (let dy = -r; dy <= r; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= H) continue;
    const row = yy * W;
    for (let dx = -r; dx <= r; dx++) {
      const xx = x + dx;
      if (xx < 0 || xx >= W) continue;
      blocked[row + xx] = 1;
    }
  }
}

/**
 * If the seed cell is blocked (label was drawn on or near a wall), nudge
 * outward in a spiral up to ~4 cells until we find an unblocked cell.
 * Returns the flat index or -1 if we can't escape.
 */
function findUnblocked(
  cx: number,
  cy: number,
  W: number,
  H: number,
  blocked: Uint8Array,
): number {
  const idx = cy * W + cx;
  if (!blocked[idx]) return idx;
  for (let r = 1; r <= 5; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || nx >= W || ny < 0 || ny >= H) continue;
        const ni = ny * W + nx;
        if (!blocked[ni]) return ni;
      }
    }
  }
  return -1;
}
