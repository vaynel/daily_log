# TASK-51 Android 실기기 알림 시험 준비 (PM·사용자용)

**상태: 준비 완료, 미배포.** worker에서는 합성 키·합성 push 서비스만 사용했다. 실제 호스트 배포, Android 실기기 결과, 실제 push 서비스(FCM) 전송은 **실행하지 않았다**. 이 문서나 합성 시험 통과는 TASK-6 AC-1(실기기) PASS가 아니다.

## 1. 로컬 재현 (합성, 실기기 아님)

```
npm ci
npm run push:harness          # 합성 키·합성 push 서비스로 201/410/500 시나리오 실행
npm test -w apps/server       # 접근 제어·검증·실패 시험
```
하네스의 201은 합성 서비스의 응답이며 기기 표시가 아니다. 모든 기록은 `PUSH_SERVICE_ACCEPTED`(전달 미확인)까지만 간다.

## 2. PM 설치 (미니 PC)

필요: Node 22, 빌드 산출물(`npm ci && npm run build`), HTTPS 종단(Caddy 등) — Android Chrome의 서비스 워커·푸시는 HTTPS 필수(localhost 제외). 외부 공개·일반 가입 없음; 사용자 1명 전용 토큰.

| 항목 | 값 |
|---|---|
| 서버 포트 | 127.0.0.1:3000 (loopback 바인딩 기본). 외부에는 TLS 프록시 443만 노출 |
| 인증 | `Authorization: Bearer <접근 토큰>`; 실패 10회/분 초과 시 1분 잠금 |
| 필요 아웃바운드 | push 서비스 HTTPS(기본 허용: fcm.googleapis.com, updates.push.services.mozilla.com, web.push.apple.com) |
| 설정 파일 | `deploy/push-test/push-test.env.example` → `/etc/daily-log/push-test.env` (0600) |
| 서비스 | `deploy/push-test/daily-log-push-test.service`, 프록시 예시 `Caddyfile.example` |

1. 비밀값 생성(호스트에서, 값은 출력되지 않음): `node apps/server/dist/push/init.js /etc/daily-log/secrets` → `vapid-private.key`, `vapid-public.key`, `access-token` (0600, 기존 파일은 덮어쓰지 않음).
2. env 파일에 `PUSH_VAPID_PUBLIC_KEY`(public.key 내용)와 경로 설정. 접근 토큰은 사용자에게 안전한 경로로 직접 전달(채팅·저장소·로그 금지).
3. 시작: `systemctl enable --now daily-log-push-test`. 확인: `systemctl status`, 시험 화면 `https://<도메인>/push-test.html`.
4. 중지: `systemctl stop daily-log-push-test`.
5. 롤백: `systemctl disable --now daily-log-push-test`, 프록시 항목 제거. 시험 기록은 `/var/lib/daily-log/push-state.json`(구독 정보 포함, 0600)이며 시험 종료 후 삭제한다. 토큰·VAPID 키 폐기는 `/etc/daily-log/secrets` 삭제.
6. **fail closed**: 설정 누락·파일 권한(0600 아님)·토큰 32자 미만·loopback 아닌 HOST(+`PUSH_ALLOW_NON_LOOPBACK` 없음)이면 서버가 누락 항목 이름만 출력하고 종료 코드 78로 시작하지 않는다. `PUSH_ENABLED` 가 없으면 `/api/push/*` 는 503.
7. 배포했다고 표시하지 말 것: 위 단계를 PM이 실행하고 `/healthz`와 시험 화면 접속을 확인하기 전까지 상태는 **미배포**.

## 3. 사용자 시험 절차 (Android, 시험 화면 `/push-test.html`)

화면에 같은 순서의 체크리스트와 기록 입력이 있다. 보인 그대로 기록하고, 실패도 숨기지 않는다.
1. 토큰 입력 → “연결 확인”. 기기 정보(Android·Chrome 버전, 모델) 저장.
2. Chrome 메뉴 > 홈 화면에 추가로 설치, 설치된 아이콘으로 실행. (관측 1)
3. “알림 허용 요청” → 허용. (관측 2) “푸시 구독 등록”. 실패하면 화면의 오류 이름을 기록. (관측 3)
4. 앱을 닫고 화면 잠금, 다른 기기에서 “시험 알림 1건 보내기”(버튼 1회=발송 1건). 잠금 화면에 보이는지·지연 시간 기록. 앱을 열면 트레이의 알림을 근거로 표시 확인이 자동 기록되고, 눈으로 본 경우 “알림이 보였습니다”로도 기록. (관측 4)
5. 교체 동작(관측 5), 10분 이상 화면 꺼짐·배터리 “제한” 반복(관측 6), 알림 끄기→거부 안내→켜고 “권한 다시 확인”(관측 7), 캡처 전달(관측 8).
- `PUSH_SERVICE_ACCEPTED` = push 서비스 접수일 뿐. **기기 표시 확인(DEVICE_DISPLAYED)만 전달 성공.** 응답 유실·네트워크 오류는 `SEND_FAILED(OUTCOME_UNKNOWN)`로 남고 자동 재시도하지 않는다.
- 이 시험 알림은 운영 22:00 인터뷰 알림(하루 1회)과 키·경로가 분리되어 있다(`test:` 키).

## 4. 알려진 한계

- Android 실기기·실제 FCM·HTTPS 호스팅 미실행. 서비스 워커 `push` 표시, 잠금 화면, Doze는 미검증.
- 상태 파일은 단일 사용자·단일 구독 전제.
- worker 컨테이너에 한글 글꼴이 없어 PC 스크린샷의 한글이 네모로 보인다(실제 Android에서는 해당 없음). 화면 문구는 HTML 텍스트 검증으로 대조했다.
