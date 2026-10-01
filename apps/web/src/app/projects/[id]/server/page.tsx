'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ProductNav } from '@/components/product-nav';
import { api, ApiError } from '@/lib/api';
import { clearAccessToken, getAccessToken } from '@/lib/auth';

type Tier = {
  profile: 'DEV' | 'STANDARD' | 'PRODUCTION';
  label: string;
  vcpu: number;
  memoryGb: number;
  systemDiskGb: number;
  recommended: boolean;
  sku: {
    instanceType: string;
    cpu: number;
    memoryGb: number;
    selectionReason: string;
  } | null;
  priceEstimate: {
    available: boolean;
    currency: string | null;
    hourlyPrice: string | null;
    monthlyEquivalent: string | null;
  } | null;
  unavailableReason: string | null;
};

type PlanPayload = {
  needServer: boolean;
  reasons: string[];
  readiness: string;
  readinessLabel: string;
  source: string;
  existingServer: {
    id: string;
    name: string;
    host: string;
    evaluation: { fitLabel: string; reason: string } | null;
  } | null;
  existingServers: Array<{ id: string; name: string; host: string }>;
  recommendation: {
    profile: string;
    profileLabel: string;
    vcpu: number;
    memoryGb: number;
    reason: string;
    regionId: string;
    regionReason: string;
    osLabel: string;
    osName: string;
    chargeTypeLabel: string;
    deployModeLabel: string;
    priceEstimate: {
      available: boolean;
      currency: string | null;
      hourlyPrice: string | null;
      monthlyEquivalent: string | null;
    } | null;
  };
  tiers: Tier[];
  placement: {
    regionId: string;
    placementReason: string;
    publicIpRequired: boolean;
    securityGroupPlan: { note: string };
  };
  image: { productLabel: string; osName: string } | null;
  billingReadiness: { message: string };
  notices: string[];
  createBlockedReason: string;
  canEdit: boolean;
  simulatedNoServer: boolean;
};

function formatMoney(currency: string | null, value: string | null): string {
  if (!value) return '暂无报价';
  const c = currency === 'CNY' || !currency ? '¥' : `${currency} `;
  return `${c}${value}`;
}

export default function ServerPlanPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [plan, setPlan] = useState<PlanPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [simulateNoServer, setSimulateNoServer] = useState(false);
  const [confirmBilling, setConfirmBilling] = useState(false);
  const [provisionStatus, setProvisionStatus] = useState<{
    phaseLabel?: string;
    failedPhaseLabel?: string | null;
    failedOperation?: string | null;
    serverReadinessLabel?: string;
    publicIp?: string | null;
    billingNotice?: string | null;
    cloudResourceId?: string;
    errorMessage?: string | null;
    productSteps?: Array<{ label: string; reached: boolean; failed: boolean }>;
    serverInstanceId?: string | null;
    status?: string;
  } | null>(null);
  const [initStatus, setInitStatus] = useState<{
    serverInstanceId?: string | null;
    serverReadiness?: string | null;
    serverReadinessLabel?: string | null;
    phaseLabel?: string | null;
    progress?: number;
    productSteps?: Array<{ label: string; reached: boolean; failed: boolean }>;
    errorMessage?: string | null;
    retryActionLabel?: string | null;
    runtimeType?: string | null;
    osName?: string | null;
    publicIp?: string | null;
  } | null>(null);

  const load = useCallback(
    async (opts?: { simulateNoServer?: boolean; profile?: string }) => {
      if (!getAccessToken()) {
        router.replace('/login');
        return;
      }
      setError(null);
      try {
        const q = new URLSearchParams();
        if (opts?.simulateNoServer) q.set('simulateNoServer', '1');
        if (opts?.profile) q.set('profile', opts.profile);
        const suffix = q.toString() ? `?${q}` : '';
        const data = await api<PlanPayload>(`/projects/${params.id}/server-plan${suffix}`);
        setPlan(data);
        setSimulateNoServer(Boolean(opts?.simulateNoServer));
        try {
          const listed = await api<{
            resources: Array<{
              cloudResourceId: string;
              status: string;
              phaseLabel?: string;
              failedPhaseLabel?: string | null;
              failedOperation?: string | null;
              serverReadinessLabel?: string;
              publicIp?: string | null;
              billingNotice?: string | null;
              errorMessage?: string | null;
              productSteps?: Array<{ label: string; reached: boolean; failed: boolean }>;
              serverInstanceId?: string | null;
            }>;
          }>(`/projects/${params.id}/server/provisions`);
          const latest = listed.resources?.[0];
          if (latest) setProvisionStatus(latest);
          try {
            const init = await api<{
              found?: boolean;
              serverInstanceId?: string | null;
              serverReadiness?: string | null;
              serverReadinessLabel?: string | null;
              phaseLabel?: string | null;
              progress?: number;
              productSteps?: Array<{ label: string; reached: boolean; failed: boolean }>;
              errorMessage?: string | null;
              retryActionLabel?: string | null;
              runtimeType?: string | null;
              osName?: string | null;
              publicIp?: string | null;
            }>(`/projects/${params.id}/server/initialization`);
            if (init?.found) setInitStatus(init);
          } catch {
            // init status optional
          }
        } catch {
          // provision list is optional on this page
        }
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          clearAccessToken();
          router.replace('/login');
          return;
        }
        setError(err instanceof Error ? err.message : '加载失败');
      }
    },
    [params.id, router],
  );

  useEffect(() => {
    void load();
  }, [load]);

  async function selectProfile(profile: string) {
    if (!plan?.canEdit) return;
    setBusy(true);
    try {
      const data = await api<PlanPayload>(`/projects/${params.id}/server-plan`, {
        method: 'POST',
        body: JSON.stringify({
          profile,
          simulateNoServer,
          source: simulateNoServer || !plan.existingServer ? 'MANAGED_CREATE' : plan.source,
        }),
      });
      setPlan(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  async function chooseExisting(serverId: string) {
    setBusy(true);
    try {
      const data = await api<PlanPayload>(`/projects/${params.id}/server-plan`, {
        method: 'POST',
        body: JSON.stringify({
          source: 'EXISTING',
          existingServerId: serverId,
          simulateNoServer: false,
        }),
      });
      setPlan(data);
      setSimulateNoServer(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '选择失败');
    } finally {
      setBusy(false);
    }
  }

  async function chooseManaged() {
    setBusy(true);
    try {
      const data = await api<PlanPayload>(`/projects/${params.id}/server-plan`, {
        method: 'POST',
        body: JSON.stringify({
          source: 'MANAGED_CREATE',
          simulateNoServer: true,
          profile: plan?.recommendation.profile,
        }),
      });
      setPlan(data);
      setSimulateNoServer(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : '规划失败');
    } finally {
      setBusy(false);
    }
  }

  async function startProvision() {
    if (!confirmBilling) {
      setError('请先确认将在阿里云产生费用');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await api<{
        cloudResourceId: string;
        phaseLabel?: string;
        serverReadinessLabel?: string;
        publicIp?: string | null;
        billingNotice?: string | null;
      }>(`/projects/${params.id}/server/provision`, {
        method: 'POST',
        body: JSON.stringify({
          source: 'MANAGED_CREATE',
          profile: plan?.recommendation.profile || 'STANDARD',
          confirmBilling: true,
        }),
      });
      setProvisionStatus(created);
      const id = created.cloudResourceId;
      for (let i = 0; i < 60; i += 1) {
        await new Promise((r) => setTimeout(r, 5000));
        const st = await api<{
          status: string;
          phaseLabel?: string;
          serverReadinessLabel?: string;
          publicIp?: string | null;
          billingNotice?: string | null;
          cloudResourceId: string;
          serverInstanceId?: string | null;
        }>(`/projects/${params.id}/server/provisions/${id}`);
        setProvisionStatus(st);
        if (st.status === 'RUNNING' || st.status === 'FAILED') break;
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
    } finally {
      setBusy(false);
    }
  }

  async function startInitialize() {
    const serverInstanceId =
      initStatus?.serverInstanceId ||
      provisionStatus?.serverInstanceId ||
      null;
    if (!serverInstanceId) {
      setError('未找到可初始化的服务器实例');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const started = await api<{
        alreadyReady?: boolean;
        alreadyInProgress?: boolean;
        serverInstanceId: string;
        serverReadinessLabel?: string;
        phaseLabel?: string;
        progress?: number;
      }>(`/projects/${params.id}/server/initialize`, {
        method: 'POST',
        body: JSON.stringify({ serverInstanceId }),
      });
      setInitStatus({
        serverInstanceId: started.serverInstanceId,
        serverReadinessLabel: started.serverReadinessLabel,
        phaseLabel: started.phaseLabel,
        progress: started.progress,
      });
      for (let i = 0; i < 90; i += 1) {
        await new Promise((r) => setTimeout(r, 4000));
        const st = await api<{
          serverInstanceId?: string | null;
          serverReadiness?: string | null;
          serverReadinessLabel?: string | null;
          phaseLabel?: string | null;
          progress?: number;
          productSteps?: Array<{ label: string; reached: boolean; failed: boolean }>;
          errorMessage?: string | null;
          retryActionLabel?: string | null;
          runtimeType?: string | null;
          osName?: string | null;
          publicIp?: string | null;
        }>(`/projects/${params.id}/server/initialization/${serverInstanceId}`);
        setInitStatus(st);
        if (
          st.serverReadiness === 'READY' ||
          st.serverReadiness === 'INITIALIZATION_FAILED'
        ) {
          break;
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '初始化失败');
    } finally {
      setBusy(false);
    }
  }

  const showInitPanel =
    Boolean(initStatus?.serverInstanceId) ||
    provisionStatus?.serverReadinessLabel?.includes('等待初始化') ||
    provisionStatus?.status === 'RUNNING';

  if (!plan && !error) {
    return (
      <main className="min-h-screen bg-zinc-50 px-6 py-10">
        <div className="mx-auto max-w-3xl">
          <ProductNav />
          <p className="mt-8 text-zinc-600">正在加载运行服务器规划…</p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <ProductNav />
        <div>
          <Link className="text-sm text-zinc-500" href={`/projects/${params.id}`}>
            ← 返回应用
          </Link>
          <h1 className="mt-2 text-3xl font-semibold text-zinc-900">运行服务器</h1>
          <p className="mt-1 text-sm text-zinc-500">
            {plan?.needServer
              ? '这个应用需要一台运行服务器。'
              : '当前应用不需要单独准备运行服务器。'}
          </p>
        </div>

        {error ? <p className="text-sm text-red-600">{error}</p> : null}

        {plan?.existingServer && !plan.simulatedNoServer ? (
          <section className="rounded-2xl border border-zinc-200 bg-white p-5">
            <h2 className="text-base font-semibold text-zinc-900">已有服务器</h2>
            <p className="mt-2 text-sm text-zinc-700">
              {plan.existingServer.name} · {plan.existingServer.host} · {plan.readinessLabel}
            </p>
            {plan.existingServer.evaluation ? (
              <p className="mt-2 text-sm text-zinc-600">
                {plan.existingServer.evaluation.fitLabel}：{plan.existingServer.evaluation.reason}
              </p>
            ) : null}
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                disabled={busy}
                className="rounded-lg border border-zinc-200 px-3 py-2 text-sm"
                onClick={() => void chooseManaged()}
              >
                LaunchOS 帮我准备
              </button>
              <Link
                href="/servers"
                className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-700"
              >
                管理已有服务器
              </Link>
            </div>
          </section>
        ) : null}

        {plan?.needServer ? (
          <section className="rounded-2xl border border-zinc-200 bg-white p-5">
            <h2 className="text-base font-semibold text-zinc-900">
              {plan.existingServer && !plan.simulatedNoServer ? '推荐参考' : '还没有运行服务器'}
            </h2>
            <p className="mt-2 text-sm text-zinc-700">{plan.recommendation.reason}</p>
            <p className="mt-3 text-sm text-zinc-800">
              LaunchOS 推荐：{plan.recommendation.profileLabel} · {plan.recommendation.vcpu} 核{' '}
              {plan.recommendation.memoryGb}GB · {plan.recommendation.regionId}
            </p>
            <p className="mt-1 text-sm text-zinc-600">
              预计费用：
              {plan.recommendation.priceEstimate?.available
                ? `${formatMoney(
                    plan.recommendation.priceEstimate.currency,
                    plan.recommendation.priceEstimate.hourlyPrice,
                  )}/小时 · 约 ${formatMoney(
                    plan.recommendation.priceEstimate.currency,
                    plan.recommendation.priceEstimate.monthlyEquivalent,
                  )}/月`
                : '暂无法询价'}
            </p>
            <p className="mt-1 text-sm text-zinc-600">
              运行系统：{plan.recommendation.osLabel}（{plan.recommendation.osName}）
            </p>
            <p className="mt-1 text-sm text-zinc-600">
              计费方式：{plan.recommendation.chargeTypeLabel} · {plan.recommendation.deployModeLabel}
            </p>
            <p className="mt-1 text-xs text-zinc-500">{plan.recommendation.regionReason}</p>

            <div className="mt-5 grid gap-3 sm:grid-cols-3">
              {plan.tiers.map((tier) => (
                <button
                  key={tier.profile}
                  type="button"
                  disabled={busy || !plan.canEdit}
                  onClick={() => void selectProfile(tier.profile)}
                  className={`rounded-xl border px-3 py-3 text-left ${
                    tier.recommended
                      ? 'border-zinc-900 bg-zinc-50'
                      : 'border-zinc-200 bg-white'
                  }`}
                >
                  <p className="text-sm font-medium text-zinc-900">
                    {tier.label}
                    {tier.recommended ? ' · 推荐' : ''}
                  </p>
                  <p className="mt-1 text-xs text-zinc-600">
                    {tier.vcpu} 核 {tier.memoryGb}GB
                  </p>
                  <p className="mt-2 text-xs text-zinc-700">
                    {tier.priceEstimate?.available
                      ? `${formatMoney(tier.priceEstimate.currency, tier.priceEstimate.hourlyPrice)}/小时`
                      : tier.unavailableReason || '暂无报价'}
                  </p>
                </button>
              ))}
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              {plan.existingServers.length > 0 ? (
                <button
                  type="button"
                  disabled={busy}
                  className="rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white"
                  onClick={() => void chooseExisting(plan.existingServers[0]!.id)}
                >
                  使用已有服务器
                </button>
              ) : (
                <Link
                  href="/servers"
                  className="rounded-lg border border-zinc-200 px-3 py-2 text-sm text-zinc-700"
                >
                  使用已有服务器
                </Link>
              )}
              <button
                type="button"
                disabled={busy}
                className="rounded-lg border border-zinc-200 px-3 py-2 text-sm"
                onClick={() => void chooseManaged()}
              >
                LaunchOS 帮我准备
              </button>
            </div>

            <label className="mt-4 flex items-start gap-2 text-sm text-zinc-700">
              <input
                type="checkbox"
                className="mt-1"
                checked={confirmBilling}
                onChange={(e) => setConfirmBilling(e.target.checked)}
              />
              <span>
                我确认将在阿里云账号创建按量付费云服务器，并了解实际费用以阿里云账单为准。
              </span>
            </label>
            <button
              type="button"
              disabled={busy || !confirmBilling || !plan.canEdit}
              className="mt-3 rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-50"
              onClick={() => void startProvision()}
            >
              {busy ? '提交中…' : '确认并创建服务器'}
            </button>
            {provisionStatus ? (
              <div className="mt-3 space-y-2 text-sm text-zinc-700">
                {provisionStatus.productSteps && provisionStatus.productSteps.length > 0 ? (
                  <ol className="space-y-1">
                    {provisionStatus.productSteps.map((step) => (
                      <li key={step.label}>
                        {step.failed ? '✕' : step.reached ? '✓' : '○'} {step.label}
                        {step.failed ? '（失败）' : ''}
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p>
                    状态：{provisionStatus.serverReadinessLabel || provisionStatus.phaseLabel}
                  </p>
                )}
                {provisionStatus.errorMessage ? (
                  <p className="text-amber-800">{provisionStatus.errorMessage}</p>
                ) : null}
                {provisionStatus.publicIp ? <p>公网地址：{provisionStatus.publicIp}</p> : null}
                {provisionStatus.billingNotice ? (
                  <p className="text-amber-800">{provisionStatus.billingNotice}</p>
                ) : null}
              </div>
            ) : null}

            {showInitPanel ? (
              <div className="mt-5 rounded-xl border border-zinc-100 bg-zinc-50 p-4">
                <h3 className="text-sm font-semibold text-zinc-900">服务器初始化</h3>
                <p className="mt-1 text-sm text-zinc-600">
                  {initStatus?.serverReadiness === 'READY'
                    ? '服务器已就绪，可以开始部署应用'
                    : initStatus?.serverReadinessLabel ||
                      provisionStatus?.serverReadinessLabel ||
                      '服务器已创建，等待初始化'}
                </p>
                {initStatus?.productSteps && initStatus.productSteps.length > 0 ? (
                  <ol className="mt-3 space-y-1 text-sm text-zinc-700">
                    {initStatus.productSteps.map((step) => (
                      <li key={step.label}>
                        {step.failed ? '✕' : step.reached ? '✓' : '○'} {step.label}
                      </li>
                    ))}
                  </ol>
                ) : null}
                {initStatus?.serverReadiness === 'READY' ? (
                  <div className="mt-3 space-y-1 text-sm text-zinc-700">
                    {initStatus.osName ? <p>系统：{initStatus.osName}</p> : null}
                    {initStatus.runtimeType ? (
                      <p>运行环境：{initStatus.runtimeType === 'podman' ? 'Podman' : initStatus.runtimeType}</p>
                    ) : null}
                    {initStatus.publicIp ? <p>公网 IP：{initStatus.publicIp}</p> : null}
                    <p>状态：可部署应用</p>
                  </div>
                ) : null}
                {initStatus?.errorMessage ? (
                  <p className="mt-2 text-sm text-amber-800">{initStatus.errorMessage}</p>
                ) : null}
                {initStatus?.serverReadiness !== 'READY' &&
                initStatus?.serverReadiness !== 'INITIALIZING' ? (
                  <button
                    type="button"
                    disabled={busy || !plan.canEdit}
                    className="mt-3 rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-50"
                    onClick={() => void startInitialize()}
                  >
                    {busy
                      ? '初始化中…'
                      : initStatus?.retryActionLabel || '初始化服务器'}
                  </button>
                ) : null}
              </div>
            ) : null}

            <p className="mt-4 text-xs text-amber-800">
              确认创建后将在你的阿里云账号开通按量付费 ECS。不会自动安装运行时软件。
            </p>
            {plan.notices.map((n) => (
              <p key={n} className="mt-1 text-xs text-zinc-500">
                {n}
              </p>
            ))}
            <p className="mt-2 text-xs text-zinc-500">{plan.billingReadiness.message}</p>
          </section>
        ) : null}

        <section className="rounded-2xl border border-zinc-200 bg-white p-5">
          <button
            type="button"
            className="text-sm font-medium text-zinc-800"
            onClick={() => setShowAdvanced((v) => !v)}
          >
            {showAdvanced ? '收起高级信息' : '高级信息'}
          </button>
          {showAdvanced && plan ? (
            <div className="mt-3 space-y-2 text-xs text-zinc-600">
              <p>地域：{plan.placement.regionId}</p>
              <p>{plan.placement.placementReason}</p>
              <p>{plan.placement.securityGroupPlan.note}</p>
              <p>公网访问：{plan.placement.publicIpRequired ? '需要' : '不需要'}</p>
              {plan.tiers
                .filter((t) => t.sku)
                .map((t) => (
                  <p key={t.profile}>
                    {t.label} SKU：{t.sku!.instanceType}（{t.sku!.selectionReason}）
                  </p>
                ))}
            </div>
          ) : null}
        </section>
      </div>
    </main>
  );
}
