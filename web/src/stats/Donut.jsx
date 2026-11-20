import { useId, useMemo, useRef, useState } from 'react';
import { arcPath, shareLabel, sliceAngles } from './chart.js';

const C = 100; // viewBox 200 x 200
const OUTER = 90;
const INNER = 64;

// A donut with its legend. `slices` = [{ key, label, value, valueText, color, row }] in drawing order (12 o'clock, clockwise);
// `row` is the legend row's content. A slice with value 0 has a legend row but no arc. Shares are of `total` (default: the sum).
// `centre` = { value, label } shown while no slice is active; an active slice (hover or focus on it, or hover on its legend row)
// replaces it with its own value, label and share and dims the others. `attr` names the legend row's data attribute.
export function Donut({ title, totalText, slices, total, centre, legendLabel, attr, intro = false }) {
  const sum = total ?? slices.reduce((n, s) => n + (s.value > 0 ? s.value : 0), 0);
  const arcs = useMemo(() => {
    const angles = sliceAngles(slices.map((s) => s.value));
    return slices.map((s, i) => ({ ...s, ...angles[i], share: sum > 0 ? (s.value / sum) * 100 : 0 })).filter((s) => s.end > s.start);
  }, [slices, sum]);
  const [hover, setHover] = useState(null);
  const [focus, setFocus] = useState(null);
  const [tab, setTab] = useState(null); // the slice that holds tabindex 0
  const ringRef = useRef(null);
  const maskId = `donut-intro-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`;
  const activeKey = hover ?? focus;
  const active = arcs.find((s) => s.key === activeKey);
  const tabKey = arcs.some((s) => s.key === tab) ? tab : arcs[0]?.key;

  const onKey = (e, i) => {
    if (e.key === 'Escape') {
      setHover(null);
      setFocus(null);
      return;
    }
    const to = { ArrowRight: i + 1, ArrowDown: i + 1, ArrowLeft: i - 1, ArrowUp: i - 1, Home: 0, End: arcs.length - 1 }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    const next = (to + arcs.length) % arcs.length;
    setTab(arcs[next].key);
    ringRef.current?.children[next]?.focus();
  };
  const opacity = (key) => (active && active.key !== key ? 0.35 : 1);

  return (
    <div className={`donut-wrap${intro ? ' intro' : ''}`}>
      <div className="donut">
        <svg viewBox={`0 0 ${2 * C} ${2 * C}`} role="group" aria-label={`${title}: ${totalText} in total. The list beside it has the numbers.`}>
          {intro && (
            <mask id={maskId} data-intro="">
              <circle cx={C} cy={C} r={(OUTER + INNER) / 2} fill="none" stroke="white" strokeWidth={OUTER - INNER + 4} pathLength="1" transform={`rotate(-90 ${C} ${C})`} />
            </mask>
          )}
          <g ref={ringRef} mask={intro ? `url(#${maskId})` : undefined} onMouseLeave={() => setHover(null)}>
            {arcs.map((s, i) => (
              <path
                key={s.key}
                data-slice={s.key}
                d={arcPath(C, C, OUTER, INNER, s.start, s.end)}
                fillRule="evenodd"
                fill={s.color}
                stroke="var(--surface)"
                strokeWidth="2"
                style={{ opacity: opacity(s.key) }}
                role="img"
                aria-label={`${s.label}: ${s.valueText} (${shareLabel(s.share)})`}
                tabIndex={s.key === tabKey ? 0 : -1}
                onMouseEnter={() => setHover(s.key)}
                onFocus={() => {
                  setTab(s.key);
                  setFocus(s.key);
                }}
                onBlur={() => setFocus(null)}
                onKeyDown={(e) => onKey(e, i)}
              />
            ))}
          </g>
        </svg>
        <div className="donut-centre">
          <span className="donut-value">{active ? active.valueText : centre.value}</span>
          <span className="donut-label">{active ? active.label : centre.label}</span>
          {active && <span className="donut-share">{shareLabel(active.share)}</span>}
        </div>
      </div>
      <ol className="donut-legend" aria-label={legendLabel}>
        {slices.map((s) => (
          <li key={s.key} {...{ [attr]: s.key }} className={`legend-row${s.key === active?.key ? ' active' : ''}`} onMouseEnter={() => setHover(s.key)} onMouseLeave={() => setHover(null)}>
            <span className="swatch" style={{ background: s.color }} aria-hidden="true" />
            {s.row}
          </li>
        ))}
      </ol>
    </div>
  );
}
