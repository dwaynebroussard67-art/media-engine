import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Media Engine',
  description: 'Misfit / Forge content review and gallery.',
};

// Global top nav — every screen of the machine is one tap away.
// D operates one-handed from a phone; keep targets tall and labels short.
function TopNav() {
  return (
    <header className="sticky top-0 z-50 border-b border-neutral-800 bg-neutral-950/90 backdrop-blur">
      <nav
        aria-label="Primary"
        className="mx-auto flex max-w-3xl items-center justify-between px-4 py-2.5"
      >
        <Link
          href="/"
          className="text-sm font-bold tracking-widest text-neutral-100"
        >
          MEDIA<span className="text-emerald-500">·</span>ENGINE
        </Link>
        <div className="flex items-center gap-1 text-sm">
          <Link
            href="/"
            className="rounded px-3 py-2 text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100"
          >
            Home
          </Link>
          <Link
            href="/review"
            className="rounded px-3 py-2 text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100"
          >
            Review
          </Link>
          <Link
            href="/gallery"
            className="rounded px-3 py-2 text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100"
          >
            Gallery
          </Link>
        </div>
      </nav>
    </header>
  );
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body className="bg-neutral-950 text-neutral-100 antialiased">
        <TopNav />
        {children}
      </body>
    </html>
  );
}
