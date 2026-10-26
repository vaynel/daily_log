import assert from 'node:assert/strict';
import { inspectQuality } from '../../../apps/server/src/video/quality.js';
import { input } from '../../../apps/server/src/video/quality.testutil.js';
// The exact excluded phrase is present across successive scene captions.
const i = input();
i.excludedTexts = ['비공개 프로젝트'];
i.scenes = [structuredClone(i.scenes[0]!), structuredClone(i.scenes[0]!)];
i.scenes[0]!.subtitles = ['비공개'];
i.scenes[1]!.key = 's2';
i.scenes[1]!.subtitles = ['프로젝트'];
const split = inspectQuality(i);
const control = input();
control.excludedTexts = i.excludedTexts;
control.scenes[0]!.subtitles = ['비공개', '프로젝트'];
const sameScene = inspectQuality(control);
console.log(JSON.stringify({sameScenePassed:sameScene.passed,crossScenePassed:split.passed,failedChecks:split.checks.filter(c=>!c.passed)},null,2));
assert.equal(sameScene.passed, false);
assert.equal(split.passed, false, 'AC-1: exact excluded phrase across scene captions must be rejected');
