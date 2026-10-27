import { useEffect, useState } from 'react';
import { putPrices } from '../api.js';

const FIELDS = [
  ['input', 'Input'],
  ['output', 'Output'],
  ['cacheWrite', 'Cache write (5m)'],
  ['cacheWrite1h', 'Cache write (1h)'],
  ['cacheRead', 'Cache read'],
];

// Editable $/MTok table. Saves the whole table with PUT /api/prices; a 400 shows the server's message.
export function PriceTable({ prices, onSaved }) {
  const [rows, setRows] = useState(prices);
  const [error, setError] = useState(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => setRows(prices), [prices]);

  const edit = (model, field, value) => {
    setSaved(false);
    setRows((rs) => rs.map((r) => (r.model === model ? { ...r, [field]: value } : r)));
  };
  const save = async () => {
    setError(null);
    try {
      const body = rows.map((r) => ({ ...r, ...Object.fromEntries(FIELDS.map(([f]) => [f, Number(r[f])])) }));
      onSaved(await putPrices(body));
      setSaved(true);
    } catch (e) {
      setError(e.message);
    }
  };

  return (
    <section aria-label="Prices">
      <h2>Prices ($ per million tokens)</h2>
      <p className="muted">Source: claude-api skill, 2026-10-06; estimates only. Costs are API-equivalent, not what a subscription bills.</p>
      <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Model (id prefix)</th>
            {FIELDS.map(([f, label]) => (
              <th key={f}>{label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.model}>
              <td className="mono">{r.model}</td>
              {FIELDS.map(([f, label]) => (
                <td key={f}>
                  <input type="number" min="0" step="any" aria-label={`${r.model} ${label}`} value={r[f] ?? ''} onChange={(e) => edit(r.model, f, e.target.value)} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      <p>
        <button type="button" className="primary" onClick={save}>
          Save prices
        </button>
        {saved && <span role="status"> Saved.</span>}
      </p>
      {error && (
        <p className="error" role="alert">
          Could not save prices: {error}
        </p>
      )}
    </section>
  );
}
