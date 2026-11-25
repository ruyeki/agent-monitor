import { createContext, useContext } from 'react';

// App provides the Back action for the current page (null on the plain Monitor); a page rendered on its own gets no button.
export const BackContext = createContext(null);

const svgProps = { width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': 'true' };

export function BackButton() {
  const back = useContext(BackContext);
  if (!back) return null;
  return (
    <button type="button" className="ghost sm back-btn" onClick={back}>
      <svg {...svgProps}>
        <path d="M19 12H5" />
        <path d="m12 19-7-7 7-7" />
      </svg>
      Back
    </button>
  );
}
