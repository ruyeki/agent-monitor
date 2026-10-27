// Holdout (phase B, AC13): the proposed ~/.claude files in integration/claude-files describe running several active stages together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO } from './holdout-v2-helpers.js';

const read = (rel) => fs.readFileSync(path.join(REPO, 'integration', 'claude-files', rel), 'utf8');
const LEAD = 'agents/fable-lead.md';
const SKILL = 'skills/fable-workflow/SKILL.md';
const TRACK = 'skills/fable-workflow/tracking.md';

for (const rel of [LEAD, SKILL, TRACK]) {
  test(`AC13 ${rel}: says a result can list several active stages, to run them together in the foreground and report each with complete_stage`, () => {
    const t = read(rel);
    assert.match(t, /PARALLEL:/, 'the PARALLEL: line is not described');
    assert.match(t, /several|more than one|multiple|both/i, 'no mention of more than one active stage');
    assert.match(t, /together|same time|one message|simultaneous|in parallel/i, 'no instruction to run them together');
    assert.match(t, /foreground/i, 'no instruction to run in the foreground');
    assert.match(t, /each/i);
    assert.match(t, /complete_stage/);
  });
}

test('AC13 fable-lead.md section 2: implement and prep are spawned in one message, then each is reported', () => {
  const t = read(LEAD);
  assert.match(t, /returns\s+`?implement`?\s+and\s+`?prep`?/i, 'the "returns implement and prep" sentence is missing');
  assert.match(t, /complete_stage\(\s*run\s*,\s*implement\s*,\s*done\s*\)/);
  assert.match(t, /complete_stage\(\s*run\s*,\s*prep\s*,\s*done\s*\)/);
  assert.match(t, /one message/i);
});

test('AC13 CHANGES.md gets a short v2 section about parallel stages', () => {
  const t = read('CHANGES.md');
  assert.match(t, /\bv2\b|version 2/i, 'no v2 section heading');
  const i = t.search(/^#{1,3}.*\bv2\b.*$/im);
  assert.ok(i >= 0, 'no heading that names v2');
  assert.match(t.slice(i), /parallel|several active|together/i);
  assert.match(t, /^# Proposed changes/m, 'the existing document is kept');
  assert.match(t, /agents\/fable-lead\.md/);
});

test('AC13 the files stay installable text: frontmatter intact, no stale product name, nothing pointing at the live server port added', () => {
  for (const rel of [LEAD, SKILL]) {
    const t = read(rel);
    assert.ok(t.startsWith('---\n') || t.startsWith('---\r\n'), `${rel} frontmatter`);
    assert.match(t.slice(0, 600), /\bname:/);
  }
  for (const rel of [LEAD, SKILL, TRACK, 'CHANGES.md']) assert.equal(/Fable Radar/i.test(read(rel)), false, rel);
});

test('AC13 edits are minimal: no claude-files document gained more than 80 lines since the repo base (c2c33c0)', (t) => {
  const r = spawnSync('git', ['-C', REPO, 'diff', '--numstat', 'c2c33c0', '--', 'integration/claude-files'], { encoding: 'utf8' });
  if (r.status !== 0) return t.skip('no git history in this copy');
  assert.ok(r.stdout.trim(), 'the claude-files documents have changed since the base');
  for (const l of r.stdout.trim().split('\n')) {
    const [add, , file] = l.split('\t');
    assert.ok(Number(add) <= 80, `${file} gained ${add} lines`);
  }
});
