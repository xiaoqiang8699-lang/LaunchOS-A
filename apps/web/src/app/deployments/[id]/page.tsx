'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { ProductNav } from '@/components/product-nav';
import { api, ApiError } from '@/lib/api';
import { clearAccessToken, getAccessToken } from '@/lib/auth';
import { writeClipboard } from '@/lib/clipboard';
import { PRODUCT_COPY } from '@/lib/product-language';
import { goLivePath } from '@/lib/start-deploy';
import {
  ACTIVE_DEPLOYMENT_STATUSES,
  EXPERIENCE_STEP_STATUS_LABELS,
  statusBadgeClass,
} from '@/lib/project-labels';
import type { DeploymentExperience, ExperienceStep } from '@/lib/types';

function formatElapsed(totalSeconds: number): string {
  if (totalSeconds < 60) {
    return `${totalSeconds} 秒`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes} 分 ${seconds} 秒`;
}

function formatRelative(iso: string | null | undefined, nowMs: number): string | null {
  if (!iso) {
    return null;
  }
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return null;
  }
  const delta = Math.max(0, Math.floor((nowMs - then) / 1000));
  if (delta < 8) {
    return '刚刚';
  }
  if (delta < 60) {
    return `${delta} 秒前`;
  }
  if (delta < 3600) {
    return `${Math.floor(delta / 60)} 分钟前`;
  }
  return `${Math.floor(delta / 3600)} 小时前`;
}

function longRunningHint(elapsedSeconds: number): string | null {
  if (elapsedSeconds >= 60) {
    return '这一步比平时需要更长时间，LaunchOS 仍在处理中。';
  }
  if (elapsedSeconds >= 10) {
    return '仍在处理中，请稍候…';
  }
  return null;
}

function queueWaitHint(
  status: string | undefined,
  queuedAt: string | null | undefined,
  nowMs: number,
): string | null {
  if (status !== 'QUEUED' && status !== 'CREATED') {
    return null;
  }
  const then = queuedAt ? Date.parse(queuedAt) : NaN;
  const waitSeconds = Number.isNaN(then) ? 0 : Math.floor((nowMs - then) / 1000);
  if (waitSeconds >= 10) {
    return '正在等待上线任务开始…';
  }
  return '等待开始';
}

function staleActivityHint(lastActivityAt: string | null | undefined, nowMs: number): string | null {
  if (!lastActivityAt) {
    return null;
  }
  const then = Date.parse(lastActivityAt);
  if (Number.isNaN(then)) {
    return null;
  }
  const quietSeconds = Math.floor((nowMs - then) / 1000);
  if (quietSeconds >= 120) {
    return '上线似乎卡住了';
  }
  return null;
}

function staleActivityDetail(lastActivityAt: string | null | undefined, nowMs: number): string | null {
  if (!lastActivityAt) {
    return null;
  }
  const then = Date.parse(lastActivityAt);
  if (Number.isNaN(then)) {
    return null;
  }
  const quietSeconds = Math.floor((nowMs - then) / 1000);
  if (quietSeconds < 120) {
    return null;
  }
  const minutes = Math.max(1, Math.floor(quietSeconds / 60));
  return `最近 ${minutes} 分钟没有新进展。`;
}

function StepStatusBadge({ step }: { step: ExperienceStep }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs ${statusBadgeClass(step.status)}`}>
      {step.status === 'RUNNING' ? (
        <span
          aria-hidden
          className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-r-transparent"
        />
      ) : null}
      {EXPERIENCE_STEP_STATUS_LABELS[step.status]}
    </span>
  );
}

export default function DeploymentExperiencePage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const [experience, setExperience] = useState<DeploymentExperience | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sawActive, setSawActive] = useState(false);
  const [copied, setCopied] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }

    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const payload = await api<DeploymentExperience>(`/deployments/${params.id}/experience`);
        if (cancelled) {
          return;
        }
        setExperience(payload);
        if (ACTIVE_DEPLOYMENT_STATUSES.includes(payload.deployment.status)) {
          setSawActive(true);
        }
      } catch (err) {
        if (cancelled) {
          return;
        }
        if (err instanceof ApiError && err.status === 401) {
          clearAccessToken();
          router.replace('/login');
          return;
        }
        setError(err instanceof Error ? err.message : '加载失败');
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [params.id, router]);

  useEffect(() => {
    if (!experience) {
      return;
    }
    if (!ACTIVE_DEPLOYMENT_STATUSES.includes(experience.deployment.status)) {
      return;
    }
    const timer = window.setInterval(() => {
      void api<DeploymentExperience>(`/deployments/${params.id}/experience`)
        .then((payload) => {
          setExperience(payload);
          if (ACTIVE_DEPLOYMENT_STATUSES.includes(payload.deployment.status)) {
            setSawActive(true);
          }
        })
        .catch(() => undefined);
    }, 1500);
    return () => {
      window.clearInterval(timer);
    };
  }, [experience, params.id]);

  useEffect(() => {
    if (!experience || !ACTIVE_DEPLOYMENT_STATUSES.includes(experience.deployment.status)) {
      return;
    }
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => {
      window.clearInterval(timer);
    };
  }, [experience]);

  useEffect(() => {
    const goLiveDone = experience?.steps.find((step) => step.key === 'GO_LIVE')?.status === 'SUCCESS';
    if (!sawActive || experience?.deployment.status !== 'SUCCESS' || !goLiveDone) {
      return;
    }
    const timer = window.setTimeout(() => {
      router.replace(`/deployments/${params.id}/success`);
    }, 1800);
    return () => {
      window.clearTimeout(timer);
    };
  }, [experience, params.id, router, sawActive]);

  async function copyAssistantPrompt(): Promise<void> {
    const prompt = experience?.userError?.assistantPrompt;
    if (!prompt) {
      return;
    }
    try {
      await writeClipboard(prompt);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('复制失败');
    }
  }

  const unitLabel = experience?.progress?.unitLabel || experience?.deployment.unitLabel || '应用';
  const runningStep = experience?.steps.find((step) => step.status === 'RUNNING') ?? null;
  const elapsedSeconds = useMemo(() => {
    const startedAt = experience?.progress?.currentStepStartedAt || runningStep?.startedAt;
    if (!startedAt) {
      return 0;
    }
    const startedMs = Date.parse(startedAt);
    if (Number.isNaN(startedMs)) {
      return 0;
    }
    return Math.max(0, Math.floor((nowMs - startedMs) / 1000));
  }, [experience?.progress?.currentStepStartedAt, nowMs, runningStep?.startedAt]);

  const recentActivity = formatRelative(experience?.progress?.lastActivityAt, nowMs);
  const activityStale = staleActivityHint(experience?.progress?.lastActivityAt, nowMs);
  const activityStaleDetail = staleActivityDetail(experience?.progress?.lastActivityAt, nowMs);
  const runningHint = runningStep ? longRunningHint(elapsedSeconds) : null;
  const waitHint = queueWaitHint(
    experience?.deployment.status,
    experience?.queue?.queuedAt ?? experience?.deployment.startedAt ?? null,
    nowMs,
  );
  const backendStalled =
    experience?.deployment.failureCode === 'RUNNING_STALLED' ||
    experience?.deployment.failureCode === 'QUEUE_STALLED' ||
    /失去响应|长时间无进展|STALLED/i.test(experience?.deployment.errorMessage || '');

  if (!experience) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-50 text-sm text-zinc-500">
        {error ?? '加载中…'}
      </main>
    );
  }

  const isFailed = experience.deployment.status === 'FAILED';
  const goLiveStep = experience.steps.find((step) => step.key === 'GO_LIVE');
  const isSuccess =
    experience.deployment.status === 'SUCCESS' && goLiveStep?.status === 'SUCCESS';
  const headline = isSuccess
    ? `${unitLabel}上线完成`
    : isFailed
      ? '上线没有完成'
      : `正在上线${unitLabel}`;

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <ProductNav />
        <div>
          <Link className="text-sm text-zinc-500" href={`/projects/${experience.deployment.projectId}`}>
            ← 返回应用
          </Link>
          <h1 className="mt-2 text-3xl font-semibold text-zinc-900">{headline}</h1>
          <p className="mt-1 text-sm text-zinc-500">{experience.deployment.projectName}</p>
        </div>

        {error ? <p className="text-sm text-red-600">{error}</p> : null}

        {!isFailed && !isSuccess ? (
          <section className="rounded-2xl border border-zinc-200 bg-white p-6">
            <h2 className="text-sm font-medium text-zinc-500">
              {experience.deployment.status === 'QUEUED' || experience.deployment.status === 'CREATED'
                ? '等待开始'
                : '正在执行'}
            </h2>
            <p className="mt-2 flex items-center gap-2 text-base font-medium text-zinc-900">
              {runningStep || experience.deployment.status === 'QUEUED' ? (
                <span
                  aria-hidden
                  className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-zinc-400 border-r-transparent"
                />
              ) : null}
              {waitHint ||
                experience.progress?.currentAction ||
                runningStep?.detail ||
                `正在准备上线${unitLabel}…`}
            </p>
            {experience.deployment.status === 'QUEUED' ? (
              <p className="mt-2 text-sm text-zinc-500">
                任务已创建，正在等待上线服务接手。若长时间无进展，请稍后重试。
              </p>
            ) : null}
            {runningStep ? (
              <p className="mt-2 text-sm text-zinc-500">已运行：{formatElapsed(elapsedSeconds)}</p>
            ) : null}
            {runningHint ? <p className="mt-2 text-sm text-zinc-500">{runningHint}</p> : null}
            {recentActivity ? (
              <p className="mt-2 text-sm text-zinc-500">最近活动：{recentActivity}</p>
            ) : null}
            {activityStale ? (
              <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
                <p className="text-sm font-medium text-amber-900">{activityStale}</p>
                {activityStaleDetail ? (
                  <p className="mt-1 text-sm text-amber-800">{activityStaleDetail}</p>
                ) : null}
                <div className="mt-3 flex flex-wrap gap-2">
                  <Link
                    className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-sm text-amber-900"
                    href={`/deployments/${params.id}/details`}
                  >
                    查看原因
                  </Link>
                  {isFailed || backendStalled ? (
                    <Link
                      className="rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white"
                      href={goLivePath(experience.deployment.projectId)}
                    >
                      重新上线
                    </Link>
                  ) : (
                    <Link
                      className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-sm text-amber-900"
                      href={goLivePath(experience.deployment.projectId)}
                    >
                      重新上线
                    </Link>
                  )}
                </div>
              </div>
            ) : null}
          </section>
        ) : null}

        <section className="rounded-2xl border border-zinc-200 bg-white p-6">
          <h2 className="text-sm font-medium text-zinc-500">{PRODUCT_COPY.hostingLocation}</h2>
          <p className="mt-2 text-sm text-zinc-700">
            {experience.deployment.hostingLabel ||
              (experience.deployment.hostingMode === 'my-server'
                ? PRODUCT_COPY.hostingMyServer
                : PRODUCT_COPY.hostingLaunchos)}
          </p>
        </section>

        <section className="rounded-2xl border border-zinc-200 bg-white p-6">
          <h2 className="text-sm font-medium text-zinc-500">{unitLabel}上线进度</h2>
          <ol className="mt-4 space-y-3">
            {experience.steps.map((step) => {
              const stepElapsed =
                step.status === 'RUNNING' && step.startedAt
                  ? Math.max(0, Math.floor((nowMs - Date.parse(step.startedAt)) / 1000))
                  : null;
              return (
                <li key={step.key} className="rounded-xl border border-zinc-100 px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <p className="font-medium text-zinc-900">{step.name}</p>
                    <StepStatusBadge step={step} />
                  </div>
                  {step.detail ? <p className="mt-2 text-sm text-zinc-600">{step.detail}</p> : null}
                  {stepElapsed != null ? (
                    <p className="mt-1 text-xs text-zinc-500">已运行：{formatElapsed(stepElapsed)}</p>
                  ) : null}
                  {step.status === 'RUNNING' && stepElapsed != null && longRunningHint(stepElapsed) ? (
                    <p className="mt-1 text-xs text-zinc-500">{longRunningHint(stepElapsed)}</p>
                  ) : null}
                </li>
              );
            })}
          </ol>
        </section>

        {isFailed ? (
          <section className="rounded-2xl border border-red-200 bg-white p-6">
            <h2 className="text-sm font-medium text-red-600">上线没有完成</h2>
            <dl className="mt-3 space-y-3 text-sm text-zinc-700">
              <div>
                <dt className="text-zinc-500">失败阶段</dt>
                <dd className="mt-1">
                  {experience.userError?.failedStageLabel ||
                    experience.deployment.currentStageLabel ||
                    '上线过程'}
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500">问题原因</dt>
                <dd className="mt-1">{experience.userError?.cause || '这次上线没有完成。'}</dd>
              </div>
              <div>
                <dt className="text-zinc-500">解决建议</dt>
                <dd className="mt-1">{experience.userError?.suggestion || '请检查代码后重新上线。'}</dd>
              </div>
              {experience.deployment.retryCount != null && experience.deployment.maxRetry != null ? (
                <div>
                  <dt className="text-zinc-500">重试</dt>
                  <dd className="mt-1">
                    {experience.deployment.retryCount}/{experience.deployment.maxRetry}
                  </dd>
                </div>
              ) : null}
              {recentActivity ? (
                <div>
                  <dt className="text-zinc-500">最近活动</dt>
                  <dd className="mt-1">{recentActivity}</dd>
                </div>
              ) : null}
            </dl>
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white"
                type="button"
                onClick={() => void copyAssistantPrompt()}
              >
                {copied ? '已复制' : '复制给开发助手'}
              </button>
              <Link
                className="rounded-lg border border-zinc-200 px-4 py-2 text-sm text-zinc-700"
                href={goLivePath(experience.deployment.projectId)}
              >
                重新上线
              </Link>
              <Link
                className="rounded-lg border border-zinc-200 px-4 py-2 text-sm text-zinc-700"
                href={`/projects/${experience.deployment.projectId}`}
              >
                返回应用
              </Link>
            </div>
            <p className="mt-4 text-sm text-zinc-500">
              <Link className="underline" href={`/deployments/${params.id}/details`}>
                查看技术日志（高级）
              </Link>
            </p>
          </section>
        ) : isSuccess ? (
          <section className="rounded-2xl border border-emerald-200 bg-white p-6">
            <p className="text-sm text-emerald-700">{unitLabel}已完成上线。</p>
            <Link
              className="mt-4 inline-flex rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white"
              href={`/deployments/${params.id}/success`}
            >
              查看上线结果
            </Link>
          </section>
        ) : (
          <p className="text-sm text-zinc-500">完成后可以进入成功页面。</p>
        )}
      </div>
    </main>
  );
}
