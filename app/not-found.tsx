import Link from 'next/link';

export default function NotFound() {
  return (
    <section>
      <div className="head">
        <div>
          <div className="eyebrow" style={{ display: 'block', marginBottom: 12 }}>
            404
          </div>
          <h1>
            There&rsquo;s no pool <em>here</em>.
          </h1>
          <p className="lede">
            That page doesn&rsquo;t exist. The listing is the place to start.
          </p>
        </div>
      </div>
      <div className="row">
        <Link className="btn btn-brand" href="/pools">
          Go to pools
        </Link>
        <Link className="btn btn-ghost" href="/portfolio">
          Your portfolio
        </Link>
      </div>
    </section>
  );
}
