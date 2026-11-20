import { useEffect, useRef, useState } from 'react';

// Width of an element, so SVG charts draw in real pixels and their text keeps its size on a phone.
// Falls back to `fallback` where nothing can be measured (no layout, no ResizeObserver).
export function useWidth(fallback = 900, min = 280, max = 900) {
  const ref = useRef(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const read = () => {
      const w = Math.round(el.getBoundingClientRect().width);
      if (w > 0) setWidth(Math.min(max, Math.max(min, w)));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    return () => ro.disconnect();
  }, [min, max]);
  return [ref, width];
}
