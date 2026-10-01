'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ProductNav } from '@/components/product-nav';
import { api } from '@/lib/api';
import { clearAccessToken, getAccessToken } from '@/lib/auth';
import { formatDateTime } from '@/lib/project-labels';
import { goLivePath } from '@/lib/start-deploy';

type DependencyItem = {
  type: string;
  label: string;
  required: boolean;
  supported: boolean;
  status: string;
  statusLabel: string;
  provider: string | null;
  providerLabel: string | null;
  connectionId: string | null;
  cloudResourceId: string | null;
  needsRedeploy: boolean;
  productPhaseLabel: string | null;
  lastCheckedAt: string | null;
  managePath: string | null;
};

type UnitDeps = {
  unitId: string;
  unitName: string;
  unitType: string;
  dependencies: DependencyItem[];
};

type SummaryPayload = {
  project: {
    required: number;
    connected: number;
    missing: number;
    status: string;
    statusLabel: string;
  };
  units: UnitDeps[];
  canEdit: boolean;
};

function statusClass(status: string): string {
  switch (status) {
    case 'CONNECTED':
      return 'bg-emerald-50 text-emerald-800';
    case 'MISSING':
    case 'ERROR':
      return 'bg-amber-50 text-amber-900';
    case 'CONFIGURING':
      return 'bg-sky-50 text-sky-900';
    case 'NEEDS_REDEPLOY':
      return 'bg-violet-50 text-violet-900';
    case 'DEGRADED':
    case 'UNAVAILABLE':
      return 'bg-rose-50 text-rose-900';
    default:
      return 'bg-zinc-100 text-zinc-700';
  }
}

export default function ProjectDependenciesPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const [summary, setSummary] = useState<SummaryPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState<Record<string, boolean>>({});
  const [healthMsg, setHealthMsg] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const data = await api<SummaryPayload>(`/projects/${params.id}/dependencies`);
    setSummary(data);
  }, [params.id]);

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        await load();
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : '加载失败');
          if (String(err).includes('401')) {
            clearAccessToken();
            router.replace('/login');
          }
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load, router]);

  async function checkHealth(unitId: string, type: string) {
    const key = `${unitId}:${type}`;
    setBusy(key);
    setHealthMsg((prev) => ({ ...prev, [key]: '' }));
    try {
      const result = await api<{ healthStatus: string; message?: string }>(
        `/projects/${params.id}/dependencies/units/${unitId}/${type}/health`,
        { method: 'POST' },
      );
      setHealthMsg((prev) => ({
        ...prev,
        [key]: result.message || result.healthStatus,
      }));
      await load();
    } catch (err) {
      setHealthMsg((prev) => ({
        ...prev,
        [key]: err instanceof Error ? err.message : '检查失败',
      }));
    } finally {
      setBusy(null);
    }
  }

  async function unlink(unitId: string, type: string) {
    if (!window.confirm('解除连接不会删除阿里云中的服务。确定继续？')) return;
    setBusy(`unlink:${unitId}:${type}`);
    try {
      await api(`/projects/${params.id}/dependencies/units/${unitId}/${type}/unlink`, {
        method: 'POST',
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '解除失败');
    } finally {
      setBusy(null);
    }
  }

  if (error && !summary) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <p className="text-rose-700">{error}</p>
      </main>
    );
  }

  if (!summary) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        <p className="text-zinc-600">正在加载应用依赖…</p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <ProductNav />
      <div className="mb-6 flex items-center justify-between gap-3">
        <div>
          <p className="text-sm text-zinc-500">
            <Link href={`/projects/${params.id}`} className="hover:underline">
              返回应用
            </Link>
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight text-zinc-900">应用依赖</h1>
          <p className="mt-1 text-sm text-zinc-600">
            {summary.project.required} 个依赖 · {summary.project.statusLabel}
          </p>
        </div>
      </div>

      {error ? <p className="mb-4 text-sm text-rose-700">{error}</p> : null}

      <div className="space-y-6">
        {summary.units.map((unit) => (
          <section key={unit.unitId} className="rounded-xl border border-zinc-200 bg-white p-5">
            <h2 className="text-lg font-medium text-zinc-900">
              {unit.unitName}
              <span className="ml-2 text-sm font-normal text-zinc-500">{unit.unitType}</span>
            </h2>
            <div className="mt-4 space-y-3">
              {unit.dependencies.map((dep) => {
                const key = `${unit.unitId}:${dep.type}`;
                if (!dep.required && dep.status === 'NOT_REQUIRED') {
                  return (
                    <div
                      key={dep.type}
                      className="flex items-center justify-between rounded-lg bg-zinc-50 px-3 py-2 text-sm text-zinc-600"
                    >
                      <span>{dep.label}</span>
                      <span>不需要</span>
                    </div>
                  );
                }
                return (
                  <div key={dep.type} className="rounded-lg border border-zinc-100 p-3">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-zinc-900">{dep.label}</span>
                          <span
                            className={`rounded-full px-2 py-0.5 text-xs ${statusClass(dep.status)}`}
                          >
                            {dep.statusLabel}
                          </span>
                        </div>
                        <p className="mt-1 text-sm text-zinc-600">
                          {dep.providerLabel || '—'}
                          {dep.productPhaseLabel ? ` · ${dep.productPhaseLabel}` : ''}
                          {dep.lastCheckedAt
                            ? ` · 最近检查：${formatDateTime(dep.lastCheckedAt)}`
                            : ''}
                        </p>
                        {dep.status === 'NEEDS_REDEPLOY' ? (
                          <p className="mt-1 text-sm text-violet-800">
                            已连接，需要重新上线后生效
                          </p>
                        ) : null}
                        {healthMsg[key] ? (
                          <p className="mt-1 text-sm text-zinc-700">{healthMsg[key]}</p>
                        ) : null}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        {dep.status === 'MISSING' && dep.supported ? (
                          <>
                            {dep.managePath ? (
                              <Link
                                href={dep.managePath}
                                className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm text-white"
                              >
                                连接已有服务
                              </Link>
                            ) : null}
                            {dep.managePath ? (
                              <Link
                                href={dep.managePath}
                                className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-800"
                              >
                                LaunchOS 帮我创建
                              </Link>
                            ) : null}
                          </>
                        ) : null}
                        {dep.status === 'NEEDS_REDEPLOY' ? (
                          <Link
                            href={goLivePath(params.id, unit.unitId)}
                            className="rounded-md bg-zinc-900 px-3 py-1.5 text-sm text-white"
                          >
                            重新上线
                          </Link>
                        ) : null}
                        {dep.connectionId ? (
                          <>
                            <button
                              type="button"
                              disabled={busy === key}
                              onClick={() => checkHealth(unit.unitId, dep.type)}
                              className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm"
                            >
                              检查连接
                            </button>
                            {summary.canEdit ? (
                              <button
                                type="button"
                                disabled={Boolean(busy)}
                                onClick={() => unlink(unit.unitId, dep.type)}
                                className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm"
                              >
                                解除连接
                              </button>
                            ) : null}
                          </>
                        ) : null}
                        {dep.managePath ? (
                          <Link
                            href={dep.managePath}
                            className="rounded-md border border-zinc-300 px-3 py-1.5 text-sm"
                          >
                            管理
                          </Link>
                        ) : null}
                        <button
                          type="button"
                          className="rounded-md px-2 py-1.5 text-sm text-zinc-500 underline"
                          onClick={() =>
                            setAdvanced((prev) => ({ ...prev, [key]: !prev[key] }))
                          }
                        >
                          高级信息
                        </button>
                      </div>
                    </div>
                    {advanced[key] ? (
                      <div className="mt-3 rounded-md bg-zinc-50 p-3 text-xs text-zinc-600">
                        <p>类型：{dep.type}</p>
                        <p>连接 ID：{dep.connectionId || '—'}</p>
                        <p>云资源 ID：{dep.cloudResourceId || '—'}</p>
                        <p className="mt-1 text-zinc-500">
                          凭证与连接串不会在此显示。
                        </p>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      <p className="mt-8 text-sm text-zinc-500">
        数据库与 Redis 的详细开通流程仍可在原页面完成；本页为统一入口。
        <Link href={`/projects/${params.id}/database`} className="ml-2 underline">
          数据库
        </Link>
        <Link href={`/projects/${params.id}/redis`} className="ml-2 underline">
          Redis
        </Link>
      </p>
    </main>
  );
}
