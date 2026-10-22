-- TASK-16: 월 추가 비용 한도 때문에 제작을 기다리는 상태를 처리 실패와 구분해 저장한다.
ALTER TABLE pipeline_states DROP CONSTRAINT pipeline_states_production_check;
ALTER TABLE pipeline_states ADD CONSTRAINT pipeline_states_production_check
  CHECK (production IN ('NONE', 'QUEUED', 'RUNNING', 'DONE', 'FAILED', 'WAITING_BUDGET'));
