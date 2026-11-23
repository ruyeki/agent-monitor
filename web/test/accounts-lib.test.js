import { describe, expect, it } from 'vitest';
import {
  NAME, STALE_MS, limitEnd, loginExpired, meterTone, msOf, needsAutoRefresh, resetsIn, signInHref, signInRunning, signInText, statusOf, switchBlock,
} from '../src/accounts/accountsLib.js';
import { parseRoute } from '../src/lib/route.js';

const NOW = Date.parse('2026-11-18T12:00:00Z');
const H = 3600_000;
const iso = (ms) => new Date(ms).toISOString();
const acc = (o = {}) => ({
  name: 'a', email: null, active: false, saved: true, status: 'no-reading', fiveHour: null, sevenDay: null, fiveHourResetsAt: null,
  sevenDayResetsAt: null, left: null, limitedUntil: null, refreshExpiresAt: iso(NOW + 30 * 24 * H), readingAt: null, ...o,
});

describe('accounts lib', () => {
  it('routes #/accounts to the accounts page', () => {
    expect(parseRoute('#/accounts')).toEqual({ name: 'accounts' });
    expect(parseRoute('#/accounts/x')).toEqual({ name: 'monitor' });
  });

  it('msOf takes epoch ms and ISO strings only', () => {
    expect(msOf(NOW)).toBe(NOW);
    expect(msOf(iso(NOW))).toBe(NOW);
    expect(msOf(null)).toBe(null);
    expect(msOf('nope')).toBe(null);
    expect(msOf(Number.NaN)).toBe(null);
  });

  it('NAME matches the server rule', () => {
    for (const n of ['a', 'lab', 'work-2', `a${'b'.repeat(31)}`]) expect(NAME.test(n)).toBe(true);
    for (const n of ['', 'Lab', '1abc', '-a', 'a_b', 'a b', `a${'b'.repeat(32)}`]) expect(NAME.test(n)).toBe(false);
  });

  it('statusOf: plain words and a pill tone per status', () => {
    expect(statusOf(acc({ status: 'available', readingAt: iso(NOW) }), NOW)).toEqual({ text: 'Available', tone: 'done' });
    expect(statusOf(acc(), NOW)).toEqual({ text: 'No usage reading yet', tone: 'idle' });
    expect(statusOf(acc({ status: 'no-login', saved: false }), NOW)).toEqual({ text: 'No saved login', tone: 'fail' });
    expect(statusOf(acc({ status: 'available', refreshExpiresAt: iso(NOW - H) }), NOW)).toEqual({ text: 'Login needs re-adding', tone: 'fail' });
    const lim = statusOf(acc({ status: 'limited', limitedUntil: NOW + 2 * H }), NOW);
    expect(lim.tone).toBe('wait');
    expect(lim.text).toMatch(/^Limited until \S/);
    expect(statusOf(acc({ status: 'limited' }), NOW).text).toBe('Limited');
  });

  it('limitEnd: the recorded limit, else the latest reset of a full window', () => {
    expect(limitEnd(acc({ limitedUntil: NOW + H }))).toBe(NOW + H);
    expect(limitEnd(acc({ fiveHour: 100, fiveHourResetsAt: NOW + H, sevenDay: 100, sevenDayResetsAt: NOW + 50 * H }))).toBe(NOW + 50 * H);
    expect(limitEnd(acc({ fiveHour: 100, fiveHourResetsAt: NOW + H, sevenDay: 40, sevenDayResetsAt: NOW + 50 * H }))).toBe(NOW + H);
    expect(limitEnd(acc({ fiveHour: 60, fiveHourResetsAt: NOW + H }))).toBe(null);
  });

  it('switchBlock: why a switch is disabled, in order of importance', () => {
    expect(switchBlock(acc({ status: 'available', readingAt: iso(NOW) }), { now: NOW })).toBe(null);
    expect(switchBlock(acc(), { now: NOW })).toBe(null); // no reading yet is no reason to refuse
    expect(switchBlock(acc({ status: 'no-login', saved: false }), { now: NOW })).toMatch(/No saved login/);
    expect(switchBlock(acc({ refreshExpiresAt: iso(NOW - H) }), { now: NOW })).toMatch(/login expired on .+add this account again/);
    expect(switchBlock(acc({ status: 'limited', limitedUntil: NOW + H }), { now: NOW })).toMatch(/^Out of usage until \S/);
    expect(switchBlock(acc({ status: 'available' }), { now: NOW, refreshing: true })).toMatch(/Wait for the usage refresh/);
    expect(loginExpired(acc({ saved: false, refreshExpiresAt: iso(NOW - H) }), NOW)).toBe(false);
  });

  it('needsAutoRefresh: only a refreshable account with a reading older than 30 minutes', () => {
    const data = (accounts, extra = {}) => ({ enabled: true, accounts, refresh: null, ...extra });
    const old = iso(NOW - STALE_MS - 1000);
    expect(needsAutoRefresh(data([acc({ status: 'available', readingAt: old })]), NOW)).toBe(true);
    expect(needsAutoRefresh(data([acc({ status: 'available', readingAt: iso(NOW - 10 * 60_000) })]), NOW)).toBe(false);
    expect(needsAutoRefresh(data([acc(), acc({ name: 'b' })]), NOW)).toBe(false); // missing readings alone
    expect(needsAutoRefresh(data([acc({ saved: false, status: 'no-login', readingAt: old })]), NOW)).toBe(false);
    expect(needsAutoRefresh(data([acc({ saved: false, active: true, readingAt: old })]), NOW)).toBe(true);
    expect(needsAutoRefresh(data([acc({ readingAt: old })], { refresh: { running: true, at: iso(NOW), results: [] } }), NOW)).toBe(false);
    expect(needsAutoRefresh({ enabled: false, accounts: [acc({ readingAt: old })] }, NOW)).toBe(false);
    expect(needsAutoRefresh(null, NOW)).toBe(false);
  });

  it('resetsIn and meterTone', () => {
    expect(resetsIn(NOW + 2 * H + 5 * 60_000, NOW)).toBe('resets in 2h 05m');
    expect(resetsIn(NOW - 1, NOW)).toBe('resets now');
    expect(resetsIn(null, NOW)).toBe(null);
    expect([meterTone(10), meterTone(80), meterTone(100)]).toEqual(['', 'high', 'full']);
  });

  it('signInHref: https links on Anthropic hosts only', () => {
    for (const u of ['https://claude.com/cai/oauth/authorize?x=1', 'https://claude.ai/login', 'https://console.anthropic.com/oauth']) expect(signInHref(u)).toBe(new URL(u).href);
    for (const u of ['javascript:alert(1)', 'http://claude.com/x', 'https://claude.com.evil.example/x', 'https://evil.example/?u=https://claude.com/',
      'https://user:pw@claude.ai/x', 'https://claude.ai:8443/x', 'data:text/html,hi', '', null, undefined]) expect(signInHref(u)).toBe(null);
  });

  it('signInRunning and signInText follow the sign-in state words', () => {
    for (const s of ['starting', 'waiting', 'checking', 'saving']) expect(signInRunning({ state: s })).toBe(true);
    for (const s of ['done', 'failed', 'cancelled']) expect(signInRunning({ state: s })).toBe(false);
    expect(signInRunning(null)).toBe(false);
    expect(signInText({ state: 'waiting', url: 'https://claude.ai/x', needsCode: true })).toMatch(/paste the code/);
    expect(signInText({ state: 'waiting', url: null, needsCode: true })).toMatch(/no sign-in link/);
    expect(signInText({ state: 'done', name: 'lab' })).toBe('Added "lab".');
    expect(signInText({ state: 'failed', error: 'sign-in did not finish (exit 1)' })).toBe('Sign-in failed: sign-in did not finish (exit 1). Nothing was saved.');
    expect(signInText({ state: 'failed', error: 'Bad name.' })).toBe('Sign-in failed: Bad name. Nothing was saved.');
    expect(signInText({ state: 'cancelled' })).toBe('Sign-in cancelled. Nothing was saved.');
  });
});
