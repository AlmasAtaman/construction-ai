// Synthetic correctness test for the planar-graph room recovery.
// Run with: npx tsx scripts/test-planar-graph-synthetic.ts
import { detectRooms, type Segment } from "../src/lib/planar-graph";

let pass = 0;
let fail = 0;

function check(label: string, cond: boolean, detail = ""): void {
  if (cond) {
    console.log(`  ✓ ${label}`);
    pass++;
  } else {
    console.log(`  ✗ ${label}  ${detail}`);
    fail++;
  }
}

// ── Case 1: single square room ────────────────────────────────────────────
console.log("\nCase 1: single 10×10 room");
{
  const segs: Segment[] = [
    { x1: 0, y1: 0, x2: 10, y2: 0 },
    { x1: 10, y1: 0, x2: 10, y2: 10 },
    { x1: 10, y1: 10, x2: 0, y2: 10 },
    { x1: 0, y1: 10, x2: 0, y2: 0 },
  ];
  const rooms = detectRooms(segs, 100, 100, {
    minRoomArea: 50,
    snapTolerance: 0.5,
  });
  check("finds exactly 1 room", rooms.length === 1, `got ${rooms.length}`);
  if (rooms.length > 0) {
    check(
      "area = 100",
      Math.abs(rooms[0].area - 100) < 0.01,
      `got ${rooms[0].area}`,
    );
    check(
      "polygon has 4 vertices",
      rooms[0].polygon.length === 4,
      `got ${rooms[0].polygon.length}`,
    );
  }
}

// ── Case 2: 2x2 grid of 4 rooms ───────────────────────────────────────────
console.log("\nCase 2: 2×2 grid of rooms (each 10×10)");
{
  const segs: Segment[] = [
    { x1: 0, y1: 0, x2: 20, y2: 0 },
    { x1: 20, y1: 0, x2: 20, y2: 20 },
    { x1: 20, y1: 20, x2: 0, y2: 20 },
    { x1: 0, y1: 20, x2: 0, y2: 0 },
    { x1: 0, y1: 10, x2: 20, y2: 10 },
    { x1: 10, y1: 0, x2: 10, y2: 20 },
  ];
  const rooms = detectRooms(segs, 100, 100, {
    minRoomArea: 50,
    snapTolerance: 0.5,
  });
  check("finds exactly 4 rooms", rooms.length === 4, `got ${rooms.length}`);
  if (rooms.length === 4) {
    const allCorrect = rooms.every((r) => Math.abs(r.area - 100) < 0.01);
    check("each room is 100 sq units", allCorrect);
  }
}

// ── Case 3: L-shaped room ─────────────────────────────────────────────────
console.log("\nCase 3: L-shaped room");
{
  const segs: Segment[] = [
    { x1: 0, y1: 0, x2: 10, y2: 0 },
    { x1: 10, y1: 0, x2: 10, y2: 10 },
    { x1: 10, y1: 10, x2: 20, y2: 10 },
    { x1: 20, y1: 10, x2: 20, y2: 20 },
    { x1: 20, y1: 20, x2: 0, y2: 20 },
    { x1: 0, y1: 20, x2: 0, y2: 0 },
  ];
  const rooms = detectRooms(segs, 100, 100, {
    minRoomArea: 50,
    snapTolerance: 0.5,
  });
  check("finds exactly 1 room", rooms.length === 1, `got ${rooms.length}`);
  if (rooms.length > 0) {
    check(
      "area = 300",
      Math.abs(rooms[0].area - 300) < 0.01,
      `got ${rooms[0].area}`,
    );
    check(
      "polygon has 6 vertices",
      rooms[0].polygon.length === 6,
      `got ${rooms[0].polygon.length}`,
    );
  }
}

// ── Case 4: T-intersection with imperfect endpoint ────────────────────────
console.log("\nCase 4: T-intersection with 0.3pt gap (should snap)");
{
  const segs: Segment[] = [
    { x1: 0, y1: 0, x2: 20, y2: 0 },
    { x1: 20, y1: 0, x2: 20, y2: 10 },
    { x1: 20, y1: 10, x2: 0, y2: 10 },
    { x1: 0, y1: 10, x2: 0, y2: 0 },
    { x1: 10, y1: 0.3, x2: 10, y2: 9.7 },
  ];
  const rooms = detectRooms(segs, 100, 100, {
    minRoomArea: 50,
    snapTolerance: 1.5,
  });
  check(
    "finds 2 rooms after snapping",
    rooms.length === 2,
    `got ${rooms.length}`,
  );
  if (rooms.length === 2) {
    // Snap pulls walls slightly off-axis; tolerate up to 2% area delta.
    const allCorrect = rooms.every((r) => Math.abs(r.area - 100) < 2);
    check("each room ≈ 100 sq units", allCorrect);
  }
}

// ── Case 5: H × V crossing in the middle ──────────────────────────────────
console.log("\nCase 5: H and V partitions that cross through each other");
{
  const segs: Segment[] = [
    { x1: 0, y1: 0, x2: 20, y2: 0 },
    { x1: 20, y1: 0, x2: 20, y2: 20 },
    { x1: 20, y1: 20, x2: 0, y2: 20 },
    { x1: 0, y1: 20, x2: 0, y2: 0 },
    { x1: 0, y1: 10, x2: 20, y2: 10 },
    { x1: 10, y1: 0, x2: 10, y2: 20 },
  ];
  const rooms = detectRooms(segs, 100, 100, {
    minRoomArea: 50,
    snapTolerance: 0.5,
  });
  check("finds 4 rooms", rooms.length === 4, `got ${rooms.length}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
