'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { usageMeter, usageDelta, shareUsage, usageText } = require('../src/usage');

const reading = (five, seven, { at = new Date().toISOString(), fiveReset = 100, sevenReset = 200 } = {}) => ({
  at,
  fiveHour: five == null ? null : { utilization: five, resetsAt: fiveReset },
  sevenDay: seven == null ? null : { utilization: seven, resetsAt: sevenReset },
});

test('meter: first and last reading give the used percent', () => {
  const m = usageMeter(null);
  m.see(reading(0.25, 0.06));
  m.see(reading(0.27, 0.06));
  m.see(reading(0.31, 0.07));
  assert.deepEqual(m.result(), { fiveHour: { from: 25, to: 31 }, sevenDay: { from: 6, to: 7 } });
});

test('meter: a recent earlier reading is the starting point, an old one is not', () => {
  const recent = usageMeter(reading(0.2, 0.05));
  recent.see(reading(0.25, 0.06));
  assert.deepEqual(recent.result().fiveHour, { from: 20, to: 25 });
  const old = usageMeter(reading(0.2, 0.05, { at: new Date(Date.now() - 10 * 60 * 1000).toISOString() }));
  old.see(reading(0.25, 0.06));
  old.see(reading(0.26, 0.06));
  assert.deepEqual(old.result().fiveHour, { from: 25, to: 26 });
});

test('meter: no readings (API key sign-in, rule-based) gives nothing', () => {
  assert.equal(usageMeter(null).result(), null);
  assert.equal(usageText(null), '');
});

test('delta: a window that reset in between counts from 0', () => {
  const d = usageDelta(reading(0.9, 0.3, { fiveReset: 100 }), reading(0.04, 0.31, { fiveReset: 500 }));
  assert.deepEqual(d, { fiveHour: { from: 0, to: 4 }, sevenDay: { from: 30, to: 31 } });
});

test('text: measured percent per window', () => {
  const u = { fiveHour: { from: 25, to: 28 }, sevenDay: { from: 6, to: 7 } };
  assert.equal(usageText(u), '사용량 5시간 +3%(25→28%) · 7일 +1%(6→7%)');
  assert.equal(usageText({ fiveHour: { from: 40, to: 40 } }), '사용량 5시간 1% 미만(40→40%)');
  assert.equal(usageText({ estimated: true, fiveHour: { share: 0 } }), '사용량 5시간 1% 미만 (추정: 동시 변환이라 전체 사용량을 화면별 토큰 비용 비율로 나눔)');
});

test('share: the run usage is split by each screen cost, marked as an estimate', () => {
  const run = { fiveHour: { from: 20, to: 32 }, sevenDay: { from: 5, to: 6 } };
  const [a, b, c, none] = shareUsage(run, [0.5, 0.3, 0.2, 0]);
  assert.deepEqual(a, { estimated: true, fiveHour: { share: 6 }, sevenDay: { share: 0.5 } });
  assert.deepEqual(b, { estimated: true, fiveHour: { share: 3.6 }, sevenDay: { share: 0.3 } });
  assert.deepEqual(c, { estimated: true, fiveHour: { share: 2.4 }, sevenDay: { share: 0.2 } });
  assert.equal(none, null);
  assert.equal(usageText(a), '사용량 5시간 약 +6% · 7일 약 +0.5% (추정: 동시 변환이라 전체 사용량을 화면별 토큰 비용 비율로 나눔)');
  assert.deepEqual(shareUsage(null, [1, 2]), [null, null]);
  assert.deepEqual(shareUsage(run, [0, 0]), [null, null]);
});
