const node = (id, type, extra = {}) => ({
  id, type, name: id.toUpperCase(), runner: 'worker', model: 'sonnet', instructions: '', pushes: false, position: { x: 0, y: 0 }, ...extra,
});
const edge = (from, to, on, extra = {}) => ({ id: `${from}>${to}:${on}`, from, to, on, ...extra });

// plan -> verify (check) -> gate2 -> pr -> done; verify fail -> plan (fix round); gate2 Stop run -> done.
export const sample = () => ({
  nodes: [
    node('plan', 'step', { position: { x: 0, y: 0 } }),
    node('verify', 'check', { runner: 'verifier', position: { x: 220, y: 0 } }),
    node('gate2', 'gate', { runner: 'main', ask: 'Accept?', textField: true, actions: [{ label: 'Accept' }, { label: 'Stop run' }], position: { x: 440, y: 0 } }),
    node('pr', 'step', { pushes: true, position: { x: 660, y: 0 } }),
    node('done', 'end', { position: { x: 880, y: 0 } }),
  ],
  edges: [
    edge('plan', 'verify', 'done'),
    edge('verify', 'gate2', 'pass'),
    edge('verify', 'plan', 'fail', { fixRound: true }),
    edge('gate2', 'pr', 'Accept'),
    edge('gate2', 'done', 'Stop run'),
    edge('pr', 'done', 'done'),
  ],
  loop: { maxRounds: 5, decision: 'gate2' },
});
