/**
 * Step 29 — Managed Gateway / Access Entry (pure engineering helpers).
 * Phase 1: generate + validate only. Never write remote nginx/DNS/certs here.
 */
import {
  DYNAMIC_PORT_RANGE_END,
  DYNAMIC_PORT_RANGE_START,
} from '@launchos/shared';

export const GATEWAY_LOOPBACK_TARGET = '127.0.0.1' as const;

export const ACCESS_ENTRY_STATUSES = [
  'ACCESS_ENTRY_PENDING',
  'GATEWAY_PENDING',
  'CERT_PENDING',
  'DNS_PENDING',
  'READY_FOR_DNS',
  'VERIFYING',
  'ACTIVE',
  'FAILED',
] as const;

export type AccessEntryStatus = (typeof ACCESS_ENTRY_STATUSES)[number];

export const STEP29_GATEWAY_WHITELIST = {
  projectId: 'cmu3j24mv0001ri7wcsoa30hj',
  serverInstanceId: 'cmub78pz001sdripco5pexhdz',
  publicIp: '116.62.198.184',
  rootDomain: 'zsaos.com',
  web: {
    unitId: 'cmu3j27340007ri7wcno1xrai',
    serviceInstanceId: 'cmuc8riut02mdritki9f21jsl',
    hostname: 'web-launchos.zsaos.com',
    targetPort: 39001,
    healthPath: '/',
  },
  api: {
    unitId: 'cmu3j272x0005ri7wlxlbajeu',
    serviceInstanceId: 'cmuc66642002hritk6h3cbwhe',
    hostname: 'api-launchos.zsaos.com',
    targetPort: 39000,
    healthPath: '/health',
  },
  allowedPublicPorts: [22, 80, 443] as const,
  forbiddenDynamicPublicPorts: { start: 39000, end: 39999 },
} as const;

export type GatewayRoutePlan = {
  hostname: string;
  scheme?: 'http' | 'https';
  targetHost: string;
  targetPort: number;
  healthPath: string;
  certificateFullchainPath?: string;
  certificatePrivkeyPath?: string;
};

export type GatewayConfigResult = {
  nginxHttpRedirect: string;
  nginxHttpsServer: string;
  combined: string;
};

export type GatewayTargetValidation = {
  ok: boolean;
  code?:
    | 'GATEWAY_TARGET_HOST_FORBIDDEN'
    | 'GATEWAY_TARGET_PORT_INVALID'
    | 'GATEWAY_HOSTNAME_INVALID'
    | 'GATEWAY_HEALTH_PATH_INVALID';
  message?: string;
};

export type GatewayRouteConflict =
  | { ok: true }
  | { ok: false; code: 'DUPLICATE_HOSTNAME' | 'DUPLICATE_UNIT_DEFAULT'; message: string };

export function assertGatewayTarget(input: {
  targetHost: string;
  targetPort: number;
  hostname?: string;
  healthPath?: string;
}): GatewayTargetValidation {
  const host = String(input.targetHost || '').trim();
  if (host !== GATEWAY_LOOPBACK_TARGET) {
    return {
      ok: false,
      code: 'GATEWAY_TARGET_HOST_FORBIDDEN',
      message: `targetHost must be ${GATEWAY_LOOPBACK_TARGET}`,
    };
  }
  const port = Number(input.targetPort);
  if (
    !Number.isInteger(port) ||
    port < DYNAMIC_PORT_RANGE_START ||
    port > DYNAMIC_PORT_RANGE_END
  ) {
    return {
      ok: false,
      code: 'GATEWAY_TARGET_PORT_INVALID',
      message: `targetPort must be in ${DYNAMIC_PORT_RANGE_START}-${DYNAMIC_PORT_RANGE_END}`,
    };
  }
  if (input.hostname !== undefined) {
    const hn = String(input.hostname).trim().toLowerCase();
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(hn)) {
      return {
        ok: false,
        code: 'GATEWAY_HOSTNAME_INVALID',
        message: 'hostname invalid',
      };
    }
  }
  if (input.healthPath !== undefined) {
    const hp = String(input.healthPath).trim();
    if (!hp.startsWith('/') || hp.includes('://') || /\s/.test(hp)) {
      return {
        ok: false,
        code: 'GATEWAY_HEALTH_PATH_INVALID',
        message: 'healthPath must be a path starting with /',
      };
    }
  }
  return { ok: true };
}

/**
 * One hostname → one active route; one unit → one default active access entry.
 */
export function assertGatewayRouteUniqueness(input: {
  hostname: string;
  unitId: string;
  existing: Array<{
    hostname: string;
    unitId: string;
    status: string;
    isDefault?: boolean;
  }>;
}): GatewayRouteConflict {
  const hostname = input.hostname.trim().toLowerCase();
  const dupHost = input.existing.find(
    (r) =>
      r.hostname.trim().toLowerCase() === hostname &&
      ['PENDING', 'CONFIGURING', 'ACTIVE'].includes(String(r.status).toUpperCase()),
  );
  if (dupHost) {
    return {
      ok: false,
      code: 'DUPLICATE_HOSTNAME',
      message: `hostname already has an active route: ${hostname}`,
    };
  }
  const dupUnit = input.existing.find(
    (r) =>
      r.unitId === input.unitId &&
      (r.isDefault !== false) &&
      String(r.status).toUpperCase() === 'ACTIVE',
  );
  if (dupUnit) {
    return {
      ok: false,
      code: 'DUPLICATE_UNIT_DEFAULT',
      message: `unit already has a default ACTIVE access entry: ${input.unitId}`,
    };
  }
  return { ok: true };
}

export function generateGatewayConfig(route: GatewayRoutePlan): GatewayConfigResult {
  const validated = assertGatewayTarget(route);
  if (!validated.ok) {
    throw new Error(validated.code || validated.message || 'invalid gateway route');
  }
  const hostname = route.hostname.trim().toLowerCase();
  const healthPath = route.healthPath.startsWith('/')
    ? route.healthPath
    : `/${route.healthPath}`;
  const certFull =
    route.certificateFullchainPath ||
    '/www/server/panel/vhost/cert/launchos-wildcard-zsaos/fullchain.pem';
  const certKey =
    route.certificatePrivkeyPath ||
    '/www/server/panel/vhost/cert/launchos-wildcard-zsaos/privkey.pem';

  const nginxHttpRedirect = [
    'server {',
    '    listen 80;',
    '    listen [::]:80;',
    `    server_name ${hostname};`,
    `    return 301 https://$host$request_uri;`,
    '}',
    '',
  ].join('\n');

  const nginxHttpsServer = [
    'server {',
    '    listen 443 ssl http2;',
    '    listen [::]:443 ssl http2;',
    `    server_name ${hostname};`,
    '',
    `    ssl_certificate ${certFull};`,
    `    ssl_certificate_key ${certKey};`,
    '',
    '    location / {',
    `        proxy_pass http://${route.targetHost}:${route.targetPort};`,
    '        proxy_http_version 1.1;',
    '        proxy_set_header Host $host;',
    '        proxy_set_header X-Real-IP $remote_addr;',
    '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
    '        proxy_set_header X-Forwarded-Proto $scheme;',
    '        proxy_set_header Upgrade $http_upgrade;',
    '        proxy_set_header Connection "";',
    '    }',
    '',
    `    # planned health probe path: ${healthPath}`,
    '}',
    '',
  ].join('\n');

  return {
    nginxHttpRedirect,
    nginxHttpsServer,
    combined: `${nginxHttpRedirect}${nginxHttpsServer}`,
  };
}

export function extractGatewayServerNames(config: string): string[] {
  const names: string[] = [];
  for (const match of config.matchAll(/server_name\s+([^;]+);/g)) {
    for (const name of (match[1] ?? '').split(/\s+/)) {
      const trimmed = name.trim().toLowerCase();
      if (trimmed) names.push(trimmed);
    }
  }
  return names;
}

/**
 * Replace server blocks for the incoming hostnames and keep every other block.
 */
export function upsertGatewayRouteConfig(existing: string, incoming: string): string {
  const incomingNames = new Set(extractGatewayServerNames(incoming));
  const blocks = splitNginxServerBlocks(existing);
  const kept = blocks.filter((block) => {
    const names = extractGatewayServerNames(block);
    return !names.some((name) => incomingNames.has(name));
  });
  return [...kept.map((block) => block.trim()), incoming.trim()].filter(Boolean).join('\n\n') + '\n';
}

function splitNginxServerBlocks(config: string): string[] {
  const blocks: string[] = [];
  let index = 0;
  while (index < config.length) {
    const start = config.indexOf('server', index);
    if (start < 0) break;
    const brace = config.indexOf('{', start);
    if (brace < 0) break;
    let depth = 0;
    let end = brace;
    for (; end < config.length; end += 1) {
      if (config[end] === '{') depth += 1;
      else if (config[end] === '}') {
        depth -= 1;
        if (depth === 0) {
          end += 1;
          break;
        }
      }
    }
    blocks.push(config.slice(start, end));
    index = end;
  }
  return blocks;
}

export function certificateCoversHostname(input: {
  commonName?: string | null;
  sans?: string[];
  hostname: string;
}): boolean {
  const hostname = input.hostname.trim().toLowerCase();
  const names = [
    ...(input.commonName ? [input.commonName] : []),
    ...(input.sans ?? []),
  ]
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);

  for (const name of names) {
    if (name === hostname) return true;
    if (name.startsWith('*.')) {
      const suffix = name.slice(1); // .zsaos.com
      if (hostname.endsWith(suffix) && hostname.split('.').length === name.split('.').length) {
        return true;
      }
      // *.zsaos.com covers web-launchos.zsaos.com (one label)
      const base = name.slice(2);
      if (hostname.endsWith(`.${base}`) && !hostname.slice(0, -(base.length + 1)).includes('.')) {
        return true;
      }
    }
  }
  return false;
}

export type WebApiConfigMode = 'BUILD_TIME' | 'RUNTIME' | 'NONE';

/**
 * Detect whether browser API base URL is build-time (Vite/Next public) or runtime.
 */
export function detectWebApiConfigMode(input: {
  framework?: string | null;
  requirements: Array<{
    key: string;
    injectionPhase?: string | null;
    required?: boolean;
  }>;
}): {
  webApiConfigMode: WebApiConfigMode;
  webApiConfigKey: string | null;
  publicConfigOnly: boolean;
  webApiPublicUrlPlanned: string;
} {
  const browserKeys = ['NEXT_PUBLIC_API_URL', 'VITE_API_URL', 'VITE_API_BASE_URL', 'API_BASE_URL'];
  const framework = String(input.framework || '').toUpperCase();
  const hit = input.requirements.find((r) => browserKeys.includes(r.key));
  const planned = `https://${STEP29_GATEWAY_WHITELIST.api.hostname}`;

  if (!hit) {
    return {
      webApiConfigMode: 'NONE',
      webApiConfigKey: null,
      publicConfigOnly: true,
      webApiPublicUrlPlanned: planned,
    };
  }

  const phase = String(hit.injectionPhase || '').toUpperCase();
  const isPublicKey =
    hit.key.startsWith('NEXT_PUBLIC_') ||
    hit.key.startsWith('VITE_') ||
    hit.key === 'API_BASE_URL';

  // Vite / Next public env is almost always build-time.
  if (
    phase === 'BUILD' ||
    phase === 'BOTH' ||
    framework === 'VITE' ||
    hit.key.startsWith('VITE_') ||
    hit.key.startsWith('NEXT_PUBLIC_')
  ) {
    return {
      webApiConfigMode: 'BUILD_TIME',
      webApiConfigKey: hit.key,
      publicConfigOnly: isPublicKey,
      webApiPublicUrlPlanned: planned,
    };
  }

  if (phase === 'RUNTIME') {
    return {
      webApiConfigMode: 'RUNTIME',
      webApiConfigKey: hit.key,
      publicConfigOnly: isPublicKey,
      webApiPublicUrlPlanned: planned,
    };
  }

  return {
    webApiConfigMode: 'NONE',
    webApiConfigKey: hit.key,
    publicConfigOnly: true,
    webApiPublicUrlPlanned: planned,
  };
}

/** Security group must not open dynamic app ports publicly. */
export function planSecurityGroupForGateway(input?: {
  currentOpenPorts?: number[];
}): {
  securityGroupChangeRequired: boolean;
  allowedPublicPorts: number[];
  dynamicPortsRemainPrivate: boolean;
  wouldOpenDynamicPorts: boolean;
} {
  const current = input?.currentOpenPorts ?? [22, 80, 443];
  const allowed = [...STEP29_GATEWAY_WHITELIST.allowedPublicPorts];
  const wouldOpenDynamic = current.some(
    (p) =>
      p >= STEP29_GATEWAY_WHITELIST.forbiddenDynamicPublicPorts.start &&
      p <= STEP29_GATEWAY_WHITELIST.forbiddenDynamicPublicPorts.end,
  );
  return {
    // Phase 1: never open 39000-39999; 22/80/443 assumed already present on managed ECS.
    securityGroupChangeRequired: false,
    allowedPublicPorts: allowed,
    dynamicPortsRemainPrivate: !wouldOpenDynamic,
    wouldOpenDynamicPorts: wouldOpenDynamic,
  };
}

export function expectedGatewayHealthChecks(): Array<{
  url: string;
  expectStatus: string;
}> {
  return [
    {
      url: `https://${STEP29_GATEWAY_WHITELIST.web.hostname}/`,
      expectStatus: '200',
    },
    {
      url: `https://${STEP29_GATEWAY_WHITELIST.api.hostname}/health`,
      expectStatus: '200',
    },
  ];
}
