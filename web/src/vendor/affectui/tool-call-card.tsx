// Vendored from https://github.com/flohoeller/affectui/blob/20a6849d2e31373426a26e87a3bead9cedc7a2bc/components/tool-call-card-clean.tsx
// MIT License, Copyright (c) 2026 Florian Höller (adfects), see ./LICENSE
// Agent Monitor adaptations for React 18.3 (each marked "// Agent Monitor:" inline):
//  - the CSS moved to ./tool-call-card.css (React 18 does not hoist <style href precedence>)
//  - inert={x ? '' : undefined} (React 18 does not know boolean inert)
//  - new status "unknown" (no end recorded), "agent" prop, "children" body slot
//  - no per-card role=status/aria-live region: the status word is sr-only text inside the head button
//  - the theme lives in ../../affectui-theme.css

import './tool-call-card.css';
import {
  Children,
  isValidElement,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from "react";

/*
 * Tool Call Card (Clean) – one tool call of an AI agent, in a single self-contained file.
 * Clean style: one white card with hairline shadows, no tile and no tray. The header row holds the
 * tool's icon, its name in mono, a short summary and the status: a blue spinner with a live timer,
 * a blue check with the duration, or a red "Failed". Click it open to see the arguments and the
 * result as highlighted JSON on a faint panel, each with a small white copy button; long blocks are
 * capped with a fade and "Show all". Errors show the message and a white Retry button.
 * ToolCallGroup folds several cards into one quiet line: "Used 3 tools · 2.4s".
 * The styles are injected below, so no extra files are needed.
 */

// Agent Monitor: "unknown" = the tool call has no recorded end
export type ToolCallStatus = "running" | "success" | "error" | "unknown";

export type ToolCallCardProps = {
  /** Tool name as the agent calls it, shown in mono – e.g. "search_web" */
  name: string;
  /** Short human summary – e.g. "Searched the web for 'CRM pricing 2026'" */
  summary?: ReactNode;
  /** Icon in the tile on the left – defaults to a wrench */
  icon?: ReactNode;
  status: ToolCallStatus;
  /** Arguments the tool was called with – objects are pretty-printed, JSON strings parsed */
  args?: unknown;
  /** What the tool returned – objects are pretty-printed, JSON strings parsed, other text shown as is */
  result?: unknown;
  /** Error message, shown when status is "error" */
  error?: string;
  /** When the call started (ms since epoch, e.g. Date.now()) – the live timer counts from here */
  startedAt?: number;
  /** Final duration in ms – otherwise measured while the card shows "running" */
  duration?: number;
  /** Start expanded (uncontrolled) */
  defaultOpen?: boolean;
  /** Expanded state (controlled) */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Opens the card when the call fails and closes it again on the next run, unless someone toggled it */
  openOnError?: boolean;
  /** Shows a Retry button next to the error */
  onRetry?: () => void;
  /** Height in px after which arguments and result are capped with a fade and "Show all" */
  maxCodeHeight?: number;
  /** Agent Monitor: which agent made the call, shown in the head */
  agent?: ReactNode;
  /** Agent Monitor: extra body content (summary, agent, start time) shown when expanded */
  children?: ReactNode;
  className?: string;
};

export type ToolCallGroupProps = {
  /** ToolCallCard elements – the group reads their name, icon, status and duration */
  children: ReactNode;
  /** Label once all calls are done – defaults to "Used 3 tools" */
  label?: string;
  /** Label while any call is running */
  runningLabel?: string;
  /** Total duration in ms – otherwise the sum of the cards' durations, or the time measured while running */
  duration?: number;
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
};

/* ---------- Card ---------- */

export function ToolCallCard({
  name,
  summary,
  icon,
  status,
  args,
  result,
  error,
  startedAt,
  duration,
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  openOnError = true,
  onRetry,
  maxCodeHeight = 220,
  agent,
  children,
  className,
}: ToolCallCardProps) {
  const id = useId();
  const [openState, setOpenState] = useState(defaultOpen);
  const open = openProp ?? openState;
  const setOpen = (next: boolean) => {
    if (openProp === undefined) setOpenState(next);
    onOpenChange?.(next);
  };

  // Open on failure, close again on the next run – only while nobody has toggled it by hand
  const [prevStatus, setPrevStatus] = useState(status);
  const [autoOpened, setAutoOpened] = useState(false);
  if (status !== prevStatus) {
    setPrevStatus(status);
    if (openProp === undefined && openOnError) {
      if (status === "error" && !openState) {
        setOpenState(true);
        setAutoOpened(true);
      } else if (prevStatus === "error" && autoOpened) {
        setOpenState(false);
        setAutoOpened(false);
      }
    }
  }

  const measured = useStopwatch(status === "running", startedAt, false);
  const ms = status === "running" ? (measured ?? 0) : (duration ?? measured);

  return (
    <div
      className={["ui-tclc", className].filter(Boolean).join(" ")}
      data-status={status}
      data-open={open || undefined}
    >
      <button
        type="button"
        className="ui-tclc__head"
        aria-expanded={open}
        aria-controls={`${id}-body`}
        onClick={() => {
          setAutoOpened(false);
          setOpen(!open);
        }}
      >
        <span className="ui-tclc__icon" aria-hidden="true">
          {icon ?? <WrenchIcon />}
        </span>
        <span className="ui-tclc__main">
          <code className="ui-tclc__name" title={name}>
            {name}
          </code>
          {summary != null && (
            <span className="ui-tclc__summary" dir="auto" title={typeof summary === "string" ? summary : undefined}>
              {summary}
            </span>
          )}
          {/* Agent Monitor: the agent that made the call */}
          {agent != null && <span className="ui-tclc__agent">{agent}</span>}
        </span>
        <span className="ui-tclc__status" key={status} title={status === "unknown" ? "No end recorded" : undefined}>
          {status === "running" && <Spinner />}
          {status === "success" && (
            <svg className="ui-tclc__ok" viewBox="0 0 16 16" aria-hidden="true">
              <circle cx="8" cy="8" r="7" />
              <path d="M5.1 8.2 7.1 10.1 10.9 6" pathLength={1} />
            </svg>
          )}
          {status === "error" && <ErrorIcon />}
          {/* Agent Monitor: the status word is sr-only text in the head button (no aria-live region per card) */}
          <span className="ui-tclc-sr">
            {status === "running" ? "running" : status === "success" ? "ok" : status === "error" ? "failed" : "No end recorded"}
          </span>
          <span className="ui-tclc__time" aria-hidden={status === "unknown" ? "true" : undefined}>
            {status === "unknown" ? "\u2013" : status === "error" ? "Failed" : ms != null ? formatMs(ms, status === "running") : null}
          </span>
          {status === "error" && ms != null && <span className="ui-tclc__time">{formatMs(ms, false)}</span>}
        </span>
        <Chevron />
      </button>

      {/* Agent Monitor: React 18 inert */}
      <div className="ui-tclc__body" id={`${id}-body`} inert={!open ? "" : undefined}>
        <div className="ui-tclc__clip">
          <div className="ui-tclc__sections">
            {status === "error" && (
              <div className="ui-tclc__error">
                <ErrorIcon />
                <p className="ui-tclc__error-text" dir="auto">{error ?? "The tool call failed."}</p>
                {onRetry && (
                  <button type="button" className="ui-tclc__retry" onClick={onRetry}>
                    <svg viewBox="0 0 16 16" aria-hidden="true">
                      <path d="M2.75 8a5.25 5.25 0 1 0 1.6-3.77" />
                      <path d="M2.5 2.5v2.75h2.75" />
                    </svg>
                    Retry
                  </button>
                )}
              </div>
            )}
            {/* Agent Monitor: body content from the caller (summary, agent, start time) */}
            {children}
            {args !== undefined && <CodeSection label="Arguments" value={args} cap={maxCodeHeight} />}
            {result !== undefined ? (
              <CodeSection label="Result" value={result} cap={maxCodeHeight} />
            ) : status === "running" && args !== undefined ? (
              <div className="ui-tclc__section">
                <div className="ui-tclc__section-head">
                  <span className="ui-tclc__label">Result</span>
                </div>
                <p className="ui-tclc__pending">Waiting for result…</p>
              </div>
            ) : null}
            {args === undefined && result === undefined && children == null && status === "success" && (
              <p className="ui-tclc__pending">No arguments or result.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---------- Group ---------- */

export function ToolCallGroup({
  children,
  label,
  runningLabel = "Using tools…",
  duration,
  defaultOpen = false,
  open: openProp,
  onOpenChange,
  className,
}: ToolCallGroupProps) {
  const id = useId();
  const [openState, setOpenState] = useState(defaultOpen);
  const open = openProp ?? openState;

  // Read the cards' props to summarise them in the header
  const calls = Children.toArray(children)
    .filter(isValidElement)
    .map((c) => (c as ReactElement<Partial<ToolCallCardProps>>).props);
  const running = calls.some((c) => c.status === "running");
  const failed = calls.filter((c) => c.status === "error").length;

  // Time spent with tools running, added up across stretches (e.g. a pause before a retry)
  // Counts from the earliest running card that knows when it started, so the group never shows less than its cards
  const since = calls.reduce<number | undefined>(
    (min, c) => (c.status === "running" && c.startedAt != null && (min == null || c.startedAt < min) ? c.startedAt : min),
    undefined,
  );
  const measured = useStopwatch(running, since, true);
  const sum = calls.length && calls.every((c) => c.duration != null) ? calls.reduce((t, c) => t + (c.duration ?? 0), 0) : null;
  const ms = running ? measured : (duration ?? sum ?? measured);

  const count = `Used ${calls.length.toLocaleString("en-US")} ${calls.length === 1 ? "tool" : "tools"}`;
  const title = running ? runningLabel : (label ?? count);
  const icons = calls.slice(-3);

  return (
    <div
      className={["ui-tclc-group", className].filter(Boolean).join(" ")}
      data-running={running || undefined}
      data-open={open || undefined}
    >
      <button
        type="button"
        className="ui-tclc-group__head"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        onClick={() => {
          if (openProp === undefined) setOpenState(!open);
          onOpenChange?.(!open);
        }}
      >
        <span className="ui-tclc-group__stack" aria-hidden="true">
          {icons.map((c, i) => (
            <span className="ui-tclc__icon" key={calls.length - icons.length + i}>
              {c.icon ?? <WrenchIcon />}
            </span>
          ))}
        </span>
        <span className="ui-tclc-group__title" key={running ? "busy" : "done"}>
          <span className={running ? "ui-tclc-group__label ui-tclc__shine" : "ui-tclc-group__label"} data-text={title}>
            {title}
          </span>
          {!running && failed > 0 && <span className="ui-tclc-group__failed">· {failed} failed</span>}
          {ms != null && <span className="ui-tclc-group__time">· {formatMs(ms, running)}</span>}
        </span>
        <Chevron />
      </button>

      <div className="ui-tclc__body" id={`${id}-list`} inert={!open ? "" : undefined}>
        <div className="ui-tclc__clip">
          <div className="ui-tclc-group__list">{children}</div>
        </div>
      </div>
    </div>
  );
}

/* ---------- Pieces ---------- */

const OPEN_MAX = 640;

function CodeSection({ label, value, cap }: { label: string; value: unknown; cap: number }) {
  const { text, json } = toText(value);
  const pre = useRef<HTMLPreElement>(null);
  const [full, setFull] = useState(false);
  const [height, setHeight] = useState(0);

  // Natural height of the block – decides whether it needs the cap and how far "Show all" opens
  useLayoutEffect(() => {
    const el = pre.current;
    const inner = el?.firstElementChild;
    if (!el || !inner) return;
    const measure = () => setHeight(el.scrollHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [text]);

  const capped = height > cap + 24;

  return (
    <div className="ui-tclc__section">
      <div className="ui-tclc__section-head">
        <span className="ui-tclc__label">{label}</span>
        <CopyButton text={text} label={label.toLowerCase()} />
      </div>
      <pre
        ref={pre}
        className="ui-tclc__code"
        data-capped={(capped && !full) || undefined}
        data-scroll={(capped && full && height > OPEN_MAX) || undefined}
        // Open, a very long block stops at a few screens and scrolls inside – no 200,000px card
        style={capped ? { maxHeight: full ? Math.min(height, OPEN_MAX) : cap } : undefined}
      >
        <code>{json ? highlight(text) : text}</code>
      </pre>
      {capped && (
        <button type="button" className="ui-tclc__more" aria-expanded={full} onClick={() => setFull(!full)}>
          {full ? "Show less" : "Show all"}
        </button>
      )}
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(t);
  }, [copied]);

  return (
    <button
      type="button"
      className="ui-tclc__copy"
      data-copied={copied || undefined}
      aria-label={copied ? "Copied" : `Copy ${label}`}
      title={copied ? "Copied" : `Copy ${label}`}
      onClick={() => copyText(text).then((ok) => ok && setCopied(true))}
    >
      <svg className="ui-tclc__copy-icon" viewBox="0 0 16 16" aria-hidden="true">
        <rect x="5.5" y="5.5" width="8.5" height="8.5" rx="2" />
        <path d="M10.5 3.75v-.25A1.5 1.5 0 0 0 9 2H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h.25" />
      </svg>
      <svg className="ui-tclc__copy-done" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3.5 8.4 6.6 11.3 12.5 4.9" pathLength={1} />
      </svg>
    </button>
  );
}

function Spinner() {
  return (
    <svg className="ui-tclc__spinner" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="6" />
      <path d="M8 2a6 6 0 0 1 6 6" />
    </svg>
  );
}

function ErrorIcon() {
  return (
    <svg className="ui-tclc__err" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="7" />
      <path d="M8 4.9v3.5M8 10.9v.1" />
    </svg>
  );
}

function Chevron() {
  return (
    <svg className="ui-tclc__chevron" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M3.5 5.25 6 7.75l2.5-2.5" />
    </svg>
  );
}

function WrenchIcon() {
  return (
    <svg viewBox="0 0 16 16">
      <path d="M10.2 2.4a3.5 3.5 0 0 0-4.3 4.6L2.6 10.3a1.4 1.4 0 0 0 2 2L7.9 9a3.5 3.5 0 0 0 4.6-4.3l-2 2-1.6-.4-.4-1.6 1.7-2.3Z" />
    </svg>
  );
}

/* ---------- Helpers ---------- */

/** Live ms while running, the final value after. accumulate = add up several running stretches. */
function useStopwatch(running: boolean, startedAt: number | undefined, accumulate: boolean) {
  const start = useRef<number | null>(null);
  const base = useRef(0);
  const [ms, setMs] = useState<number | null>(null);
  useEffect(() => {
    if (!running) {
      if (start.current !== null) {
        base.current += Date.now() - start.current;
        start.current = null;
        setMs(base.current);
      }
      return;
    }
    if (!accumulate) base.current = 0;
    start.current = startedAt ?? Date.now();
    const tick = () => setMs(base.current + Date.now() - (start.current ?? Date.now()));
    tick();
    const t = window.setInterval(tick, 100);
    return () => window.clearInterval(t);
  }, [running, startedAt, accumulate]);
  return ms;
}

/** 0.4s, 12.3s, 2m 05s, 3h 12m, 2d 4h – the live timer always shows tenths below a minute */
function formatMs(ms: number, live: boolean) {
  if (!live && ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  if (ms < 60_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
  const s = Math.floor(ms / 1000);
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(s / 3600);
  if (h < 24) return `${h}h ${String(Math.floor(s / 60) % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function toText(value: unknown): { text: string; json: boolean } {
  if (typeof value === "string") {
    const t = value.trim();
    if (t.startsWith("{") || t.startsWith("[")) {
      try {
        return { text: JSON.stringify(JSON.parse(t), null, 2), json: true };
      } catch {
        /* not JSON – shown as plain text */
      }
    }
    return { text: value, json: false };
  }
  try {
    const s = JSON.stringify(value, null, 2);
    return s === undefined ? { text: String(value), json: false } : { text: s, json: true };
  } catch {
    return { text: String(value), json: false };
  }
}

// Strings (keys when followed by a colon), literals and numbers – everything else stays punctuation
const TOKEN = /("(?:[^"\\]|\\.)*")(\s*:)?|\b(?:true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g;

function highlight(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = new RegExp(TOKEN.source, "g");
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] && m[2]) {
      out.push(
        <span key={m.index} className="ui-tclc__t-key">
          {m[1]}
        </span>,
        m[2],
      );
    } else {
      const kind = m[1] ? "str" : /^[tfn]/.test(m[0]) ? "lit" : "num";
      out.push(
        <span key={m.index} className={`ui-tclc__t-${kind}`}>
          {m[0]}
        </span>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Older browsers and non-secure contexts
    const area = document.createElement("textarea");
    area.value = text;
    area.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}
