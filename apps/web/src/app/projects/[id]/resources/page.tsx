'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ProductNav } from '@/components/product-nav';
import {
  CLOUD_RESOURCE_STATUS_LABELS,
  statusBadgeClass,
} from '@/lib/project-labels';
import { api, ApiError } from '@/lib/api';
import { clearAccessToken, getAccessToken } from '@/lib/auth';
import { goLivePath } from '@/lib/start-deploy';
import type {
  AiAnalyzeResponse,
  ProjectDetail,
  ResourceRecommendationResponse,
  CloudResource,
} from '@/lib/types';

export default function ResourceRecommendationPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const [project, setProject] = useState<ProjectDetail | null>(null);
  const [payload, setPayload] = useState<ResourceRecommendationResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingRecommendation, setLoadingRecommendation] = useState(false);
  const [resource, setResource] = useState<CloudResource | null>(null);
  const [creatingResource, setCreatingResource] = useState(false);

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
        const resources = await api<CloudResource[]>(`/projects/${params.id}/resources`).catch(
          () => [],
        );
        if (!cancelled) {
          setResource(resources[0] ?? null);
        }
        try {
          const recommendation = await api<ResourceRecommendationResponse>(
            `/projects/${params.id}/resource-recommendation`,
          );
          if (!cancelled) {
            setPayload(recommendation);
          }
        } catch (err) {
          if (cancelled) {
            return;
          }
          if (err instanceof ApiError && err.message === 'Deployment plan is required') {
            setPayload(null);
            return;
          }
          throw err;
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

  useEffect(() => {
    if (resource?.status !== 'CREATING') {
      return;
    }
    const timer = window.setInterval(() => {
      void api<CloudResource[]>(`/projects/${params.id}/resources`)
        .then((resources) => setResource(resources[0] ?? null))
        .catch(() => undefined);
    }, 2000);
    return () => {
      window.clearInterval(timer);
    };
  }, [params.id, resource?.status]);

  async function generateRecommendation(): Promise<void> {
    setLoadingRecommendation(true);
    setError(null);
    try {
      if (project?.sources.length === 0) {
        setError('请先连接代码');
        return;
      }
      await api<AiAnalyzeResponse>(`/projects/${params.id}/ai/analyze`, { method: 'POST' });
      const recommendation = await api<ResourceRecommendationResponse>(
        `/projects/${params.id}/resource-recommendation`,
      );
      setPayload(recommendation);
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成推荐失败');
    } finally {
      setLoadingRecommendation(false);
    }
  }

  async function createRealResource(): Promise<void> {
    setCreatingResource(true);
    setError(null);
    setResource((current) =>
      current
        ? { ...current, status: 'CREATING' }
        : null,
    );
    try {
      const created = await api<CloudResource>(`/projects/${params.id}/resources/create`, {
        method: 'POST',
      });
      setResource(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建真实资源失败');
      const resources = await api<CloudResource[]>(`/projects/${params.id}/resources`).catch(
        () => [],
      );
      setResource(resources[0] ?? null);
    } finally {
      setCreatingResource(false);
    }
  }

  if (!project) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-50 text-sm text-zinc-500">
        {error ?? '加载中…'}
      </main>
    );
  }

  const plan = payload?.recommendation.plan;

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <ProductNav />
        <div>
          <Link className="text-sm text-zinc-500" href={`/projects/${project.id}`}>
            ← 返回应用
          </Link>
          <h1 className="mt-2 text-3xl font-semibold text-zinc-900">资源准备建议</h1>
          <p className="mt-1 text-sm text-zinc-500">{project.name} · 高级工具</p>
        </div>

        {error ? <p className="text-sm text-red-600">{error}</p> : null}

        <section className="rounded-2xl border border-zinc-200 bg-white p-6">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-medium text-zinc-500">推荐方案</h2>
            <button
              className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm text-zinc-700 disabled:opacity-60"
              type="button"
              onClick={() => void generateRecommendation()}
              disabled={loadingRecommendation || project.sources.length === 0}
            >
              {loadingRecommendation ? '生成中…' : payload ? '重新生成' : '生成推荐'}
            </button>
          </div>
          {project.sources.length === 0 ? (
            <p className="mt-3 text-sm text-zinc-500">请先连接代码，并完成智能检测。</p>
          ) : plan ? (
            <dl className="mt-3 space-y-2 text-sm text-zinc-700">
              <div>
                <dt className="text-zinc-500">方案</dt>
                <dd className="text-lg font-semibold text-zinc-900">{plan.name}</dd>
              </div>
              <div>
                <dt className="text-zinc-500">说明</dt>
                <dd>{plan.description}</dd>
              </div>
            </dl>
          ) : (
            <p className="mt-3 text-sm text-zinc-500">
              还没有资源推荐。请先完成 AI 部署分析，或点击“生成推荐”。
            </p>
          )}
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6">
          <h2 className="text-sm font-medium text-zinc-500">资源配置</h2>
          {plan ? (
            <dl className="mt-3 space-y-2 text-sm text-zinc-700">
              <div>
                <dt className="text-zinc-500">CPU</dt>
                <dd>{plan.cpu} CPU</dd>
              </div>
              <div>
                <dt className="text-zinc-500">内存</dt>
                <dd>{plan.memory}</dd>
              </div>
              <div>
                <dt className="text-zinc-500">存储</dt>
                <dd>{plan.storage}</dd>
              </div>
              <div>
                <dt className="text-zinc-500">数据库</dt>
                <dd>{plan.database}</dd>
              </div>
            </dl>
          ) : (
            <p className="mt-3 text-sm text-zinc-500">生成推荐后会显示 CPU、内存、存储和数据库配置。</p>
          )}
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6">
          <h2 className="text-sm font-medium text-zinc-500">推荐原因</h2>
          {payload ? (
            <p className="mt-3 text-sm text-zinc-700">{payload.recommendation.reason}</p>
          ) : (
            <p className="mt-3 text-sm text-zinc-500">推荐会根据智能检测结果选择合适的上线方式。</p>
          )}
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-medium text-zinc-500">云服务器</h2>
            <button
              className="rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-60"
              type="button"
              onClick={() => void createRealResource()}
              disabled={!plan || creatingResource || resource?.status === 'CREATING'}
            >
              {creatingResource || resource?.status === 'CREATING' ? '创建中…' : '创建服务器'}
            </button>
          </div>
          {!resource ? (
            <p className="mt-3 text-sm text-zinc-500">
              可选：创建一台云服务器。没有云服务器时，也可以直接部署。
            </p>
          ) : (
            <dl className="mt-3 space-y-2 text-sm text-zinc-700">
              <div className="flex items-center justify-between gap-3">
                <dt className="text-zinc-500">状态</dt>
                <dd>
                  <span className={`rounded-full px-2 py-0.5 text-xs ${statusBadgeClass(resource.status)}`}>
                    {CLOUD_RESOURCE_STATUS_LABELS[resource.status]}
                  </span>
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500">公网地址</dt>
                <dd>{resource.publicIp || '-'}</dd>
              </div>
              <div>
                <dt className="text-zinc-500">地域</dt>
                <dd>{resource.region || '-'}</dd>
              </div>
            </dl>
          )}
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6">
          <h2 className="text-sm font-medium text-zinc-500">开始上线</h2>
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
