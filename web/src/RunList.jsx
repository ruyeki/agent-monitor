import { roundsLabel } from './lib/format.js';
import { runHref } from './lib/route.js';
import { Ago } from './Ago.jsx';

export const CodexTag = ({ run }) => (run?.provider === 'codex' ? <span className="badge codex">Codex</span> : null);

export function StatusBadge({ status }) {
  return <span className={`badge status-${status}`}>{status}</span>;
}

export const stageLabel = (r) => (r.active?.length > 1 ? r.active.map((a) => a.name || a.id).join(' + ') : r.stageName || r.stage);

const ICONS = {
  waiting: { label: 'Waiting on you', cls: 'si-waiting', paths: [<circle key="c" cx="12" cy="12" r="9" />, <path key="p" d="M10 9v6M14 9v6" />] },
  running: {
    label: 'Running',
    cls: 'si-running',
    paths: [<circle key="c" cx="12" cy="12" r="9" strokeOpacity="0.35" />, <path key="p" d="M12 3a9 9 0 0 1 9 9" />],
  },
  done: { label: 'Done', cls: 'si-done', paths: [<circle key="c" cx="12" cy="12" r="9" />, <path key="p" d="m8 12 3 3 5-6" />] },
  stopped: { label: 'Stopped', cls: 'si-stopped', paths: [<circle key="c" cx="12" cy="12" r="9" />, <path key="p" d="m9 9 6 6M15 9l-6 6" />] },
};

// Status as icon + accessible name; the colour is a second cue, never the only one.
export function StatusIcon({ status, size = 16 }) {
  const i = ICONS[ICONS[status] ? status : 'running'];
  return (
    <svg className={`status-icon ${i.cls}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" role="img" aria-label={i.label}>
      {i.paths}
    </svg>
  );
}

function RowBody({ run }) {
  return (
    <>
      <StatusIcon status={run.status} />
      <span className="run-title">{run.title}</span>
      <span className="row-meta">
        <CodexTag run={run} />
        <span className="mono">{run.id}</span>
        <span className="stage-pill">{stageLabel(run)}</span>
        <span className="run-rounds">{roundsLabel(run)}</span>
        <span className="run-age">
          <Ago at={run.updatedAt} />
        </span>
      </span>
    </>
  );
}

// Waiting rows select into the answer pane; every other row opens the run view.
export function RunList({ runs, selectedId, onSelect }) {
  return (
    <ul className="run-rows">
      {runs.map((r) => (
        <li key={r.id}>
          {r.status === 'waiting' ? (
            <button type="button" className="run-row" aria-pressed={r.id === selectedId} onClick={() => onSelect?.(r.id)}>
              <RowBody run={r} />
            </button>
          ) : (
            <a className="run-row" href={runHref(r.id)}>
              <RowBody run={r} />
            </a>
          )}
        </li>
      ))}
    </ul>
  );
}
