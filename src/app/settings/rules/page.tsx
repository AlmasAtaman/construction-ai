"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { AppShell, TopBar } from "@/components/nav/AppShell";

export default function RulesPage() {
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    fetch("/api/settings/rules")
      .then((r) => r.json())
      .then((j) => {
        setText(
          (j.rules ?? [])
            .map((r: { rule: string }) => r.rule)
            .join("\n"),
        );
      });
  }, []);

  async function save() {
    setSaving(true);
    setSaved(false);
    const rules = text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((rule) => ({ rule, category: "general", active: true }));
    await fetch("/api/settings/rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rules }),
    });
    setSaving(false);
    setSaved(true);
    window.dispatchEvent(new Event("settings-changed"));
    setTimeout(() => setSaved(false), 2500);
  }

  return (
    <AppShell>
      <TopBar
        title="Painter rules"
        subtitle="Standing instructions the AI follows on every project"
      >
        <Link
          href="/settings"
          className="text-[12px] text-[hsl(var(--ink-2))] hover:text-[hsl(var(--ink-1))]"
        >
          ← Settings
        </Link>
      </TopBar>
      <main className="flex-1 px-6 py-10">
        <div className="mx-auto max-w-3xl">
          <p className="text-[13px] text-[hsl(var(--ink-2))]">
            One rule per line, in plain English. The AI follows these every
            time it measures a plan.
          </p>

          <div className="mt-4 rounded-md bg-blue-50 px-4 py-3 text-sm text-blue-900">
            <strong>Examples:</strong>
            <ul className="mt-1 list-inside list-disc">
              <li>Always use net deduction for commercial bids.</li>
              <li>Always use 12% waste factor for interior work.</li>
              <li>Doors and frames are always semi-gloss enamel.</li>
            </ul>
          </div>

          <div className="mt-6 rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              rows={10}
              className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              placeholder="Always use net deduction for commercial bids."
              data-testid="rules-textarea"
            />

            <div className="mt-4 flex items-center justify-end gap-2">
              {saved && (
                <span
                  className="text-sm text-green-700"
                  data-testid="saved-toast"
                >
                  Saved.
                </span>
              )}
              <Button
                onClick={save}
                disabled={saving}
                data-testid="save-rules"
              >
                {saving ? "Saving..." : "Save painter rules"}
              </Button>
            </div>
          </div>
        </div>
      </main>
    </AppShell>
  );
}
