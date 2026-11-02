// Shared by the Codex tests. Not a test file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const STUB = path.join(import.meta.dirname, 'fixtures', 'codex-stub.mjs');
export const tmp = (prefix = 'am-cx-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(fn, ms = 5000, step = 25) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    last = await fn();
    if (last) return last;
    await sleep(step);
  }
  return last;
}

// A temp root holding one git work tree `repo` and a plain folder `plain`, plus a git work tree `outside` beside the root.
export function makeWorld() {
  const base = fs.realpathSync(tmp('am-world-'));
  const root = path.join(base, 'root');
  const repo = path.join(root, 'repo');
  const plain = path.join(root, 'plain');
  const outside = path.join(base, 'outside');
  for (const d of [repo, plain, outside]) fs.mkdirSync(d, { recursive: true });
  for (const d of [repo, outside]) execFileSync('git', ['init', '-q', d], { windowsHide: true });
  fs.writeFileSync(path.join(repo, 'a.txt'), 'x');
  return { base, root, repo, plain, outside };
}

export const calls = (steps) => JSON.stringify(steps);
export const readLog = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
