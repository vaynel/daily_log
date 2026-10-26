import { describe, expect, it } from 'vitest';
import { inspectQuality } from './quality.js';
import { input } from './quality.testutil.js';
import { createRule } from '../briefing/rules.js';

describe('품질 검수', () => {
  for (const part of ['script', 'visual', 'transcript', 'subtitles', 'zooms'] as const) {
    it.each(['exact', 'rule', 'policy'] as const)(`${part} 장면 경계의 %s 제외 문구를 차단한다`, policy => {
      const i = input();
      const fragments = policy === 'policy' ? ['대통', '령'] : ['비공개', '프로젝트'];
      i.scenes = fragments.map((text, n) => {
        const scene = structuredClone(i.scenes[0]!);
        scene.key = `s${n}`;
        Object.assign(scene, { [part]: part === 'subtitles' || part === 'zooms' ? [text] : text });
        if (part === 'script') scene.transcript = text;
        if (part === 'transcript') scene.script = text;
        return scene;
      });
      if (policy === 'exact') i.excludedTexts = ['비공개 프로젝트'];
      if (policy === 'rule') i.rules = [createRule([], { category: 'WORK_CONFIDENTIAL', keywords: ['비공개 프로젝트'] }, new Date()).rule];
      const report = inspectQuality(i);
      expect(report.passed).toBe(false);
      expect(report.checks).toEqual(expect.arrayContaining([expect.objectContaining({
        scene: null, component: part, passed: false,
        code: policy === 'exact' ? 'THIS_VIDEO_EXCLUDED' : policy === 'rule' ? 'USER_RULE' : 'POLITICS',
      })]));
      expect(JSON.stringify(report)).not.toContain('비공개');
    });
  }
  it('세 장면에 걸친 제외 문구도 차단하고 안전한 여러 장면은 통과한다', () => {
    const i = input();
    i.scenes = ['비공', '개프로', '젝트'].map((text, n) => ({ ...structuredClone(i.scenes[0]!), key: `s${n}`, subtitles: [text] }));
    expect(inspectQuality(i).passed).toBe(true);
    i.excludedTexts = ['비공개 프로젝트'];
    expect(inspectQuality(i).passed).toBe(false);
  });
  it('완전한 안전 입력만 통과하며 원문 대신 구성 요소 해시와 근거를 남긴다', () => {
    const r = inspectQuality(input());
    expect(r.passed).toBe(true);
    expect(r.checks.length).toBeGreaterThan(8);
    expect(JSON.stringify(r)).not.toContain('인증 보안을 배웠다');
  });
  it.each(['script', 'visual', 'transcript', 'subtitles', 'zooms'] as const)('%s 한 곳의 공개 제외 누출도 거절한다', (part) => {
    const i = input();
    Object.assign(i.scenes[0]!, { [part]: ['subtitles', 'zooms'].includes(part) ? ['대통령 선거'] : '대통령 선거' });
    expect(inspectQuality(i).checks).toEqual(expect.arrayContaining([expect.objectContaining({ component: part, passed: false, code: 'POLITICS' })]));
    expect(inspectQuality(i).passed).toBe(false);
  });
  it('반복 제외 규칙과 이번 영상 제외 문장도 모든 구성 요소에 적용한다', () => {
    for (const part of ['script', 'visual', 'transcript', 'subtitles', 'zooms'] as const) {
      const i = input();
      i.rules = [createRule([], { category: 'PRIVATE_LIFE', keywords: ['인증'] }, new Date()).rule];
      expect(inspectQuality(i).checks.some(c => c.component === part && !c.passed)).toBe(part !== 'visual');
      i.rules = []; i.excludedTexts = ['인증 보안'];
      expect(inspectQuality(i).passed).toBe(false);
    }
  });
  it('전사 누락·버전 불일치·근거 없는 사실·가독성 실패·길이 초과는 fail closed', () => {
    const i = input(); i.scenes[0]!.transcript = ''; i.scenes[0]!.versions.voice = 1;
    i.scenes[0]!.facts.evidence = ''; i.scenes[0]!.readability.passed = false; i.probe.format.duration = '181';
    const r = inspectQuality(i);
    expect(r.passed).toBe(false);
    expect(r.checks.filter(c => !c.passed).map(c => c.code)).toEqual(expect.arrayContaining(['MISSING_CONTENT', 'VERSION_MISMATCH', 'NO_EVIDENCE', 'READABILITY', 'OVER_MAX_SEC']));
  });
  it('음성 전사가 대본과 다르거나 자막 경계에 제외 내용이 나뉘어도 통과하지 않는다', () => {
    const voice = input(); voice.scenes[0]!.transcript = '여행을 다녀왔다.';
    expect(inspectQuality(voice).checks).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'TRANSCRIPT_MISMATCH', passed: false })]));
    const split = input(); split.scenes[0]!.subtitles = ['정', '치'];
    expect(inspectQuality(split).passed).toBe(false);
  });

});
