import Link from "next/link";

export default function SettingsPage() {
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
          <div className="mb-6">
            <Link href="/" className="text-sm text-blue-600 hover:underline">
              &larr; Back to dashboard
            </Link>
          </div>
          <h2 className="text-2xl font-bold text-gray-900">Settings</h2>
          <p className="mt-2 text-sm text-gray-600">
            Tune defaults that apply to every project: labor rates, paint
            catalog, painter rules, and the saved tool chest.
          </p>
          <div className="mt-8 grid gap-4 sm:grid-cols-2">
            <SettingsCard
              title="Labor rates"
              description="Hourly cost and production rates for walls, ceilings, trim, and more."
              href="/settings/rates"
            />
            <SettingsCard
              title="Painter rules"
              description="Standing instructions the AI follows on every project."
              href="/settings/rules"
            />
            <SettingsCard
              title="Tool chest"
              description="Saved paint assemblies you can apply to surfaces in one click."
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
    </div>
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
      className="block rounded-lg border border-gray-200 bg-white p-5 shadow-sm transition-colors hover:bg-gray-50"
    >
      <h3 className="font-semibold text-gray-900">{title}</h3>
      <p className="mt-2 text-sm text-gray-600">{description}</p>
      <div className="mt-3 text-sm font-medium text-blue-600">Open &rarr;</div>
    </Link>
  );
}
