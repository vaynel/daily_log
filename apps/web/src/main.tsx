import { StrictMode, useCallback, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { InterviewScreen } from './InterviewScreen';
import { NotifySettings } from './NotifySettings';
import { recordIdFromSearch } from './notify';
import { RecordDetailView, RecordsBrowser, type RecordsMode } from './RecordsView';
import { TrashView } from './TrashView';

type Session = { email: string; name: string | null; driveConnected: boolean };
type View =
  | { kind: 'loading' }
  | { kind: 'signed-in'; session: Session }
  | { kind: 'signed-out' }
  | { kind: 'expired' }
  | { kind: 'not-allowed' }
  | { kind: 'login-failed' };

const params = new URLSearchParams(window.location.search);

async function loadView(): Promise<View> {
  // 로그인 콜백이 보낸 사유를 우선 표시한다.
  if (window.location.pathname === '/login') {
    if (params.get('error') === 'not_allowed') return { kind: 'not-allowed' };
    if (params.get('error') === 'login_failed') return { kind: 'login-failed' };
    if (params.get('reason') === 'expired') return { kind: 'expired' };
  }
  try {
    const res = await fetch('/auth/session');
    if (res.ok) return { kind: 'signed-in', session: (await res.json()) as Session };
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (body.error === 'session_expired') return { kind: 'expired' };
    if (body.error === 'account_not_allowed') return { kind: 'not-allowed' };
  } catch {
    /* 서버 연결 실패는 로그인 화면으로 */
  }
  return { kind: 'signed-out' };
}

function Notice({ title, children, action }: { title: string; children: string; action?: 'login' | 'switch' }) {
  return (
    <section data-testid={`screen-${title}`} className="card">
      <h2>{title}</h2>
      <p>{children}</p>
      {action && <a className="button" href="/auth/login">{action === 'switch' ? '다른 Google 계정으로 로그인' : 'Google로 다시 로그인'}</a>}
    </section>
  );
}

function Home({ session, onLogout }: { session: Session; onLogout: () => void }) {
  const [openId, setOpenId] = useState<string | null>(() => recordIdFromSearch(window.location.search)); // 알림 클릭: ?record=<id> 로 해당 기록 상세를 연다
  const [mode, setMode] = useState<RecordsMode>('list');
  const [month, setMonth] = useState<string | null>(null); // 상세에서 돌아와도 보던 달을 유지
  const [trash, setTrash] = useState(false);
  const [listKey, setListKey] = useState(0); // 복구·삭제 뒤 목록을 다시 불러오기 위한 키
  return (
    <section data-testid="screen-home" className="card">
      <h2>내 기록</h2>
      <p data-testid="account">{session.email} 로 로그인됨</p>
      <p data-testid="drive-status">Google Drive: {session.driveConnected ? '연결됨' : '연결 안 됨 (선택 사항)'}</p>
      {!session.driveConnected && <a className="button secondary" href="/auth/drive/connect">Google Drive 연결</a>}
      {trash ? <TrashView onBack={() => { setTrash(false); setListKey((k) => k + 1); }} />
        : openId ? <RecordDetailView id={openId} onBack={() => { setOpenId(null); setListKey((k) => k + 1); }} />
        : <><RecordsBrowser key={listKey} mode={mode} onMode={setMode} month={month} onMonth={setMonth} onOpen={setOpenId} /><button data-testid="open-trash" onClick={() => setTrash(true)}>휴지통</button></>}
      <InterviewScreen />
      <NotifySettings />
      <button onClick={onLogout}>로그아웃</button>
    </section>
  );
}

function App() {
  const [view, setView] = useState<View>({ kind: 'loading' });
  useEffect(() => { void loadView().then(setView); }, []);
  const logout = useCallback(() => { void fetch('/auth/logout', { method: 'POST' }).then(() => { window.location.assign('/login'); }); }, []);
  return (
    <main>
      <h1>Daily Log</h1>
      {view.kind === 'loading' && <p>확인 중</p>}
      {view.kind === 'signed-in' && <Home session={view.session} onLogout={logout} />}
      {view.kind === 'signed-out' && (
        <section data-testid="screen-login" className="card">
          <h2>로그인</h2>
          <p>허용된 Google 계정으로만 기록을 볼 수 있습니다. Google Drive 연결은 로그인 후 선택할 수 있습니다.</p>
          <a className="button" href="/auth/login">Google로 로그인</a>
        </section>
      )}
      {view.kind === 'expired' && <Notice title="세션이 만료되었습니다" action="login">보안을 위해 로그인이 해제되었습니다. 다시 로그인해 주세요.</Notice>}
      {view.kind === 'not-allowed' && <Notice title="접근이 허용되지 않은 계정입니다" action="switch">이 앱은 허용된 본인 계정만 사용할 수 있습니다. 올바른 계정으로 다시 로그인해 주세요.</Notice>}
      {view.kind === 'login-failed' && <Notice title="로그인에 실패했습니다" action="login">잠시 후 다시 시도해 주세요. 문제가 계속되면 관리자에게 문의하세요.</Notice>}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
