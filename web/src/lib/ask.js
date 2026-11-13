// A label is 1-3 capitalised words and a colon, then whitespace or end of line,
// so 'See http://x.io' stays plain text.
const ROW = /^([A-Z][A-Za-z]*(?: [A-Za-z]+){0,2}):(?:\s+(.*))?$/s;

// A run's ask text -> { heading, blocks }. First non-blank line is the heading; later
// "Label: text" lines are rows; other consecutive lines merge into one paragraph.
export function parseAsk(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const first = lines.findIndex((l) => l.trim());
  if (first < 0) return { heading: '', blocks: [] };
  const blocks = [];
  let para = null;
  for (const raw of lines.slice(first + 1)) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      para = null;
      continue;
    }
    const m = ROW.exec(line);
    if (m && m[1].length <= 24) {
      blocks.push({ kind: 'row', label: m[1], text: m[2] ?? '' });
      para = null;
    } else if (para) {
      para.text += `\n${line}`;
    } else {
      para = { kind: 'text', text: line };
      blocks.push(para);
    }
  }
  return { heading: lines[first].trim(), blocks };
}

// 'use `x` now' -> [{code:false,text:'use '},{code:true,text:'x'},{code:false,text:' now'}]
export function splitCode(line) {
  const out = [];
  const re = /`([^`]+)`/g;
  let last = 0;
  let m;
  while ((m = re.exec(line ?? ''))) {
    if (m.index > last) out.push({ code: false, text: line.slice(last, m.index) });
    out.push({ code: true, text: m[1] });
    last = re.lastIndex;
  }
  if (last < (line ?? '').length) out.push({ code: false, text: line.slice(last) });
  return out;
}
