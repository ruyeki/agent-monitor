// Reads token usage from Claude transcript files (jsonl), incrementally, confined to projectsDir.
import fs from 'node:fs';
import path from 'node:path';

export const MAX_READ = 8 * 1024 * 1024;

// Returns the resolved path when it is a .jsonl/.json file inside root, else null.
export function safePath(file, root, ext = '.jsonl') {
  if (typeof file !== 'string' || !file || !root) return null;
  const abs = path.resolve(file);
  const rel = path.relative(path.resolve(root), abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || !abs.endsWith(ext)) return null;
  return abs;
}

export function fileSize(file, root) {
  const abs = safePath(file, root);
  try { return abs ? fs.statSync(abs).size : 0; } catch { return 0; }
}

// Where a subagent's transcript lives: the path the hook gave us, else derived from the session transcript.
export function subagentPath(agentId, transcriptPath, agentTranscriptPath) {
  if (agentTranscriptPath) return agentTranscriptPath;
  if (!transcriptPath || !agentId) return null;
  const base = transcriptPath.replace(/\.jsonl$/, '');
  return path.join(base, 'subagents', `agent-${String(agentId).replace(/^agent-/, '')}.jsonl`);
}

export function readMeta(transcriptFile, root) {
  const abs = safePath(transcriptFile && transcriptFile.replace(/\.jsonl$/, '.meta.json'), root, '.json');
  if (!abs) return null;
  try { return JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { return null; }
}

// Reads complete lines after `offset`. Usage is counted once per message.id (entries are split per content block).
export function readUsage({ file, root, offset = 0, lastMsgId = null, maxRead = MAX_READ }) {
  const out = { offset, lastMsgId, model: null, input: 0, output: 0, cacheCreation: 0, cacheRead: 0 };
  const abs = safePath(file, root);
  if (!abs) return out;
  let fd;
  try {
    fd = fs.openSync(abs, 'r');
    const size = fs.fstatSync(fd).size;
    if (size < offset) offset = out.offset = 0;
    const len = Math.min(size - offset, maxRead);
    if (len <= 0) return out;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);
    const end = buf.lastIndexOf(0x0a);
    if (end < 0) {
      if (len === maxRead) out.offset = offset + len; // one line longer than the window: skip it, or every read repeats it
      return out;
    }
    out.offset = offset + end + 1;
    let last = lastMsgId;
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      let msg;
      try { msg = JSON.parse(line)?.message; } catch { continue; }
      if (!msg?.usage || !msg.id || msg.id === last) continue;
      last = msg.id;
      const u = msg.usage;
      out.input += u.input_tokens || 0;
      out.output += u.output_tokens || 0;
      out.cacheCreation += u.cache_creation_input_tokens || 0;
      out.cacheRead += u.cache_read_input_tokens || 0;
      if (msg.model && msg.model !== '<synthetic>') out.model = msg.model;
    }
    out.lastMsgId = last;
  } catch { /* unreadable file: report nothing new */ } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return out;
}
