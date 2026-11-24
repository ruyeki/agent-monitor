// The second click for a gate answer that ends the run (the server marks those actions `ends: true`).
// Same pattern and look as StopButton's confirm: the consequence in words, a danger Confirm and a Cancel.
export function EndConfirm({ confirm, cancel, disabled }) {
  return (
    <span className="confirm-inline" role="group" aria-label="Confirm stop">
      <span>Stop the run? This can't be undone.</span>
      <button type="button" className="danger sm" disabled={disabled} onClick={confirm}>
        Confirm
      </button>
      <button type="button" className="sm" disabled={disabled} onClick={cancel}>
        Cancel
      </button>
    </span>
  );
}
