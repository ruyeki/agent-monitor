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

// Tokens only: Claude Code 2.1.287 writes claudeAiOauth without accountUuid.
export const hasTokens = (o) => Boolean(o && typeof o === 'object' && typeof o.accessToken === 'string' && o.accessToken
  && typeof o.refreshToken === 'string' && o.refreshToken);

const str = (v) => (typeof v === 'string' && v ? v : null);

const rawAccount = (claudeJson) => {
  try { return JSON.parse(fs.readFileSync(guardReal(claudeJson), 'utf8'))?.oauthAccount ?? null; } catch { return null; }
};

// Claude Code's .claude.json oauthAccount -> {accountUuid, email, organizationUuid}, or null. Read only, never throws.
export function readOauthAccount(claudeJson) {
  const a = rawAccount(claudeJson);
  const accountUuid = str(a?.accountUuid);
  return accountUuid ? { accountUuid, email: str(a.emailAddress), organizationUuid: str(a.organizationUuid) } : null;
}

// Just oauthAccount's email, for an oauthAccount that has no accountUuid, or null.
export const readOauthEmail = (claudeJson) => str(rawAccount(claudeJson)?.emailAddress);

const NO_LOGIN = { oauth: null, accountUuid: null, email: null, reason: null };

// Who the live login is -> {oauth, accountUuid, email, reason}. oauth carries an accountUuid when known.
// No tokens: all null (no live login). Uncertain: oauth null and reason set. The creds' own accountUuid is trusted.
// Without one (a renewal drops it) the carried reg.live account holds as long as .claude.json's oauthAccount names it
// or is unchanged since it was recorded (it lags after a swap; absent counts only if it was absent when recorded);
// a changed one naming another account, or a missing or unreadable one that was there, is uncertain.
// A registry without live uses the older rule: oauthAccount, unless Agent Monitor switched last and it names another account.
export function liveIdentity({ home, claudeJson, reg }) {
  const live = liveOauth(home);
  if (!hasTokens(live)) return NO_LOGIN;
  if (str(live.accountUuid)) return { oauth: live, accountUuid: live.accountUuid, email: null, reason: null };
  const oa = readOauthAccount(claudeJson);
  const carried = reg?.live;
  if (str(carried?.accountUuid)) {
    const c = carried.accountUuid;
    // An absent oauthAccount only counts as unchanged when it was absent when recorded (a missing or half-written file is uncertain).
    const oaUuid = oa?.accountUuid ?? null;
    if (oaUuid === c || oaUuid === (carried.oauthAccount ?? null)) {
      const org = carried.organizationUuid ?? live.organizationUuid ?? (oa?.accountUuid === c ? oa.organizationUuid : null);
      return { oauth: { ...live, accountUuid: c, ...(org ? { organizationUuid: org } : {}) }, accountUuid: c, email: oa?.accountUuid === c ? oa.email : null, reason: null };
    }
    const name = Object.keys(reg.accounts ?? {}).find((n) => reg.accounts[n].accountUuid === c);
    const reason = `the live login carries no account id, and Claude Code's .claude.json now ${oa ? `names ${oa.email ?? 'another account'}` : 'names no account (missing or unreadable)'}`
      + `, but Agent Monitor last knew the live login as ${name ? `"${name}"` : 'another account'}; sign in to Claude Code (/login) as the account you want`;
    return { oauth: null, accountUuid: null, email: null, reason };
  }
  const to = reg?.lastSwitch?.to;
  const wanted = to ? reg.accounts?.[to]?.accountUuid : null;
  if (oa && (!reg?.lastSwitch || oa.accountUuid === wanted)) {
    const org = live.organizationUuid ?? oa.organizationUuid;
    return { oauth: { ...live, accountUuid: oa.accountUuid, ...(org ? { organizationUuid: org } : {}) }, accountUuid: oa.accountUuid, email: oa.email, reason: null };
  }
  const reason = `the live login carries no account id; Claude Code's .claude.json names ${oa ? (oa.email ?? 'another account') : 'no account'}`
    + `${to ? `, but Agent Monitor last switched to "${to}"` : ''}; sign in to Claude Code (/login) as the account you want, or wait for Claude Code to re-read its account profile (within a day)`;
  return { oauth: null, accountUuid: null, email: null, reason };
}

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
