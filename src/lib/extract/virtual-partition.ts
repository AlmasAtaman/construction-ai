/**
 * Virtual-wall partitioning for open-plan rooms.
 *
 * Deterministic geometry-only fallback that runs ONLY when the main
 * planar-graph extraction couldn't enclose a labelled room. The
 * approach is borrowed from the GraFloor technique: when there are no
 * physical walls between rooms (open kitchen-living-dining layouts),
 * compute virtual partition lines from the room-label positions and
 * the partial wall geometry that does exist.
 *
 * Algorithm sketch:
 *
 *   1. Compute each failed label's "open extent" — a generous bbox
 *      reached by ray-casting against LONG walls only (≥ 4-5 ft).
 *      Short walls (furniture, half-walls, counters) are ignored.
 *
 *   2. Group failed labels that share an open zone (label A inside
 *      B's extent and vice versa) via union-find.
 *
 *   3. For each group, gather peer labels in the zone — both other
 *      failed labels and already-claimed neighbours. The zone is the
 *      union of every member's extent, clipped to the floor-plan
 *      outer envelope.
 *
 *   4. Partition the zone among all peers using axis-aligned
 *      guillotine cuts. Cuts are placed midway between adjacent
 *      label centroids, then snapped to nearby real wall segments
 *      (within 24 pt) when one exists collinear with the cut. A
 *      scoring function rewards cuts that snap to walls and that
 *      separate labels cleanly, penalising cuts that pass too close
 *      to a centroid.
 *
 *   5. Each member's sub-rectangle is the candidate polygon. An
 *      accept check enforces:
 *        - area ≥ per-room-type minimum
 *        - aspect ratio < 5
 *        - printed dimension callouts near the label, if any, must
 *          agree with the partition dims within ±20 % per axis.
 *          When they disagree, prefer the architect's callouts.
 *
 *   6. Output an action list:
 *        - `emit-failed`     replace a `geometry-uncertain` room with
 *                            the new partition polygon
 *        - `replace-claimed` replace an already-claimed room whose old
 *                            bbox disagrees with the partition by
 *                            > 25 % in area (a "suspect peer" whose
 *                            measurement contradicts the partition)
 *        - `skip`            partition couldn't produce a confident
 *                            result — keep the existing
 *                            geometry-uncertain entry
 *
 * Output polygons feed the same downstream path (measurement,
 * overlay, queue, dialog) as any other extracted room. They carry
 * derivation = "virtual-partition" so the estimator can tell a
 * computed boundary from a traced one.
 */

import type { DimensionCallout } from "../dimension-callouts";

export interface Wall {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface BboxPt {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LabelInput {
  id: string;
  text: string;
  cxPt: number;
  cyPt: number;
}

export interface FailedLabel extends LabelInput {
  /** Index into the caller's rooms array — where to write the result. */
  roomsIndex: number;
}

export interface ClaimedPeer extends LabelInput {
  bboxPt: BboxPt;
  areaSqft: number | null;
  /** Index into the caller's rooms array — where to write the result. */
  roomsIndex: number;
}

export interface VirtualPartitionResult {
  /** Index into the caller's rooms array. */
  roomsIndex: number;
  label: string;
  /** Sub-rectangle owned by this label, in PDF user-space (y-up). */
  bboxPt: BboxPt;
  widthFt: number;
  heightFt: number;
  areaSqft: number;
  perimeterFt: number;
  measurementWarning: string;
  /** True when this was originally an "ok" claimed peer that the
   *  partition is now overriding because its old bbox disagreed. */
  replacedClaimed: boolean;
}

export interface VirtualPartitionInput {
  failed: FailedLabel[];
  claimed: ClaimedPeer[];
  walls: Wall[];
  callouts: DimensionCallout[];
  ptPerFt: number;
  pageWidthPt: number;
  pageHeightPt: number;
  segmentBboxPt: { x0: number; y0: number; x1: number; y1: number } | null;
  /** Per-label-type minimum plausible area. Same as page-extract's. */
  minPlausibleSqft: (label: string) => number;
}

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

// Only walls at least this long (in PDF pt) count when defining an
// open extent. At a typical residential scale of 13.5 pt/ft this is
// ~4.4 ft — long enough to exclude furniture edges and partition
// stubs, short enough to catch a 5-ft section of exterior wall.
const STRICT_MIN_WALL_PT = 60;
// Min clearance from label bbox to a candidate "real wall" — keeps
// the ray-cast from snapping to a wall painted right behind the
// label text.
const STRICT_CLEARANCE_PT = 8;
// Walls within this distance of a candidate guillotine cut are
// candidates for the cut to snap to. ~1.8 ft at 13.5 pt/ft.
const WALL_SNAP_TOLERANCE_PT = 24;
// Cuts within this many pt of either side of the zone wall are
// rejected — degenerate sub-region.
const MIN_CUT_MARGIN_PT = 10;
// A bbox extent below this side length is treated as "ray-cast
// failed" and the fallback zone is used.
const MIN_EXTENT_SIDE_PT = 60;

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export function virtualPartition(
  input: VirtualPartitionInput,
): VirtualPartitionResult[] {
  if (input.failed.length === 0) return [];
  if (input.ptPerFt <= 0) return [];

  // 1. Compute each failed label's open extent. Labels whose extent
  // can't be reliably bounded (no long walls on one axis, extreme
  // aspect) are excluded — they stay geometry-uncertain.
  const extentByFailed = new Map<string, BboxPt>();
  for (const f of input.failed) {
    const ext = computeOpenExtent(
      f,
      input.walls,
      input.pageWidthPt,
      input.pageHeightPt,
      input.segmentBboxPt,
    );
    if (ext) extentByFailed.set(f.id, ext);
  }
  if (extentByFailed.size === 0) return [];
  const failedWithExtent = input.failed.filter((f) => extentByFailed.has(f.id));

  // 2. Group failed labels by shared zone (union-find).
  const parent: Record<string, string> = {};
  for (const f of failedWithExtent) parent[f.id] = f.id;
  function find(a: string): string {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  }
  function union(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  }
  for (let i = 0; i < failedWithExtent.length; i++) {
    const fi = failedWithExtent[i];
    const ei = extentByFailed.get(fi.id)!;
    for (let j = i + 1; j < failedWithExtent.length; j++) {
      const fj = failedWithExtent[j];
      const ej = extentByFailed.get(fj.id)!;
      if (
        pointInBbox({ x: fj.cxPt, y: fj.cyPt }, ei) ||
        pointInBbox({ x: fi.cxPt, y: fi.cyPt }, ej)
      ) {
        union(fi.id, fj.id);
      }
    }
  }
  const groupsByRoot = new Map<string, FailedLabel[]>();
  for (const f of failedWithExtent) {
    const r = find(f.id);
    const arr = groupsByRoot.get(r) ?? [];
    arr.push(f);
    groupsByRoot.set(r, arr);
  }

  const results: VirtualPartitionResult[] = [];

  // 3-6. For each group: zone, peers, partition, accept-check.
  for (const groupFailed of groupsByRoot.values()) {
    // Group zone = union of all member extents.
    let zone = extentByFailed.get(groupFailed[0].id)!;
    for (let i = 1; i < groupFailed.length; i++) {
      zone = unionBbox(zone, extentByFailed.get(groupFailed[i].id)!);
    }
    // Clip to floor-plan envelope.
    if (input.segmentBboxPt) {
      zone = clipBbox(zone, input.segmentBboxPt);
    }
    // Sanity: zone must be at least a small room (40 pt × 40 pt).
    if (zone.width < 40 || zone.height < 40) continue;

    // Claimed peers inside this zone — candidates for the suspect-peer
    // re-emit. Anything whose centroid is inside the zone.
    const claimedInZone = input.claimed.filter((c) =>
      pointInBbox({ x: c.cxPt, y: c.cyPt }, zone),
    );

    // All partition members: failed + claimed inside the zone.
    const members: Array<{
      id: string;
      kind: "failed" | "claimed";
      label: string;
      cxPt: number;
      cyPt: number;
      claimed?: ClaimedPeer;
      failed?: FailedLabel;
    }> = [
      ...groupFailed.map((f) => ({
        id: f.id,
        kind: "failed" as const,
        label: f.text,
        cxPt: f.cxPt,
        cyPt: f.cyPt,
        failed: f,
      })),
      ...claimedInZone.map((c) => ({
        id: c.id,
        kind: "claimed" as const,
        label: c.text,
        cxPt: c.cxPt,
        cyPt: c.cyPt,
        claimed: c,
      })),
    ];

    // Group-size cap: partitioning > 4 members in one zone produces
    // thin strips (each member gets ~1/N of the zone). At that point
    // we're guessing, not estimating. Skip — failed labels stay
    // geometry-uncertain.
    if (members.length > 4) continue;

    // Partition the zone among all members.
    const subRects = partitionZone(zone, members, input.walls);

    // 5-6. Accept-check + emit results.
    for (const m of members) {
      const rect = subRects.get(m.id);
      if (!rect) continue;
      const check = acceptPartition(
        m.label,
        rect,
        input.ptPerFt,
        input.callouts,
        { x: m.cxPt, y: m.cyPt },
        input.minPlausibleSqft,
      );
      if (!check.ok) continue;

      if (m.kind === "failed") {
        results.push({
          roomsIndex: m.failed!.roomsIndex,
          label: m.label,
          bboxPt: rect,
          widthFt: check.widthFt,
          heightFt: check.heightFt,
          areaSqft: round1(check.widthFt * check.heightFt),
          perimeterFt: round1(2 * (check.widthFt + check.heightFt)),
          measurementWarning:
            check.calloutOverride ??
            `Estimated boundary — this room has no fully enclosing walls. The polygon was computed by partitioning the open zone between nearby labels (${check.widthFt}'×${check.heightFt}'). Review before bidding.`,
          replacedClaimed: false,
        });
      } else {
        // Claimed peer: only override when the partition disagrees
        // with the existing bbox by > 25 % in area. A claimed peer
        // whose old measurement matches the partition is genuinely
        // correct — leave it alone per the brief.
        const peer = m.claimed!;
        const oldArea = peer.areaSqft ?? bboxAreaSqft(peer.bboxPt, input.ptPerFt);
        const newArea = check.widthFt * check.heightFt;
        const diff = oldArea > 0 ? Math.abs(newArea - oldArea) / oldArea : 1;
        if (diff <= 0.25) continue; // peer was correct enough; don't touch
        results.push({
          roomsIndex: peer.roomsIndex,
          label: m.label,
          bboxPt: rect,
          widthFt: check.widthFt,
          heightFt: check.heightFt,
          areaSqft: round1(newArea),
          perimeterFt: round1(2 * (check.widthFt + check.heightFt)),
          measurementWarning:
            check.calloutOverride ??
            `Previous bbox (${round1(oldArea)} sqft) contradicted the open-zone partition. ` +
              `Re-measured by virtual partitioning to ${check.widthFt}'×${check.heightFt}' (${round1(newArea)} sqft). Review before bidding.`,
          replacedClaimed: true,
        });
      }
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Open-extent ray-cast
// ---------------------------------------------------------------------------

function computeOpenExtent(
  label: LabelInput,
  walls: Wall[],
  pageWidthPt: number,
  pageHeightPt: number,
  segBbox: { x0: number; y0: number; x1: number; y1: number } | null,
): BboxPt | null {
  const cx = label.cxPt;
  const cy = label.cyPt;
  // Ray-cast against LONG walls only. Furniture / counters / partition
  // stubs (< 60 pt) are deliberately ignored so the rays escape past
  // them to the next real architectural wall.
  let topY = pageHeightPt;
  let bottomY = 0;
  let leftX = 0;
  let rightX = pageWidthPt;
  let hits = 0;
  for (const w of walls) {
    const isH = Math.abs(w.y1 - w.y2) < 1.5;
    const isV = Math.abs(w.x1 - w.x2) < 1.5;
    if (isH) {
      const wx0 = Math.min(w.x1, w.x2);
      const wx1 = Math.max(w.x1, w.x2);
      if (wx1 - wx0 < STRICT_MIN_WALL_PT) continue;
      if (cx < wx0 || cx > wx1) continue;
      const wy = w.y1;
      if (wy > cy + STRICT_CLEARANCE_PT && wy < topY) {
        topY = wy;
        hits++;
      } else if (wy < cy - STRICT_CLEARANCE_PT && wy > bottomY) {
        bottomY = wy;
        hits++;
      }
    } else if (isV) {
      const wy0 = Math.min(w.y1, w.y2);
      const wy1 = Math.max(w.y1, w.y2);
      if (wy1 - wy0 < STRICT_MIN_WALL_PT) continue;
      if (cy < wy0 || cy > wy1) continue;
      const wx = w.x1;
      if (wx > cx + STRICT_CLEARANCE_PT && wx < rightX) {
        rightX = wx;
        hits++;
      } else if (wx < cx - STRICT_CLEARANCE_PT && wx > leftX) {
        leftX = wx;
        hits++;
      }
    }
  }

  let ext: BboxPt = {
    x: leftX,
    y: bottomY,
    width: rightX - leftX,
    height: topY - bottomY,
  };

  // No fallback. If the strict ray-cast couldn't bound the label in
  // at least one direction per axis, or yielded a skinny/tiny extent,
  // refuse to invent a zone — return null and let the label stay
  // geometry-uncertain. A label-centred bbox of arbitrary size grows
  // into adjacent rooms on open-plan condos and produces partitions
  // that look real but aren't (LOFT page 4: 40×40 ft FOYERs etc.).
  const aspect =
    ext.width > 0 && ext.height > 0
      ? Math.max(ext.width, ext.height) / Math.min(ext.width, ext.height)
      : 99;
  if (
    hits < 2 ||
    ext.width < MIN_EXTENT_SIDE_PT ||
    ext.height < MIN_EXTENT_SIDE_PT ||
    aspect > 5
  ) {
    return null;
  }

  if (segBbox) ext = clipBbox(ext, segBbox);
  return ext;
}

// ---------------------------------------------------------------------------
// Guillotine partitioning
// ---------------------------------------------------------------------------

interface PartitionMember {
  id: string;
  cxPt: number;
  cyPt: number;
}

function partitionZone(
  zone: BboxPt,
  members: PartitionMember[],
  walls: Wall[],
): Map<string, BboxPt> {
  const out = new Map<string, BboxPt>();
  partitionRec(zone, members, walls, out);
  return out;
}

function partitionRec(
  zone: BboxPt,
  members: PartitionMember[],
  walls: Wall[],
  out: Map<string, BboxPt>,
): void {
  if (members.length === 0) return;
  if (members.length === 1) {
    out.set(members[0].id, zone);
    return;
  }

  type Cut = {
    axis: "v" | "h";
    at: number;
    leftIds: string[];
    rightIds: string[];
    snapped: boolean;
  };
  let bestCut: Cut | null = null;
  let bestScore = Infinity;

  const tryCut = (axis: "v" | "h"): void => {
    const sorted = [...members].sort((a, b) =>
      axis === "v" ? a.cxPt - b.cxPt : a.cyPt - b.cyPt,
    );
    for (let i = 1; i < sorted.length; i++) {
      const cA = axis === "v" ? sorted[i - 1].cxPt : sorted[i - 1].cyPt;
      const cB = axis === "v" ? sorted[i].cxPt : sorted[i].cyPt;
      if (cB - cA < 20) continue;
      const midAt = (cA + cB) / 2;
      // Adaptive snap tolerance: gap/3 (capped at 50 pt). Wider gaps
      // → more permissive snap so we can catch the actual dividing
      // wall when it sits well off the midpoint.
      const tolerance = Math.min(50, (cB - cA) / 3);
      const snapped = axis === "v"
        ? snapToVerticalWall(midAt, zone, walls, tolerance)
        : snapToHorizontalWall(midAt, zone, walls, tolerance);
      const at = snapped ?? midAt;
      const zMin = axis === "v" ? zone.x : zone.y;
      const zMax = axis === "v" ? zone.x + zone.width : zone.y + zone.height;
      if (at < zMin + MIN_CUT_MARGIN_PT || at > zMax - MIN_CUT_MARGIN_PT) continue;
      // After snap, cut must still cleanly separate the two groups.
      if (at <= cA || at >= cB) continue;
      const score = scoreCut(at, axis, zone, sorted[i - 1], sorted[i], snapped !== null);
      if (score < bestScore) {
        bestScore = score;
        bestCut = {
          axis,
          at,
          leftIds: sorted.slice(0, i).map((m) => m.id),
          rightIds: sorted.slice(i).map((m) => m.id),
          snapped: snapped !== null,
        };
      }
    }
  };
  tryCut("v");
  tryCut("h");

  // Bail out if no cut viable — recover by giving each member a band
  // proportional to its position. Better than a degenerate single
  // assignment when there are 2+ labels we can't separate cleanly.
  if (!bestCut) {
    const sorted = [...members].sort((a, b) =>
      zone.width > zone.height ? a.cxPt - b.cxPt : a.cyPt - b.cyPt,
    );
    const stripe = zone.width > zone.height ? zone.width / sorted.length : zone.height / sorted.length;
    for (let i = 0; i < sorted.length; i++) {
      out.set(sorted[i].id,
        zone.width > zone.height
          ? { x: zone.x + i * stripe, y: zone.y, width: stripe, height: zone.height }
          : { x: zone.x, y: zone.y + i * stripe, width: zone.width, height: stripe });
    }
    return;
  }

  const cut: Cut = bestCut;
  if (cut.axis === "v") {
    const left: BboxPt = {
      x: zone.x,
      y: zone.y,
      width: cut.at - zone.x,
      height: zone.height,
    };
    const right: BboxPt = {
      x: cut.at,
      y: zone.y,
      width: zone.x + zone.width - cut.at,
      height: zone.height,
    };
    const leftSet = new Set(cut.leftIds);
    partitionRec(left, members.filter((m) => leftSet.has(m.id)), walls, out);
    partitionRec(right, members.filter((m) => !leftSet.has(m.id)), walls, out);
  } else {
    const top: BboxPt = {
      x: zone.x,
      y: zone.y,
      width: zone.width,
      height: cut.at - zone.y,
    };
    const bot: BboxPt = {
      x: zone.x,
      y: cut.at,
      width: zone.width,
      height: zone.y + zone.height - cut.at,
    };
    const topSet = new Set(cut.leftIds);
    partitionRec(top, members.filter((m) => topSet.has(m.id)), walls, out);
    partitionRec(bot, members.filter((m) => !topSet.has(m.id)), walls, out);
  }
}

function snapToVerticalWall(
  candidateX: number,
  zone: BboxPt,
  walls: Wall[],
  tolerancePt: number = WALL_SNAP_TOLERANCE_PT,
): number | null {
  let bestDist = tolerancePt;
  let bestX: number | null = null;
  for (const w of walls) {
    if (Math.abs(w.x1 - w.x2) > 1.5) continue;
    const wx = w.x1;
    if (Math.abs(wx - candidateX) > bestDist) continue;
    const wyMin = Math.min(w.y1, w.y2);
    const wyMax = Math.max(w.y1, w.y2);
    if (wyMax < zone.y || wyMin > zone.y + zone.height) continue;
    if (wyMax - wyMin < 30) continue;
    bestDist = Math.abs(wx - candidateX);
    bestX = wx;
  }
  return bestX;
}

function snapToHorizontalWall(
  candidateY: number,
  zone: BboxPt,
  walls: Wall[],
  tolerancePt: number = WALL_SNAP_TOLERANCE_PT,
): number | null {
  let bestDist = tolerancePt;
  let bestY: number | null = null;
  for (const w of walls) {
    if (Math.abs(w.y1 - w.y2) > 1.5) continue;
    const wy = w.y1;
    if (Math.abs(wy - candidateY) > bestDist) continue;
    const wxMin = Math.min(w.x1, w.x2);
    const wxMax = Math.max(w.x1, w.x2);
    if (wxMax < zone.x || wxMin > zone.x + zone.width) continue;
    if (wxMax - wxMin < 30) continue;
    bestDist = Math.abs(wy - candidateY);
    bestY = wy;
  }
  return bestY;
}

function scoreCut(
  cutAt: number,
  axis: "v" | "h",
  zone: BboxPt,
  leftM: PartitionMember,
  rightM: PartitionMember,
  snapped: boolean,
): number {
  let score = 0;
  // Closeness: cut shouldn't graze a label centroid.
  const distL = axis === "v" ? Math.abs(cutAt - leftM.cxPt) : Math.abs(cutAt - leftM.cyPt);
  const distR = axis === "v" ? Math.abs(cutAt - rightM.cxPt) : Math.abs(cutAt - rightM.cyPt);
  const minDist = Math.min(distL, distR);
  if (minDist < 20) score += 5;
  // Snap bonus — snapping to a real wall is a strong signal.
  if (!snapped) score += 2;
  // Balance: cut roughly midway between centroids preferred over heavily skewed.
  const balance = Math.abs(distL - distR) / Math.max(distL + distR, 1);
  score += balance * 0.5;
  // Length: longer cuts (across the zone) are slightly worse — but
  // we have to cut SOMETHING. Cap penalty.
  const cutLen = axis === "v" ? zone.height : zone.width;
  score += Math.min(cutLen / 500, 0.4);
  // Axis-dominance: when labels are clearly arranged along one axis,
  // strongly prefer that axis. Two labels with xDelta=146 / yDelta=48
  // are side-by-side; cutting them horizontally is the wrong topology
  // even if a wall happens to be there.
  const xDelta = Math.abs(rightM.cxPt - leftM.cxPt);
  const yDelta = Math.abs(rightM.cyPt - leftM.cyPt);
  const total = Math.max(xDelta + yDelta, 1);
  const naturalAxis: "v" | "h" = xDelta > yDelta ? "v" : "h";
  if (axis !== naturalAxis) {
    const dominance = Math.max(xDelta, yDelta) / total; // 0.5–1
    score += 4 * (dominance - 0.5) * 2; // 0 when equal, 4 when fully dominant
  }
  return score;
}

// ---------------------------------------------------------------------------
// Accept check (sliver + aspect + callout cross-check)
// ---------------------------------------------------------------------------

interface AcceptResult {
  ok: boolean;
  widthFt: number;
  heightFt: number;
  /** When the printed callouts overrode the partition dims, the
   *  human-readable warning explaining that. */
  calloutOverride?: string;
}

function acceptPartition(
  label: string,
  bbox: BboxPt,
  ptPerFt: number,
  callouts: DimensionCallout[],
  labelCenter: { x: number; y: number },
  minPlausibleSqft: (label: string) => number,
): AcceptResult {
  let widthFt = round1(bbox.width / ptPerFt);
  let heightFt = round1(bbox.height / ptPerFt);
  let calloutOverride: string | undefined;

  // Sliver — relaxed by 30 % vs. the main pipeline's threshold,
  // because the partition is honestly tagged as estimated and a
  // somewhat-too-small estimate is still better than a blank.
  const minSqft = minPlausibleSqft(label);
  const relaxedMin = minSqft * 0.7;
  if (relaxedMin > 0 && widthFt * heightFt < relaxedMin) {
    return { ok: false, widthFt, heightFt };
  }
  // Upper sanity — a wildly inflated partition (e.g., an 18×18 ft
  // BATH or a 60-ft KITCHEN) signals the zone over-grew. Reject at
  // 10× the per-type minimum (BATH 150 sqft, KITCHEN 600 sqft,
  // LIVING 800 sqft) — generous enough for open-plan great rooms
  // and combined dining/kitchens, tight enough to catch bath-sized
  // labels that picked up the wrong zone.
  if (minSqft > 0 && widthFt * heightFt > minSqft * 10) {
    return { ok: false, widthFt, heightFt };
  }
  // Aspect — tighter for virtual partitions than for the main
  // pipeline. A 4:1 strip is the absolute outer limit for a real
  // room; anything thinner is almost certainly an artifact of the
  // partition cutting a multi-label group into stripes.
  if (widthFt > 0 && heightFt > 0) {
    const aspect = Math.max(widthFt, heightFt) / Math.min(widthFt, heightFt);
    if (aspect > 4) return { ok: false, widthFt, heightFt };
  }

  // Callout cross-check. If a confident H+V callout pair sits near
  // the label, the partition must AGREE WITH THE ARCHITECT'S NUMBERS
  // OR WE PREFER THE CALLOUTS. But pages like DP-BP often print
  // wall-SEGMENT dims (e.g., a south wall split into 4'-0" + 4'-1"
  // + 3'-4" instead of one 11'-5" callout). Without aggregation, the
  // picker grabs only the largest sub-segment — a misleading override.
  //
  // We override only when:
  //   1. Both override dims are themselves plausibly room-sized
  //      (each ≥ 6 ft — wall-segment dims are usually < 5 ft).
  //   2. The override's area disagrees with the partition by > 50 %
  //      — small disagreements are tolerated because the partition
  //      already lands within the same ballpark as the callout pair.
  //      Big disagreements are the case the brief wants us to catch.
  //   3. The override passes the same sliver / aspect / max checks
  //      as the partition.
  const picked = pickCalloutsNearLabel(callouts, labelCenter, 150);
  if (picked && picked.widthFt >= 6 && picked.heightFt >= 6) {
    const partitionArea = widthFt * heightFt;
    const ratioWH =
      Math.abs(widthFt - picked.widthFt) / picked.widthFt +
      Math.abs(heightFt - picked.heightFt) / picked.heightFt;
    const ratioHW =
      Math.abs(widthFt - picked.heightFt) / picked.heightFt +
      Math.abs(heightFt - picked.widthFt) / picked.widthFt;
    const useSameOrder = ratioWH < ratioHW;
    const useWidthFt = useSameOrder ? picked.widthFt : picked.heightFt;
    const useHeightFt = useSameOrder ? picked.heightFt : picked.widthFt;
    const overrideArea = useWidthFt * useHeightFt;
    const areaRatio = overrideArea / Math.max(partitionArea, 1);

    // Big area mismatch + override is itself plausible → architect wins.
    const overrideAspect =
      Math.max(useWidthFt, useHeightFt) /
      Math.max(Math.min(useWidthFt, useHeightFt), 1);
    const overridePassesAccept =
      overrideArea >= relaxedMin &&
      overrideArea <= minSqft * 5 &&
      overrideAspect <= 5;

    if (
      overridePassesAccept &&
      (areaRatio < 0.5 || areaRatio > 1.5)
    ) {
      calloutOverride =
        `Partition initially produced ${widthFt}'×${heightFt}', but the architect's printed ` +
        `callouts near "${label}" say ${useWidthFt}'×${useHeightFt}' — disagreement is too large to ignore. ` +
        `Using the callouts. Review before bidding.`;
      widthFt = useWidthFt;
      heightFt = useHeightFt;
    }
  }

  return { ok: true, widthFt, heightFt, calloutOverride };
}

/**
 * Pick the largest horizontal + largest vertical printed callouts
 * within `radiusPt` of the label centre. Returns null when fewer than
 * one of each is found.
 *
 * This is the same pattern page-extract uses for callout
 * cross-checking, with one important difference: here we don't have
 * a bbox to compare against, so we take the LARGEST callout in each
 * axis. The 100 pt radius keeps us from sweeping in dimensions from
 * the next room over.
 */
function pickCalloutsNearLabel(
  callouts: DimensionCallout[],
  labelCenter: { x: number; y: number },
  radiusPt: number,
): { widthFt: number; heightFt: number } | null {
  const local = callouts.filter((c) => {
    if (c.lengthFt < 3 || c.lengthFt > 60) return false;
    const dx = c.x - labelCenter.x;
    const dy = c.y - labelCenter.y;
    return dx * dx + dy * dy <= radiusPt * radiusPt;
  });
  if (local.length < 2) return null;

  let hor = local.filter((c) => c.orientation === "h");
  let ver = local.filter((c) => c.orientation === "v");

  if (hor.length === 0 || ver.length === 0) {
    for (const c of local) {
      if (c.orientation === "h" || c.orientation === "v") continue;
      const dx = Math.abs(c.x - labelCenter.x);
      const dy = Math.abs(c.y - labelCenter.y);
      if (dy > dx) hor.push(c);
      else ver.push(c);
    }
  }
  if (hor.length === 0 || ver.length === 0) return null;

  hor.sort((a, b) => b.lengthFt - a.lengthFt);
  ver.sort((a, b) => b.lengthFt - a.lengthFt);
  return { widthFt: hor[0].lengthFt, heightFt: ver[0].lengthFt };
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

function pointInBbox(p: { x: number; y: number }, b: BboxPt): boolean {
  return p.x >= b.x && p.x <= b.x + b.width && p.y >= b.y && p.y <= b.y + b.height;
}

function unionBbox(a: BboxPt, b: BboxPt): BboxPt {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const x1 = Math.max(a.x + a.width, b.x + b.width);
  const y1 = Math.max(a.y + a.height, b.y + b.height);
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

function clipBbox(
  a: BboxPt,
  envelope: { x0: number; y0: number; x1: number; y1: number },
): BboxPt {
  const x0 = Math.max(a.x, envelope.x0);
  const y0 = Math.max(a.y, envelope.y0);
  const x1 = Math.min(a.x + a.width, envelope.x1);
  const y1 = Math.min(a.y + a.height, envelope.y1);
  return { x: x0, y: y0, width: Math.max(0, x1 - x0), height: Math.max(0, y1 - y0) };
}

function bboxAreaSqft(b: BboxPt, ptPerFt: number): number {
  const w = b.width / ptPerFt;
  const h = b.height / ptPerFt;
  return w * h;
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
