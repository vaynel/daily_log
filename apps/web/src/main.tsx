import { StrictMode, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

function App() {
  const [api, setApi] = useState('확인 중');
  useEffect(() => {
    fetch('/healthz').then((r) => r.json()).then((j: { status: string }) => setApi(j.status)).catch(() => setApi('연결 실패'));
  }, []);
  return (
    <main>
      <h1>Daily Log</h1>
      <p data-testid="api-status">서버: {api}</p>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
