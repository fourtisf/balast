import Link from 'next/link';
import { Masthead } from '@/components/shell/Masthead';

export default function NotFound() {
  return (
    <section>
      <Masthead
        eyebrow="404"
        title={
          <>
            There&rsquo;s no pool <em>here</em>.
          </>
        }
        lede="That page doesn’t exist. The listing is the place to start."
        actions={
          <>
            <Link className="btn btn-brand" href="/pools">
              Go to pools
            </Link>
            <Link className="btn btn-ghost" href="/portfolio">
              Your portfolio
            </Link>
          </>
        }
      />
    </section>
  );
}
