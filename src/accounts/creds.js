// The live Claude Code login, <home>/.credentials.json: read it, and swap its claudeAiOauth for a saved one.
// Only claudeAiOauth and organizationUuid ever change; key order and formatting are kept, mcpOAuth is never touched.
import fs from 'node:fs';
import path from 'node:path';
import { guardReal } from './paths.js';
import { writeAtomic } from './state.js';

export const credsPath = (home) => path.join(guardReal(home), '.credentials.json');

// The file's text, or null when there is none.
export function readCredsText(home) {
  try { return fs.readFileSync(credsPath(home), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

// Parsed credentials ({} for no file). A file that is not a JSON object throws.
export function parseCreds(text) {
  if (text == null) return {};
  let o;
  try { o = JSON.parse(text); } catch { throw new Error('.credentials.json is not valid JSON'); }
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('.credentials.json is not a JSON object');
  return o;
}

// The live claudeAiOauth, or null. Never throws.
export function liveOauth(home) {
  try { return parseCreds(readCredsText(home)).claudeAiOauth ?? null; } catch { return null; }
}

// A usable login: accessToken and refreshToken non-empty strings and an accountUuid.
export const validOauth = (o) => Boolean(o && typeof o === 'object' && typeof o.accessToken === 'string' && o.accessToken
  && typeof o.refreshToken === 'string' && o.refreshToken && typeof o.accountUuid === 'string' && o.accountUuid);

// A vault value -> a valid login, or null.
export function parseOauth(text) {
  if (typeof text !== 'string') return null;
  try { const o = JSON.parse(text); return validOauth(o) ? o : null; } catch { return null; }
}

// New file text: current with claudeAiOauth replaced and organizationUuid = target's (else kept).
export function swapText(curText, target) {
  const cur = parseCreds(curText);
  const next = { ...cur, claudeAiOauth: target };
  const org = target.organizationUuid ?? cur.organizationUuid;
  if (org !== undefined) next.organizationUuid = org;
  const indent = curText ? /^\{\r?\n([ \t]+)"/.exec(curText)?.[1] : undefined;
  const nl = curText && /\n$/.test(curText) ? '\n' : '';
  return JSON.stringify(next, null, indent) + nl;
}

// Writes the swapped login and reads it back. On a bad read-back the old text (or no file) is restored and it throws.
// write is replaceable in tests.
export function applySwap(home, curText, target, { write = writeAtomic } = {}) {
  const file = credsPath(home);
  const cur = parseCreds(curText);
  write(file, swapText(curText, target));
  let ok = false;
  try {
    const back = JSON.parse(fs.readFileSync(file, 'utf8'));
    ok = back?.claudeAiOauth?.accountUuid === target.accountUuid && JSON.stringify(back.mcpOAuth) === JSON.stringify(cur.mcpOAuth);
  } catch { ok = false; }
  if (ok) return;
  if (curText == null) fs.rmSync(file, { force: true }); else writeAtomic(file, curText);
  throw new Error('the new login did not read back correctly; the previous login was restored');
}
