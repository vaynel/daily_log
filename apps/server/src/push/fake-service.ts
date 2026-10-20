// 합성 push 서비스: 실제 push 서비스가 아니다. 이 서비스의 201은 실기기 성공이 아니다.
import { createServer, type Server } from 'node:http';

export interface FakePushService {
  server: Server;
  url: string;
  host: string;
  received: { path: string; headers: Record<string, string | string[] | undefined>; bytes: number }[];
  status: number;
  close(): Promise<void>;
}

export async function startFakePushService(port = 0, status = 201): Promise<FakePushService> {
  const received: FakePushService['received'] = [];
  const fake = { status } as FakePushService;
  const server = createServer((req, res) => {
    let bytes = 0;
    req.on('data', (c: Buffer) => (bytes += c.length));
    req.on('end', () => {
      received.push({ path: req.url ?? '', headers: req.headers, bytes });
      res.statusCode = fake.status;
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  const addr = server.address() as { port: number };
  Object.assign(fake, {
    server,
    received,
    host: `127.0.0.1:${addr.port}`,
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise<void>((r) => server.close(() => r())),
  });
  return fake;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const f = await startFakePushService(Number(process.env.FAKE_PUSH_PORT ?? 9911), Number(process.env.FAKE_PUSH_STATUS ?? 201));
  console.log(`합성 push 서비스(실기기 아님) ${f.url} status=${f.status}`);
}
