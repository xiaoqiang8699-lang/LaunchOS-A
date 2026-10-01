'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { OnboardingLayout } from '@/components/onboarding-layout';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';
import { writeClipboard } from '@/lib/clipboard';

type Stage = 'CONNECT' | 'ANALYZE' | 'PLAN' | 'LAUNCH' | 'SUCCESS' | 'FAILED';

type OnboardingState = {
  onboardingStatus: string;
  shouldEnterOnboarding: boolean;
  stage: Stage;
  projectId: string | null;
  findings: string[];
  uncertainties: string[];
  launchStatus: string | null;
  publicUrl: string | null;
  hidesTestControls: boolean;
};

type PlanView = {
  ready: string[];
  toCreate: Array<{ label: string; spec: string | null }>;
  noNewBillable: boolean;
  needsBilling: boolean;
  primaryLabel: string;
  launchRunId: string;
  specs: string[];
  estimatedCostAvailable: boolean;
};

type FailurePresentation = {
  category: string;
  title: string;
  stageLabel: string;
  productStage: string;
  userMessage: string;
  suggestedAction: string;
  retryable: boolean;
  fixPromptAvailable: boolean;
  techCode: string;
  configPath: string | null;
  fixPrompt: string | null;
};

type LaunchPoll = {
  status: string;
  currentStage?: string | null;
  currentStep?: string | null;
  userMessage?: string | null;
  failure?: FailurePresentation | null;
  failureCode?: string | null;
};

const PROGRESS = ['连接代码', '智能检测', '上线方案', '发布成功'];
const PHASES = [
  '分析应用',
  '准备依赖',
  '准备服务器',
  '构建应用',
  '部署应用',
  '配置访问入口',
  '上线检查',
];

function progressIndex(stage: Stage): number {
  if (stage === 'CONNECT') return 0;
  if (stage === 'ANALYZE') return 1;
  if (stage === 'PLAN') return 2;
  return 3;
}

function phaseIndex(stage: string | null | undefined, step?: string | null): number {
  const value = `${stage ?? ''} ${step ?? ''}`;
  if (/DEPEND/i.test(value)) return 1;
  if (/INFRA|SERVER/i.test(value)) return 2;
  if (/BUILD/i.test(value)) return 3;
  if (/DEPLOY|RUNTIME/i.test(value)) return 4;
  if (/GATEWAY|DNS|PUBLIC|CERT/i.test(value)) return 5;
  if (/VERIFY|FINAL/i.test(value)) return 6;
  return 0;
}

function phaseMarker(
  index: number,
  current: number,
  failed: boolean,
): { mark: string; className: string } {
  if (failed && index === current) {
    return { mark: '✕ ', className: 'font-medium text-red-600' };
  }
  if (failed && index < current) {
    return { mark: '✓ ', className: 'text-emerald-700' };
  }
  if (!failed && index < current) {
    return { mark: '✓ ', className: 'text-emerald-700' };
  }
  if (!failed && index === current) {
    return { mark: '● ', className: 'font-medium text-zinc-900' };
  }
  return { mark: '○ ', className: 'text-zinc-400' };
}

export default function OnboardingFlowPage() {
  const router = useRouter();
  const [state, setState] = useState<OnboardingState | null>(null);
  const [plan, setPlan] = useState<PlanView | null>(null);
  const [currentPhase, setCurrentPhase] = useState(0);
  const [failedPhase, setFailedPhase] = useState<number | null>(null);
  const [failure, setFailure] = useState<FailurePresentation | null>(null);
  const [publicUrl, setPublicUrl] = useState<string | null>(null);
  const [showTechnical, setShowTechnical] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [copiedFix, setCopiedFix] = useState(false);

  async function load(): Promise<OnboardingState> {
    const next = await api<OnboardingState>('/onboarding');
    setState(next);
    if (next.publicUrl) setPublicUrl(next.publicUrl);
    if (!next.shouldEnterOnboarding) router.replace('/dashboard');
    if (next.stage === 'CONNECT') router.replace('/onboarding/source');
    return next;
  }

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }
    void load().catch((err: unknown) => setError(err instanceof Error ? err.message : '加载失败'));
  }, [router]);

  async function analyze(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const next = await api<OnboardingState>('/onboarding/analyze', { method: 'POST' });
      setState(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : '分析失败');
    } finally {
      setPending(false);
    }
  }

  async function loadPlan(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      setPlan(await api<PlanView>('/onboarding/plan', { method: 'POST' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : '暂时无法准备上线方案');
    } finally {
      setPending(false);
    }
  }

  async function startLaunchWithPlan(activePlan: PlanView): Promise<void> {
    setPending(true);
    setError(null);
    setFailure(null);
    setFailedPhase(null);
    setCopiedFix(false);
    try {
      if (activePlan.needsBilling) {
        await api('/onboarding/confirm', { method: 'POST' });
      }
      await api('/onboarding/launch', { method: 'POST' });
      setState((current) => (current ? { ...current, stage: 'LAUNCH' } : current));
      for (let i = 0; i < 80; i += 1) {
        const run = await api<LaunchPoll>('/onboarding/launch');
        setCurrentPhase(phaseIndex(run.currentStage, run.currentStep));
        if (run.status === 'SUCCESS') {
          const next = await load();
          setPublicUrl(next.publicUrl);
          setState({ ...next, stage: 'SUCCESS' });
          return;
        }
        if (run.status === 'FAILED' || run.status === 'CANCELLED') {
          const phase = phaseIndex(run.currentStage, run.currentStep);
          setFailedPhase(phase);
          setCurrentPhase(phase);
          setFailure(run.failure ?? null);
          setError(run.failure?.userMessage || run.userMessage || '上线失败');
          setState((current) => (current ? { ...current, stage: 'FAILED' } : current));
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      setError('上线仍在进行中，请稍后到我的应用查看结果。');
    } catch (err) {
      setError(err instanceof Error ? err.message : '上线失败');
      setState((current) => (current ? { ...current, stage: 'FAILED' } : current));
    } finally {
      setPending(false);
    }
  }

  async function startLaunch(): Promise<void> {
    if (!plan) return;
    await startLaunchWithPlan(plan);
  }

  function defer(): void {
    window.sessionStorage.setItem('launchos-onboarding-console', '1');
    router.push('/dashboard?tab=apps');
  }

  async function enterApps(): Promise<void> {
    await api('/onboarding/complete', {
      method: 'POST',
      body: JSON.stringify({ reason: 'SUCCESS' }),
    });
    router.push('/dashboard?tab=apps');
  }

  async function copyFixPrompt(): Promise<void> {
    if (!failure?.fixPrompt) return;
    try {
      await writeClipboard(failure.fixPrompt);
      setCopiedFix(true);
      window.setTimeout(() => setCopiedFix(false), 2000);
    } catch {
      setError('复制失败，请手动复制修复提示词。');
    }
  }

  const stage = state?.stage ?? 'ANALYZE';
  const progressPhase = failedPhase ?? currentPhase;

  return (
    <OnboardingLayout>
      <div>
        <p className="text-sm text-zinc-500">欢迎使用 LaunchOS</p>
        <h1 className="mt-2 text-3xl font-semibold text-zinc-900">开始第一次上线</h1>
      </div>
      <ol className="flex flex-wrap items-center gap-2 text-sm text-zinc-500">
        {PROGRESS.map((label, index) => (
          <li
            key={label}
            className={index === progressIndex(stage === 'FAILED' ? 'LAUNCH' : stage) ? 'font-medium text-zinc-900' : ''}
          >
            {index > 0 ? '→ ' : ''}
            {label}
          </li>
        ))}
      </ol>
      {error && stage !== 'FAILED' && stage !== 'LAUNCH' ? (
        <p className="text-sm text-red-600">{error}</p>
      ) : null}

      {stage === 'ANALYZE' ? (
        <section className="rounded-2xl border border-zinc-200 bg-white p-6">
          <h2 className="text-xl font-semibold text-zinc-900">智能检测</h2>
          {state && state.findings.length === 0 && !pending ? (
            <>
              <p className="mt-2 text-sm text-zinc-500">正在准备分析你的应用。</p>
              <button
                className="mt-4 rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white"
                type="button"
                onClick={() => void analyze()}
              >
                开始检测
              </button>
            </>
          ) : (
            <>
              <p className="mt-2 text-sm text-zinc-700">
                {pending ? '正在分析你的应用…' : '我们检测到：'}
              </p>
              <ul className="mt-3 space-y-1 text-sm text-zinc-800">
                {state?.findings.map((item) => (
                  <li key={item}>✓ {item}</li>
                ))}
              </ul>
              {state && state.uncertainties.length > 0 ? (
                <p className="mt-3 text-sm text-amber-800">
                  这里需要你确认一下。{state.uncertainties.join('')}
                </p>
              ) : null}
              <button
                className="mt-4 text-sm text-zinc-500 underline"
                type="button"
                onClick={() => setShowTechnical((value) => !value)}
              >
                {showTechnical ? '隐藏技术详情' : '查看技术详情'}
              </button>
              {showTechnical ? (
                <p className="mt-2 text-xs text-zinc-500">技术细节只在这里显示，不影响继续上线。</p>
              ) : null}
              <button
                className="mt-4 block rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white"
                type="button"
                onClick={() =>
                  void loadPlan().then(() =>
                    setState((current) => (current ? { ...current, stage: 'PLAN' } : current)),
                  )
                }
              >
                查看上线方案
              </button>
            </>
          )}
        </section>
      ) : null}

      {stage === 'PLAN' ? (
        <section className="rounded-2xl border border-zinc-200 bg-white p-6">
          <h2 className="text-xl font-semibold text-zinc-900">LaunchOS 已为你准备好上线方案</h2>
          {!plan ? (
            <button
              className="mt-4 rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white"
              type="button"
              onClick={() => void loadPlan()}
            >
              查看方案
            </button>
          ) : (
            <>
              {plan.ready.length > 0 ? (
                <div className="mt-3">
                  <p className="text-sm text-zinc-500">已经准备好的：</p>
                  <ul className="mt-1 text-sm text-zinc-800">
                    {plan.ready.map((item) => (
                      <li key={item}>✓ {item}</li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {plan.noNewBillable ? (
                <p className="mt-3 text-sm text-emerald-800">无需创建新的收费云资源</p>
              ) : null}
              {plan.toCreate.length > 0 ? (
                <div className="mt-3 text-sm text-zinc-800">
                  <p>需要创建的：</p>
                  <ul>
                    {plan.toCreate.map((item) => (
                      <li key={item.label}>
                        {item.label}
                        {item.spec ? ` · ${item.spec}` : ''}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-zinc-500">
                    预计费用：{plan.estimatedCostAvailable ? '见云账户报价' : '确认时展示预估'}
                  </p>
                </div>
              ) : null}
              <button
                className="mt-4 rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white disabled:opacity-60"
                type="button"
                disabled={pending}
                onClick={() => void startLaunch()}
              >
                {pending ? '正在上线…' : plan.primaryLabel}
              </button>
            </>
          )}
        </section>
      ) : null}

      {stage === 'LAUNCH' ? (
        <section className="rounded-2xl border border-zinc-200 bg-white p-6">
          <h2 className="text-xl font-semibold text-zinc-900">正在上线</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {PHASES.map((label, index) => {
              const marker = phaseMarker(index, progressPhase, false);
              return (
                <li key={label} className={marker.className}>
                  {marker.mark}
                  {label}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {stage === 'FAILED' ? (
        <section className="rounded-2xl border border-red-200 bg-white p-6">
          <h2 className="text-2xl font-semibold text-red-700">{failure?.title || '上线失败'}</h2>
          <ul className="mt-4 space-y-2 text-sm">
            {PHASES.map((label, index) => {
              const marker = phaseMarker(index, progressPhase, true);
              return (
                <li key={label} className={marker.className}>
                  {marker.mark}
                  {label}
                </li>
              );
            })}
          </ul>
          <div className="mt-5 space-y-3 rounded-xl border border-red-100 bg-red-50 p-4 text-sm text-zinc-800">
            <p>
              <span className="font-medium text-zinc-900">失败阶段：</span>
              {failure?.stageLabel || PHASES[progressPhase] || '部署应用'}
            </p>
            <p>
              <span className="font-medium text-zinc-900">失败原因：</span>
              {failure?.userMessage || error || '上线失败'}
            </p>
            <p>
              <span className="font-medium text-zinc-900">怎么处理：</span>
              {failure?.suggestedAction || '请检查后重新上线，或稍后重试。'}
            </p>
          </div>
          <div className="mt-4 flex flex-wrap gap-3">
            {failure?.configPath ? (
              <a
                className="rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white"
                href={`${failure.configPath}?from=onboarding`}
              >
                去填写运行配置
              </a>
            ) : null}
            {failure?.retryable !== false ? (
              <button
                className={`rounded-lg px-4 py-2 text-sm disabled:opacity-60 ${
                  failure?.configPath
                    ? 'border border-zinc-300 bg-white text-zinc-900'
                    : 'bg-zinc-900 text-white'
                }`}
                type="button"
                disabled={pending}
                onClick={() => {
                  void (async () => {
                    setError(null);
                    setFailure(null);
                    setFailedPhase(null);
                    try {
                      const nextPlan = await api<PlanView>('/onboarding/plan', { method: 'POST' });
                      setPlan(nextPlan);
                      // Reuse same Project / Environment / Source via a fresh LaunchRun.
                      await startLaunchWithPlan(nextPlan);
                    } catch (err) {
                      setPending(false);
                      setError(err instanceof Error ? err.message : '重新上线失败');
                      setState((current) => (current ? { ...current, stage: 'FAILED' } : current));
                    }
                  })();
                }}
              >
                {pending ? '正在重新上线…' : '重新上线'}
              </button>
            ) : null}
            {failure?.fixPromptAvailable && failure.fixPrompt ? (
              <button
                className="rounded-lg border border-zinc-300 px-4 py-2 text-sm"
                type="button"
                onClick={() => void copyFixPrompt()}
              >
                {copiedFix ? '已复制' : '生成修复提示词'}
              </button>
            ) : null}
            <button
              className="rounded-lg border border-zinc-300 px-4 py-2 text-sm"
              type="button"
              onClick={defer}
            >
              进入我的应用
            </button>
          </div>
          {failure?.fixPromptAvailable ? (
            <p className="mt-3 text-xs text-zinc-500">
              修复提示词可复制给 Codex / Cursor / Claude Code。LaunchOS 不会自动修改你的代码。
            </p>
          ) : null}
        </section>
      ) : null}

      {stage === 'SUCCESS' ? (
        <section className="rounded-2xl border border-zinc-200 bg-white p-6">
          <h2 className="text-2xl font-semibold text-zinc-900">你的应用已经上线</h2>
          {publicUrl ? <p className="mt-3 text-sm text-zinc-700">访问地址 {publicUrl}</p> : null}
          <div className="mt-4 flex gap-3">
            {publicUrl ? (
              <a
                className="rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white"
                href={publicUrl}
                target="_blank"
                rel="noreferrer"
              >
                打开应用
              </a>
            ) : null}
            <button
              className="rounded-lg border border-zinc-300 px-4 py-2 text-sm"
              type="button"
              onClick={() => void enterApps()}
            >
              进入我的应用
            </button>
          </div>
        </section>
      ) : null}

      {stage !== 'SUCCESS' && stage !== 'FAILED' ? (
        <button className="w-fit text-sm text-zinc-400" type="button" onClick={defer}>
          稍后再说
        </button>
      ) : null}
    </OnboardingLayout>
  );
}
