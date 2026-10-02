'use client';

import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ProductNav } from '@/components/product-nav';
import { api, ApiError } from '@/lib/api';
import { goLivePath } from '@/lib/start-deploy';

type Check = {
  id: string;
  name: string;
  category: string;
  severity: string;
  passed: boolean;
  title: string;
  reason: string;
  suggestion: string;
};

type Preflight = {
  status: 'PASSED' | 'WARNING' | 'BLOCKED';
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH';
  checks: Check[];
  recommendations: string[];
  summary: string;
  confidence: number;
  source: string;
  passedCount: number;
  riskCount: number;
  allowDeploy: boolean;
  requireConfirm: boolean;
  note?: string;
};

export default function ProjectPreflightPage() {
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const unitId = search.get('unitId');
  const [data, setData] = useState<Preflight | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);

  async function load(force = false) {
    setLoading(true);
    setError('');
    try {
      const q = unitId ? `?unitId=${encodeURIComponent(unitId)}` : '';
      const payload = force
        ? await api<Preflight>(`/projects/${params.id}/preflight${q}`, {
            method: 'POST',
            body: JSON.stringify(unitId ? { unitId } : {}),
          })
        : await api<Preflight>(`/projects/${params.id}/preflight${q}`);
      setData(payload);
    } catch (err: unknown) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id, unitId]);

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <ProductNav />
        <div>
          <Link className="text-sm text-zinc-500" href={goLivePath(params.id, unitId)}>
            ← 返回上线
          </Link>
          <h1 className="mt-2 text-3xl font-semibold text-zinc-900">AI部署预检</h1>
          <p className="mt-1 text-sm text-zinc-500">上线前预测风险（不会自动改代码）</p>
        </div>

        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        {loading && !data ? <p className="text-sm text-zinc-500">正在预检…</p> : null}

        {data ? (
          <>
            <section className="rounded-2xl border border-zinc-200 bg-white p-6">
              <h2 className="text-sm font-medium text-zinc-500">预检摘要</h2>
              <dl className="mt-3 grid gap-3 text-sm text-zinc-700 sm:grid-cols-2">
                <div>
                  <dt className="text-zinc-500">状态</dt>
                  <dd className="mt-1 font-medium">{data.status}</dd>
                </div>
                <div>
                  <dt className="text-zinc-500">风险等级</dt>
                  <dd className="mt-1 font-medium">{data.riskLevel}</dd>
                </div>
                <div>
                  <dt className="text-zinc-500">通过</dt>
                  <dd className="mt-1">{data.passedCount} 项</dd>
                </div>
                <div>
                  <dt className="text-zinc-500">发现风险</dt>
                  <dd className="mt-1">{data.riskCount} 项</dd>
                </div>
              </dl>
              <p className="mt-4 text-sm leading-6 text-zinc-700">{data.summary}</p>
              {data.note ? <p className="mt-2 text-xs text-zinc-500">{data.note}</p> : null}
            </section>

            <section className="rounded-2xl border border-zinc-200 bg-white p-6">
              <h2 className="text-sm font-medium text-zinc-500">检查列表</h2>
              <ul className="mt-3 space-y-2">
                {data.checks.map((check) => (
                  <li key={check.id} className="rounded-xl border border-zinc-100">
                    <button
                      type="button"
                      className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left text-sm"
                      onClick={() => setOpenId(openId === check.id ? null : check.id)}
                    >
                      <span>
                        <span className="mr-2">{check.passed ? '✓' : '⚠'}</span>
                        <span className="font-medium text-zinc-900">{check.name}</span>
                        <span className="ml-2 text-xs text-zinc-500">{check.severity}</span>
                      </span>
                      <span className="text-xs text-zinc-500">{check.passed ? '通过' : '风险'}</span>
                    </button>
                    {openId === check.id ? (
                      <div className="space-y-1 border-t border-zinc-100 px-4 py-3 text-sm text-zinc-600">
                        <p>问题：{check.title}</p>
                        <p>原因：{check.reason}</p>
                        <p>建议：{check.suggestion}</p>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>

            {data.recommendations.length > 0 ? (
              <section className="rounded-2xl border border-zinc-200 bg-white p-6">
                <h2 className="text-sm font-medium text-zinc-500">修复建议</h2>
                <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-zinc-700">
                  {data.recommendations.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ol>
              </section>
            ) : null}

            <div className="flex flex-wrap gap-2">
              {data.allowDeploy ? (
                <Link
                  className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white"
                  href={goLivePath(params.id, unitId)}
                >
                  {data.requireConfirm ? '确认风险后继续上线' : '继续上线'}
                </Link>
              ) : (
                <button
                  type="button"
                  className="rounded-lg bg-zinc-300 px-4 py-2 text-sm font-medium text-zinc-600"
                  disabled
                >
                  需处理风险后继续
                </button>
              )}
              <button
                type="button"
                className="rounded-lg border border-zinc-200 px-4 py-2 text-sm text-zinc-700"
                onClick={() => void load(true)}
              >
                重新预检
              </button>
              <Link
                className="rounded-lg border border-zinc-200 px-4 py-2 text-sm text-zinc-700"
                href={`/projects/${params.id}`}
              >
                返回应用
              </Link>
            </div>
          </>
        ) : null}
      </div>
    </main>
  );
}
