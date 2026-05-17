"use client";

import { use, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { UsageBadge } from "@/components/usage/UsageBadge";
import { AppShell, TopBar } from "@/components/nav/AppShell";

interface FlaggedReq {
  item: string;
  quote: string;
  risk: "low" | "medium" | "high";
}

interface SpecSummary {
  paintScope: {
    area: string;
    surface: string;
    paintType: string;
    sheen?: string;
    coats: number;
    color?: string;
  }[];
  finishSchedule: { room: string; paintType: string }[];
  flaggedRequirements: FlaggedReq[];
  productionRateAdjustments: string[];
  safetyRequirements: string[];
  materialRequirements: string[];
  exclusions: string[];
}

interface SpecData {
  id: string;
  filename: string;
  summary: SpecSummary | null;
  createdAt: string;
}

export default function SpecsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: projectId } = use(params);
  const [specs, setSpecs] = useState<SpecData[]>([]);
  const [uploading, setUploading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applyResult, setApplyResult] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function loadSpecs() {
    const res = await fetch(`/api/ai/specs?projectId=${projectId}`, {
      cache: "no-store",
    });
    if (res.ok) {
      const json = await res.json();
      setSpecs(json.specs);
    }
  }

  useEffect(() => {
    void loadSpecs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function uploadAndAnalyze(file: File) {
    setError(null);
    setUploading(true);
    setAnalyzing(true);
    try {
      const form = new FormData();
      form.append("projectId", projectId);
      form.append("file", file);
      const res = await fetch("/api/ai/specs", {
        method: "POST",
        body: form,
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Something went wrong.");
        return;
      }
      window.dispatchEvent(new Event("ai-usage-changed"));
      await loadSpecs();
    } catch {
      setError(
        "We couldn't analyze that spec. Try again, or refresh the page.",
      );
    } finally {
      setUploading(false);
      setAnalyzing(false);
    }
  }

  async function applySpec(specId: string) {
    setApplying(true);
    setApplyResult(null);
    const res = await fetch("/api/ai/specs/apply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, specId }),
    });
    const json = await res.json();
    setApplying(false);
    if (res.ok) {
      setApplyResult(`Updated ${json.updated} surfaces with spec paint types.`);
    } else {
      setError(json.error ?? "Something went wrong applying the spec.");
    }
  }

  const latestSpec = specs[0] ?? null;
  const summary = latestSpec?.summary ?? null;

  return (
    <AppShell>
      <TopBar
        title="Spec reader"
        subtitle="Upload a paint spec PDF — the AI pulls out scope, finishes, and exclusions"
      >
        <UsageBadge />
        <Link href={`/projects/${projectId}`}>
          <Button variant="ghost" size="sm">
            Back to project
          </Button>
        </Link>
      </TopBar>

      <main className="flex-1 px-6 py-8">
        <div className="mx-auto max-w-4xl space-y-6">
          <div
            className="rounded-lg border-2 border-dashed border-gray-300 bg-white p-8 text-center"
            data-testid="spec-upload-zone"
          >
            <h2 className="text-lg font-semibold text-gray-900">
              Upload a specifications PDF
            </h2>
            <p className="mx-auto mt-2 max-w-md text-sm text-gray-600">
              The AI reads CSI Division 09 90 00 and pulls out paint scope,
              finish schedules, flagged requirements, and exclusions.
            </p>
            <input
              ref={fileRef}
              type="file"
              accept="application/pdf,.pdf"
              className="hidden"
              data-testid="spec-file-input"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void uploadAndAnalyze(f);
              }}
            />
            <div className="mt-5">
              <Button
                onClick={() => fileRef.current?.click()}
                disabled={uploading || analyzing}
                size="lg"
                data-testid="upload-spec-button"
              >
                {uploading
                  ? "Uploading..."
                  : analyzing
                    ? "Analyzing... this takes about 30 seconds"
                    : "Choose a spec PDF"}
              </Button>
            </div>
            {analyzing && (
              <div
                className="mt-4 text-sm text-blue-700"
                data-testid="spec-analyzing"
              >
                Reading your spec... please don&apos;t close the page.
              </div>
            )}
            {error && (
              <div
                role="alert"
                className="mt-4 rounded-md bg-red-50 px-3 py-2 text-sm text-red-800"
              >
                {error}
              </div>
            )}
          </div>

          {summary && (
            <>
              <SectionTitle>Paint scope</SectionTitle>
              <div
                className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm"
                data-testid="paint-scope"
              >
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-600">
                    <tr>
                      <th className="px-4 py-2 text-left">Area</th>
                      <th className="px-4 py-2 text-left">Surface</th>
                      <th className="px-4 py-2 text-left">Paint type</th>
                      <th className="px-4 py-2 text-left">Sheen</th>
                      <th className="px-4 py-2 text-right">Coats</th>
                      <th className="px-4 py-2 text-left">Color</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {summary.paintScope.map((p, i) => (
                      <tr key={i}>
                        <td className="px-4 py-2">{p.area}</td>
                        <td className="px-4 py-2">{p.surface}</td>
                        <td className="px-4 py-2">{p.paintType}</td>
                        <td className="px-4 py-2">{p.sheen ?? "—"}</td>
                        <td className="px-4 py-2 text-right">{p.coats}</td>
                        <td className="px-4 py-2">{p.color ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <SectionTitle>Finish schedule</SectionTitle>
              <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-xs uppercase tracking-wide text-gray-600">
                    <tr>
                      <th className="px-4 py-2 text-left">Room</th>
                      <th className="px-4 py-2 text-left">Paint type</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {summary.finishSchedule.map((f, i) => (
                      <tr key={i}>
                        <td className="px-4 py-2">{f.room}</td>
                        <td className="px-4 py-2">{f.paintType}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {summary.flaggedRequirements.length > 0 && (
                <>
                  <SectionTitle>Flagged requirements</SectionTitle>
                  <div className="space-y-3" data-testid="flagged-requirements">
                    {summary.flaggedRequirements.map((f, i) => (
                      <FlaggedCard key={i} item={f} />
                    ))}
                  </div>
                </>
              )}

              {summary.exclusions.length > 0 && (
                <>
                  <SectionTitle>Exclusions</SectionTitle>
                  <ul className="list-disc space-y-1 rounded-lg border border-gray-200 bg-white p-4 pl-8 text-sm text-gray-700 shadow-sm">
                    {summary.exclusions.map((e, i) => (
                      <li key={i}>{e}</li>
                    ))}
                  </ul>
                </>
              )}

              <div className="pt-4">
                {applyResult && (
                  <div
                    className="mb-3 rounded-md bg-green-50 px-3 py-2 text-sm text-green-800"
                    data-testid="apply-result"
                  >
                    {applyResult}
                  </div>
                )}
                <Button
                  size="lg"
                  onClick={() => latestSpec && void applySpec(latestSpec.id)}
                  disabled={applying || !latestSpec}
                  data-testid="apply-spec-button"
                >
                  {applying
                    ? "Applying..."
                    : "Apply spec to project"}
                </Button>
              </div>
            </>
          )}
        </div>
      </main>
    </AppShell>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mt-2 text-lg font-semibold text-gray-900">{children}</h3>
  );
}

function FlaggedCard({ item }: { item: FlaggedReq }) {
  const color =
    item.risk === "high"
      ? "border-red-300 bg-red-50 text-red-900"
      : item.risk === "medium"
        ? "border-orange-300 bg-orange-50 text-orange-900"
        : "border-yellow-300 bg-yellow-50 text-yellow-900";
  return (
    <div
      data-testid="flagged-item"
      className={`rounded-lg border px-4 py-3 ${color}`}
    >
      <div className="flex items-center justify-between">
        <h4 className="font-semibold">{item.item}</h4>
        <span className="rounded-full bg-white/60 px-2 py-0.5 text-xs font-medium uppercase tracking-wide">
          {item.risk}
        </span>
      </div>
      <p className="mt-1 text-sm italic">&ldquo;{item.quote}&rdquo;</p>
    </div>
  );
}
