// Small pieces shared by the Monitor rows, the Fleet cards and the run header.
import { agentName, avatarOf, sortCrew } from './lib/crew.js';
import { stageSteps } from './lib/stepper.js';

const MAX_AVATARS = 5;

// The run's agents as letter avatars (main, lead, engineers, ...), at most five plus "+N"; one accessible name for the group.
export function Avatars({ agents }) {
  const crew = sortCrew(agents);
  if (!crew.length) return null;
  const shown = crew.slice(0, MAX_AVATARS);
  const names = crew.map(agentName);
  return (
    <span className="avs" role="img" aria-label={`${crew.length} ${crew.length === 1 ? 'agent' : 'agents'}: ${names.join(', ')}`}>
      {shown.map((a, i) => {
        const av = avatarOf(a);
        return (
          <span key={a.id ?? i} className={`av av-${av.cls}`} aria-hidden="true">
            {av.letter}
          </span>
        );
      })}
      {crew.length > MAX_AVATARS && (
        <span className="av av-more" aria-hidden="true">
          +{crew.length - MAX_AVATARS}
        </span>
      )}
    </span>
  );
}

// One avatar, for a crew card.
export function Avatar({ agent }) {
  const av = avatarOf(agent);
  return (
    <span className={`av av-${av.cls}`} aria-hidden="true">
      {av.letter}
    </span>
  );
}

// Segments per pipeline stage; the label beside it carries the same information as text.
export function StageStepper({ detail }) {
  const steps = stageSteps(detail);
  if (!steps.length) return <span className="steps steps-empty" aria-hidden="true" />;
  return (
    <span className="steps" aria-hidden="true">
      {steps.map((s) => (
        <i key={s.id} className={`step-${s.state}`} title={s.name} />
      ))}
    </span>
  );
}

const STATUS = { active: ['run', 'Running'], waiting: ['wait', 'Needs you'], done: ['done', 'Done'], stopped: ['idle', 'Stopped'] };

// A tinted status pill; the running one carries a spinner ring (still when the user asks for less motion).
export function StatusPill({ status }) {
  const [cls, label] = STATUS[status] ?? ['idle', status || 'Unknown'];
  return (
    <span className={`pill ${cls}`}>
      {cls === 'run' && <span className="ring" aria-hidden="true" />}
      {cls === 'wait' && <ClockIcon />}
      {label}
    </span>
  );
}

export function ClockIcon() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

// Agent status as a pill for a crew card.
export function AgentPill({ agent }) {
  if (agent?.waitingPermission) return <span className="pill wait">Needs permission</span>;
  if (agent?.status === 'running')
    return (
      <span className="pill run">
        <span className="ring" aria-hidden="true" />
        Running
      </span>
    );
  if (agent?.status === 'finished') return <span className="pill done">Done</span>;
  return <span className="pill idle">{agent?.status ? agent.status[0].toUpperCase() + agent.status.slice(1) : 'Idle'}</span>;
}
