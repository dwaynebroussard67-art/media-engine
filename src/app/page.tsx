// src/app/page.tsx
// Root landing page — the engine previously had no route at "/" (404).
// Static server component: links to the two operator surfaces.

import Link from 'next/link';

export default function HomePage() {
  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <div className="max-w-xl mx-auto px-6 py-20 flex flex-col gap-8">
        <header className="flex flex-col gap-2">
          <h1 className="text-3xl font-bold tracking-tight">Media Engine</h1>
          <p className="text-neutral-400">
            Governed content pipeline for <span className="text-neutral-200">Misfit</span>{' '}
            and <span className="text-neutral-200">Forge</span>. Candidates are generated,
            oracle-gated, and wait here for a human decision — Post, Remix, or Reject.
          </p>
        </header>

        <nav className="grid gap-3" aria-label="Operator surfaces">
          <Link
            href="/review"
            className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-5 hover:border-neutral-600 transition-colors"
          >
            <span className="block font-semibold text-lg">Review queue</span>
            <span className="block text-sm text-neutral-400 mt-1">
              Phone-first decision UI. Sign in with email OTP and work the
              pending queue one-handed.
            </span>
          </Link>

          <Link
            href="/gallery"
            className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-5 hover:border-neutral-600 transition-colors"
          >
            <span className="block font-semibold text-lg">Gallery</span>
            <span className="block text-sm text-neutral-400 mt-1">
              Permanent, append-only asset store. Upload seed imagery here;
              approved posts land here automatically.
            </span>
          </Link>
        </nav>

        <footer className="text-xs text-neutral-600 border-t border-neutral-900 pt-4">
          Reader / Oracle / Overseer — the human operator is the final ground truth.
        </footer>
      </div>
    </main>
  );
}
