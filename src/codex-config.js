// The one place that names Codex models, efforts and the hand-off root.
const FAMILY = 'gpt-5.6'; // the one line to change for gpt-6.1-*
export const CODEX_ROOT = 'C:\\Users\\ruyek\\Documents\\Persist-AI';
export const HANDOFF_PROFILE = 'agent-monitor-handoff';
export const ROLES = {
  'fable-lead': { model: `${FAMILY}-sol`, effort: 'high' },
  'sonnet-engineer': { model: `${FAMILY}-terra`, effort: 'medium' },
  'opus-engineer': { model: `${FAMILY}-sol`, effort: 'xhigh' },
  'haiku-engineer': { model: `${FAMILY}-luna`, effort: 'low' },
  verifier: { model: `${FAMILY}-terra`, effort: 'medium' },
  'white-hat': { model: `${FAMILY}-sol`, effort: 'high' },
};
export const HANDOFF = ROLES['fable-lead'];
export const DISABLED_FEATURES = ['fast_mode'];

// Returns a list of problems: astra models, ultra effort, fast/ultrafast tiers.
export function checkCodexConfig({ roles = ROLES, handoff = HANDOFF } = {}) {
  const errors = [];
  const entries = [...Object.entries(roles), ['handoff', handoff]];
  for (const [name, r] of entries) {
    for (const [k, v] of Object.entries(r || {})) {
      const s = String(v);
      if (/astra/i.test(s)) errors.push(`${name}: ${k} "${s}" uses astra`);
      if (k === 'effort' && s.toLowerCase() === 'ultra') errors.push(`${name}: effort "ultra" is not allowed`);
      if (/^(ultra)?fast$/i.test(s)) errors.push(`${name}: ${k} "${s}" is a fast tier`);
    }
  }
  return errors;
}
