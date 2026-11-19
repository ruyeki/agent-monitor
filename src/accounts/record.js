// `agent-monitor statusline-record [--quiet]`: the statusline's JSON passes through to stdout unchanged (unless --quiet),
// then its rate_limits are recorded on the account they belong to. Runs on every statusline refresh: sync fs, light
// imports, writes only when a window changed, never fails (always exit 0).
import { defaults } from './paths.js';
import { loadRegistry, readUsage, saveReading } from './state.js';
import { liveOauth } from './creds.js';
import { attribute, normWindow } from './usage.js';

// Records reading {five_hour, seven_day} on name, or (name null) on the account it belongs to: attribution by
// five_hour.resets_at, else the live login's account. -> the account name, or null when nothing was recorded.
export function recordWindows({ dataDir, home, name = null, reading, now }) {
  const five = normWindow(reading?.five_hour);
  const seven = normWindow(reading?.seven_day);
  if (!five && !seven) return null;
  const reg = loadRegistry(dataDir);
  const names = Object.keys(reg.accounts);
  if (!names.length) return null;
  let target = name;
  if (!target) {
    const uuid = liveOauth(home)?.accountUuid;
    const active = names.find((n) => reg.accounts[n].accountUuid === uuid) ?? null;
    target = attribute(names, active, Object.fromEntries(names.map((n) => [n, readUsage(dataDir, n)])), five?.resets_at ?? null);
  }
  if (!target || !reg.accounts[target]) return null;
  saveReading(dataDir, target, { five_hour: five, seven_day: seven }, now);
  return target;
}

// The statusline JSON's rate_limits -> recordWindows. Never throws.
export function recordStatusline(raw, { dataDir, home, clock = Date.now }) {
  try {
    const rl = JSON.parse(raw)?.rate_limits;
    return rl && typeof rl === 'object' ? recordWindows({ dataDir, home, reading: rl, now: clock() }) : null;
  } catch { return null; }
}

export async function main(argv = []) {
  const quiet = argv.includes('--quiet');
  const chunks = [];
  try { for await (const c of process.stdin) chunks.push(c); } catch { /* no stdin */ }
  const raw = Buffer.concat(chunks);
  if (!quiet && raw.length) {
    process.stdout.on('error', () => {});
    await new Promise((r) => { try { process.stdout.write(raw, () => r()); } catch { r(); } });
  }
  try { recordStatusline(raw.toString('utf8'), defaults(process.env)); } catch { /* fail silent */ }
  process.exitCode = 0;
}
