-- TASK-13: 월 추가 API 비용 원장. 예약→확정/해제 상태와 불명 과금을 한 표에 둔다.
CREATE TABLE budget_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  month text NOT NULL CHECK (month ~ '^[0-9]{4}-[0-9]{2}$'),
  provider text NOT NULL,
  operation text NOT NULL,
  purpose text NOT NULL CHECK (purpose IN ('PRODUCT', 'TEST', 'RETRY', 'CARRYOVER')),
  state text NOT NULL CHECK (state IN ('RESERVED', 'CONFIRMED', 'RELEASED', 'UNKNOWN')),
  estimate_krw numeric(14,4) NOT NULL CHECK (estimate_krw >= 0),
  actual_krw numeric(14,4) CHECK (actual_krw IS NULL OR actual_krw >= 0),
  idempotency_key text UNIQUE,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz
);
CREATE INDEX budget_entries_month_idx ON budget_entries (month, state);
CREATE TABLE budget_months (
  month text PRIMARY KEY CHECK (month ~ '^[0-9]{4}-[0-9]{2}$'),
  limit_krw numeric(14,4) NOT NULL CHECK (limit_krw > 0 AND limit_krw <= 50000)
);
