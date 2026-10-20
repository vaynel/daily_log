# TASK-6 Android 알림·백그라운드 검증

상태: **부분 완료.** 비교·정책·권한 안내·실패 시험은 완료. **Android 실기기 시험(D06-02, AC-1)은 NOT_RUN** — 이 worker에 Android 기기·adb가 없고 PC Chromium 결과를 실기기 PASS로 쓰지 않는다.
Wiki 00~09와 Flowchart 원문은 열람하지 못했다(조회 도구 없음). PM이 전달한 요약과 Task 본문만 사용했다.

## 1. 설치 형태 후보 비교 (D06-01)

| | A. Android Chrome 설치형 PWA + Web Push (잠정 선정) | B. 브라우저 탭만 | C. Capacitor/네이티브 + FCM |
|---|---|---|---|
| 알림 권한 | 브라우저 `Notification` 권한, 사용자 동작 후 요청 | 동일 | Android 13+ `POST_NOTIFICATIONS` 런타임 권한 |
| 앱 닫힘/잠금 화면 | 서비스 워커가 push로 깨어나 표시 (MDN: 앱이 로드되지 않아도 전달) | 브라우저 프로세스에 의존, 설치형보다 불안정 | FCM high priority는 Doze에서도 즉시 전달 |
| 백그라운드 제한 | Doze·App Standby가 Chrome에 적용. 배터리 최적화·알림 채널 설정에 영향. **기기별 실측 필요** | 동일, 더 큼 | 앱 단위 제한. 동일하게 실측 필요 |
| 정확한 22:00 | push 서버가 22:00에 발송. TTL·Urgency로 지연 한도 지정 | - | 동일 |
| 비용/운영 | 앱스토어·네이티브 빌드 없음. VAPID 키만 필요(서버 비공개) | - | 빌드·서명·Firebase 계정 필요 |
| 전달 보장 | 없음 (MDN: 전달 보장 문구 없음) | 없음 | 없음 |

잠정 선정: **A**. 근거는 문서 수준이며 실기기에서 깨질 수 있다. 실기기 결과가 실패하면 C로 전환을 PM에 제안한다.

읽은 공식 자료 (이번 실행에서 실제 조회):
- MDN Push API: https://developer.mozilla.org/en-US/docs/Web/API/Push_API
- Android Doze/App Standby: https://developer.android.com/training/monitoring-device-state/doze-standby
- Android 알림 런타임 권한: https://developer.android.com/develop/ui/views/notifications/notification-permission
- Web Push 프로토콜(VAPID, TTL, Topic, 상태코드): https://web.dev/articles/push-notifications-web-push-protocol

읽지 못한 자료: Chrome 설치형 웹앱·알림 채널 문서, 제조사별 배터리 절약 정책. 실기기 시험 전 확인 필요.

## 2. 알림 정책 (AC-2)

- 시간대 Asia/Seoul, 기본 **22:00, 하루 1회**. 미응답 재알림 **없음**.
- **생활일**은 기록 대상 날짜(KST 달력일), **발송일**은 실제 발송 시각의 KST 날짜. 22:00 알림은 둘이 같지만 큐 지연으로 자정을 넘겨 발송되어도 생활일은 원래 날짜로 유지한다 (`livingDayOf`, `ReminderSlot`).
- 인터뷰 알림 중복 방지 키: `interview:{userId}:{livingDay}`. 완료 알림 키: `complete:{userId}:{jobId}` — 인터뷰 알림과 별도이며 하루 1회 제한을 공유하지 않는다.
- 키당 발송 시도는 1회. 실패해도 같은 키로 다시 보내지 않는다(`SKIPPED_DUPLICATE`). 재시도 정책은 별도 결정 사항이며 이 시험에서는 정의하지 않았다.
- Web Push `Topic` 헤더에는 키의 SHA-256 앞 32자(URL-safe)를 넣어 오프라인 중 중복 대기 메시지를 교체한다. 서비스 워커는 `tag`에 키를 넣어 화면에서도 교체한다.
- push 상태코드: 201 접수, 404/410 구독 만료(구독 삭제 대상), 429·기타 실패.

## 3. 표시 방식: 권한 거부·실패·중복 (D06-03, AC-3/AC-4)

전달 상태(`DeliveryStatus`) — **`DEVICE_DISPLAYED`(기기가 표시를 확인)만 전달 성공**이다.

| 상태 | 의미 | 전달 성공? |
|---|---|---|
| SKIPPED_PERMISSION_DENIED / NO_SUBSCRIPTION / UNSUPPORTED | 보낼 수 없음 | 아니오 |
| SUBSCRIPTION_EXPIRED / SEND_FAILED | push 서비스 거부·오류 | 아니오 |
| SKIPPED_DUPLICATE | 같은 키 재요청 | 아니오 (원 기록 유지) |
| MOCK_ACCEPTED | 로컬 모의 201. 실제 push 아님 | 아니오, 승격 불가 |
| PUSH_SERVICE_ACCEPTED | push 서비스가 접수. 기기 표시는 미확인 | 아니오 |
| DEVICE_DISPLAYED | 서비스 워커가 표시 후 앱에 확인 | 예 |

권한 거부 안내 문구와 단계는 `permissionGuidance`에 있다. 앱은 거부 후 허용창을 다시 띄울 수 없으므로 설정 이동 단계를 보여 주고 "다시 확인" 버튼을 둔다. 미지원 환경에서는 설치형 Chrome 사용을 안내하고 수동 기록이 가능함을 알린다.

## 4. 로컬 시험 결과 (PC Chromium, 실기기 아님)

실행: `npm test -w apps/web` (12개 통과). 시험 화면: `npm run dev:web` 후 http://127.0.0.1:5173/notify-spike.html. 합성 VAPID 공개키만 포함, 개인키·실제 자격증명 없음.
- 권한 denied: 안내 표시, 기록 `SKIPPED_PERMISSION_DENIED`, 전달 확인 "아니오", 중복 클릭 시 기록 1건.
- 권한 granted + 구독 시도: headless Chromium에서 `AbortError`(푸시 서비스 없음) → `SKIPPED_NO_SUBSCRIPTION`. 구독 실패가 전달 성공으로 기록되지 않음을 확인.
- 모의 201 → `MOCK_ACCEPTED`, 410 → `SUBSCRIPTION_EXPIRED`: 단위 시험으로만 확인 (브라우저에서는 구독이 없어 도달하지 않음).
- 미검증: 실제 push 발송, 서비스 워커 `push` 이벤트 표시, 잠금 화면, Doze.

## 5. 지원하지 않는 환경 (D06-04, 잠정)

iOS·알림 API/서비스 워커 없는 브라우저·인앱 웹뷰·알림 차단 상태·배터리 제한으로 Chrome이 중단된 기기. 이 경우 알림 없이 수동 기록만 제공한다. 실기기 결과로 확정한다.

## 6. 사용자가 수행할 Android 실기기 시험 절차 (D06-02 / AC-1)

필요 입력: Android 기기(버전 기록), Chrome, 본인 소유 HTTPS 시험 주소(공개 호스팅 금지 방침에 따라 PM이 허용한 방식으로, 예: 같은 네트워크의 USB 포트 포워딩 `chrome://inspect` → localhost 허용), 실제 VAPID 키쌍(사용자가 직접 생성·보관, 저장소에 넣지 않음).
1. Chrome에서 시험 페이지를 열고 메뉴 > 홈 화면에 추가로 설치한다. 설치형 아이콘으로 실행한다.
2. "알림 허용 요청" → 허용. 화면: "알림이 켜져 있습니다".
3. "푸시 구독 시도". 기대: 오류 없음. 실패하면 오류 이름을 기록.
4. 앱을 닫고 화면을 잠근 채 서버에서 실제 push를 1건 발송(Topic=키 해시, TTL 짧게). 기대: 잠금 화면에 알림 표시, 앱을 열면 기록이 DEVICE_DISPLAYED.
5. 같은 키로 다시 발송. 기대: 알림이 교체되며 중복 표시 없음.
6. 기기를 10분 이상 화면 꺼진 상태로 두고 재발송(Doze 확인), 배터리 최적화 "제한" 상태에서도 반복.
7. 설정에서 알림 끄기 → 앱 열기. 기대: 거부 안내 화면. 알림 켜고 "다시 확인" → 정상 안내.
8. 각 단계 화면 캡처와 기기·Android·Chrome 버전, 표시 지연 시간을 기록한다.
