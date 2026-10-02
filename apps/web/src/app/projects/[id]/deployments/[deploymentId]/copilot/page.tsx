'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ProductNav } from '@/components/product-nav';
import { api, ApiError } from '@/lib/api';
import { goLivePath } from '@/lib/start-deploy';

type KnowledgeRef = {
  id: string;
  title: string;
  successRate: number;
  usageCount: number;
  confidence: number;
};

type Copilot = {
  category: string;
  summary: string;
  rootCause: string;
  impact: string;
  fixActions: Array<{ step: number; title: string; detail?: string }>;
  confidence: number;
  source: string;
  failedStage: string | null;
  failureCode: string | null;
  timeline: Array<{ key: string; label: string; status: string }>;
  similarCount?: number;
  knowledgeReferences?: KnowledgeRef[];
  note?: string;
  deployment?: {
    id: string;
    status: string;
    failedStage: string | null;
    finishedAt: string | null;
    version: string | null;
    commit: string | null;
    projectId: string;
    failureCode: string | null;
  };
};

export default function ProjectDeploymentCopilotPage() {
  const params = useParams<{ id: string; deploymentId: string }>();
  const [data, setData] = useState<Copilot | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [feedbackMsg, setFeedbackMsg] = useState('');

  async function load(force = false) {
    setLoading(true);
    setError('');
    try {
      const path = force
        ? `/deployments/${params.deploymentId}/copilot/analyze`
        : `/deployments/${params.deploymentId}/copilot`;
      const payload = force
        ? await api<Copilot>(path, { method: 'POST' })
        : await api<Copilot>(path);
      setData(payload);
    } catch (err: unknown) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }

  async function sendFeedback(knowledgeId: string, result: 'SUCCESS' | 'FAILED') {
    setFeedbackMsg('');
    try {
      await api(`/deployment-knowledge/${knowledgeId}/feedback`, {
        method: 'POST',
        body: JSON.stringify({ deploymentId: params.deploymentId, result }),
      });
      setFeedbackMsg(result === 'SUCCESS' ? '已记录：方案已解决' : '已记录：方案未解决');
    } catch (err: unknown) {
      setFeedbackMsg(err instanceof Error ? err.message : '反馈失败');
    }
  }

  useEffect(() => {
    void load(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.deploymentId]);

  const refs = data?.knowledgeReferences || [];

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <ProductNav />
        <div>
          <Link className="text-sm text-zinc-500" href={`/deployments/${params.deploymentId}`}>
            ← 返回部署进度
          </Link>
          <h1 className="mt-2 text-3xl font-semibold text-zinc-900">AI部署诊断</h1>
          <p className="mt-1 text-sm text-zinc-500">分析失败原因并给出修复建议（不会自动改代码）</p>
        </div>

        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        {loading && !data ? <p className="text-sm text-zinc-500">正在分析…</p> : null}

        {data ? (
          <>
            {data.note ? (
              <p className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-600">
                {data.note}
              </p>
            ) : null}

            <section className="rounded-2xl border border-zinc-200 bg-white p-6">
              <h2 className="text-sm font-medium text-zinc-500">部署状态</h2>
              <dl className="mt-3 grid gap-3 text-sm text-zinc-700 sm:grid-cols-2">
                <div>
                  <dt className="text-zinc-500">失败阶段</dt>
                  <dd className="mt-1 font-medium">{data.failedStage || data.deployment?.failedStage || '—'}</dd>
                </div>
                <div>
                  <dt className="text-zinc-500">失败时间</dt>
                  <dd className="mt-1">
                    {data.deployment?.finishedAt
                      ? new Date(data.deployment.finishedAt).toLocaleString()
                      : '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-zinc-500">当前版本</dt>
                  <dd className="mt-1">{data.deployment?.version || '—'}</dd>
                </div>
                <div>
                  <dt className="text-zinc-500">Commit</dt>
                  <dd className="mt-1 font-mono text-xs">{data.deployment?.commit || '—'}</dd>
                </div>
              </dl>
            </section>

            {refs.length > 0 ? (
              <section className="rounded-2xl border border-violet-200 bg-violet-50/40 p-6">
                <h2 className="text-sm font-medium text-zinc-900">历史验证方案</h2>
                <p className="mt-1 text-sm text-zinc-600">
                  类似问题：{refs.length} 次匹配 · 优先展示知识库经验
                </p>
                <ul className="mt-4 space-y-3">
                  {refs.map((ref) => (
                    <li key={ref.id} className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm">
                      <p className="font-medium text-zinc-900">{ref.title}</p>
                      <p className="mt-1 text-xs text-zinc-500">
                        成功率 {(ref.successRate * 100).toFixed(0)}% · 使用 {ref.usageCount} 次 · 置信度{' '}
                        {(ref.confidence * 100).toFixed(0)}%
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <span className="text-xs text-zinc-500">是否解决？</span>
                        <button
                          type="button"
                          className="rounded-lg border border-zinc-200 px-3 py-1 text-xs text-zinc-700"
                          onClick={() => void sendFeedback(ref.id, 'SUCCESS')}
                        >
                          已解决
                        </button>
                        <button
                          type="button"
                          className="rounded-lg border border-zinc-200 px-3 py-1 text-xs text-zinc-700"
                          onClick={() => void sendFeedback(ref.id, 'FAILED')}
                        >
                          未解决
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
                {feedbackMsg ? <p className="mt-2 text-xs text-zinc-600">{feedbackMsg}</p> : null}
              </section>
            ) : null}

            <section className="rounded-2xl border border-zinc-200 bg-white p-6">
              <h2 className="text-sm font-medium text-zinc-500">AI诊断结果</h2>
              <div className="mt-3 space-y-3 text-sm text-zinc-700">
                <p>
                  问题分类：<span className="font-medium">{data.category}</span>
                </p>
                <p>
                  原因：<span className="font-medium">{data.summary}</span>
                </p>
                <p>影响：{data.impact}</p>
                <p className="leading-6">{data.rootCause}</p>
                <p className="text-xs text-zinc-500">
                  置信度 {(data.confidence * 100).toFixed(0)}% · 来源 {data.source}
                  {data.similarCount != null ? ` · 近30天类似 ${data.similarCount}` : ''}
                </p>
              </div>
            </section>

            <section className="rounded-2xl border border-zinc-200 bg-white p-6">
              <h2 className="text-sm font-medium text-zinc-500">诊断时间线</h2>
              <ol className="mt-4 space-y-0">
                {data.timeline.map((item, index) => (
                  <li key={item.key} className="relative flex gap-3 pb-4 last:pb-0">
                    <div className="flex w-4 flex-col items-center">
                      <span
                        className={
                          item.status === 'FAILED'
                            ? 'mt-1 h-2.5 w-2.5 rounded-full bg-red-600'
                            : item.status === 'AI'
                              ? 'mt-1 h-2.5 w-2.5 rounded-full bg-violet-600'
                              : 'mt-1 h-2.5 w-2.5 rounded-full bg-zinc-900'
                        }
                      />
                      {index < data.timeline.length - 1 ? (
                        <span className="mt-1 w-px flex-1 bg-zinc-200" />
                      ) : null}
                    </div>
                    <div className="text-sm">
                      <p className="font-medium text-zinc-900">{item.label}</p>
                      <p className="text-xs text-zinc-500">{item.status}</p>
                    </div>
                  </li>
                ))}
              </ol>
            </section>

            <section className="rounded-2xl border border-zinc-200 bg-white p-6">
              <h2 className="text-sm font-medium text-zinc-500">修复建议</h2>
              <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-zinc-700">
                {data.fixActions.map((action) => (
                  <li key={action.step}>
                    <span className="font-medium">{action.title}</span>
                    {action.detail ? <span className="text-zinc-500"> — {action.detail}</span> : null}
                  </li>
                ))}
              </ol>
              <div className="mt-5 flex flex-wrap gap-2">
                <Link
                  className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white"
                  href={goLivePath(params.id)}
                >
                  重新上线
                </Link>
                <button
                  type="button"
                  className="rounded-lg border border-zinc-200 px-4 py-2 text-sm text-zinc-700"
                  onClick={() => void load(true)}
                >
                  重新分析
                </button>
                <Link
                  className="rounded-lg border border-zinc-200 px-4 py-2 text-sm text-zinc-700"
                  href={`/projects/${params.id}`}
                >
                  返回应用
                </Link>
              </div>
            </section>
          </>
        ) : null}
      </div>
    </main>
  );
}
