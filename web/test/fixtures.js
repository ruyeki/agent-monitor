const step = (id, extra = {}) => ({ id, name: id.toUpperCase(), kind: 'step', runner: 'worker', model: 'sonnet', instructions: '', check: null, pushes: false, ...extra });

export const sample = () => ({
  stages: [
    step('plan'),
    step('verify', { check: { onFail: 'fix' } }),
    step('review', { check: { onFail: 'decision' } }),
    step('whitehat', { name: 'White-hat', runner: 'white-hat', check: { onFail: 'continue' } }),
    { ...step('gate2', { runner: 'main' }), kind: 'gate', ask: 'Accept?', textField: true, actions: [{ label: 'Accept', goto: 'next' }, { label: 'Redo', goto: 'plan' }, { label: 'Stop run', goto: 'stop' }, { label: 'Lost', goto: 'ghost' }] },
    step('pr', { pushes: true }),
  ],
  loop: { maxRounds: 5, fixRunner: 'worker', fixModel: 'sonnet', afterFix: 'verify', resumeAt: 'plan' },
});
