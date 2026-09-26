'use client';

/**
 * Ask LockFi: a short conversation about the pool on screen (server/api/ask.ts).
 *
 * The panel renders nothing until the API says the assistant is on, so a box
 * that could only fail is never offered — on simulated data (see
 * `askReachable`), or on a box without a key. It explains figures and trade-offs; it does not forecast,
 * and the line under it says so.
 */

import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { ask, type AskPlan, type AskPosition, type AskTurn } from '@/lib/ask';
import { useAskStatus } from './useAskStatus';

const QUESTION_MAX = 500;

export function AskPanel({
  poolId = null,
  plan = null,
  position = null,
  suggestions,
  title = 'Ask LockFi AI',
  placeholder = 'Ask about this pool, a shape or a risk',
  page = false,
}: {
  poolId?: string | null;
  plan?: AskPlan | null;
  /** One of the person's positions, from a portfolio row. */
  position?: AskPosition | null;
  suggestions: string[];
  title?: string;
  placeholder?: string;
  /** The full-page version on /ask: taller, and says so when the assistant is off rather than vanishing. */
  page?: boolean;
}) {
  const status = useAskStatus();
  const [turns, setTurns] = useState<AskTurn[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  // A conversation is about one pool: another pool starts a fresh one.
  useEffect(() => {
    setTurns([]);
    setError(null);
  }, [poolId]);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [turns, busy]);

  if (!status?.enabled) {
    // Inside the drawer or the builder the panel is extra, and silence is right.
    // On its own page it is the page, so it says what is happening.
    if (!page) return null;
    return (
      <section className="ask ask-page" aria-label={title} data-testid="ask-off">
        <div className="ask-h">
          <span className="ask-dot" aria-hidden="true" />
          <b>{title}</b>
        </div>
        <p className="ask-a" style={{ marginTop: 10 }}>
          {status === null ? 'Connecting to the assistant…' : 'The assistant is not switched on here yet.'}
        </p>
      </section>
    );
  }

  const send = async (text: string) => {
    const question = text.trim().slice(0, QUESTION_MAX);
    if (!question || busy) return;
    setBusy(true);
    setError(null);
    setDraft('');
    const history = turns;
    setTurns([...history, { role: 'user', content: question }]);
    const result = await ask({ question, history, poolId, plan, position });
    if (result.ok) {
      setTurns((prev) => [...prev, { role: 'assistant', content: result.answer }]);
    } else {
      // The question stays on screen and goes back in the box, so it can be sent again.
      setTurns(history);
      setDraft(question);
      setError(result.message);
    }
    setBusy(false);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send(draft);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void send(draft);
    }
  };

  return (
    <section className={page ? 'ask ask-page' : 'ask'} aria-label={title} data-testid="ask-panel">
      <div className="ask-h">
        <span className="ask-dot" aria-hidden="true" />
        <b>{title}</b>
      </div>

      {turns.length === 0 && !busy ? (
        <div className="ask-chips">
          {suggestions.map((s) => (
            <button key={s} type="button" className="ask-chip" onClick={() => void send(s)}>
              {s}
            </button>
          ))}
        </div>
      ) : (
        <div className="ask-log" ref={logRef} aria-live="polite">
          {turns.map((t, i) => (
            <p key={i} className={t.role === 'user' ? 'ask-q' : 'ask-a'}>
              {t.content}
            </p>
          ))}
          {busy && <p className="ask-a ask-wait">{position ? 'Reading this position…' : poolId ? 'Reading this pool’s figures…' : 'Thinking…'}</p>}
        </div>
      )}

      {error && (
        <p className="ask-err" role="alert">
          {error}
        </p>
      )}

      <form className="ask-form" onSubmit={onSubmit}>
        <label className="sr-only" htmlFor={`ask-${position?.tokenId ?? poolId ?? 'general'}`}>
          Your question
        </label>
        <textarea
          id={`ask-${position?.tokenId ?? poolId ?? 'general'}`}
          rows={1}
          value={draft}
          maxLength={QUESTION_MAX}
          placeholder={placeholder}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={busy}
        />
        <button className="btn btn-brand btn-sm" type="submit" disabled={busy || draft.trim() === ''}>
          Ask
        </button>
      </form>
      <p className="ask-foot">
        Explains the figures on this page. It never predicts prices and is not financial advice.
      </p>
    </section>
  );
}
