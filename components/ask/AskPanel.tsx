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
import { ask, askReachable, askStatus, type AskPlan, type AskStatus, type AskTurn } from '@/lib/ask';
import { DATA_SOURCE } from '@/lib/data';

const QUESTION_MAX = 500;

export function AskPanel({
  poolId = null,
  plan = null,
  suggestions,
  title = 'Ask LockFi AI',
}: {
  poolId?: string | null;
  plan?: AskPlan | null;
  suggestions: string[];
  title?: string;
}) {
  const [status, setStatus] = useState<AskStatus | null>(null);
  const [turns, setTurns] = useState<AskTurn[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!askReachable(DATA_SOURCE === 'live')) return;
    let alive = true;
    void askStatus().then((s) => alive && setStatus(s));
    return () => {
      alive = false;
    };
  }, []);

  // A conversation is about one pool: another pool starts a fresh one.
  useEffect(() => {
    setTurns([]);
    setError(null);
  }, [poolId]);

  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [turns, busy]);

  if (!status?.enabled) return null;

  const send = async (text: string) => {
    const question = text.trim().slice(0, QUESTION_MAX);
    if (!question || busy) return;
    setBusy(true);
    setError(null);
    setDraft('');
    const history = turns;
    setTurns([...history, { role: 'user', content: question }]);
    const result = await ask({ question, history, poolId, plan });
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
    <section className="ask" aria-label={title} data-testid="ask-panel">
      <div className="ask-h">
        <span className="ask-dot" aria-hidden="true" />
        <b>{title}</b>
        {status.provider && <span className="ask-via">via {status.provider}</span>}
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
          {busy && <p className="ask-a ask-wait">Reading this pool’s figures…</p>}
        </div>
      )}

      {error && (
        <p className="ask-err" role="alert">
          {error}
        </p>
      )}

      <form className="ask-form" onSubmit={onSubmit}>
        <label className="sr-only" htmlFor={`ask-${poolId ?? 'general'}`}>
          Your question
        </label>
        <textarea
          id={`ask-${poolId ?? 'general'}`}
          rows={1}
          value={draft}
          maxLength={QUESTION_MAX}
          placeholder="Ask in English or Bahasa Indonesia"
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
