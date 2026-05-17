import Link from "next/link";
import { AppShell, TopBar } from "@/components/nav/AppShell";

export default function SettingsPage() {
  return (
    <AppShell>
      <TopBar title="Settings" subtitle="Defaults for every project" />
      <main className="flex-1 px-6 py-10">
        <div className="mx-auto max-w-3xl">
          <p className="text-[13px] text-[hsl(var(--ink-2))]">
            Tune defaults that apply to every project: labor rates, paint
            catalog, painter rules, and the saved tool chest.
          </p>
          <div className="mt-6 grid gap-4 sm:grid-cols-2">
            <SettingsCard
              title="Labor rates"
              description="Hourly cost and how fast your crew paints — walls, ceilings, trim, and more."
              href="/settings/rates"
            />
            <SettingsCard
              title="Painter rules"
              description="Standing instructions the AI follows on every project."
              href="/settings/rules"
            />
            <SettingsCard
              title="Tool chest"
              description="Saved paint bundles you can apply to rooms in one click."
              href="/settings/tool-chest"
            />
            <SettingsCard
              title="AI usage"
              description="See how much of today's AI budget you've used and what for."
              href="/settings/usage"
            />
          </div>
        </div>
      </main>
    </AppShell>
  );
}

function SettingsCard({
  title,
  description,
  href,
}: {
  title: string;
  description: string;
  href: string;
}) {
  return (
    <Link
      href={href}
      className="block rounded-[8px] border border-[hsl(var(--line))] bg-white p-5 shadow-sm transition-colors hover:bg-[hsl(var(--surface-2))]"
    >
      <h3 className="text-[14px] font-semibold text-[hsl(var(--ink-1))]">
        {title}
      </h3>
      <p className="mt-2 text-[12px] text-[hsl(var(--ink-2))]">{description}</p>
      <div className="mt-3 text-[12px] font-medium text-[hsl(var(--brand))]">
        Open &rarr;
      </div>
    </Link>
  );
}
