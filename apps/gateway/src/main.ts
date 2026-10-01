import './env';
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PrismaClient } from '@launchos/database';
import {
  DomainManager,
  readGatewayHttpPort,
  readGatewayRoutesFile,
  readSystemDomainZone,
} from '@launchos/domain';
import { proxyToRuntime, sendNotFound, sendStopped, sendUnavailable } from './proxy';
import { startRoutesGateway } from './routes-gateway';

const routesFile = readGatewayRoutesFile();
if (routesFile) {
  startRoutesGateway({
    port: readGatewayHttpPort(),
    routesFile,
  });
} else {
  const prisma = new PrismaClient();
  const domains = new DomainManager(prisma);
  const httpPort = readGatewayHttpPort();

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = req.url ?? '/';
    const hostname = req.headers.host ?? '';
    const route = await domains.resolveRoute(hostname);

    const isHealth =
      (req.method === 'GET' || req.method === 'HEAD') &&
      (url === '/health' || url.startsWith('/health?'));
    if (isHealth && route.kind === 'not_found') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ status: 'ok', service: 'launchos-gateway' }));
      return;
    }

    if (route.kind === 'not_found') {
      sendNotFound(res);
      return;
    }
    if (route.kind === 'stopped') {
      sendStopped(res);
      return;
    }
    if (route.kind === 'unavailable') {
      sendUnavailable(res);
      return;
    }

    proxyToRuntime(req, res, route.binding, 'http');
  }

  const httpServer = http.createServer((req, res) => {
    void handle(req, res).catch((error) => {
      console.error('LaunchOS gateway handler error', error instanceof Error ? error.message : error);
      sendUnavailable(res);
    });
  });

  httpServer.listen(httpPort, '0.0.0.0', () => {
    console.log(`LaunchOS Gateway HTTP listening on http://127.0.0.1:${httpPort}`);
    console.log(`LaunchOS system zone ${readSystemDomainZone()} (DNS not assumed live)`);
  });

  async function shutdown(): Promise<void> {
    httpServer.close();
    await prisma.$disconnect();
    process.exit(0);
  }

  process.on('SIGINT', () => {
    void shutdown();
  });
  process.on('SIGTERM', () => {
    void shutdown();
  });
}
