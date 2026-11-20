import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildSeries, compactCost, dayRange, modelSlots, niceTicks, periodDelta, rankByMetric, readChoice, shareLabel, shortModel, summarizeRuns, totalsByModel, writeChoice } from '../src/stats/chart.js';

const NOW = new Date(2026, 9, 27, 12, 0, 0); // local noon, whatever TZ the machine uses
const row = (day, model, cost, tokens = 0, costs) => ({ day, model, input: tokens, output: 0, cacheWrite: 0, cacheRead: 0, total: tokens, cost, costs: costs ?? { input: cost, output: 0, cacheWrite: 0, cacheRead: 0 } });

describe('shortModel', () => {
  it('turns claude ids into "Family major[.minor]"', () => {
    expect(shortModel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(shortModel('claude-haiku-4-5-20251001')).toBe('Haiku 4.5');
    expect(shortModel('claude-opus-5')).toBe('Opus 5');
    expect(shortModel('claude-opus-5-5-20261001')).toBe('Opus 5.5');
    expect(shortModel('claude-opus-5-20261001')).toBe('Opus 5');
  });
  it('leaves everything else unchanged', () => {
    for (const id of ['gpt-5', 'mystery-1', 'claude-3-5-sonnet-20241022', '', 'unknown']) expect(shortModel(id)).toBe(id);
  });
});

describe('niceTicks', () => {
  it('gives 4-5 gridlines from zero with a 1/2/2.5/5 step that covers the max', () => {
    for (const max of [0, 0.3, 1, 3, 4, 7, 10, 42, 75, 99, 100, 130, 1234, 2_500_000, 7.77e9]) {
      const t = niceTicks(max);
      expect([4, 5]).toContain(t.length);
      expect(t[0]).toBe(0);
      expect(t.at(-1)).toBeGreaterThanOrEqual(max);
      const s = t[1];
      const mantissa = s / 10 ** Math.floor(Math.log10(s));
      expect([1, 2, 2.5, 5]).toContain(+mantissa.toPrecision(6));
      t.forEach((v, i) => expect(v).toBeCloseTo(i * s, 9));
    }
    expect(niceTicks(100)).toEqual([0, 25, 50, 75, 100]);
    expect(niceTicks(0)).toEqual(niceTicks(1));
  });
  it('keeps whole steps for counts', () => {
    for (const max of [0, 1, 2, 5, 9, 10, 13]) {
      const t = niceTicks(max, { integer: true });
      expect(t.every(Number.isInteger)).toBe(true);
      expect(t.at(-1)).toBeGreaterThanOrEqual(max);
    }
  });
  it('labels cost axes compactly', () => {
    expect([0, 50, 0.25, 1500, 1000, 12_000].map(compactCost)).toEqual(['$0', '$50', '$0.25', '$1.5k', '$1k', '$12k']);
  });
});

describe('shareLabel', () => {
  it('uses one decimal under 1%', () => {
    expect([0, 0.4, 0.04, 1, 12.6, 100].map(shareLabel)).toEqual(['0%', '0.4%', '0.0%', '1%', '13%', '100%']);
  });
});

describe('series building', () => {
  const manyModels = () => Array.from({ length: 8 }, (_, i) => row('2026-10-27', `claude-opus-${i + 1}`, 10 - i, 100 * (i + 1)));

  it('keeps 5 models ranked by the selected metric and folds the rest into Other (last)', () => {
    const daily = manyModels();
    const cost = buildSeries(daily, { split: 'model', metric: 'cost', days: 30, now: NOW });
    expect(cost.series.map((s) => s.label)).toEqual(['Opus 1', 'Opus 2', 'Opus 3', 'Opus 4', 'Opus 5', 'Other']);
    expect(cost.series.at(-1)).toMatchObject({ key: 'Other', slot: -1 });
    const tokens = buildSeries(daily, { split: 'model', metric: 'tokens', days: 30, now: NOW });
    expect(tokens.series.map((s) => s.label)).toEqual(['Opus 8', 'Opus 7', 'Opus 6', 'Opus 5', 'Opus 4', 'Other']);
    const day = cost.columns.find((c) => c.day === '2026-10-27');
    expect(day.values.Other).toBe(5 + 4 + 3); // Opus 6, 7, 8
    expect(cost.total).toBeCloseTo(10 + 9 + 8 + 7 + 6 + 5 + 4 + 3, 9);
  });

  it('has no Other with 5 models or fewer; ids with the same short label merge', () => {
    const daily = [row('2026-10-27', 'claude-opus-5-5', 1), row('2026-10-26', 'claude-opus-5-5-20261001', 2), row('2026-10-26', 'claude-sonnet-5', 4)];
    const { series, columns } = buildSeries(daily, { metric: 'cost', days: 7, now: NOW });
    expect(series.map((s) => s.key)).toEqual(['Sonnet 5', 'Opus 5.5']);
    expect(columns.reduce((n, c) => n + c.values['Opus 5.5'], 0)).toBe(3);
  });

  it('keeps colour slots when the metric changes (slots follow the model, ranked by cost over the whole response)', () => {
    const daily = [row('2026-10-27', 'claude-opus-5', 10, 10), row('2026-10-27', 'claude-sonnet-5', 5, 1000), row('2026-10-27', 'claude-haiku-4-5', 1, 500)];
    const slots = modelSlots(daily);
    expect([...slots]).toEqual([['Opus 5', 0], ['Sonnet 5', 1], ['Haiku 4.5', 2]]);
    const slotOf = (metric, label) => buildSeries(daily, { metric, days: 7, slots, now: NOW }).series.find((s) => s.label === label).slot;
    for (const label of ['Opus 5', 'Sonnet 5', 'Haiku 4.5']) expect(slotOf('cost', label)).toBe(slotOf('tokens', label));
    // stack order does follow the metric
    expect(buildSeries(daily, { metric: 'tokens', days: 7, slots, now: NOW }).series.map((s) => s.label)).toEqual(['Sonnet 5', 'Haiku 4.5', 'Opus 5']);
  });

  it('ranks slots by cost, then tokens, then label', () => {
    const slots = modelSlots([row('2026-10-27', 'b-model', 1, 5), row('2026-10-27', 'a-model', 1, 5), row('2026-10-27', 'c-model', 1, 9), row('2026-10-27', 'top', 2, 1)]);
    expect([...slots.keys()]).toEqual(['top', 'c-model', 'a-model', 'b-model']);
  });

  it('gives a visible model without a slot the lowest slot no other visible series uses', () => {
    // nine models; the last two by cost (ranks 9 and 10 -> no slot) are the only ones with usage in the shown window
    const all = Array.from({ length: 10 }, (_, i) => row('2026-08-01', `m${i}`, 100 - i));
    const slots = modelSlots(all);
    expect(slots.size).toBe(8);
    const daily = [...all, row('2026-10-27', 'm8', 1), row('2026-10-27', 'm9', 1), row('2026-10-27', 'm2', 50)];
    const { series } = buildSeries(daily, { metric: 'cost', days: 7, slots, now: NOW });
    const bySlot = Object.fromEntries(series.map((s) => [s.label, s.slot]));
    expect(bySlot.m2).toBe(2);
    expect(bySlot.m8).toBe(0);
    expect(bySlot.m9).toBe(1);
  });

  it('splits by token type from costs (cost) or counts (tokens), always slots 0-3', () => {
    const daily = [{ day: '2026-10-27', model: 'claude-opus-5', input: 10, output: 20, cacheWrite: 30, cacheRead: 40, cost: 1, costs: { input: 0.1, output: 0.2, cacheWrite: 0.3, cacheRead: 0.4 } }];
    const cost = buildSeries(daily, { split: 'type', metric: 'cost', days: 7, now: NOW });
    expect(cost.series.map((s) => [s.key, s.slot])).toEqual([['input', 0], ['output', 1], ['cacheWrite', 2], ['cacheRead', 3]]);
    expect(cost.columns.at(-1).values).toEqual({ input: 0.1, output: 0.2, cacheWrite: 0.3, cacheRead: 0.4 });
    expect(buildSeries(daily, { split: 'type', metric: 'tokens', days: 7, now: NOW }).columns.at(-1).values).toEqual({ input: 10, output: 20, cacheWrite: 30, cacheRead: 40 });
  });

  it('shows only the last `days` days, oldest first, and counts the shown days only', () => {
    const daily = [row('2026-10-27', 'claude-opus-5', 1), row('2026-10-20', 'claude-opus-5', 2), row('2026-10-19', 'claude-opus-5', 4)];
    const { columns, total } = buildSeries(daily, { metric: 'cost', days: 7, now: NOW });
    expect(columns.map((c) => c.day)).toEqual(dayRange(7, NOW));
    expect(columns[0].day).toBe('2026-10-21');
    expect(total).toBe(1);
  });

  it('ranks and totals models for the spend list', () => {
    const t = totalsByModel([row('2026-10-27', 'claude-opus-5', 2, 10), row('2026-10-26', 'claude-opus-5', 1, 5), row('2026-10-26', 'claude-haiku-4-5', 0, 0)]);
    expect(t).toEqual([{ label: 'Opus 5', cost: 3, tokens: 15 }, { label: 'Haiku 4.5', cost: 0, tokens: 0 }]);
    expect(rankByMetric(t, 'cost').map((x) => x.label)).toEqual(['Opus 5']); // no data -> not listed
  });
});

describe('periodDelta', () => {
  // range 7 at 2026-10-27: current 10-21..10-27, previous 10-14..10-20
  const base = [row('2026-10-27', 'claude-opus-5', 112), row('2026-10-15', 'claude-opus-5', 100)];
  it('reports the rounded percentage with a direction glyph', () => {
    expect(periodDelta(base, { metric: 'cost', range: 7, firstDay: '2026-01-01', now: NOW })).toEqual({ kind: 'up', text: '▲ 12% vs previous 7 days' });
    expect(periodDelta([row('2026-10-27', 'm', 95), row('2026-10-15', 'm', 100)], { metric: 'cost', range: 7, firstDay: '2026-01-01', now: NOW })).toEqual({ kind: 'down', text: '▼ 5% vs previous 7 days' });
    expect(periodDelta([row('2026-10-27', 'm', 100), row('2026-10-15', 'm', 100)], { metric: 'cost', range: 7, firstDay: '2026-01-01', now: NOW })).toEqual({ kind: 'same', text: 'No change vs previous 7 days' });
  });
  it('uses the selected metric', () => {
    const rows = [row('2026-10-27', 'm', 1, 300), row('2026-10-15', 'm', 1, 100)];
    expect(periodDelta(rows, { metric: 'tokens', range: 7, firstDay: '2026-01-01', now: NOW }).text).toBe('▲ 200% vs previous 7 days');
    expect(periodDelta(rows, { metric: 'cost', range: 7, firstDay: '2026-01-01', now: NOW }).kind).toBe('same');
  });
  it('says nothing was there when the previous period is covered but empty', () => {
    expect(periodDelta([row('2026-10-27', 'm', 5)], { metric: 'cost', range: 7, firstDay: '2026-10-01', now: NOW })).toEqual({ kind: 'nothing', text: 'Nothing in the previous 7 days' });
  });
  it('says there is no data when usage starts after the previous period began', () => {
    expect(periodDelta([row('2026-10-27', 'm', 5)], { metric: 'cost', range: 7, firstDay: '2026-10-20', now: NOW })).toEqual({ kind: 'nodata', text: 'No data for the previous 7 days' });
    expect(periodDelta([row('2026-10-27', 'm', 5)], { metric: 'cost', range: 7, firstDay: '2026-10-14', now: NOW }).kind).toBe('nothing'); // exactly its first day: covered
    expect(periodDelta([], { metric: 'cost', range: 7, firstDay: null, now: NOW }).kind).toBe('nodata');
  });
});

describe('summarizeRuns', () => {
  const at = (d, h = 12) => new Date(2026, 9, d, h, 0, 0).toISOString();
  const run = (status, created, ended, round = 0) => ({ status, createdAt: created, endedAt: ended, round });
  const runs = [
    run('done', at(27, 10), at(27, 11), 1), // 1 h
    run('done', at(26, 10), at(26, 13), 3), // 3 h
    run('done', at(26, 8), at(26, 12), 2), // 4 h
    run('stopped', at(26, 9), at(26, 9), 0),
    run('active', at(25), null),
    run('waiting', at(25), null),
    run('done', at(1), at(1, 13), 9), // outside the 7 days
    { status: 'done', createdAt: 'nonsense' },
  ];
  it('counts runs per local day, outcomes, median duration and mean fix rounds of finished runs in range', () => {
    const s = summarizeRuns(runs, 7, NOW);
    expect(s.total).toBe(6);
    expect(s.perDay.map((d) => d.day)).toEqual(dayRange(7, NOW));
    expect(Object.fromEntries(s.perDay.filter((d) => d.count).map((d) => [d.day, d.count]))).toEqual({ '2026-10-25': 2, '2026-10-26': 3, '2026-10-27': 1 });
    expect(s.outcomes).toEqual({ finished: 3, stopped: 1, open: 2 });
    expect(s.medianMs).toBe(3 * 3_600_000);
    expect(s.avgRounds).toBe(2);
  });
  it('averages the two middle durations for an even count and gives null without finished runs', () => {
    expect(summarizeRuns([run('done', at(27, 10), at(27, 11)), run('done', at(27, 10), at(27, 13))], 7, NOW).medianMs).toBe(2 * 3_600_000);
    const none = summarizeRuns([run('stopped', at(27), at(27)), run('active', at(27), null)], 7, NOW);
    expect([none.medianMs, none.avgRounds]).toEqual([null, null]);
    expect(summarizeRuns([], 7, NOW).total).toBe(0);
    expect(summarizeRuns(undefined, 7, NOW).outcomes).toEqual({ finished: 0, stopped: 0, open: 0 });
  });
});

describe('remembered choices', () => {
  afterEach(() => vi.unstubAllGlobals());
  const store = (items) => ({ getItem: (k) => items[k] ?? null, setItem: (k, v) => { items[k] = v; } });

  it('reads a valid value, falls back for missing or invalid ones', () => {
    vi.stubGlobal('localStorage', store({ a: '7', b: '12', c: 'tokens' }));
    expect(readChoice('a', ['7', '30', '90'], '30')).toBe('7');
    expect(readChoice('b', ['7', '30', '90'], '30')).toBe('30');
    expect(readChoice('missing', ['7', '30', '90'], '30')).toBe('30');
    expect(readChoice('c', ['cost', 'tokens'], 'cost')).toBe('tokens');
  });
  it('writes the value as a string', () => {
    const items = {};
    vi.stubGlobal('localStorage', store(items));
    writeChoice('k', 90);
    expect(items.k).toBe('90');
  });
  it('survives storage that throws on every access', () => {
    const boom = () => { throw new Error('blocked'); };
    vi.stubGlobal('localStorage', { getItem: boom, setItem: boom });
    expect(readChoice('a', ['7', '30'], '30')).toBe('30');
    expect(() => writeChoice('a', 7)).not.toThrow();
  });
});
