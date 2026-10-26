import { createHash } from 'node:crypto';
import { classifyExclusion } from '../briefing/exclusion.js';
import { matchRule, type ExclusionRule } from '../briefing/rules.js';
import { checkOutput, type Probe } from './render.js';

export type QualityComponent = 'script' | 'visual' | 'transcript' | 'subtitles' | 'zooms' | 'render';
export interface Assessment { passed: boolean; evidence: string }
export interface QualityScene {
  key: string; script: string; visual: string; transcript: string; subtitles: string[]; zooms: string[];
  versions: { image: number; voice: number; subtitles: number; zoom: number };
  facts: Assessment; image: Assessment; learning: Assessment; readability: Assessment;
}
/** 전사·그림/사실/학습 검수 근거는 호출자가 제공한다. 누락은 통과로 추정하지 않는다. */
export interface QualityInput {
  file: string; sha256: string; scriptVersion: number; probe: Probe; expectedSec: number;
  scenes: QualityScene[]; rules: ExclusionRule[]; excludedTexts: string[];
}
export interface QualityCheck { scene: string | null; component: QualityComponent; passed: boolean; code: string; evidence: string }
export interface QualityReport { passed: boolean; file: string; sha256: string; scriptVersion: number; checks: QualityCheck[] }
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const speech = (s: string) => s.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase();
const normalized = (s: string) => s.normalize('NFKC').replace(/\s+/g, '').toLowerCase();

export function inspectQuality(i: QualityInput): QualityReport {
  const checks: QualityCheck[] = [];
  const add = (scene: string | null, component: QualityComponent, passed: boolean, code: string, evidence: string) => checks.push({ scene, component, passed, code, evidence });
  const exclusionOf = (text: string) => classifyExclusion(text) ?? (matchRule(text, i.rules) ? 'USER_RULE' : null)
    ?? (i.excludedTexts.some(x => normalized(x) && normalized(text).includes(normalized(x))) ? 'THIS_VIDEO_EXCLUDED' : null);
  add(null, 'render', i.scenes.length > 0 && Number.isInteger(i.scriptVersion) && i.scriptVersion > 0 && /^[a-f0-9]{64}$/.test(i.sha256), 'INPUT_IDENTITY', `sha256:${i.sha256}`);
  const issues = checkOutput(i.probe, i.expectedSec);
  if (!Number.isFinite(i.expectedSec) || i.expectedSec <= 0) issues.push('DURATION_MISMATCH');
  if (!issues.length) add(null, 'render', true, 'MEDIA_FORMAT', `duration:${i.probe.format.duration}`);
  for (const issue of issues) add(null, 'render', false, issue, `duration:${i.probe.format.duration}`);
  for (const s of i.scenes) {
    for (const component of ['script', 'visual', 'transcript', 'subtitles', 'zooms'] as const) {
      const value = s[component];
      const texts = typeof value === 'string' ? [value] : value.length > 1 ? [...value, value.join('')] : value;
      if (!texts.length && component !== 'zooms') add(s.key, component, false, 'MISSING_CONTENT', 'missing');
      for (const text of texts) {
        const exclusion = exclusionOf(text);
        const code = !text.trim() ? 'MISSING_CONTENT' : exclusion ?? 'PUBLIC_SCOPE';
        add(s.key, component, !!text.trim() && !exclusion, code, `sha256:${hash(text)}`);
      }
    }
    add(s.key, 'transcript', speech(s.script) === speech(s.transcript), 'TRANSCRIPT_MISMATCH', `script:${hash(s.script)};transcript:${hash(s.transcript)}`);
    for (const [part, component] of [['image', 'visual'], ['voice', 'transcript'], ['subtitles', 'subtitles'], ['zoom', 'zooms']] as const)
      add(s.key, component, s.versions[part] === i.scriptVersion, 'VERSION_MISMATCH', `script:${i.scriptVersion};component:${s.versions[part]}`);
    for (const [part, component, code] of [['facts', 'script', 'FACTS'], ['image', 'visual', 'IMAGE'], ['learning', 'zooms', 'LEARNING'], ['readability', 'subtitles', 'READABILITY']] as const) {
      const a = s[part];
      add(s.key, component, a.passed === true && !!a.evidence.trim(), a.evidence.trim() ? code : 'NO_EVIDENCE', a.evidence.trim() ? `evidence-sha256:${hash(a.evidence)}` : 'missing');
    }
  }
  // Scene boundaries are not privacy boundaries. Inspect each component in playback
  // order, both for split words and for phrases separated by caption/scene breaks.
  // A global failure conservatively repairs the component across all scenes.
  if (i.scenes.length > 1) {
    for (const component of ['script', 'visual', 'transcript', 'subtitles', 'zooms'] as const) {
      const fragments = i.scenes.flatMap(s => s[component]);
      for (const separator of ['', ' ']) {
        const text = fragments.join(separator);
        const exclusion = exclusionOf(text);
        if (exclusion) add(null, component, false, exclusion, `scope:all-scenes;sha256:${hash(text)}`);
      }
    }
  }
  return { passed: checks.every(c => c.passed), file: i.file, sha256: i.sha256, scriptVersion: i.scriptVersion, checks };
}
