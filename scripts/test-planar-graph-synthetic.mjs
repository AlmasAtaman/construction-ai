// Synthetic correctness test for the planar-graph room recovery.
//
// We hand-build the segment list for a known floor plan and verify
// detectRooms() returns the expected polygons.
//
// Cases:
//   1. Single square room (10x10) — expect 1 face, area = 100
//   2. 2x2 grid of rooms (4 rooms, each 10x10) — expect 4 faces
//   3. L-shaped room — expect 1 face with 6 vertices
//   4. T-intersection: partition wall doesn't quite touch — expect
//      snapping to fix it, then 2 rooms

import { tsImport } from "tsx/esm/api";

const mod = await tsImport(
  "../src/lib/planar-graph.ts",
  import.meta.url,
);
const { detectRooms } = mod;

let pass = 0;
let fail = 0;

function check(label, cond, detail = "") {
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
  const segs = [
    { x1: 0, y1: 0, x2: 10, y2: 0 }, // bottom
    { x1: 10, y1: 0, x2: 10, y2: 10 }, // right
    { x1: 10, y1: 10, x2: 0, y2: 10 }, // top
    { x1: 0, y1: 10, x2: 0, y2: 0 }, // left
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
  // Outer 20x20 box + cross at center
  const segs = [
    // outer
    { x1: 0, y1: 0, x2: 20, y2: 0 },
    { x1: 20, y1: 0, x2: 20, y2: 20 },
    { x1: 20, y1: 20, x2: 0, y2: 20 },
    { x1: 0, y1: 20, x2: 0, y2: 0 },
    // horizontal partition at y=10
    { x1: 0, y1: 10, x2: 20, y2: 10 },
    // vertical partition at x=10
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
  // L shape: a 20x10 rectangle with a 10x10 notch cut from upper-right
  //
  //   +-------+
  //   |       |
  //   |   +---+
  //   |   |
  //   +---+
  //
  const segs = [
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
    // L = 10x10 bottom-left + 20x10 top = 100 + 200 = 300
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
  // Square with a partition that has its endpoint 0.3 short of the wall
  const segs = [
    { x1: 0, y1: 0, x2: 20, y2: 0 },
    { x1: 20, y1: 0, x2: 20, y2: 10 },
    { x1: 20, y1: 10, x2: 0, y2: 10 },
    { x1: 0, y1: 10, x2: 0, y2: 0 },
    // partition: should go x=10, y=0→10 but is 0.3 short top + bottom
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
    const allCorrect = rooms.every((r) => Math.abs(r.area - 100) < 1);
    check("each room ≈ 100 sq units", allCorrect);
  }
}

// ── Case 5: H × V crossing in the middle ──────────────────────────────────
console.log("\nCase 5: H and V partitions that cross through each other");
{
  // Two long partitions crossing inside a 20x20 box, neither ending at
  // the other — should be split at the crossing → 4 quadrant rooms.
  const segs = [
    { x1: 0, y1: 0, x2: 20, y2: 0 },
    { x1: 20, y1: 0, x2: 20, y2: 20 },
    { x1: 20, y1: 20, x2: 0, y2: 20 },
    { x1: 0, y1: 20, x2: 0, y2: 0 },
    // horizontal partition through middle (not split into two)
    { x1: 0, y1: 10, x2: 20, y2: 10 },
    // vertical partition through middle (not split into two)
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
