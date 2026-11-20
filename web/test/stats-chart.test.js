import { afterEach, describe, expect, it, vi } from 'vitest';
import { arcPath, buildSeries, compactCost, dayRange, linePath, linePoints, maxSeriesValue, modelSlots, niceTicks, periodDelta, rankByMetric, readChoice, shareLabel, shortModel, sliceAngles, stageSlices, stageSlots, summarizeRuns, topModels, totalsByModel, writeChoice } from '../src/stats/chart.js';

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

describe('line chart points', () => {
  it('puts a point at each column centre, zero days on the baseline, and the largest single series sets the y axis', () => {
    const plot = { left: 10, step: 20, top: 5, height: 100, max: 4 };
    expect(linePoints([0, 2, 4, 0], plot)).toEqual([{ x: 20, y: 105 }, { x: 40, y: 55 }, { x: 60, y: 5 }, { x: 80, y: 105 }]);
    expect(linePath([{ x: 1, y: 2 }, { x: 3.456, y: 4 }])).toBe('M1 2 L3.46 4');
    const daily = [row('2026-10-27', 'claude-opus-5-5', 3), row('2026-10-27', 'claude-sonnet-5', 2), row('2026-10-26', 'claude-sonnet-5', 2.5)];
    const { columns } = buildSeries(daily, { metric: 'cost', days: 7, now: NOW });
    expect(columns.at(-1).total).toBe(5); // stacked it would be 5
    expect(maxSeriesValue(columns)).toBe(3); // largest single series: 3
    expect(maxSeriesValue([])).toBe(0);
  });
});

describe('topModels', () => {
  const seven = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n, i) => row('2026-10-27', `claude-${n}-1`, 10 - i, i));
  it('gives the top 5 with slots plus Other with its model count, and the daily chart uses the same members', () => {
    const top = topModels(seven, 'cost');
    expect(top.map((t) => t.key)).toEqual(['A 1', 'B 1', 'C 1', 'D 1', 'E 1', 'Other']);
    expect(top.map((t) => t.slot)).toEqual([0, 1, 2, 3, 4, -1]);
    expect(top.at(-1)).toMatchObject({ label: 'Other', count: 2, cost: 9, tokens: 11 });
    expect(top[0]).toMatchObject({ cost: 10, tokens: 0 });
    expect(buildSeries(seven, { metric: 'cost', days: 7, now: NOW }).series.map((s) => [s.key, s.slot])).toEqual(top.map((t) => [t.key, t.slot]));
  });
  it('has no Other with 5 models or fewer and applies the lowest-free-slot rule', () => {
    const slots = new Map([['A 1', 6]]); // B 1 and C 1 have no slot
    const top = topModels(seven.slice(0, 3), 'cost', slots);
    expect(top.map((t) => t.key)).toEqual(['A 1', 'B 1', 'C 1']);
    expect(top.map((t) => t.slot)).toEqual([6, 0, 1]);
  });
  it('ranks by tokens when asked', () => {
    expect(topModels(seven, 'tokens').map((t) => t.key).slice(0, 2)).toEqual(['G 1', 'F 1']);
  });
});

describe('donut geometry', () => {
  const sum = (a) => a.reduce((n, x) => n + (x.end - x.start), 0);
  it('adds slice angles up to 360, in order from 0', () => {
    const a = sliceAngles([1, 1, 2]);
    expect(a.map((x) => x.start)).toEqual([0, 90, 180]);
    expect(a.at(-1).end).toBeCloseTo(360, 9);
    expect(sum(a)).toBeCloseTo(360, 9);
  });
  it('gives a tiny slice a one degree sliver and shrinks the rest to keep 360', () => {
    const a = sliceAngles([1000, 1, 1000]);
    expect(a[1].end - a[1].start).toBe(1);
    expect(sum(a)).toBeCloseTo(360, 9);
    expect(a[0].end - a[0].start).toBeCloseTo(179.5, 9);
  });
  it('gives zero values no angle, and an all-zero list nothing', () => {
    expect(sliceAngles([0, 5, 0]).map((x) => x.end - x.start)).toEqual([0, 360, 0]);
    expect(sliceAngles([0, 0]).every((x) => x.start === 0 && x.end === 0)).toBe(true);
  });
  it('builds ring paths: a quarter starts at 12 o clock, a full circle takes two arcs per edge', () => {
    expect(arcPath(100, 100, 90, 64, 0, 90)).toBe('M100 10 A90 90 0 0 1 190 100 L164 100 A64 64 0 0 0 100 36 Z');
    expect(arcPath(100, 100, 90, 64, 0, 270)).toContain('A90 90 0 1 1'); // large arc
    const full = arcPath(100, 100, 90, 64, 0, 360);
    expect(full.match(/A/g)).toHaveLength(4);
    expect(full.match(/M/g)).toHaveLength(2);
  });
});

describe('stage slices', () => {
  const node = (id, runs, avgTokens, avgCost, avgDurationMs = 1000) => ({ id, name: id.toUpperCase(), runs, avgTokens, avgCost, avgDurationMs });
  const ver = (nodes, avgTokens, avgCost, finishedRuns = 4) => ({ version: 1, finishedRuns, avgTokens, avgCost, avgDurationMs: 1, nodes });

  it('uses the per-run contribution (average x runs / finished runs) and adds the unstaged rest', () => {
    const v = ver([node('a', 4, 100, 1), node('b', 2, 100, 1), node('c', 0, 50, 5)], 300, 3);
    const { total, slices } = stageSlices(v, 'cost');
    expect(total).toBe(3);
    expect(slices.map((s) => [s.key, s.value])).toEqual([['a', 1], ['b', 0.5], ['not-staged', 1.5]]); // c has no runs
    expect(slices.at(-1)).toMatchObject({ label: 'Not tied to a stage', color: 'var(--border-strong)', slot: -2 });
    const t = stageSlices(v, 'tokens');
    expect(t.slices.map((s) => s.value)).toEqual([100, 50, 150]);
    expect(t.slices.reduce((n, s) => n + s.value, 0)).toBe(t.total);
  });

  it('shows the unstaged rest only above 0.5% of the average', () => {
    const keys = (rest) => stageSlices(ver([node('a', 4, 1, 100 - rest)], 1, 100), 'cost').slices.map((s) => s.key);
    expect(keys(0.5)).toEqual(['a']); // exactly 0.5% is not above it
    expect(keys(0.6)).toEqual(['a', 'not-staged']);
    expect(keys(0)).toEqual(['a']);
  });

  it('keeps 7 slices at most: the 6 largest in workflow order, Other stages after the last stage, then the unstaged rest', () => {
    const nodes = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id, i) => node(id, 4, 10, 1 + i * 0.01 + (id === 'c' ? 5 : 0)));
    const { slices } = stageSlices(ver(nodes, 80, 20), 'cost');
    const stages = slices.filter((s) => s.key !== 'not-staged');
    expect(stages).toHaveLength(7);
    expect(stages.map((s) => s.key)).toEqual(['c', 'd', 'e', 'f', 'g', 'h', 'other-stages']); // a and b are the smallest, folded
    expect(stages.at(-1)).toMatchObject({ label: 'Other stages', color: 'var(--series-other)', count: 2 });
    expect(stages.at(-1).value).toBeCloseTo(1 + 1.01, 9);
    expect(slices.at(-1).key).toBe('not-staged'); // last, and not one of the 7
    expect(slices).toHaveLength(8);
  });

  it('does not fold exactly 7 stages', () => {
    const nodes = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => node(id, 4, 10, 1));
    expect(stageSlices(ver(nodes, 70, 7), 'cost').slices.map((s) => s.key)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g']);
  });

  it('ranks stage colour slots by per-run cost, then tokens, then workflow order', () => {
    const v = ver([node('a', 4, 100, 1), node('b', 4, 300, 3), node('c', 4, 200, 1), node('d', 4, 100, 1), node('e', 0, 0, 0)], 700, 6);
    const slots = stageSlots(v);
    expect([...slots.entries()].sort((x, y) => x[1] - y[1])).toEqual([['b', 0], ['c', 1], ['a', 2], ['d', 3]]); // a and d tie on cost and tokens: workflow order
    expect(stageSlices(v, 'tokens').slices.filter((s) => s.node).map((s) => [s.key, s.slot])).toEqual([['a', 2], ['b', 0], ['c', 1], ['d', 3]]);
  });

  it('keeps zero-value stages as legend-only slices', () => {
    const v = ver([node('a', 4, 100, 0), node('b', 4, 100, 2)], 200, 2);
    expect(stageSlices(v, 'cost').slices.map((s) => [s.key, s.value])).toEqual([['a', 0], ['b', 2]]);
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
