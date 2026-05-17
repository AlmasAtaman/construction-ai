/**
 * Painting assemblies — bundles of paint type + coats + production rate
 * + waste factor + labor rate + paint cost.
 *
 * An assembly is what a painter applies to a surface. Picking an assembly
 * from a saved list is faster than typing paint name, coats, and dragging
 * costs every time. PlanSwift calls these "assemblies"; Togal calls them
 * "templates"; we use the same Prisma model `ToolChestItem` already in
 * the schema.
 *
 * On first request the defaults below are seeded so the app is usable
 * out of the box.
 */

import { db } from "./db";

export interface DefaultAssembly {
  name: string;
  category: "interior" | "exterior" | "trim" | "ceiling" | "specialty";
  paintType: string;
  coats: number;
  /** sqft per labor hour for this assembly. */
  productionRate: number;
  /** 0..1 waste factor. */
  wasteFactor: number;
  /** Hourly labor cost ($/hr). */
  laborRate: number;
  /** Paint product cost ($/gal). */
  paintCost: number;
  notes?: string;
}

export const DEFAULT_ASSEMBLIES: DefaultAssembly[] = [
  {
    name: "Interior drywall — eggshell",
    category: "interior",
    paintType: "Eggshell latex",
    coats: 2,
    productionRate: 200,
    wasteFactor: 0.1,
    laborRate: 55,
    paintCost: 38,
    notes: "Standard interior wall coating: primer included on new drywall, 2 finish coats.",
  },
  {
    name: "Interior drywall — semi-gloss",
    category: "interior",
    paintType: "Semi-gloss latex",
    coats: 2,
    productionRate: 180,
    wasteFactor: 0.1,
    laborRate: 55,
    paintCost: 42,
    notes: "Bathrooms, kitchens, washable surfaces.",
  },
  {
    name: "Interior drywall — flat",
    category: "interior",
    paintType: "Flat latex",
    coats: 2,
    productionRate: 220,
    wasteFactor: 0.1,
    laborRate: 50,
    paintCost: 34,
    notes: "Bedrooms, living rooms with minimal scuffing risk.",
  },
  {
    name: "Ceiling — flat white",
    category: "ceiling",
    paintType: "Flat ceiling paint",
    coats: 1,
    productionRate: 250,
    wasteFactor: 0.1,
    laborRate: 60,
    paintCost: 32,
    notes: "Single coat usually sufficient over factory-finished drywall.",
  },
  {
    name: "Trim — semi-gloss enamel",
    category: "trim",
    paintType: "Semi-gloss alkyd enamel",
    coats: 2,
    productionRate: 90,
    wasteFactor: 0.15,
    laborRate: 60,
    paintCost: 50,
    notes: "Baseboards, casing, door frames. Linear feet basis.",
  },
  {
    name: "Trim — high-gloss enamel",
    category: "trim",
    paintType: "High-gloss enamel",
    coats: 2,
    productionRate: 80,
    wasteFactor: 0.15,
    laborRate: 65,
    paintCost: 58,
    notes: "Premium trim finish for commercial doors and millwork.",
  },
  {
    name: "Exterior siding — latex",
    category: "exterior",
    paintType: "Exterior acrylic latex",
    coats: 2,
    productionRate: 180,
    wasteFactor: 0.15,
    laborRate: 65,
    paintCost: 48,
    notes: "Standard residential siding repaint.",
  },
  {
    name: "Exterior masonry / CMU",
    category: "exterior",
    paintType: "Block filler + acrylic",
    coats: 3,
    productionRate: 100,
    wasteFactor: 0.2,
    laborRate: 70,
    paintCost: 65,
    notes: "Block filler primer + 2 finish coats for commercial CMU.",
  },
  {
    name: "Specialty — anti-microbial epoxy",
    category: "specialty",
    paintType: "Anti-microbial epoxy",
    coats: 2,
    productionRate: 130,
    wasteFactor: 0.15,
    laborRate: 80,
    paintCost: 95,
    notes: "Healthcare, food service, lab walls. 2-component epoxy.",
  },
];

/**
 * Seed default assemblies the first time we run. Idempotent.
 */
export async function ensureDefaultAssemblies(): Promise<void> {
  const count = await db.toolChestItem.count();
  if (count > 0) return;
  for (const a of DEFAULT_ASSEMBLIES) {
    await db.toolChestItem.create({ data: a });
  }
}
