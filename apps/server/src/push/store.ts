import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export type DeliveryStatus =
  | 'SENDING' // 요청 직전에 먼저 기록. 이 상태로 남으면 결과 미확인(응답 유실 가능)
  | 'SKIPPED_NO_SUBSCRIPTION'
  | 'SUBSCRIPTION_EXPIRED'
  | 'SEND_FAILED'
  | 'PUSH_SERVICE_ACCEPTED' // push 서비스 접수. 기기 표시는 미확인
  | 'DEVICE_DISPLAYED'; // 기기에서 표시가 확인된 경우만 전달 성공

export interface StoredSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  savedAt: string;
}

export interface DeliveryRecord {
  key: string;
  requestId: string;
  kind: 'test';
  status: DeliveryStatus;
  at: string;
  httpStatus?: number;
  detail?: string;
  displayedAt?: string;
}

export interface Observation {
  step: string;
  result: 'OK' | 'FAIL' | 'NOT_APPLICABLE';
  note: string;
  at: string;
}

export interface DeviceInfo {
  android: string;
  chrome: string;
  model: string;
}

export interface PushState {
  subscription: StoredSubscription | null;
  records: DeliveryRecord[];
  observations: Observation[];
  device: DeviceInfo | null;
}

const MAX_ITEMS = 200;

/** 단일 사용자용 JSON 상태 파일. 0600, 임시 파일 후 rename, 쓰기는 직렬화. */
export class PushStore {
  private state: PushState = { subscription: null, records: [], observations: [], device: null };
  private chain: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await readFile(this.file, 'utf8')) as Partial<PushState>;
      this.state = {
        subscription: raw.subscription ?? null,
        records: raw.records ?? [],
        observations: raw.observations ?? [],
        device: raw.device ?? null,
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('push 상태 파일을 읽을 수 없음');
    }
  }

  get snapshot(): Readonly<PushState> {
    return this.state;
  }

  /** mutate 는 동기 함수여야 한다(경합 방지). 저장이 끝나야 반환한다. */
  mutate<T>(fn: (s: PushState) => T): Promise<T> {
    const result = fn(this.state);
    this.state.records = this.state.records.slice(-MAX_ITEMS);
    this.state.observations = this.state.observations.slice(-MAX_ITEMS);
    const body = JSON.stringify(this.state);
    const tmp = `${this.file}.tmp`;
    this.chain = this.chain.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(tmp, body, { mode: 0o600 });
      await rename(tmp, this.file);
    });
    return this.chain.then(() => result);
  }
}
