/*
 * Decision Inbox (clean style), vendored from affectUI.
 * Source: https://github.com/flohoeller/affectui/blob/20a6849d2e31373426a26e87a3bead9cedc7a2bc/components/decision-inbox-clean.tsx
 * MIT License, Copyright (c) 2026 Florian Höller (adfects), see ./LICENSE
 *
 * Agent Monitor adaptations (each marked inline with "Agent Monitor:"):
 * - React 18.3: no "use client"; the styles moved verbatim to ./decision-inbox.css; `inert` is passed as "" / undefined.
 * - Any number of answers (`actions`, the first is the main one); title and detail take React nodes; an `extra` slot
 *   (reply box) and a `footer` slot (link); `rowProps` for the row's label and data attributes.
 * - onDecide may return a promise: the item's controls are disabled while it is pending; a rejection shows its message
 *   and keeps the item open. Only a success confirms and folds.
 * - An item being answered stays in its place through the confirmation and the fold even after `decisions` drops it,
 *   unless a new decision with the same `rowKey` takes the row over.
 * - One item opens by default: the first, or a newcomer when nothing else is open. Keyboard focus follows when a folded
 *   line opens or an answered item folds away (to the next open item, else the heading).
 * - Closed bodies are inert, so their hidden buttons are not tabbable.
 * - The count is an h2; the empty text is Agent Monitor's and renders only when nothing is open.
 */

import { useEffect, useLayoutEffect, useRef, useState, type HTMLAttributes, type ReactNode } from "react";
import "./decision-inbox.css";

/*
 * Decision Inbox (clean style) – open decisions with two quick answers each, in one white card, in a single self-contained file.
 * A heading row with the count sits at the top of the card; every decision is a row under a hairline.
 * Answering a decision confirms it briefly, then folds it away and the count goes down.
 * The styles are injected below, so no extra files are needed.
 */

export type Decision = {
  id: string;
  /** Agent Monitor: the row's React key (default `id`); a live decision with the same rowKey takes over an answered row in place */
  rowKey?: string;
  // Agent Monitor: a React node (was a string), e.g. the title plus a tag
  title: ReactNode;
  /** Agent Monitor: the title as plain text, for the folded line's tooltip */
  label?: string;
  /** Short context under the title */
  // Agent Monitor: a React node (was a string)
  detail?: ReactNode;
  /** Agent Monitor: the answers in order (was `primary` + `secondary`); the first is the main one, shown as the dark button */
  actions: string[];
  /** Agent Monitor: shown between the detail and the answers, e.g. a reply box; a function gets { disabled } */
  extra?: ReactNode | ((s: { disabled: boolean }) => ReactNode);
  /** Agent Monitor: shown after the answers, e.g. a link */
  footer?: ReactNode;
  /** Agent Monitor: extra attributes for the row, e.g. aria-label and data-* */
  rowProps?: HTMLAttributes<HTMLElement> & Record<string, unknown>;
  /** Starts folded to one muted line – click to open */
  collapsed?: boolean;
};

export type DecisionInboxProps = {
  decisions: Decision[];
  /** Called with the decision and the chosen answer */
  // Agent Monitor: the answer is the action's label; a returned promise keeps the item pending, a rejection shows its message
  onDecide?: (decision: Decision, answer: string) => void | Promise<unknown>;
  className?: string;
};

// Agent Monitor: `pending`, `error`, the decision kept while it is answered (`d`), a token per answer (`tok`), whether it
// left `decisions` while answered (`left`) and whether it has folded away (`folded`)
type State = { open: boolean; answered?: string; gone?: boolean; pending?: boolean; error?: string; d?: Decision; tok?: object; left?: boolean; folded?: boolean };
type States = Record<string, State>;

// Agent Monitor: the row's fold transition (460 ms) plus a little; after it an answered row may leave the DOM
const FOLD_MS = 500;

// Agent Monitor: kept in place while being answered, until it has folded away or a live decision took its row
const rowKey = (d: Decision) => d.rowKey ?? d.id;
const isHeld = (s: State | undefined, liveKeys: Set<string>) => !!s?.d && !!(s.pending || s.answered) && !s.folded && !liveKeys.has(rowKey(s.d));

// Agent Monitor: a decision without an entry opens only when nothing else is open (so the first one, on mount)
function withDefaults(s: States, rows: Decision[]): States {
  let next = s;
  let opened = rows.some((d) => s[d.id]?.open && !s[d.id]?.answered);
  for (const d of rows) {
    if (s[d.id]) continue;
    const open = !opened && !d.collapsed;
    opened ||= open;
    if (next === s) next = { ...s };
    next[d.id] = { open };
  }
  return next;
}

// Agent Monitor: live decisions in their order, plus held rows that `decisions` dropped, each before the live row that followed it
function keepHeld(decisions: Decision[], s: States, prev: string[]): Decision[] {
  const live = new Set(decisions.map((d) => d.id));
  const liveKeys = new Set(decisions.map(rowKey));
  const pos = (id: string) => (prev.includes(id) ? prev.indexOf(id) : Infinity);
  const held = Object.keys(s).filter((id) => !live.has(id) && isHeld(s[id], liveKeys)).sort((a, b) => pos(a) - pos(b));
  if (!held.length) return decisions;
  const rows = [...decisions];
  for (const id of held) {
    const after = prev.slice(pos(id) + 1).find((x) => live.has(x));
    const at = after === undefined ? -1 : rows.findIndex((d) => d.id === after);
    rows.splice(at < 0 ? rows.length : at, 0, s[id].d as Decision);
  }
  return rows;
}

export function DecisionInbox({ decisions, onDecide, className }: DecisionInboxProps) {
  // Agent Monitor: entries are also added for decisions that arrive later (see the layout effect below)
  const [state, setState] = useState<States>(() => withDefaults({}, decisions));
  const patch = (id: string, next: Partial<State>) => setState((s) => ({ ...s, [id]: { ...s[id], ...next } }));

  // Agent Monitor: rows rendered last time, live ids, timers, row elements and focus requests
  const order = useRef<string[]>([]);
  const live = new Set(decisions.map((d) => d.id));
  const liveKeys = new Set(decisions.map(rowKey));
  const liveRef = useRef(live);
  liveRef.current = live;
  const rows = keepHeld(decisions, state, order.current);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const view = withDefaults(state, rows);
  const timers = useRef<number[]>([]);
  const later = (fn: () => void, ms: number) => timers.current.push(window.setTimeout(fn, ms));
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);
  const rowEls = useRef(new Map<string, HTMLElement>());
  const heading = useRef<HTMLHeadingElement>(null);
  const focusTo = useRef<{ id: string; next: boolean } | null>(null);

  // Agent Monitor: keep entries for new decisions; drop entries of decisions that are gone and not held; an answered
  // decision that left and came back (same id) is a fresh one
  const liveIds = decisions.map((d) => d.id).join("\n");
  const rowIds = rows.map((d) => d.id).join("\n");
  useLayoutEffect(() => {
    order.current = rows.map((d) => d.id);
    setState((s) => {
      let next = s;
      const edit = () => (next === s ? (next = { ...s }) : next);
      for (const [id, st] of Object.entries(s)) {
        if (live.has(id)) {
          if (st.left) delete edit()[id];
        } else if (!isHeld(st, liveKeys)) delete edit()[id];
        else if (st.answered && !st.left) edit()[id] = { ...st, left: true };
      }
      return withDefaults(next, rows);
    });
  }, [liveIds, rowIds]);

  // Agent Monitor: a folded line (a button) that opens, or an answered item that folds, would drop keyboard focus to
  // the page: move it to that item, or to the next open item, else the heading. Never steal focus from elsewhere.
  useLayoutEffect(() => {
    const req = focusTo.current;
    if (!req) return;
    focusTo.current = null;
    const from = rowEls.current.get(req.id);
    const active = document.activeElement;
    if (active && active !== document.body && !(from && from.contains(active))) return;
    if (!req.next) {
      from?.focus();
      return;
    }
    const at = rows.findIndex((d) => d.id === req.id);
    const isOpen = (d: Decision) => d.id !== req.id && view[d.id]?.open && !view[d.id]?.answered && !view[d.id]?.gone;
    const next = rows.slice(at + 1).find(isOpen) ?? rows.slice(0, Math.max(at, 0)).find(isOpen);
    (next ? rowEls.current.get(next.id) : heading.current)?.focus();
  });

  const open = decisions.filter((d) => !view[d.id]?.answered).length;
  // 1284 → "1,284"
  const count = new Intl.NumberFormat("en").format(open);

  // Agent Monitor: waits for onDecide; a rejection shows its message and keeps the item open with its controls
  const decide = async (d: Decision, answer: string) => {
    patch(d.id, { pending: true, error: undefined, d });
    try {
      await onDecide?.(d, answer);
    } catch (e) {
      patch(d.id, { pending: false, error: (e as Error)?.message || String(e) });
      return;
    }
    const tok = {};
    patch(d.id, { pending: false, answered: answer, d, tok });
    // Show the confirmation for a moment, then fold the row away and open the next folded one
    later(() => {
      setState((s) => {
        if (s[d.id]?.tok !== tok) return s; // Agent Monitor: it came back as a fresh decision meanwhile
        const next = { ...s, [d.id]: { ...s[d.id], gone: true } };
        // Agent Monitor: the rows rendered now, not the decisions of the moment it was answered
        const folded = rowsRef.current.find((x) => x.id !== d.id && !next[x.id]?.open && !next[x.id]?.answered);
        if (folded) next[folded.id] = { ...next[folded.id], open: true };
        return next;
      });
      focusTo.current = { id: d.id, next: true };
      // Agent Monitor: once folded, the row leaves unless its decision is still live (then it stays folded, as upstream)
      later(() => {
        setState((s) => {
          const st = s[d.id];
          if (st?.tok !== tok) return s;
          if (liveRef.current.has(d.id) && !st.left) return { ...s, [d.id]: { ...st, folded: true } };
          const { [d.id]: _gone, ...rest } = s;
          return rest;
        });
      }, FOLD_MS);
    }, 1100);
  };

  // Agent Monitor: opening a folded line keeps keyboard focus on the item
  const openItem = (id: string) => {
    patch(id, { open: true });
    focusTo.current = { id, next: false };
  };

  return (
    <>
      {/* Agent Monitor: the styles are imported from ./decision-inbox.css (React 18 does not hoist <style precedence>) */}
      <section className={["ui-dic", className].filter(Boolean).join(" ")} data-clear={open === 0 || undefined}>
        <header className="ui-dic__head" aria-live="polite">
          {open > 0 ? (
            <>
              <AlertIcon />
              {/* Agent Monitor: the count is the inbox's heading (h2 around the upstream span) */}
              <h2 className="ui-dic__heading" ref={heading} tabIndex={-1}>
                <span>
                  {count} {open === 1 ? "needs" : "need"} your input
                </span>
              </h2>
            </>
          ) : (
            <>
              <DoneIcon />
              <h2 className="ui-dic__heading" ref={heading} tabIndex={-1}>
                <span>All caught up</span>
              </h2>
            </>
          )}
        </header>

        <div className="ui-dic__card">
          {rows.map((d) => {
            const s = view[d.id] ?? { open: true };
            const busy = !!(s.pending || s.answered); // Agent Monitor
            return (
              // Agent Monitor: an article (was a div), focusable from script, with the caller's label and data attributes
              <article
                key={rowKey(d)}
                {...d.rowProps}
                ref={(el) => {
                  if (el) rowEls.current.set(d.id, el);
                  else rowEls.current.delete(d.id);
                }}
                tabIndex={-1}
                className="ui-dic__row"
                data-gone={s.gone || undefined}
                inert={s.gone ? "" : undefined}
              >
                <div className="ui-dic__row-inner">
                  <div className="ui-dic__item" data-open={s.open || undefined} data-answered={s.answered ? true : undefined}>
                    {s.open ? (
                      // Agent Monitor: a heading (was a p)
                      <h3 className="ui-dic__title" dir="auto">
                        {d.title}
                      </h3>
                    ) : (
                      <button
                        type="button"
                        className="ui-dic__title ui-dic__title--folded"
                        dir="auto"
                        title={typeof d.title === "string" ? d.title : d.label}
                        onClick={() => openItem(d.id)}
                      >
                        {d.title}
                      </button>
                    )}
                    {/* Agent Monitor: a closed body is inert, so its hidden controls cannot be tabbed to */}
                    <div className="ui-dic__body" data-open={s.open || undefined} inert={s.open ? undefined : ""}>
                      <div className="ui-dic__body-inner">
                        {d.detail && (
                          // Agent Monitor: a div (was a p), since the detail can hold blocks
                          <div className="ui-dic__detail" dir="auto">
                            {d.detail}
                          </div>
                        )}
                        {typeof d.extra === "function" ? d.extra({ disabled: busy }) : d.extra}
                        <div className="ui-dic__actions">
                          {s.answered ? (
                            <span className="ui-dic__done" role="status">
                              <DoneIcon />
                              <span dir="auto">{s.answered}</span>
                            </span>
                          ) : (
                            // Agent Monitor: one button per action, disabled while pending; the first also carries Agent Monitor's `primary` class
                            d.actions.map((a, i) => (
                              <button
                                key={`${i}:${a}`}
                                type="button"
                                className={i === 0 ? "ui-dic__btn ui-dic__btn--primary primary" : "ui-dic__btn"}
                                dir="auto"
                                disabled={!!s.pending}
                                onClick={() => decide(d, a)}
                              >
                                {a}
                              </button>
                            ))
                          )}
                          {d.footer}
                        </div>
                        {s.error && (
                          // Agent Monitor: why the answer failed
                          <p className="error ui-dic__error" role="alert">
                            {s.error}
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </article>
            );
          })}
          {/* Agent Monitor: Agent Monitor's text, rendered only when nothing is open */}
          {open === 0 && <p className="ui-dic__empty">Nothing is waiting on you.</p>}
        </div>
      </section>
    </>
  );
}

/* ---------- Icons ---------- */

// Solid glyphs – the cut-out mark takes the card color, so it works in dark mode too
const AlertIcon = () => (
  <svg className="ui-dic__glyph" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <path d="M6.7 2.3a1.5 1.5 0 0 1 2.6 0l5.4 9.4A1.5 1.5 0 0 1 13.4 14H2.6a1.5 1.5 0 0 1-1.3-2.3Z" fill="currentColor" />
    <path className="ui-dic__cut" d="M8 5.8v3.2" strokeWidth="1.4" strokeLinecap="round" fill="none" />
    <circle className="ui-dic__cut-dot" cx="8" cy="11.3" r="0.8" />
  </svg>
);

const DoneIcon = () => (
  <svg className="ui-dic__glyph" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
    <circle cx="8" cy="8" r="6.5" fill="currentColor" />
    <path className="ui-dic__cut" d="m5.3 8.2 1.8 1.8 3.6-3.8" fill="none" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/* ---------- Styles ---------- */
// Agent Monitor: the upstream `css` string is ./decision-inbox.css, imported at the top.
