import { useRef } from 'react';

// The second click for a gate answer that ends the run (the server marks those actions `ends: true`).
// Same pattern and look as StopButton's confirm: the consequence in words, a danger Confirm and a Cancel.
// The confirm replaces the answer buttons, so it takes keyboard focus itself (on Cancel, the safe default), says its text
// to a screen reader, and on Cancel hands focus back to the answer button that opened it (found by its label in the
// same container, which still holds the answer buttons once the confirm is gone).
export function EndConfirm({ answer, confirm, cancel, disabled }) {
  const box = useRef(null);
  const onCancel = () => {
    const holder = box.current?.parentElement;
    cancel();
    queueMicrotask(() => [...(holder?.querySelectorAll('button') ?? [])].find((b) => b.textContent === answer)?.focus());
  };
  return (
    <span className="confirm-inline" role="group" aria-label="Confirm stop" ref={box}>
      <span role="status" aria-live="polite">Stop the run? This can't be undone.</span>
      <button type="button" className="danger sm" disabled={disabled} onClick={confirm}>
        Confirm
      </button>
      <button type="button" className="sm" disabled={disabled} onClick={onCancel} autoFocus>
        Cancel
      </button>
    </span>
  );
}
