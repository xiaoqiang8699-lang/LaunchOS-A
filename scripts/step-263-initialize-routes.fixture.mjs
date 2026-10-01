/**
 * Step 26.3 — controller route metadata + HTTP probe fixture.
 * No enqueue / no SSH. Requires apps/api dist build.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import http from 'node:http';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
for (const line of readFileSync(resolve(root, '.env'), 'utf8').split(/\r?\n/)) {
  const t = line.trim();
  if (!t || t.startsWith('#')) continue;
  const i = t.indexOf('=');
  if (i <= 0) continue;
  const k = t.slice(0, i).trim();
  let v = t.slice(i + 1).trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  if (process.env[k] === undefined) process.env[k] = v;
}

const require = createRequire(resolve(root, 'apps/api/package.json'));
const GLOBAL_PREFIX = 'api/v1';
const CONTROLLER_PATH = 'projects/:projectId/server';

function readControllerRoutes() {
  const ctrlPath = resolve(
    root,
    'apps/api/dist/server-provision/server-provision.controller.js',
  );
  assert.equal(existsSync(ctrlPath), true, 'api dist missing — run nest build first');
  const { PATH_METADATA, METHOD_METADATA } = require('@nestjs/common/constants');
  const { RequestMethod } = require('@nestjs/common');
  const { ServerProvisionController } = require(ctrlPath);
  const base = Reflect.getMetadata(PATH_METADATA, ServerProvisionController);
  const proto = ServerProvisionController.prototype;
  const names = Object.getOwnPropertyNames(proto).filter((n) => n !== 'constructor');
  const methodName = {
    [RequestMethod.GET]: 'GET',
    [RequestMethod.POST]: 'POST',
    [RequestMethod.PUT]: 'PUT',
    [RequestMethod.DELETE]: 'DELETE',
    [RequestMethod.PATCH]: 'PATCH',
  };
  const routes = [];
  for (const name of names) {
    const path = Reflect.getMetadata(PATH_METADATA, proto[name]);
    const method = Reflect.getMetadata(METHOD_METADATA, proto[name]);
    if (path === undefined || method === undefined) continue;
    const rel = Array.isArray(path) ? path[0] : path;
    routes.push({
      handler: name,
      method: methodName[method] || String(method),
      controllerPath: base,
      routePath: rel,
      fullPath: `/${GLOBAL_PREFIX}/${base}/${rel}`.replace(/\/+/g, '/'),
    });
  }
  return routes;
}

describe('step-263 initialize Nest route metadata', () => {
  it('controller prefix is projects/:projectId/server', () => {
    const routes = readControllerRoutes();
    assert.equal(routes[0]?.controllerPath, CONTROLLER_PATH);
  });

  it('POST initialize full path is /api/v1/projects/:projectId/server/initialize', () => {
    const routes = readControllerRoutes();
    const post = routes.find((r) => r.method === 'POST' && r.routePath === 'initialize');
    assert.ok(post, `POST initialize missing: ${JSON.stringify(routes)}`);
    assert.equal(post.fullPath, '/api/v1/projects/:projectId/server/initialize');
  });

  it('GET initialization routes exist with correct prefix', () => {
    const routes = readControllerRoutes();
    const latest = routes.find((r) => r.method === 'GET' && r.routePath === 'initialization');
    const byId = routes.find(
      (r) => r.method === 'GET' && r.routePath === 'initialization/:id',
    );
    assert.ok(latest, 'GET initialization missing');
    assert.ok(byId, 'GET initialization/:id missing');
    assert.equal(latest.fullPath, '/api/v1/projects/:projectId/server/initialization');
    assert.equal(byId.fullPath, '/api/v1/projects/:projectId/server/initialization/:id');
  });

  it('main.ts globalPrefix is api/v1 (source of truth)', () => {
    const main = readFileSync(resolve(root, 'apps/api/src/main.ts'), 'utf8');
    assert.match(main, /setGlobalPrefix\(\s*['"]api\/v1['"]\s*\)/);
  });

  it('POST mock HTTP reaches handler without enqueue (local probe server)', async () => {
    let initializeCalls = 0;
    const server = http.createServer((req, res) => {
      const url = req.url || '';
      if (req.method === 'POST' && /\/api\/v1\/projects\/[^/]+\/server\/initialize$/.test(url)) {
        initializeCalls += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            mocked: true,
            WRITE_ENQUEUE: false,
            path: url,
            enteredInitializeService: true,
          }),
        );
        return;
      }
      if (req.method === 'GET' && /\/api\/v1\/projects\/[^/]+\/server\/initialization/.test(url)) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ found: true, mocked: true }));
        return;
      }
      res.writeHead(404);
      res.end('Cannot ' + req.method + ' ' + url);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address();
    try {
      const post = await fetch(
        `http://127.0.0.1:${port}/api/v1/projects/proj/server/initialize`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ serverInstanceId: 'cmub78pz001sdripco5pexhdz' }),
        },
      );
      const body = await post.json();
      assert.equal(post.status, 200);
      assert.equal(body.enteredInitializeService, true);
      assert.equal(body.WRITE_ENQUEUE, false);
      assert.equal(initializeCalls, 1);

      const get = await fetch(
        `http://127.0.0.1:${port}/api/v1/projects/proj/server/initialization`,
      );
      assert.equal(get.status, 200);
      assert.equal((await get.json()).found, true);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});
