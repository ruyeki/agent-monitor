export function Field({ label, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

// <option>s for `values`, plus the current value when it is not one of them (so the select never lies).
export function Options({ values, current }) {
  const all = current === undefined || current === null || values.includes(current) ? values : [...values, current];
  return all.map((v) => (
    <option key={v} value={v}>
      {v}
    </option>
  ));
}
