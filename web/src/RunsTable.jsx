import { roundsLabel } from './lib/format.js';
import { Ago } from './Ago.jsx';

export function StatusBadge({ status }) {
  return <span className={`badge status-${status}`}>{status}</span>;
}

export function RunsTable({ runs, selectedId, onSelect, caption }) {
  if (!runs.length) return <p className="muted">None.</p>;
  const onKey = (r) => (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect(r.id);
    }
  };
  return (
    <table className="runs">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          <th>Run</th>
          <th>Stage</th>
          <th>Rounds</th>
          <th>Last verdict</th>
          <th>Updated</th>
        </tr>
      </thead>
      <tbody>
        {runs.map((r) => (
          <tr
            key={r.id}
            tabIndex={0}
            className={r.id === selectedId ? 'selected' : ''}
            aria-selected={r.id === selectedId}
            onClick={() => onSelect(r.id)}
            onKeyDown={onKey(r)}
          >
            <td>
              <strong>{r.title}</strong> <span className="muted mono">{r.id}</span>
              {r.status === 'waiting' && <StatusBadge status="waiting" />}
            </td>
            <td>{r.stageName || r.stage}</td>
            <td>{roundsLabel(r)}</td>
            <td>{r.verdict || '-'}</td>
            <td><Ago at={r.updatedAt} /></td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
