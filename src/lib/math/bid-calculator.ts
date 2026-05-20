import type { SurfaceDTO, SurfaceType } from "@/types/surface";
import {
  productionRateFor,
  unitFor,
  type ComplexityFlags,
} from "./production-rates";
import { coverageFor } from "./coverage";
import { applyWaste } from "./waste";
import { adjustForMode, type MeasurementMode } from "./pca-standards";

export interface BidConfig {
  measurementMode: MeasurementMode;
  wasteFactor: number; // 0..1
  markup: number; // 0..1
  overheadPct: number; // 0..1
  hourlyCostBySurface: Partial<Record<SurfaceType, number>>;
  defaultHourlyCost: number;
  paintPricePerGal: number;
  burdenRate: number; // 0..1 — applied on top of base hourly
  complexity: ComplexityFlags;
}

export interface BidLineItem {
  surfaceId: string;
  type: SurfaceType;
  roomLabel: string | null;
  paintType: string | null;
  coats: number;
  quantity: number;
  unit: "sqft" | "lf" | "ea";
  productionRate: number;
  laborHours: number;
  laborCost: number;
  gallons: number;
  materialCost: number;
}

export interface BidTotals {
  lineItems: BidLineItem[];
  subtotal: number;
  totalLabor: number;
  totalMaterial: number;
  totalOverhead: number;
  totalMarkup: number;
  grandTotal: number;
}

export const DEFAULT_CONFIG: BidConfig = {
  measurementMode: "net",
  wasteFactor: 0.10,
  markup: 0.20,
  overheadPct: 0.10,
  hourlyCostBySurface: {},
  defaultHourlyCost: 55,
  paintPricePerGal: 45,
  burdenRate: 0.30,
  complexity: {},
};

export interface ProjectConfigInputs {
  project: {
    measurementMode: string;
    wasteFactor: number;
    markup: number;
    overheadPct: number;
  };
  rates: Array<{ surfaceType: string; rate?: number; hourlyCost?: number }>;
}

/**
 * Single source of truth for turning a Project + labor rates into a
 * BidConfig. Used by the generate route, the live worksheet, and the
 * bid page so every path produces byte-identical math.
 */
export function buildProjectConfig({
  project,
  rates,
}: ProjectConfigInputs): BidConfig {
  const hourlyCostBySurface: Partial<Record<SurfaceType, number>> = {};
  for (const r of rates) {
    if (typeof r.hourlyCost === "number") {
      hourlyCostBySurface[r.surfaceType as SurfaceType] = r.hourlyCost;
    }
  }
  const defaultRow = rates.find((r) => r.surfaceType === "default");
  const defaultHourlyCost =
    typeof defaultRow?.rate === "number"
      ? defaultRow.rate
      : DEFAULT_CONFIG.defaultHourlyCost;

  return {
    ...DEFAULT_CONFIG,
    measurementMode: (project.measurementMode as MeasurementMode) ?? "net",
    wasteFactor: project.wasteFactor,
    markup: project.markup,
    overheadPct: project.overheadPct,
    hourlyCostBySurface,
    defaultHourlyCost,
  };
}

export function calculateBid(
  surfaces: SurfaceDTO[],
  config: BidConfig = DEFAULT_CONFIG,
): BidTotals {
  const lineItems: BidLineItem[] = [];

  for (const s of surfaces) {
    if (s.status === "excluded") continue;
    // Skip non-paintable surface kinds (annotations, symbol counts) so
    // they don't pollute the bid totals.
    if (s.type.startsWith("annotation:") || s.type.startsWith("symbol:")) continue;
    // Wall-path traces are measured + reviewable but are NOT rolled
    // into the bid yet — that's the dedicated "rolled-up totals" task.
    // Including them now would double-count walls already measured as
    // room polygons. Keeping them out preserves existing bid math
    // exactly while the trace is reviewed.
    if (s.type === "wall-path") continue;

    const unit = unitFor(s.type);
    let quantity = 0;
    if (unit === "sqft") {
      quantity = adjustForMode(
        s.squareFootage ?? 0,
        config.measurementMode,
      );
    } else if (unit === "lf") {
      quantity = s.linearFootage ?? 0;
    } else {
      quantity = s.count ?? 1;
    }

    const productionRate = productionRateFor(s.type, config.complexity);
    const totalUnits = quantity * s.coats;
    const laborHours = productionRate > 0 ? totalUnits / productionRate : 0;

    const hourlyCost =
      config.hourlyCostBySurface[s.type] ?? config.defaultHourlyCost;
    const laborCost = laborHours * hourlyCost * (1 + config.burdenRate);

    let gallons = 0;
    if (unit === "sqft") {
      const coverage = coverageFor(s.substrate);
      gallons = applyWaste(
        (quantity * s.coats) / coverage,
        config.wasteFactor,
      );
    } else if (unit === "lf") {
      // trim: rough estimate, 1 gal per ~250 lf with 2 coats
      gallons = applyWaste(
        (quantity * s.coats) / 250,
        config.wasteFactor,
      );
    } else {
      // doors/windows: ~0.25 gal each per coat
      gallons = applyWaste(
        quantity * s.coats * 0.25,
        config.wasteFactor,
      );
    }
    const materialCost = gallons * config.paintPricePerGal;

    lineItems.push({
      surfaceId: s.id,
      type: s.type,
      roomLabel: s.roomLabel,
      paintType: s.paintType,
      coats: s.coats,
      quantity,
      unit,
      productionRate,
      laborHours,
      laborCost,
      gallons,
      materialCost,
    });
  }

  const totalLabor = lineItems.reduce((a, l) => a + l.laborCost, 0);
  const totalMaterial = lineItems.reduce((a, l) => a + l.materialCost, 0);
  const subtotal = totalLabor + totalMaterial;
  const totalOverhead = subtotal * config.overheadPct;
  const subAfterOverhead = subtotal + totalOverhead;
  const totalMarkup = subAfterOverhead * config.markup;
  const grandTotal = subAfterOverhead + totalMarkup;

  return {
    lineItems,
    subtotal,
    totalLabor,
    totalMaterial,
    totalOverhead,
    totalMarkup,
    grandTotal,
  };
}
