import { useState } from 'react';
import { respond } from './api.js';
import { Ago } from './Ago.jsx';
import { CodexTag } from './RunsTable.jsx';
import { parseAsk, splitCode } from './lib/ask.js';

function Code({ text }) {
  return splitCode(text).map((s, i) => (s.code ? <code key={i}>{s.text}</code> : s.text));
}

function Ask({ text }) {
  const { heading, blocks } = parseAsk(text);
  if (!heading) return null;
  return (
    <div className="ask">
      <h4 className="ask-heading"><Code text={heading} /></h4>
      {blocks.map((b, i) =>
        b.kind === 'row' ? (
          <div key={i} className="ask-row">
            <span className="ask-label">{b.label}</span>
            <span className="ask-text"><Code text={b.text} /></span>
          </div>
        ) : (
          <p key={i} className="ask-para"><Code text={b.text} /></p>
        ),
      )}
    </div>
  );
}

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
        <h3>{run.title}<CodexTag run={run} /></h3>
        <span className="muted">
          {run.stageName || run.stage} · round {run.round}/{run.maxRounds} · <Ago at={run.updatedAt} />
        </span>
      </header>
      <Ask text={run.ask} />
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
