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

export function calculateBid(
  surfaces: SurfaceDTO[],
  config: BidConfig = DEFAULT_CONFIG,
): BidTotals {
  const lineItems: BidLineItem[] = [];

  for (const s of surfaces) {
    if (s.status === "excluded") continue;

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
