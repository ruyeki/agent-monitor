import { useState } from 'react';
import { respond } from './api.js';
import { Ago } from './Ago.jsx';

export function WaitingCard({ run, onDone }) {
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState(null);

  async function send(action) {
    setPosting(true);
    setError(null);
    try {
      await respond(run.id, action, text);
      setText('');
      onDone?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setPosting(false);
    }
  }

  return (
    <article className="card waiting-card" aria-label={`Waiting on you: ${run.title}`}>
      <header className="card-head">
        <h3>{run.title}</h3>
        <span className="muted">
          {run.stageName || run.stage} · round {run.round}/{run.maxRounds} · <Ago at={run.updatedAt} />
        </span>
      </header>
      <p className="ask">{run.ask}</p>
      {run.textField && (
        <textarea
          aria-label={`Reply for ${run.title}`}
          rows={3}
          value={text}
          disabled={posting}
          onChange={(e) => setText(e.target.value)}
          placeholder="Your reply (optional)"
        />
      )}
      <div className="actions">
        {(run.actions || []).map((a) => (
          <button key={a.label} type="button" disabled={posting} onClick={() => send(a.label)}>
            {a.label}
          </button>
        ))}
      </div>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}

export function WaitingCards({ runs, onDone }) {
  return (
    <section aria-labelledby="waiting-h">
      <h2 id="waiting-h">Waiting on you ({runs.length})</h2>
      {runs.length === 0 && <p className="muted">Nothing is waiting on you.</p>}
      <div className="cards">
        {runs.map((r) => (
          <WaitingCard key={r.id} run={r} onDone={onDone} />
        ))}
      </div>
    </section>
  );
}
