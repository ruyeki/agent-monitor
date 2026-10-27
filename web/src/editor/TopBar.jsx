import { useState } from 'react';
import { formatDuration, formatTokens } from '../lib/format.js';

const STATUS_TEXT = { saved: 'Draft — saved', unsaved: 'Draft — unsaved', saving: 'Draft — saving…', error: 'Draft — save failed' };

export function TopBar({ published, status, versions, onPublish, onDiscard, onLoadVersion, onLayout }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="topbar">
      <strong>{published ? `Published v${published.version}` : 'Not published'}</strong>
      <span role="status">{STATUS_TEXT[status]}</span>
      <span className="spacer" />
      <button type="button" onClick={onLayout}>
        Auto-layout
      </button>
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        Versions
      </button>
      <button type="button" onClick={onDiscard}>
        Discard
      </button>
      <button type="button" className="primary" onClick={onPublish}>
        Publish
      </button>
      {open && (
        <section className="versions" aria-label="Versions">
          <table>
            <thead>
              <tr>
                <th>Version</th>
                <th>Published</th>
                <th>Nodes</th>
                <th>Finished runs</th>
                <th>Avg tokens</th>
                <th>Avg duration</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.version}>
                  <td>v{v.version}</td>
                  <td>{new Date(v.publishedAt).toLocaleString()}</td>
                  <td>{v.nodes}</td>
                  <td>{v.stats?.finishedRuns ?? 0}</td>
                  <td>{v.stats?.finishedRuns ? formatTokens(v.stats.avgTokens) : '-'}</td>
                  <td>{v.stats?.finishedRuns ? formatDuration(v.stats.avgDurationMs) : '-'}</td>
                  <td>
                    <button type="button" aria-label={`Load v${v.version} into draft`} onClick={() => onLoadVersion(v.version)}>
                      Load into draft
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}
