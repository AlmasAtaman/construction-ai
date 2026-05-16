"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Rate {
  surfaceType: string;
  unit: string;
  rate: number;
  hourlyCost: number;
}

const DEFAULT_RATES: Rate[] = [
  { surfaceType: "wall", unit: "sqft/hr", rate: 55, hourlyCost: 55 },
  { surfaceType: "ceiling", unit: "sqft/hr", rate: 60, hourlyCost: 60 },
  { surfaceType: "trim", unit: "lf/hr", rate: 50, hourlyCost: 50 },
  { surfaceType: "door", unit: "ea/hr", rate: 55, hourlyCost: 55 },
  { surfaceType: "window", unit: "ea/hr", rate: 55, hourlyCost: 55 },
];

export default function RatesPage() {
  const [rates, setRates] = useState<Rate[]>(DEFAULT_RATES);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/settings/rates")
      .then((r) => r.json())
      .then((j) => {
        if (j.rates && j.rates.length > 0) {
          setRates(
            j.rates.map((r: Rate) => ({
              surfaceType: r.surfaceType,
              unit: r.unit,
              rate: r.rate,
              hourlyCost: r.hourlyCost,
            })),
          );
        }
      });
  }, []);

  async function save() {
    setSaving(true);
    setSaved(false);
    await fetch("/api/settings/rates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rates }),
    });
    setSaving(false);
    setSaved(true);
    window.dispatchEvent(new Event("settings-changed"));
    setTimeout(() => setSaved(false), 2500);
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex h-16 items-center justify-between border-b border-gray-200 bg-white px-6">
        <Link href="/" className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-blue-600 font-bold text-white">
            P
          </div>
          <h1 className="text-lg font-semibold text-gray-900">PainterDesk</h1>
        </Link>
      </header>
      <main className="flex-1 px-6 py-10">
        <div className="mx-auto max-w-3xl">
          <Link
            href="/settings"
            className="text-sm text-blue-600 hover:underline"
          >
            &larr; Back to settings
          </Link>
          <h2 className="mt-4 text-2xl font-bold text-gray-900">Labor rates</h2>
          <p className="mt-2 text-sm text-gray-600">
            How fast your team paints, and how much they cost per hour. Used
            for every project until you change them.
          </p>

          <div
            className="mt-6 space-y-4 rounded-lg border border-gray-200 bg-white p-6 shadow-sm"
            data-testid="rates-form"
          >
            {rates.map((r, i) => (
              <div
                key={r.surfaceType}
                className="grid grid-cols-1 gap-3 sm:grid-cols-[100px_120px_120px]"
              >
                <Label className="flex items-center capitalize">
                  {r.surfaceType}
                </Label>
                <div>
                  <Label className="text-xs text-gray-500">
                    Production rate
                  </Label>
                  <div className="mt-1 flex items-center gap-1">
                    <Input
                      type="number"
                      step="0.1"
                      value={r.rate}
                      data-testid={`rate-${r.surfaceType}`}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value) || 0;
                        setRates((rs) =>
                          rs.map((rr, j) =>
                            j === i ? { ...rr, rate: v } : rr,
                          ),
                        );
                      }}
                    />
                    <span className="text-xs text-gray-500">{r.unit}</span>
                  </div>
                </div>
                <div>
                  <Label className="text-xs text-gray-500">Hourly cost</Label>
                  <div className="mt-1 flex items-center gap-1">
                    <span className="text-sm text-gray-500">$</span>
                    <Input
                      type="number"
                      step="0.5"
                      value={r.hourlyCost}
                      data-testid={`hourly-${r.surfaceType}`}
                      onChange={(e) => {
                        const v = parseFloat(e.target.value) || 0;
                        setRates((rs) =>
                          rs.map((rr, j) =>
                            j === i ? { ...rr, hourlyCost: v } : rr,
                          ),
                        );
                      }}
                    />
                  </div>
                </div>
              </div>
            ))}

            <div className="flex items-center justify-end gap-2 pt-2">
              {saved && (
                <span className="text-sm text-green-700" data-testid="saved-toast">
                  Saved.
                </span>
              )}
              <Button
                onClick={save}
                disabled={saving}
                data-testid="save-rates"
              >
                {saving ? "Saving..." : "Save labor rates"}
              </Button>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
