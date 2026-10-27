// Usage and version statistics. Everything here is an estimate built from the indexer's numbers and the price table.
import { priceFor } from './prices.js';
import { attributeRun, toTokens, emptyAcc, add, isLead } from './attribution.js';

const pad = (n) => String(n).padStart(2, '0');
export const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const shiftDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const COUNTS = ['input', 'output', 'cacheWrite', 'cacheRead'];

const sum = (rows, prices) => { const a = emptyAcc(); for (const r of rows) add(a, r, priceFor(prices, r.model)); return toTokens(a); };

// Dashboard numbers: today, Monday-start week, calendar month and the average of the latest 30 days with data.
export function usageStats({ usage, prices, now = new Date(), days = 90 }) {
  const today = localDay(now);
  const weekStart = localDay(shiftDays(now, -((now.getDay() + 6) % 7)));
  const monthStart = `${today.slice(0, 8)}01`;
  const rows = usage.daily({});
  const inRange = (from) => rows.filter((r) => r.day >= from && r.day <= today);

  const dataDays = [...new Set(rows.filter((r) => r.day <= today).map((r) => r.day))].sort().slice(-30);
  const avgRows = rows.filter((r) => dataDays.includes(r.day));
  const n = dataDays.length;
  const total = sum(avgRows, prices);
  const mean = emptyAcc();
  for (const f of COUNTS) mean[f] = n ? Math.round(total[f] / n) : 0;
  mean.cost = n ? total.cost / n : 0;
  mean.unpriced = n ? Math.round(total.unpriced / n) : 0;
  const avg = { days: n, ...toTokens(mean) };

  const windowRows = inRange(localDay(shiftDays(now, -(days - 1))));
  const daily = windowRows.map((r) => {
    const t = sum([r], prices);
    return { day: r.day, model: r.model, input: r.input, output: r.output, cacheWrite: r.cacheWrite, cacheRead: r.cacheRead, total: t.total, cost: t.cost };
  });
  const unpricedModels = [...new Set(windowRows.filter((r) => r.model && !priceFor(prices, r.model)).map((r) => r.model))].sort();
  return {
    indexer: usage.status(),
    periods: { today: sum(inRange(today), prices), week: sum(inRange(weekStart), prices), month: sum(inRange(monthStart), prices), avg30: avg },
    daily, unpricedModels,
  };
}

const memos = new WeakMap(); // usage -> Map(runId -> {base, generation, frozen, att})
const FREEZE_AFTER_MS = 60_000;

// Attribution of one run from the indexer's numbers; null when the run does not exist. Only lead agents load
// per-message rows (they need timestamps); everyone else is one SUMmed row per (agent, model) and per (session, model).
// Memoised per run: a hit needs the same run, agents, visits and prices and the same indexer write generation. An ended
// run is frozen once a scan has finished more than a minute after it ended, so old runs are never recomputed.
export function runAttribution(store, usage, runId, now = Date.now(), input = store.attributionInput(runId), status = usage.status()) {
  if (!input) return null;
  const prices = usage.prices();
  const base = JSON.stringify([store.getRun(runId).updated_at, input.run, input.agents, input.visits, input.mainSessions, prices]);
  let memo = memos.get(usage);
  if (!memo) memos.set(usage, (memo = new Map()));
  const hit = memo.get(runId);
  if (hit && hit.base === base && (hit.frozen || hit.generation === status.generation)) return hit.att;

  const subs = input.agents.filter((a) => a.type !== 'main');
  const leadIds = subs.filter(isLead).map((a) => a.id);
  const otherIds = subs.filter((a) => !isLead(a)).map((a) => a.id);
  const { createdAt, endedAt } = input.run;
  const rows = (list) => list.map((r) => ({ ...r, ts: createdAt }));
  const messages = [
    ...(leadIds.length ? usage.messages({ agentIds: leadIds }) : []),
    ...(otherIds.length ? rows(usage.totals({ agentIds: otherIds })) : []),
    ...(input.mainSessions.length
      ? rows(usage.totals({ sessionIds: input.mainSessions, agentNull: true, from: createdAt, to: endedAt ?? new Date(now).toISOString() })) : []),
  ];
  const att = attributeRun({ ...input, messages, prices, now });
  memo.set(runId, { base, generation: status.generation, frozen: !!endedAt && Date.parse(status.lastScanAt) - Date.parse(endedAt) > FREEZE_AFTER_MS, att });
  return att;
}

// Per workflow version: finished runs (status 'done'), mean tokens and duration, and the same per node.
export function versionStats(store, usage, now = Date.now()) {
  const byVersion = new Map();
  const status = usage.status();
  for (const run of store.finishedRuns()) {
    const input = store.attributionInput(run.id);
    const att = runAttribution(store, usage, run.id, now, input, status);
    const perNode = new Map();
    for (const v of input.visits) perNode.set(v.node, (perNode.get(v.node) ?? 0) + (Date.parse(v.leftAt ?? run.endedAt) - Date.parse(v.enteredAt)));
    if (!byVersion.has(run.version)) byVersion.set(run.version, []);
    byVersion.get(run.version).push({ tokens: att.total.total, durationMs: Date.parse(run.endedAt) - Date.parse(run.createdAt), att, perNode });
  }
  const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
  return store.versions().map(({ version, publishedAt }) => {
    const runs = byVersion.get(version) ?? [];
    const wf = store.version(version);
    return {
      version, publishedAt, finishedRuns: runs.length, avgTokens: mean(runs.map((r) => r.tokens)), avgDurationMs: mean(runs.map((r) => r.durationMs)),
      nodes: wf.nodes.map((n) => {
        const seen = runs.filter((r) => r.perNode.has(n.id));
        return { id: n.id, name: n.name, runs: seen.length, avgTokens: mean(seen.map((r) => r.att.nodes[n.id]?.total ?? 0)), avgDurationMs: mean(seen.map((r) => r.perNode.get(n.id))) };
      }),
    };
  });
}
