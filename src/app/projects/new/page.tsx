"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AppShell, TopBar } from "@/components/nav/AppShell";

export default function NewProjectPage() {
  const router = useRouter();
  const [name, setName] = useState("");
  const [clientName, setClientName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) {
      setError("Please give your project a name first.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, clientName: clientName || undefined }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(
          json.error ??
            "Something went wrong creating your project. Try again, or refresh the page.",
        );
        setSubmitting(false);
        return;
      }
      const { project } = await res.json();
      router.push(`/projects/${project.id}`);
    } catch {
      setError(
        "Something went wrong creating your project. Try again, or refresh the page.",
      );
      setSubmitting(false);
    }
  }

  return (
    <AppShell>
      <TopBar title="New project" subtitle="Set up a new bid" />
      <main className="flex-1 overflow-y-auto px-6 py-8">
        <div className="mx-auto max-w-2xl">
          <Link
            href="/"
            className="text-[13px] text-[hsl(var(--brand))] hover:underline"
          >
            ← Back to projects
          </Link>

          <form
            onSubmit={onSubmit}
            className="mt-6 rounded-[8px] border border-[hsl(var(--line))] bg-white p-6 shadow-sm"
          >
            <div className="space-y-5">
              <div>
                <Label htmlFor="name" className="text-[13px]">
                  Project name <span className="text-red-600">*</span>
                </Label>
                <Input
                  id="name"
                  data-testid="project-name-input"
                  placeholder="e.g. Memorial Hospital — Wing C"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-1.5"
                  autoFocus
                  required
                />
                <p className="mt-1.5 text-[12px] text-[hsl(var(--ink-3))]">
                  Building name, address, or job number works best.
                </p>
              </div>

              <div>
                <Label htmlFor="client" className="text-[13px]">
                  Client name (optional)
                </Label>
                <Input
                  id="client"
                  data-testid="client-name-input"
                  placeholder="e.g. Acme General Contractors"
                  value={clientName}
                  onChange={(e) => setClientName(e.target.value)}
                  className="mt-1.5"
                />
                <p className="mt-1.5 text-[12px] text-[hsl(var(--ink-3))]">
                  The GC or owner this bid will be sent to.
                </p>
              </div>

              {error && (
                <div
                  role="alert"
                  className="rounded-[6px] border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-800"
                >
                  {error}
                </div>
              )}
            </div>

            <div className="mt-6 flex items-center justify-end gap-2 border-t border-[hsl(var(--line))] pt-4">
              <Link href="/">
                <Button type="button" variant="secondary">
                  Cancel
                </Button>
              </Link>
              <Button
                type="submit"
                disabled={submitting}
                data-testid="submit-project-button"
              >
                {submitting ? "Creating…" : "Create project"}
              </Button>
            </div>
          </form>
        </div>
      </main>
    </AppShell>
  );
}
