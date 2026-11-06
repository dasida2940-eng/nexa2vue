'use strict';

// Claude usage as a share of the plan's limits, instead of dollars.
// Claude Code's stream-json "rate_limit_event" gives the account's current
// utilization (0..1) for the 5-hour and 7-day windows (ai-convert recordUsage).
// A meter keeps the first and last reading seen during some work; the
// difference is what that work used (plus anything else running at the time).

const WINDOWS = [['fiveHour', '5시간'], ['sevenDay', '7일']];
// A reading older than this is not used as the starting point
const BASELINE_MAX_AGE_MS = 2 * 60 * 1000;

const pct = (w) => Math.round(w.utilization * 100);

/** start: an earlier reading (e.g. the last one seen before the work began), used when recent. */
function usageMeter(start) {
  const fresh = start && start.at && Date.now() - Date.parse(start.at) <= BASELINE_MAX_AGE_MS;
  let from = fresh ? start : null;
  let to = null;
  return {
    see(u) {
      if (!u) return;
      if (!from) from = u;
      to = u;
    },
    result() {
      return usageDelta(from, to);
    },
  };
}

/** { fiveHour: { from, to }, sevenDay: { from, to } } in whole percent, or null without readings. */
function usageDelta(from, to) {
  if (!from || !to) return null;
  const out = {};
  for (const [key] of WINDOWS) {
    const a = from[key];
    const b = to[key];
    if (!b || typeof b.utilization !== 'number') continue;
    // The window reset in between: the usage started again from 0
    const reset = !a || typeof a.utilization !== 'number' || (a.resetsAt && b.resetsAt && a.resetsAt !== b.resetsAt);
    out[key] = { from: reset ? 0 : pct(a), to: pct(b) };
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Screens converted at the same time all move the one account figure, so each
 * screen's share is estimated: the whole run's usage split by each screen's
 * token cost (Claude Code reports that per session). weights: [number] (>= 0).
 * Returns one usage per weight: { fiveHour: { share }, sevenDay: { share }, estimated: true }, or null.
 */
function shareUsage(runUsage, weights) {
  const total = weights.reduce((a, w) => a + (w > 0 ? w : 0), 0);
  if (!runUsage || !(total > 0)) return weights.map(() => null);
  return weights.map((w) => {
    if (!(w > 0)) return null;
    const out = { estimated: true };
    for (const [key] of WINDOWS) {
      const r = runUsage[key];
      if (r) out[key] = { share: Math.round((Math.max(0, r.to - r.from) * w / total) * 10) / 10 };
    }
    return out;
  });
}

/**
 * Measured: "사용량 5시간 +3%(25→28%) · 7일 +1%(6→7%)".
 * Estimated (screens ran at the same time): "사용량 5시간 약 +2.4% · 7일 약 +0.3% (추정: …)".
 */
function usageText(usage) {
  if (!usage) return '';
  const parts = WINDOWS.filter(([key]) => usage[key]).map(([key, label]) => {
    const w = usage[key];
    // Readings come in whole percent, so no change means "under 1%", not none
    if (usage.estimated) return w.share > 0 ? `${label} 약 +${w.share}%` : `${label} 1% 미만`;
    const d = Math.max(0, w.to - w.from);
    return `${label} ${d > 0 ? `+${d}%` : '1% 미만'}(${w.from}→${w.to}%)`;
  });
  if (!parts.length) return '';
  const note = usage.estimated ? ' (추정: 동시 변환이라 전체 사용량을 화면별 토큰 비용 비율로 나눔)' : '';
  return `사용량 ${parts.join(' · ')}${note}`;
}

module.exports = { usageMeter, usageDelta, shareUsage, usageText };
