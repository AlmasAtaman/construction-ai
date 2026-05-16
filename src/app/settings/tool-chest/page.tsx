import Link from "next/link";

export default function ToolChestPage() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="flex h-16 items-center border-b border-gray-200 bg-white px-6">
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
          <h2 className="mt-4 text-2xl font-bold text-gray-900">Tool chest</h2>
          <p className="mt-2 text-sm text-gray-600">
            Save paint assemblies (e.g. &ldquo;Bathroom semi-gloss epoxy, 2
            coats&rdquo;) and apply them with one click in chat. Coming in a
            future update.
          </p>
        </div>
      </main>
    </div>
  );
}
