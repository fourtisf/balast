import type { Metadata } from 'next';
import { AskWorkspace } from '@/components/ask/AskWorkspace';
import { Masthead } from '@/components/shell/Masthead';

export const metadata: Metadata = { title: 'Ask AI' };

export default function AskPage() {
  return (
    <section>
      <Masthead
        eyebrow="Ask AI"
        title="Ask LockFi AI"
        lede="Questions about a pool, a shape, a fee tier or a risk, answered from the figures LockFi shows. It explains; it never predicts prices."
      />
      <AskWorkspace />
    </section>
  );
}
