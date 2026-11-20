import { useState } from 'react';
import { readChoice, writeChoice } from './chart.js';

// A row of exclusive buttons; the pressed one wears class `on`.
export function Toggle({ label, value, options, onChange }) {
  return (
    <div role="group" aria-label={label} className="toggle">
      {options.map(([v, text]) => (
        <button key={v} type="button" aria-pressed={value === v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

// State remembered in localStorage under `key`; `allowed` are the valid string values.
export function useStoredChoice(key, allowed, fallback) {
  const [value, setValue] = useState(() => readChoice(key, allowed, fallback));
  const set = (v) => {
    setValue(v);
    writeChoice(key, v);
  };
  return [value, set];
}
