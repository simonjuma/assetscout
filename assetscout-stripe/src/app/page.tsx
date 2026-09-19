import Link from 'next/link';

export default function HomePage() {
  return (
    <>
      <section className="as-card">
        <h1>AssetScout</h1>
        <p className="as-muted">
          Property investment intelligence: search, scoring, verification, pipeline, portfolio and
          reporting. Subscription billing is handled by Stripe Checkout and the Stripe Billing
          Portal.
        </p>
        <div className="as-row">
          <Link className="as-btn as-btn--primary" href="/pricing">
            View plans
          </Link>
          <Link className="as-btn" href="/billing">
            Manage billing
          </Link>
        </div>
      </section>

      <section className="as-card">
        <h2>How billing works here</h2>
        <ul>
          <li>Prices and limits are stored in the database, never hard-coded in pages.</li>
          <li>
            Access is granted only by the Stripe webhook writing subscription state — never by the
            checkout success page.
          </li>
          <li>Stripe secret keys stay server-side in environment variables.</li>
        </ul>
      </section>
    </>
  );
}
