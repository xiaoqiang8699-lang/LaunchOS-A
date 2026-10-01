import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { RuntimeBinding } from '@launchos/domain';

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

export function proxyToRuntime(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: RuntimeBinding,
  proto: 'http' | 'https',
): void {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase()) && value !== undefined) {
      headers[name] = value;
    }
  }
  headers['x-forwarded-proto'] = proto;
  headers['x-forwarded-host'] = req.headers.host ?? '';
  headers.host = `${runtime.host}:${runtime.port}`;

  const proxyReq = http.request(
    {
      hostname: runtime.host,
      port: runtime.port,
      path: req.url,
      method: req.method,
      headers,
      timeout: 30_000,
    },
    (proxyRes) => {
      const responseHeaders: http.OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(proxyRes.headers)) {
        if (!HOP_BY_HOP.has(name.toLowerCase()) && value !== undefined) {
          responseHeaders[name] = value;
        }
      }
      res.writeHead(proxyRes.statusCode ?? 502, responseHeaders);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
  });

  proxyReq.on('error', (error) => {
    console.error(
      `LaunchOS gateway upstream error domain=${runtime.domain} target=${runtime.host}:${runtime.port}`,
      error.message,
    );
    sendUnavailable(res);
  });

  req.pipe(proxyReq);
}

export function sendNotFound(res: ServerResponse): void {
  sendFriendlyPage(res, 404, '没有找到这个应用', '请确认访问地址是否正确，或应用是否已经创建。');
}

export function sendStopped(res: ServerResponse): void {
  sendFriendlyPage(res, 503, '应用当前未运行', '应用可能已停止。请在 LaunchOS 中重新启动后再试。');
}

export function sendUnavailable(res: ServerResponse): void {
  sendFriendlyPage(res, 502, '应用暂时无法访问，请稍后重试', '我们已记录问题，请稍后再试。');
}

function sendFriendlyPage(
  res: ServerResponse,
  status: number,
  title: string,
  detail: string,
): void {
  if (res.headersSent) {
    return;
  }
  const body = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, sans-serif; background: #fafafa; color: #18181b; margin: 0; padding: 48px 24px; }
    main { max-width: 420px; margin: 0 auto; }
    h1 { font-size: 1.25rem; margin: 0 0 8px; }
    p { color: #52525b; line-height: 1.5; margin: 0; }
  </style>
</head>
<body>
  <main>
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(detail)}</p>
  </main>
</body>
</html>`;
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
