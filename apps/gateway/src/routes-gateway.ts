import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFileSync, statSync } from 'node:fs';

type GatewayRouteEntry = {
  host: string;
  port: number;
  status: 'running' | 'stopped' | 'unavailable';
  projectId: string;
};

type GatewayRouteTable = {
  updatedAt: string;
  rootDomain: string;
  routes: Record<string, GatewayRouteEntry>;
};

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

type Cache = { mtimeMs: number; table: GatewayRouteTable };

let cache: Cache | null = null;

function loadRoutes(file: string): GatewayRouteTable {
  const st = statSync(file);
  if (cache && cache.mtimeMs === st.mtimeMs) {
    return cache.table;
  }
  const table = JSON.parse(readFileSync(file, 'utf8')) as GatewayRouteTable;
  cache = { mtimeMs: st.mtimeMs, table };
  return table;
}

function normalizeHost(hostname: string, rootDomain: string): string {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '').split(':')[0] ?? '';
  if (host.endsWith('.localhost')) {
    const label = host.replace(/\.localhost$/, '');
    return label ? `${label}.${rootDomain}` : host;
  }
  return host;
}

function sendPage(res: ServerResponse, status: number, title: string, detail: string): void {
  if (res.headersSent) return;
  const body = `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"/><title>${title}</title></head><body><h1>${title}</h1><p>${detail}</p></body></html>`;
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function proxy(
  req: IncomingMessage,
  res: ServerResponse,
  targetHost: string,
  targetPort: number,
): void {
  const headers: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.has(name.toLowerCase()) && value !== undefined) {
      headers[name] = value;
    }
  }
  headers['x-forwarded-proto'] = 'http';
  headers['x-forwarded-host'] = req.headers.host ?? '';
  headers.host = `${targetHost}:${targetPort}`;

  const proxyReq = http.request(
    {
      hostname: targetHost,
      port: targetPort,
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
  proxyReq.on('error', () => {
    sendPage(res, 502, '应用暂时无法访问，请稍后重试', '请稍后再试。');
  });
  req.pipe(proxyReq);
}

export function startRoutesGateway(options: {
  port: number;
  routesFile: string;
  host?: string;
}): http.Server {
  const server = http.createServer((req, res) => {
    try {
      const url = req.url ?? '/';
      const table = loadRoutes(options.routesFile);
      const hostname = normalizeHost(req.headers.host ?? '', table.rootDomain || '');
      const route = table.routes[hostname];

      // Gateway self-health only when Host is not a routed app domain.
      // App domains must be able to expose their own /health through the proxy.
      const isHealth =
        (req.method === 'GET' || req.method === 'HEAD') &&
        (url === '/health' || url.startsWith('/health?'));
      if (isHealth && !route) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ status: 'ok', service: 'launchos-gateway' }));
        return;
      }

      if (!route) {
        sendPage(res, 404, '没有找到这个应用', '请确认访问地址是否正确。');
        return;
      }
      if (route.status === 'stopped' || route.port <= 0) {
        sendPage(res, 503, '应用当前未运行', '请在 LaunchOS 中重新启动后再试。');
        return;
      }
      if (route.status !== 'running') {
        sendPage(res, 502, '应用暂时无法访问，请稍后重试', '请稍后再试。');
        return;
      }
      // Open-proxy guard: only table entries (written by control plane from ApplicationDomain)
      proxy(req, res, route.host, route.port);
    } catch (error) {
      console.error('gateway error', error instanceof Error ? error.message : error);
      sendPage(res, 502, '应用暂时无法访问，请稍后重试', '请稍后再试。');
    }
  });

  const bindHost = options.host?.trim() || '0.0.0.0';
  server.listen(options.port, bindHost, () => {
    console.log(`LaunchOS Gateway (routes) listening on http://${bindHost}:${options.port}`);
    console.log(`routes file ${options.routesFile}`);
  });
  return server;
}
