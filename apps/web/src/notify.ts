export type Permission = 'unknown' | 'default' | 'granted' | 'denied' | 'unsupported';
export interface NotifySettings { interviewTime: string; permission: Permission; subscribed: boolean; timezone: string; pushAvailable: boolean; vapidPublicKey: string | null }
export interface NotifyItem { id: string; kind: string; lifeDate: string | null; status: string; errorCode: string | null; createdAt: string; guidance: string | null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** 알림 클릭으로 열린 주소(?record=<id>)에서 기록 ID 를 꺼낸다. 형식이 맞지 않으면 무시. */
export const recordIdFromSearch = (search: string): string | null => {
  const v = new URLSearchParams(search).get('record');
  return v && UUID.test(v) ? v : null;
};

export const isValidTime = (s: string) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

export const KIND_LABEL: Record<string, string> = {
  INTERVIEW_REMINDER: '인터뷰 알림', RESULT_COMPLETED: '영상 완성', RESULT_REVISED: '수정본 완성', PROCESSING_FAILED: '처리 실패', BACKUP_FAILED: '백업 실패',
};
export const DELIVERY_LABEL: Record<string, string> = {
  PENDING: '전달 대기', ACCEPTED: '전달됨', UNDELIVERABLE: '전달 불가', FAILED: '전달 실패', SKIPPED: '건너뜀',
};

/** 권한 상태별 화면 문구. 거부는 해결 방법을 함께 안내한다. */
export const PERMISSION_INFO: Record<Permission, { label: string; hint: string }> = {
  unknown: { label: '확인 전', hint: '이 기기의 알림 권한을 아직 확인하지 않았습니다.' },
  default: { label: '아직 허용하지 않음', hint: '아래 버튼으로 알림을 허용하면 설정한 시각에 알려 드립니다.' },
  granted: { label: '허용됨', hint: '이 기기로 알림을 보냅니다.' },
  denied: { label: '꺼져 있음', hint: '알림이 꺼져 있습니다. 기기 설정 > 앱 > 알림에서 켠 뒤 "권한 다시 확인"을 누르세요. 기록과 영상에는 영향이 없습니다.' },
  unsupported: { label: '이 브라우저는 지원하지 않음', hint: '이 브라우저에서는 알림을 받을 수 없습니다. 설치형 앱(홈 화면에 추가)에서 사용해 보세요.' },
};

export function urlBase64ToUint8Array(b64: string): Uint8Array {
  const pad = '='.repeat((4 - (b64.length % 4)) % 4);
  const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export function currentPermission(): Permission {
  if (typeof Notification === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';
  return Notification.permission as Permission;
}
