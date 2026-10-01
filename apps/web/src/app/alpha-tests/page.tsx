'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ProductNav } from '@/components/product-nav';
import { api, ApiError } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';
import type { AppSummary } from '@/lib/types';

type Summary = {
  total: number;
  successCount: number;
  firstLaunchSuccessRate: number | null;
  medianLaunchDurationMs: number | null;
  averageInterventions: number;
  mostCommonFailureStage: string | null;
  health24hRate: number | null;
  exit: {
    sampleReady: boolean;
    met: boolean;
    note: string;
    checks: Array<{ id: string; label: string; met: boolean; actual: string }>;
  };
};

type SessionRow = {
  id: string;
  projectId: string | null;
  projectName: string | null;
  projectType: string | null;
  sessionStatus: string;
  launchSucceeded: boolean | null;
  totalDurationMs: number | null;
  manualInterventionCount: number;
  primaryFailureCode: string | null;
  blockedStage: string | null;
  publicUrl: string | null;
  health24h: string;
};

const STATUS_LABEL: Record<string, string> = {
  PLANNED: '未开始',
  IN_PROGRESS: '进行中',
  COMPLETED: '已完成',
  FAILED: '失败',
  ABANDONED: '已放弃',
};

function percent(value: number | null): string {
  if (value == null) return '—';
  return `${Math.round(value * 100)}%`;
}

function duration(value: number | null): string {
  if (value == null) return '—';
  const minutes = Math.round(value / 60000);
  if (minutes < 1) return `${Math.round(value / 1000)} 秒`;
  return `${minutes} 分钟`;
}

export default function AlphaTestsPage() {
  const router = useRouter();
  const [summary, setSummary] = useState<Summary | null>(null);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [apps, setApps] = useState<AppSummary[]>([]);
  const [projectId, setProjectId] = useState('');
  const [projectType, setProjectType] = useState('WEB');
  const [framework, setFramework] = useState('VITE');
  const [dependencies, setDependencies] = useState('NONE');
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }
    void api<{ summary: Summary; sessions: SessionRow[] }>('/alpha-tests')
      .then((payload) => {
        setSummary(payload.summary);
        setSessions(payload.sessions);
      })
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 403) {
          setForbidden(true);
          return;
        }
        setError(err instanceof Error ? err.message : '加载失败');
      });
    void api<AppSummary[]>('/apps')
      .then(setApps)
      .catch(() => undefined);
  }, [router]);

  async function createSession(): Promise<void> {
    setError(null);
    try {
      const created = await api<{ id: string }>('/alpha-tests', {
        method: 'POST',
        body: JSON.stringify({
          projectId: projectId || undefined,
          projectType,
          framework,
          dependencies,
        }),
      });
      router.push(`/alpha-tests/${created.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '登记失败');
    }
  }

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10">
      <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
        <ProductNav />
        <div>
          <p className="text-sm text-zinc-500">内部</p>
          <h1 className="mt-1 text-3xl font-semibold text-zinc-900">Alpha 测试记录</h1>
        </div>
        {forbidden ? (
          <section className="rounded-xl border border-amber-200 bg-amber-50 p-6">
            <h2 className="text-lg font-medium text-amber-950">无权查看</h2>
            <p className="mt-2 text-sm text-amber-900">测试记录只对平台管理员或内部测试人员开放。</p>
          </section>
        ) : null}
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        {summary ? (
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="总测试数" value={String(summary.total)} />
            <Metric label="上线成功数" value={String(summary.successCount)} />
            <Metric label="首次上线成功率" value={percent(summary.firstLaunchSuccessRate)} />
            <Metric label="中位上线耗时" value={duration(summary.medianLaunchDurationMs)} />
            <Metric label="平均人工介入" value={summary.averageInterventions.toFixed(1)} />
            <Metric label="最常见失败阶段" value={summary.mostCommonFailureStage ?? '—'} />
            <Metric label="24h 健康率" value={percent(summary.health24hRate)} />
            <Metric label="样本" value={summary.exit.sampleReady ? '已够 3 人' : '不足 3 人'} />
          </section>
        ) : forbidden ? null : (
          <p className="text-sm text-zinc-500">加载中…</p>
        )}
        {summary ? (
          <section className="rounded-2xl border border-zinc-200 bg-white p-4">
            <h2 className="text-sm font-medium text-zinc-900">第一轮目标</h2>
            <p className="mt-1 text-sm text-zinc-500">{summary.exit.note}</p>
            <ul className="mt-3 grid gap-2 sm:grid-cols-2">
              {summary.exit.checks.map((check) => (
                <li key={check.id} className="text-sm text-zinc-700">
                  {check.label}：{check.actual}
                  {summary.exit.sampleReady ? (check.met ? '，达到' : '，未达到') : ''}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {forbidden ? null : <><section className="rounded-2xl border border-zinc-200 bg-white p-4">
          <h2 className="text-sm font-medium text-zinc-900">登记一次测试</h2>
          <p className="mt-1 text-sm text-zinc-500">创建后是「未开始」。不要提前填写上线记录。请让测试用户使用自己的代码仓库，不要用已经调通的示例。</p>
          {framework === 'OTHER_SUPPORTED' || (projectType === 'WEB' && framework === 'NODE') || (projectType === 'API' && framework !== 'NODE') ? (
            <p className="mt-2 text-sm text-amber-700">这组类型不在第一批范围。第一批是网页、接口，或两者一起，可以带数据库或缓存。暂不测复杂编排和复杂语言项目。</p>
          ) : null}
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="text-sm text-zinc-600">
              项目
              <select className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2" value={projectId} onChange={(event) => setProjectId(event.target.value)}>
                <option value="">稍后绑定</option>
                {apps.map((app) => (
                  <option key={app.id} value={app.id}>
                    {app.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm text-zinc-600">
              项目类型
              <select className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2" value={projectType} onChange={(event) => setProjectType(event.target.value)}>
                <option value="WEB">WEB</option>
                <option value="API">API</option>
                <option value="WEB_API">WEB + API</option>
              </select>
            </label>
            <label className="text-sm text-zinc-600">
              框架
              <select className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2" value={framework} onChange={(event) => setFramework(event.target.value)}>
                <option value="VITE">VITE</option>
                <option value="NEXTJS">NEXTJS</option>
                <option value="NODE">NODE</option>
                <option value="OTHER_SUPPORTED">OTHER_SUPPORTED</option>
              </select>
            </label>
            <label className="text-sm text-zinc-600">
              依赖
              <select className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2" value={dependencies} onChange={(event) => setDependencies(event.target.value)}>
                <option value="NONE">NONE</option>
                <option value="POSTGRESQL">POSTGRESQL</option>
                <option value="REDIS">REDIS</option>
              </select>
            </label>
          </div>
          <button className="mt-3 rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white" type="button" onClick={() => void createSession()}>
            登记
          </button>
        </section>
        <section className="overflow-x-auto rounded-2xl border border-zinc-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-zinc-200 text-zinc-500">
              <tr>
                <th className="px-3 py-2 font-medium">测试编号</th>
                <th className="px-3 py-2 font-medium">项目</th>
                <th className="px-3 py-2 font-medium">类型</th>
                <th className="px-3 py-2 font-medium">阶段</th>
                <th className="px-3 py-2 font-medium">上线成功</th>
                <th className="px-3 py-2 font-medium">耗时</th>
                <th className="px-3 py-2 font-medium">人工介入</th>
                <th className="px-3 py-2 font-medium">失败原因</th>
                <th className="px-3 py-2 font-medium">公网地址</th>
                <th className="px-3 py-2 font-medium">24h 健康</th>
              </tr>
            </thead>
            <tbody>
              {sessions.length === 0 ? (
                <tr>
                  <td className="px-3 py-6 text-zinc-500" colSpan={10}>
                    还没有测试记录。
                  </td>
                </tr>
              ) : (
                sessions.map((session) => (
                  <tr key={session.id} className="border-t border-zinc-100">
                    <td className="px-3 py-2">
                      <Link className="text-zinc-900 underline" href={`/alpha-tests/${session.id}`}>
                        {session.id.slice(0, 8)}
                      </Link>
                    </td>
                    <td className="px-3 py-2">{session.projectName ?? '未绑定'}</td>
                    <td className="px-3 py-2">{session.projectType ?? '—'}</td>
                    <td className="px-3 py-2">{STATUS_LABEL[session.sessionStatus] ?? session.sessionStatus}</td>
                    <td className="px-3 py-2">{session.launchSucceeded == null ? '—' : session.launchSucceeded ? '是' : '否'}</td>
                    <td className="px-3 py-2">{duration(session.totalDurationMs)}</td>
                    <td className="px-3 py-2">{session.manualInterventionCount}</td>
                    <td className="px-3 py-2">{session.blockedStage ?? '—'}</td>
                    <td className="px-3 py-2">{session.publicUrl ?? '—'}</td>
                    <td className="px-3 py-2">{session.health24h}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </section></>}
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-zinc-200 bg-white p-4">
      <p className="text-sm text-zinc-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-zinc-900">{value}</p>
    </div>
  );
}
