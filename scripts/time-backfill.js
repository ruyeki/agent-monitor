// Times a full backfill of the real ~/.claude/projects (read-only) into a throwaway data dir.
// Usage: node --disable-warning=ExperimentalWarning scripts/time-backfill.js [projectsDir]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { openUsage } from '../src/usage.js';

const projectsDir = process.argv[2] || path.join(os.homedir(), '.claude', 'projects');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-backfill-'));
const delay = monitorEventLoopDelay({ resolution: 10 });
try {
  const usage = await openUsage({ dataDir, projectsDir });
  delay.enable();
  const r = await usage.scan();
  delay.disable();
  const s = usage.status();
  console.log(`files: ${r.files}`);
  console.log(`messages: ${s.messages}`);
  console.log(`backfill ms: ${s.backfillMs}`);
  console.log(`max event-loop delay ms: ${(delay.max / 1e6).toFixed(1)} (p99 ${(delay.percentile(99) / 1e6).toFixed(1)})`);
  await usage.close();
} finally {
  fs.rmSync(dataDir, { recursive: true, force: true });
}
