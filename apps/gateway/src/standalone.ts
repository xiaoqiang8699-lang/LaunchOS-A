/**
 * Standalone entry for remote Gateway (routes-file mode only).
 * Bundled to gateway.cjs for servers without monorepo deps.
 *
 * Behind host nginx (e.g. BT), bind loopback only — never expose 9080 publicly.
 */
import { startRoutesGateway } from './routes-gateway';

const port = Number(process.env.GATEWAY_HTTP_PORT || 9080);
const host = process.env.GATEWAY_BIND_HOST?.trim() || '127.0.0.1';
const routesFile = process.env.GATEWAY_ROUTES_FILE || '/opt/launchos-gateway/routes.json';

startRoutesGateway({ port, host, routesFile });
