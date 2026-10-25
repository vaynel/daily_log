/**
 * 공개용(영상) 제작 입력 제외 분류(TASK-20, AC-5). 정치·타인 비방·뒷담화·형사 사건 관련 문장은 영상에서 제외한다.
 * 기록 자체를 지우는 것이 아니라 영상 입력에서만 뺀다. 사이버보안 학습(취약점·예방·대응)은 일괄 제외하지 않는다.
 * 키워드 기반이라 놓치는 표현이 있을 수 있으며, 사용자는 브리핑에서 항목을 직접 제외할 수 있다.
 */
export type ExclusionReason = 'POLITICS' | 'DEFAMATION' | 'GOSSIP' | 'CRIMINAL';

const RULES: [ExclusionReason, RegExp][] = [
  ['CRIMINAL', /형사|고소(?:당|했|하|장|인|를|와)|고발|기소|피의자|피고인|구속|검찰|수사\s*(?:중|받)|재판|소송/],
  ['POLITICS', /정당|여당|야당|대통령|국회의원|국회|선거|총선|대선|탄핵|정권|보수\s*(?:진영|정당)|진보\s*(?:진영|정당)|정치/],
  ['DEFAMATION', /멍청|무능(?:한|하|해)|쓰레기|한심|병신|미친\s*(?:놈|새끼)|꼴\s*보기\s*싫|인간\s*이\s*덜|극혐/],
  ['GOSSIP', /뒷담|험담|카더라|소문|들은\s*얘기인데|뒷얘기|씹었|말이\s*많/],
];

const SECURITY_LEARNING = /보안|취약점|해킹\s*(?:예방|방어|대응)|피싱|랜섬웨어|CVE|XSS|CSRF|SQL\s*인젝션|인젝션|침해\s*(?:사고\s*)?(?:예방|대응)|암호화|인증\s*(?:보안|강화)|방화벽|모의\s*해킹/i;

/** 보안 예방 학습 문장인지. 제외 분류에는 쓰이지 않고 표시용 주제 표지로만 쓰인다. */
export function isSecurityLearning(text: string): boolean {
  return SECURITY_LEARNING.test(text);
}

/** 제외 사유를 돌려준다. 없으면 null. 보안 학습 문장은 해당 사유 키워드가 없는 한 제외하지 않는다. */
export function classifyExclusion(text: string): ExclusionReason | null {
  for (const [reason, re] of RULES) if (re.test(text)) return reason;
  return null;
}

export const EXCLUSION_LABEL: Record<ExclusionReason, string> = {
  POLITICS: '정치 관련', DEFAMATION: '타인 비방', GOSSIP: '뒷담화', CRIMINAL: '형사 사건 관련',
};
