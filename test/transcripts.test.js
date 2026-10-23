import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readUsage, safePath, subagentPath, fileSize } from '../src/transcripts.js';
import { tmp, fixture } from './helpers.js';

// The fixture is a trimmed copy of a real subagent transcript: 6 messages, split over several entries.
const TOTALS = { input: 12, output: 5210, cacheCreation: 53667, cacheRead: 361757 };

function copyFixture() {
  const root = tmp();
  const file = path.join(root, 'proj', 'agent-x.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(fixture('subagent-transcript.jsonl'), file);
  return { root, file };
}

test('counts usage once per message.id and finds the model', () => {
  const { root, file } = copyFixture();
  const u = readUsage({ file, root });
  assert.deepEqual({ input: u.input, output: u.output, cacheCreation: u.cacheCreation, cacheRead: u.cacheRead }, TOTALS);
  assert.equal(u.model, 'claude-opus-5-5');
  assert.equal(u.offset, fs.statSync(file).size);
  assert.ok(u.lastMsgId.startsWith('msg_'));
});

test('is incremental: a second read from the stored offset adds only new messages', () => {
  const { root, file } = copyFixture();
  const first = readUsage({ file, root });
  assert.deepEqual(readUsage({ file, root, offset: first.offset, lastMsgId: first.lastMsgId }).input, 0);
  const line = (id, extra = {}) => `${JSON.stringify({ type: 'assistant', message: { id, model: 'claude-sonnet-5-5', usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 }, ...extra } })}\n`;
  // the last known message repeats (a split entry), then two new ones
  fs.appendFileSync(file, line(first.lastMsgId) + line('msg_new1') + line('msg_new1') + line('msg_new2'));
  const second = readUsage({ file, root, offset: first.offset, lastMsgId: first.lastMsgId });
  assert.deepEqual([second.input, second.output, second.cacheCreation, second.cacheRead], [2, 4, 6, 8]);
  assert.equal(second.model, 'claude-sonnet-5-5');
  assert.equal(second.lastMsgId, 'msg_new2');
});

test('reads only complete lines and resumes the partial line later', () => {
  const root = tmp();
  const file = path.join(root, 's.jsonl');
  const full = JSON.stringify({ message: { id: 'm1', usage: { input_tokens: 5, output_tokens: 1 } } });
  fs.writeFileSync(file, `${full}\n${full.slice(0, 10)}`);
  const a = readUsage({ file, root });
  assert.equal(a.input, 5);
  assert.equal(a.offset, full.length + 1);
  fs.writeFileSync(file, `${full}\n${JSON.stringify({ message: { id: 'm2', usage: { input_tokens: 7 } } })}\n`);
  const b = readUsage({ file, root, offset: a.offset, lastMsgId: a.lastMsgId });
  assert.equal(b.input, 7);
});

test('skips synthetic models and bad lines', () => {
  const root = tmp();
  const file = path.join(root, 's.jsonl');
  fs.writeFileSync(file, `not json\n${JSON.stringify({ message: { id: 'm1', model: '<synthetic>', usage: { input_tokens: 1 } } })}\n`);
  const u = readUsage({ file, root });
  assert.equal(u.model, null);
  assert.equal(u.input, 1);
});

test('reads are confined to projectsDir and .jsonl files', () => {
  const root = tmp();
  const outside = tmp();
  fs.writeFileSync(path.join(outside, 'x.jsonl'), '{}\n');
  fs.writeFileSync(path.join(root, 'x.txt'), '{}\n');
  assert.equal(safePath(path.join(outside, 'x.jsonl'), root), null);
  assert.equal(safePath(path.join(root, '..', path.basename(outside), 'x.jsonl'), root), null);
  assert.equal(safePath(path.join(root, 'x.txt'), root), null);
  assert.equal(safePath(root, root), null);
  assert.ok(safePath(path.join(root, 'a', 'x.jsonl'), root));
  assert.equal(readUsage({ file: path.join(outside, 'x.jsonl'), root }).offset, 0);
  assert.equal(fileSize(path.join(outside, 'x.jsonl'), root), 0);
});

test('subagent path: given path wins, else derived without doubling the agent- prefix', () => {
  assert.equal(subagentPath('a1', '/p/s.jsonl', '/given.jsonl'), '/given.jsonl');
  const expected = path.join('/p/s', 'subagents', 'agent-a1.jsonl');
  assert.equal(subagentPath('a1', '/p/s.jsonl'), expected);
  assert.equal(subagentPath('agent-a1', '/p/s.jsonl'), expected);
  assert.equal(subagentPath('a1', null), null);
});

test('a single line longer than the read window is skipped, not re-read forever', () => {
  const root = tmp();
  const file = path.join(root, 's.jsonl');
  const ok = JSON.stringify({ message: { id: 'm1', usage: { input_tokens: 3 } } });
  fs.writeFileSync(file, `${'x'.repeat(100)}\n${ok}\n`);
  let u = readUsage({ file, root, maxRead: 40 });
  assert.equal(u.offset, 40); // moved past the window instead of staying at 0
  for (let i = 0; i < 10 && u.offset <= 100; i++) u = readUsage({ file, root, offset: u.offset, maxRead: 40 });
  assert.ok(u.offset > 100);
  assert.equal(readUsage({ file, root, offset: 101, maxRead: 400 }).input, 3);
});
