import { useEffect, useState } from 'react';

export const INTRO_MS = 1200;

const reduced = () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// True for INTRO_MS after the component mounts (the charts' one-off draw-in), false from the start under reduced motion.
// Never turns true again, so refreshes and view switches do not replay it.
export function useIntro() {
  const [intro, setIntro] = useState(() => !reduced());
  useEffect(() => {
    if (!intro) return undefined;
    const t = setTimeout(() => setIntro(false), INTRO_MS);
    return () => clearTimeout(t);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return intro;
}
