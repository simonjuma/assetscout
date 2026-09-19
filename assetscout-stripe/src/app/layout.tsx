import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'AssetScout',
  description: 'AssetScout — property investment intelligence and acquisition workflow.',
};

/**
 * Root layout. Intentionally tiny: it exists so the billing surfaces
 * (pricing, billing dashboard, checkout result pages) render inside the app
 * shell. When this is merged into the real AssetScout repo, keep that repo's
 * layout and only port the pages under `src/app/pricing` and `src/app/billing`.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="as-header">
          <Link className="as-brand" href="/">
            AssetScout
          </Link>
          <nav className="as-nav" aria-label="Main">
            <Link href="/pricing">Pricing</Link>
            <Link href="/billing">Billing</Link>
          </nav>
        </header>
        <main className="as-main">{children}</main>
      </body>
    </html>
  );
}
