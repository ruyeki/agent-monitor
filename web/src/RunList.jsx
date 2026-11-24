import { useNow } from './hooks.js';
import { costOfUsage, isEnded, roundsLabel } from './lib/format.js';
import { nowWorking } from './lib/crew.js';
import { runHref } from './lib/route.js';
import { Elapsed } from './Ago.jsx';
import { Avatars } from './RunBits.jsx';

export const CodexTag = ({ run }) => (run?.provider === 'codex' ? <span className="badge codex">Codex</span> : null);

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
  idle: { label: 'Not reached', cls: 'si-idle', paths: [<circle key="c" cx="12" cy="12" r="9" />, <path key="p" d="M8 12h8" />] },
};

// Status as icon + accessible name; the colour is a second cue, never the only one. The running arc turns (not when reduced motion is asked for).
// `decorative` hides the icon from assistive tech where the words come right beside it (the graph legend, a node's status).
export function StatusIcon({ status, size = 16, decorative = false }) {
  const i = ICONS[ICONS[status] ? status : 'running'];
  const a11y = decorative ? { 'aria-hidden': 'true' } : { role: 'img', 'aria-label': i.label };
  return (
    <svg className={`status-icon ${i.cls}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" {...a11y}>
      {i.paths}
    </svg>
  );
}

function Working({ detail }) {
  const w = nowWorking(detail, useNow(10000));
  if (!w) return null;
  return (
    <span className="working">
      <span className="ring" aria-hidden="true" />
      <span className="working-text">
        {w.name} · {w.call}
      </span>
    </span>
  );
}

const ENDED_LABEL = { done: 'Done', stopped: 'Stopped' };

function RowBody({ run, detail }) {
  const ended = isEnded(run);
  const cost = costOfUsage(detail?.tokens?.total);
  // An ended run's stage label often is its end state ("Stopped") and the end pill already says it; a run that never
  // looped has no rounds worth showing.
  const stage = stageLabel(run);
  const sameAsEnd = ended && [run.status, ENDED_LABEL[run.status]].some((w) => w && String(stage).toLowerCase() === w.toLowerCase());
  const noRounds = ended && !(Number(run.round) > 0);
  return (
    <>
      <StatusIcon status={run.status} />
      <span className="run-main">
        <span className="run-title">
          {run.title}
          <CodexTag run={run} />
        </span>
        <span className="row-meta">
          <span className="mono">{run.id}</span>
          {!sameAsEnd && <span className="stage-pill">{stage}</span>}
          {!noRounds && (
            <span className="run-rounds">
              round <span>{roundsLabel(run)}</span>
            </span>
          )}
        </span>
      </span>
      {ended ? (
        <span className={`pill ${run.status === 'done' ? 'done' : 'idle'}`} aria-hidden="true">
          {ENDED_LABEL[run.status]}
        </span>
      ) : (
        <>
          {detail && <Working detail={detail} />}
          {detail && <Avatars agents={detail.agents} />}
        </>
      )}
      <span className="row-end">
        <strong className="run-cost">{cost}</strong>
        <span className="run-age">
          <Elapsed from={run.createdAt} to={ended ? run.endedAt || run.updatedAt : null} />
        </span>
      </span>
    </>
  );
}

// Every row opens the run view (waiting runs are answered in the Monitor's decision inbox, not listed here).
// detailOf(id) gives the run's detail (agents, cost, activity) once fetched.
export function RunList({ runs, detailOf }) {
  return (
    <ul className="run-rows">
      {runs.map((r) => (
        <li key={r.id}>
          <a className="run-row" href={runHref(r.id, isEnded(r) ? 'ledger' : 'crew')}>
            <RowBody run={r} detail={detailOf?.(r.id) ?? null} />
          </a>
        </li>
      ))}
    </ul>
  );
}
