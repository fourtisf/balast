/**
 * Shown while a page's data source is still connecting. Deliberately shaped
 * like the content it replaces, and deliberately empty of numbers.
 */
export default function Loading() {
  return (
    <section aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading pool data</span>
      <div className="hero">
        <div className="card feat skeleton" style={{ minHeight: 220 }} />
        <div className="mini-cards">
          <div className="card skeleton" style={{ minHeight: 104 }} />
          <div className="card skeleton" style={{ minHeight: 104 }} />
        </div>
      </div>
      <div className="boards">
        <div className="card skeleton" style={{ minHeight: 420 }} />
        <div className="card skeleton" style={{ minHeight: 420 }} />
      </div>
    </section>
  );
}
