import { useRef, useState } from 'react';

// Keyboard- and mouse-reachable hit rects for a per-day chart: one tab stop (roving tabindex), ArrowLeft/Right/Home/End
// move focus, focus or hover shows the tooltip, Escape/blur hides it. `days` are the column days, `attr` the data
// attribute that marks the hit rects (they must be the children of the element `hitsRef` is put on).
export function useRovingHits(days) {
  const [hover, setHover] = useState(null);
  const [active, setActive] = useState(null); // the day that holds tabindex 0
  const hitsRef = useRef(null);
  const hoverIdx = days.indexOf(hover);
  const tabDay = days[active ? Math.max(0, days.indexOf(active)) : days.length - 1];
  const pct = ((hoverIdx + 0.5) / days.length) * 100;

  const move = (e, i) => {
    const to = { ArrowLeft: i - 1, ArrowRight: i + 1, Home: 0, End: days.length - 1 }[e.key];
    if (e.key === 'Escape') {
      setHover(null);
      return;
    }
    if (to === undefined) return;
    e.preventDefault();
    const next = Math.min(days.length - 1, Math.max(0, to));
    setActive(days[next]);
    hitsRef.current?.children[next]?.focus();
  };

  // Props for the hit rect of column `i`.
  const hitProps = (i) => ({
    tabIndex: days[i] === tabDay ? 0 : -1,
    onMouseEnter: () => setHover(days[i]),
    onFocus: () => {
      setActive(days[i]);
      setHover(days[i]);
    },
    onBlur: () => setHover(null),
    onKeyDown: (e) => move(e, i),
  });

  return {
    hitsRef,
    hoverIdx,
    hitProps,
    clearHover: () => setHover(null),
    tooltipStyle: { left: `${pct}%`, transform: `translateX(-${pct}%)` },
  };
}
