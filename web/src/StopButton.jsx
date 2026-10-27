import { useState } from 'react';
import { stopRun } from './api.js';
import { isEnded } from './lib/format.js';

export function StopButton({ run, onDone }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await stopRun(run.id);
      setConfirming(false);
      onDone?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (confirming) {
    return (
      <span className="confirm-inline" role="group" aria-label="Confirm stop">
        <span>Stop run {run.id}?</span>
        <button type="button" className="danger" disabled={busy} onClick={confirm}>
          Confirm
        </button>
        <button type="button" disabled={busy} onClick={() => setConfirming(false)}>
          Cancel
        </button>
        {error && (
          <span className="error" role="alert">
            {error}
          </span>
        )}
      </span>
    );
  }
  return (
    <button type="button" className="danger" disabled={isEnded(run)} onClick={() => setConfirming(true)}>
      Stop
    </button>
  );
}
