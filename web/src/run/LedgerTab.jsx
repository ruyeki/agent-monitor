import { useEffect, useState } from 'react';
import { Ago } from '../Ago.jsx';
import { getLedger } from '../api.js';
import { useThrottledTick } from '../hooks.js';

const FILTERS = [['all', 'All'], ['code', 'Code'], ['tasks', 'Tasks'], ['machines', 'Machines']];
const svg = { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' };
const ICONS = {
  commit: [<circle key="a" cx="12" cy="12" r="3.5" />, <path key="b" d="M3 12h5.5M15.5 12H21" />],
  push: [<path key="a" d="M12 19V5M5 12l7-7 7 7" />],
  'task-status': [<rect key="a" x="4" y="4" width="16" height="16" rx="3" />, <path key="b" d="m8 12 3 3 5-6" />],
  restart: [<path key="a" d="M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5" />],
  db: [<ellipse key="a" cx="12" cy="5" rx="8" ry="3" />, <path key="b" d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />],
  worktree: [<path key="a" d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />],
  merge: [<circle key="a" cx="6" cy="6" r="2.5" />, <circle key="b" cx="18" cy="18" r="2.5" />, <path key="c" d="M6 8.5v3a4 4 0 0 0 4 4h5.5" />],
  other: [<circle key="a" cx="12" cy="12" r="3.5" />],
};
const iconKey = (k = '') => (k.startsWith('db-') ? 'db' : k.startsWith('worktree') ? 'worktree' : k.startsWith('pr-') || k === 'merge' ? 'merge' : ICONS[k] ? k : 'other');
const nf = (n) => Number(n || 0).toLocaleString('en-US');
const COMMIT = /^Committed ([0-9a-f]{7,40})(?: (.*))?$/;
const STAT_CHIP = /^(\+\d|−\d|\d+ files?$)/;

// One change: icon, what happened (plain text only), chips, detail, the tag and the age. Read-only: nothing here undoes anything.
function Row({ item }) {
  const commit = item.kind === 'commit' ? COMMIT.exec(item.title || '') : null;
  const stats = item.kind === 'commit' && item.stats ? item.stats : null;
  // a commit's +/-/files chips are drawn from item.stats below, so the plain chip strings are dropped
  const chips = (item.chips || []).filter((c) => !(stats && STAT_CHIP.test(c)));
  return (
    <li className="lg" data-tag={item.tag} data-kind={item.kind} data-category={item.category}>
      <span className="ico">
        <svg {...svg}>{ICONS[iconKey(item.kind)]}</svg>
      </span>
      <span className="body">
        <span className="what">
          {commit ? (
            <>
              Committed <span className="mono">{commit[1]}</span>
              {commit[2] ? ` ${commit[2]}` : ''}
            </>
          ) : (
            item.title
          )}
        </span>
        {(chips.length > 0 || stats) && (
          <span className="ba">
            {chips.map((c, i) => (
              <span key={i} className="chip">
                {c}
              </span>
            ))}
            {stats && (
              <>
                <span className="ok">+{nf(stats.insertions)}</span>
                <span className="bad">{'−'}{nf(stats.deletions)}</span>
                <span className="faint">
                  {stats.files} {stats.files === 1 ? 'file' : 'files'}
                </span>
              </>
            )}
          </span>
        )}
        {item.detail && <span className="faint small">{item.detail}</span>}
      </span>
      <span className="lg-end">
        <span className="tag" data-tag={item.tag}>
          {item.tagLabel}
        </span>
        <span className="faint small">
          <Ago at={item.at} />
        </span>
      </span>
    </li>
  );
}

function Stat({ label, children }) {
  return (
    <div>
      <div className="faint small">{label}</div>
      <div className="strong lg-stat">{children}</div>
    </div>
  );
}

// The Ledger tab (contract C9): what the run changed, from the tool calls already logged. `tick` changes on live events.
export function LedgerTab({ detail, tick = 0 }) {
  const id = detail.run.id;
  const t = useThrottledTick(tick, 3000);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');

  useEffect(() => {
    let stale = false;
    getLedger(id).then(
      (d) => !stale && (setData(d), setError(null)),
      (e) => !stale && setError(e.message), // keep the last good list on screen
    );
    return () => {
      stale = true;
    };
  }, [id, t]);

  const items = Array.isArray(data?.items) ? data.items : [];
  const shown = filter === 'all' ? items : items.filter((i) => i.category === filter);
  const s = data?.summary || {};
  const permanent = Array.isArray(s.permanent) ? s.permanent : [];
  const total = s.total ?? items.length;

  return (
    <div className="run-body ledger-body" role="tabpanel" id="panel-ledger" aria-labelledby="tab-ledger">
      <section className="card ledger-main" aria-label="What this run changed">
        <div className="cardhead">
          <h2>What this run changed</h2>
          <div className="seg" role="group" aria-label="Filter">
            {FILTERS.map(([key, label]) => (
              <button key={key} type="button" className={filter === key ? 'on' : ''} aria-pressed={filter === key} onClick={() => setFilter(key)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {error && (
          <p className="error pad" role="alert">
            {data ? `Out of date: ${error}` : `Could not load the ledger: ${error}`}
          </p>
        )}
        {!data && !error && <p className="muted pad">Loading the ledger…</p>}
        {data &&
          (shown.length ? (
            <ul className="lg-list">
              {shown.map((it) => (
                <Row key={it.id} item={it} />
              ))}
            </ul>
          ) : (
            <p className="muted pad">{items.length ? 'Nothing in this filter.' : 'Nothing changed yet.'}</p>
          ))}
      </section>
      <aside className="run-side" aria-label="Ledger summary">
        <section className="card side-card" aria-label="Summary">
          <div className="cardhead">
            <h3>Summary</h3>
            <span className="faint small">{data ? `${total} ${total === 1 ? 'change' : 'changes'}` : '–'}</span>
          </div>
          <div className="pad lg-stats">
            <Stat label="Commits">{nf(s.commits)}</Stat>
            <Stat label="Files">{nf(s.files)}</Stat>
            <Stat label="Lines">
              <span className="ok">+{nf(s.insertions)}</span> <span className="bad">{'−'}{nf(s.deletions)}</span>
            </Stat>
            <Stat label="Pushes">{nf(s.pushes)}</Stat>
            <Stat label="Tasks updated">{nf(s.tasks)}</Stat>
            <Stat label="Restarts">{nf(s.restarts)}</Stat>
          </div>
        </section>
        <section className="card side-card" aria-label="Can't be undone">
          <div className="cardhead">
            <h3>Can't be undone</h3>
            <span className="tag" data-tag="permanent">
              {permanent.length}
            </span>
          </div>
          <div className="pad small lg-perm">
            {permanent.length ? (
              <ul>
                {permanent.map((p) => (
                  <li key={p.id}>{p.title}</li>
                ))}
              </ul>
            ) : (
              <span>Nothing here can't be undone.</span>
            )}
          </div>
        </section>
        <p className="faint small lg-foot">Built from the tool calls Agent Monitor already logs: git, gh, Hephaestus and server restarts. Nothing new is stored about file contents.</p>
      </aside>
    </div>
  );
}
