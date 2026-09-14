/**
 * Shown while a page's data source is still connecting. Deliberately shaped
 * like the content it replaces, and deliberately empty of numbers.
 */
export default function Loading() {
  return (
    <section aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading pool data</span>
      <div className="mast">
        <div className="mast-l">
          <div className="skeleton sk-line" style={{ width: 220 }} />
          <div className="skeleton sk-line lg" />
          <div className="skeleton sk-line lg" style={{ width: '70%' }} />
        </div>
        <div className="mast-r">
          <div className="skeleton" style={{ height: 128 }} />
        </div>
      </div>
      <div className="lb-rows">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="skeleton sk-row" />
        ))}
      </div>
    </section>
  );
}
