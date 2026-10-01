'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ProductNav } from '@/components/product-nav';
import { api } from '@/lib/api';
import { clearAccessToken, getAccessToken } from '@/lib/auth';
import { goLivePath } from '@/lib/start-deploy';
import type {
  AiAnalysis,
  AiAnalyzeResponse,
  DeploymentPlan,
  ProjectDetail,
} from '@/lib/types';

export default function AiDeploymentAnalysisPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [analysis, setAnalysis] = useState<AiAnalyzeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [analyzing, setAnalyzing] = useState(false);

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }

    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const detail = await api<ProjectDetail>(`/projects/${params.id}`);
        if (cancelled) {
          return;
        }
        setProject(detail);

        const latest = await api<{ analysis: AiAnalysis | null; plan: DeploymentPlan | null }>(
          `/projects/${params.id}/ai/analysis`,
        );
        if (cancelled) {
          return;
        }
        if (latest.analysis && latest.plan) {
          setAnalysis({ analysis: latest.analysis, plan: latest.plan });
        }
      } catch (err) {
        if (cancelled) {
          return;
        }
        clearAccessToken();
        setError(err instanceof Error ? err.message : '加载失败');
        router.replace('/login');
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [params.id, router]);

  async function runAnalysis(): Promise<void> {
    setAnalyzing(true);
    setError(null);
    try {
      const result = await api<AiAnalyzeResponse>(`/projects/${params.id}/ai/analyze`, {
        method: 'POST',
      });
      setAnalysis(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : '分析失败');
    } finally {
      setAnalyzing(false);
    }
  }

  if (!project) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-50 text-sm text-zinc-500">
        {error ?? '加载中…'}
      </main>
    );
  }

  const plan: DeploymentPlan | undefined = analysis?.plan;
  const findings = analysis?.analysis.result.findings ?? [];

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <ProductNav />
        <div>
          <Link className="text-sm text-zinc-500" href={`/projects/${project.id}`}>
            ← 返回应用
          </Link>
          <h1 className="mt-2 text-3xl font-semibold text-zinc-900">AI 部署分析</h1>
          <p className="mt-1 text-sm text-zinc-500">{project.name} · 高级工具</p>
        </div>

        {error ? <p className="text-sm text-red-600">{error}</p> : null}

        <section className="rounded-2xl border border-zinc-200 bg-white p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-zinc-500">检测结果</h2>
            <button
              className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm text-zinc-700 disabled:opacity-60"
              type="button"
              onClick={() => void runAnalysis()}
              disabled={analyzing || project.sources.length === 0}
            >
              {analyzing ? '分析中…' : analysis ? '重新分析' : '开始分析'}
            </button>
          </div>
          {project.sources.length === 0 ? (
            <p className="mt-3 text-sm text-zinc-500">请先连接代码。</p>
          ) : analysis ? (
            <ul className="mt-3 space-y-2 text-sm text-zinc-700">
              {findings.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-sm text-zinc-500">尚未检测。点击“开始分析”即可。</p>
          )}
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6">
          <h2 className="text-sm font-medium text-zinc-500">推荐配置</h2>
          {plan ? (
            <dl className="mt-3 space-y-2 text-sm text-zinc-700">
              <div>
                <dt className="text-zinc-500">运行环境</dt>
                <dd>自动识别</dd>
              </div>
            </dl>
          ) : (
            <p className="mt-3 text-sm text-zinc-500">分析完成后会显示推荐配置。</p>
          )}
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6">
          <h2 className="text-sm font-medium text-zinc-500">开始上线</h2>
          <p className="mt-3 text-sm text-zinc-500">确认检测结果后即可选择上线方式。</p>
          {plan ? (
            <Link
              className="mt-4 inline-flex rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white"
              href={goLivePath(project.id)}
            >
              上线
            </Link>
          ) : (
            <button
              className="mt-4 rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white opacity-60"
              type="button"
              disabled
            >
              上线
            </button>
          )}
        </section>
      </div>
    </main>
  );
}
