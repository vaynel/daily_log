import assert from 'node:assert/strict';
import { test } from 'node:test';
import { percentile, summarize } from './voice-measure.mjs';

const turn = (stt, pro, tts) => ({ latencyMs: { stt, pro, tts, total: stt + pro + tts } });
test('summarize: 평균·백분위·비용을 값으로만 요약한다', () => {
  const s = summarize({
    turns: [turn(100, 200, 300), turn(200, 400, 600), turn(300, 600, 900)], rejected: [{ code: 'STT_EMPTY' }],
    calls: { stt: 4, pro: 3, tts: 3 }, estimatedCostKrw: 3.333, budgetKrw: 1000, stoppedReason: null, pricingNote: 'n',
  });
  assert.equal(s.turns, 3);
  assert.equal(s.latencyMs.totalAvg, 1200);
  assert.equal(s.latencyMs.totalP50, 1200);
  assert.equal(s.latencyMs.totalMax, 1800);
  assert.equal(s.estimatedCostKrw, 3.33);
  assert.equal(s.costPerTurnKrw, 1.11);
  assert.deepEqual(Object.keys(s).filter((k) => /text|key|audio/i.test(k)), []);
});
test('summarize: 턴이 없어도 깨지지 않는다', () => {
  const s = summarize({ turns: [], rejected: [], calls: { stt: 0, pro: 0, tts: 0 }, estimatedCostKrw: 0, budgetKrw: 1, stoppedReason: 'BUDGET', pricingNote: '' });
  assert.equal(s.costPerTurnKrw, null);
  assert.equal(percentile([], 50), null);
});
