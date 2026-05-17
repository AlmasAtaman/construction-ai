"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AppShell, TopBar } from "@/components/nav/AppShell";

interface ProjectSettings {
  wasteFactor: number;
  markup: number;
  overheadPct: number;
}

const DEFAULTS: ProjectSettings = {
  wasteFactor: 0.10,
  markup: 0.20,
  overheadPct: 0.10,
};

// Stored as decimals 0..1; displayed as whole-number percents.
function toPercent(decimal: number): number {
  return Math.round(decimal * 1000) / 10;
}

function fromPercent(percent: number): number {
  return Math.max(0, Math.min(100, percent)) / 100;
}

export default function ProjectSettingsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: projectId } = use(params);
  const [projectName, setProjectName] = useState<string | null>(null);
  const [settings, setSettings] = useState<ProjectSettings>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const res = await fetch(`/api/projects/${projectId}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        if (!cancelled) setLoading(false);
        return;
      }
      const j = await res.json();
      if (cancelled) return;
      setProjectName(j.project?.name ?? null);
      setSettings({
        wasteFactor: j.project?.wasteFactor ?? DEFAULTS.wasteFactor,
        markup: j.project?.markup ?? DEFAULTS.markup,
        overheadPct: j.project?.overheadPct ?? DEFAULTS.overheadPct,
      });
      setLoading(false);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  async function save() {
    setSaving(true);
    setSaved(false);
    setError(null);
    const res = await fetch(`/api/projects/${projectId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(settings),
    });
    setSaving(false);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(
        j.error ?? "Couldn't save settings. Check the values and try again.",
      );
      return;
    }
    setSaved(true);
    window.dispatchEvent(new Event("settings-changed"));
    setTimeout(() => setSaved(false), 2500);
  }

  return (
    <AppShell>
      <TopBar
        title="Project settings"
        subtitle={projectName ?? "Loading…"}
      >
        <Link href={`/projects/${projectId}`}>
          <Button variant="ghost" size="sm">
            Back to plan
          </Button>
        </Link>
      </TopBar>
      <main className="flex-1 overflow-y-auto px-6 py-8">
        <div className="mx-auto max-w-2xl">
          <p className="text-[13px] text-[hsl(var(--ink-2))]">
            These numbers go into every bid for this project. Change them
            once here — every estimate, export, and live worksheet uses
            the same values.
          </p>

          {loading ? (
            <div className="mt-6 text-[13px] text-[hsl(var(--ink-3))]">
              Loading settings…
            </div>
          ) : (
            <div
              className="mt-6 space-y-6 rounded-lg border border-gray-200 bg-white p-6 shadow-sm"
              data-testid="project-settings-form"
            >
              <PercentField
                id="waste-factor"
                label="Waste factor"
                helperText="Extra paint for spills, roller soak, and porous surfaces. Typically 5-15%."
                testId="waste-factor-input"
                value={toPercent(settings.wasteFactor)}
                onChange={(p) =>
                  setSettings((s) => ({ ...s, wasteFactor: fromPercent(p) }))
                }
              />

              <PercentField
                id="overhead-pct"
                label="Overhead"
                helperText="Covers insurance, vehicles, office, and admin costs. Industry typical is 10-15%."
                testId="overhead-pct-input"
                value={toPercent(settings.overheadPct)}
                onChange={(p) =>
                  setSettings((s) => ({ ...s, overheadPct: fromPercent(p) }))
                }
              />

              <PercentField
                id="markup"
                label="Markup"
                helperText="Your profit on top of costs. Most commercial painters use 15-30%."
                testId="markup-input"
                value={toPercent(settings.markup)}
                onChange={(p) =>
                  setSettings((s) => ({ ...s, markup: fromPercent(p) }))
                }
              />

              {error && (
                <div
                  role="alert"
                  className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-800"
                >
                  {error}
                </div>
              )}

              <div className="flex items-center justify-end gap-2 border-t border-gray-200 pt-4">
                {saved && (
                  <span
                    className="text-sm text-green-700"
                    data-testid="saved-toast"
                  >
                    Saved.
                  </span>
                )}
                <Button
                  onClick={() => void save()}
                  disabled={saving}
                  data-testid="save-project-settings"
                >
                  {saving ? "Saving…" : "Save project settings"}
                </Button>
              </div>
            </div>
          )}
        </div>
      </main>
    </AppShell>
  );
}

function PercentField({
  id,
  label,
  helperText,
  testId,
  value,
  onChange,
}: {
  id: string;
  label: string;
  helperText: string;
  testId: string;
  value: number;
  onChange: (percent: number) => void;
}) {
  return (
    <div>
      <Label htmlFor={id} className="text-[13px]">
        {label}
      </Label>
      <div className="mt-1.5 flex items-center gap-2">
        <Input
          id={id}
          data-testid={testId}
          type="number"
          step="0.5"
          min={0}
          max={100}
          value={value}
          onChange={(e) => onChange(parseFloat(e.target.value) || 0)}
          className="w-24"
        />
        <span className="text-sm text-gray-500">%</span>
      </div>
      <p className="mt-1.5 text-[12px] text-[hsl(var(--ink-3))]">
        {helperText}
      </p>
    </div>
  );
}
