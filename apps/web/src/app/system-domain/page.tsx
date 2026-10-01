'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { ProductNav } from '@/components/product-nav';
import { api, ApiError } from '@/lib/api';
import { clearAccessToken, getAccessToken } from '@/lib/auth';
import { isWorkspaceAdmin } from '@/lib/workspace-role';
import type { ProviderAccount, SystemDnsProviderConfig, WorkspaceSummary } from '@/lib/types';

type ActionKey = 'verify' | 'txt' | 'enable' | 'dryRun';
type ActionPhase = 'idle' | 'loading' | 'success' | 'error';

type ActionUiState = {
  phase: ActionPhase;
  title: string;
  summary: string;
  detail?: string;
  bullets?: string[];
};

type StepResult = {
  ok: boolean;
  message: string;
  detail?: string;
  steps?: Array<{ step: string; ok: boolean; message: string }>;
};

const ACTION_LABELS: Record<
  ActionKey,
  { idle: string; loading: string; success: string; failTitle: string; failHint: string }
> = {
  verify: {
    idle: '验证 DNS 凭证',
    loading: '正在验证 DNS…',
    success: 'DNS 凭证验证通过',
    failTitle: 'DNS 凭证验证失败',
    failHint: '无法完成只读 DNS 查询。',
  },
  txt: {
    idle: '测试 DNS 写入',
    loading: '正在测试 TXT…',
    success: 'TXT 创建、验证和清理完成',
    failTitle: 'DNS 写入测试失败',
    failHint: '无法创建或清理临时 TXT 记录。',
  },
  enable: {
    idle: '开启自动续期',
    loading: '正在开启自动续期…',
    success: '自动 DNS 续期已开启',
    failTitle: '开启自动续期失败',
    failHint: '请确认前两步已全部通过。',
  },
  dryRun: {
    idle: '测试续期流程',
    loading: '正在执行续期检查…',
    success: '续期流程测试通过',
    failTitle: '续期流程测试失败',
    failHint: 'dryRun 检查未通过。',
  },
};

const DRY_RUN_HINT_STEPS = [
  '检查 DNS Provider',
  '创建测试 TXT',
  '等待公网 DNS 生效',
  '删除测试 TXT',
  '检查 ACME 工具',
  '检查证书目录',
  '检查 Nginx 配置',
];

const INITIAL_ACTIONS: Record<ActionKey, ActionUiState> = {
  verify: { phase: 'idle', title: '', summary: '' },
  txt: { phase: 'idle', title: '', summary: '' },
  enable: { phase: 'idle', title: '', summary: '' },
  dryRun: { phase: 'idle', title: '', summary: '' },
};

function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent"
    />
  );
}

function formatDryRunBullets(message: string): string[] {
  const bullets: string[] = [];
  if (/DNS Provider/i.test(message)) bullets.push('DNS Provider 可用');
  if (/challenge|TXT/i.test(message)) bullets.push('DNS challenge 创建/删除成功');
  if (/ACME/i.test(message)) bullets.push('ACME 工具正常');
  if (/证书目录/i.test(message)) bullets.push('证书目录可访问');
  if (/Nginx/i.test(message)) bullets.push('Nginx 配置正常');
  bullets.push('未替换生产证书。');
  return bullets;
}

function stepLabel(step: string): string {
  switch (step) {
    case 'create':
      return '创建测试 TXT';
    case 'doh':
      return '公网确认 TXT 生效';
    case 'find':
      return '确认 recordId';
    case 'delete':
      return '按 recordId 删除';
    case 'doh-gone':
      return '公网确认 TXT 消失';
    default:
      return step;
  }
}

export default function SystemDomainPage() {
  const router = useRouter();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [config, setConfig] = useState<SystemDnsProviderConfig | null>(null);
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [showTech, setShowTech] = useState(false);
  const [actions, setActions] = useState(INITIAL_ACTIONS);
  const [activeAction, setActiveAction] = useState<ActionKey | null>(null);
  const [form, setForm] = useState({
    label: '系统 DNS（zsaos.com）',
    accessKey: '',
    secretKey: '',
  });
  const inFlight = useRef<Partial<Record<ActionKey, boolean>>>({});

  async function loadAll(): Promise<void> {
    const [dnsConfig, accountList] = await Promise.all([
      api<SystemDnsProviderConfig>('/system-domain/dns-provider'),
      api<ProviderAccount[]>('/provider-accounts'),
    ]);
    setConfig(dnsConfig);
    setAccounts(accountList.filter((item) => item.provider.type === 'ALIYUN_DNS'));
  }

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }
    let cancelled = false;

    async function load(): Promise<void> {
      try {
        const workspaces = await api<WorkspaceSummary[]>('/workspaces');
        if (!isWorkspaceAdmin(workspaces[0]?.role)) {
          if (!cancelled) setAllowed(false);
          return;
        }
        if (!cancelled) setAllowed(true);

        const [dnsConfig, accountList] = await Promise.all([
          api<SystemDnsProviderConfig>('/system-domain/dns-provider'),
          api<ProviderAccount[]>('/provider-accounts'),
        ]);
        if (cancelled) return;
        setConfig(dnsConfig);
        setAccounts(accountList.filter((item) => item.provider.type === 'ALIYUN_DNS'));
      } catch (err: unknown) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 403) {
          setAllowed(false);
          return;
        }
        if (err instanceof ApiError && err.status === 401) {
          clearAccessToken();
          router.replace('/login');
          return;
        }
        setError(err instanceof Error ? err.message : '加载失败');
        setAllowed(true);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [router]);

  function setActionLoading(key: ActionKey): void {
    const labels = ACTION_LABELS[key];
    setActiveAction(key);
    setShowTech(false);
    setError(null);
    setActions((current) => ({
      ...current,
      [key]: {
        phase: 'loading',
        title: labels.loading,
        summary: '正在执行，请稍候…',
        bullets: key === 'dryRun' ? DRY_RUN_HINT_STEPS.map((s, i) => `${i + 1}. ${s}`) : undefined,
      },
    }));
  }

  function setActionSuccess(key: ActionKey, summary: string, bullets?: string[]): void {
    const labels = ACTION_LABELS[key];
    setActions((current) => ({
      ...current,
      [key]: {
        phase: 'success',
        title: labels.success,
        summary,
        bullets,
      },
    }));
    setActiveAction(key);
  }

  function setActionError(key: ActionKey, summary: string, detail?: string): void {
    const labels = ACTION_LABELS[key];
    setActions((current) => ({
      ...current,
      [key]: {
        phase: 'error',
        title: labels.failTitle,
        summary: summary || labels.failHint,
        detail,
      },
    }));
    setActiveAction(key);
  }

  async function runGuarded(key: ActionKey, work: () => Promise<void>): Promise<void> {
    if (inFlight.current[key]) return;
    inFlight.current[key] = true;
    setActionLoading(key);
    try {
      await work();
    } finally {
      inFlight.current[key] = false;
    }
  }

  async function createDnsAccount(): Promise<void> {
    setPending(true);
    setError(null);
    try {
      await api<ProviderAccount>('/provider-accounts', {
        method: 'POST',
        body: JSON.stringify({
          providerType: 'ALIYUN_DNS',
          label: form.label.trim(),
          region: 'cn-hangzhou',
          accessKey: form.accessKey.trim(),
          secretKey: form.secretKey,
        }),
      });
      setForm((current) => ({ ...current, accessKey: '', secretKey: '' }));
      await loadAll();
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败');
    } finally {
      setPending(false);
    }
  }

  async function bindAccount(accountId: string): Promise<void> {
    setPending(true);
    setError(null);
    try {
      const result = await api<SystemDnsProviderConfig>('/system-domain/dns-provider/bind', {
        method: 'POST',
        body: JSON.stringify({ providerAccountId: accountId }),
      });
      setConfig(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : '绑定失败');
    } finally {
      setPending(false);
    }
  }

  async function verifyCredentials(): Promise<void> {
    await runGuarded('verify', async () => {
      try {
        const result = await api<StepResult>('/system-domain/dns-provider/verify', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        if (!result.ok) {
          setActionError('verify', result.message || ACTION_LABELS.verify.failHint, result.detail);
          await loadAll();
          return;
        }
        setActionSuccess('verify', result.message || '只读 DNS 查询成功。');
        await loadAll();
      } catch (err) {
        setActionError(
          'verify',
          err instanceof Error ? err.message : ACTION_LABELS.verify.failHint,
        );
      }
    });
  }

  async function runTxtTest(): Promise<void> {
    await runGuarded('txt', async () => {
      try {
        const result = await api<StepResult>('/system-domain/dns-provider/txt-test', {
          method: 'POST',
          body: JSON.stringify({}),
        });
        if (!result.ok) {
          setActionError(
            'txt',
            result.message || ACTION_LABELS.txt.failHint,
            result.detail || result.steps?.find((s) => !s.ok)?.message,
          );
          await loadAll();
          return;
        }
        setActionSuccess(
          'txt',
          result.message || '临时 TXT 已创建、公网确认并清理。',
          result.steps?.map((s) => `${s.ok ? '✓' : '×'} ${stepLabel(s.step)}：${s.message}`),
        );
        await loadAll();
      } catch (err) {
        setActionError('txt', err instanceof Error ? err.message : ACTION_LABELS.txt.failHint);
      }
    });
  }

  async function enableAutomatic(): Promise<void> {
    await runGuarded('enable', async () => {
      try {
        const result = await api<SystemDnsProviderConfig>(
          '/system-domain/dns-provider/enable-automatic',
          {
            method: 'POST',
            body: JSON.stringify({}),
          },
        );
        setConfig(result);
        setActionSuccess('enable', '证书续期模式已切换为自动 DNS。');
      } catch (err) {
        setActionError(
          'enable',
          err instanceof Error ? err.message : ACTION_LABELS.enable.failHint,
        );
      }
    });
  }

  async function dryRunRenew(): Promise<void> {
    await runGuarded('dryRun', async () => {
      try {
        const result = await api<{ message: string; status: string }>(
          '/system-domain/certificate/renew',
          {
            method: 'POST',
            body: JSON.stringify({ dryRun: true }),
          },
        );
        setActionSuccess('dryRun', result.message, formatDryRunBullets(result.message));
      } catch (err) {
        setActionError(
          'dryRun',
          err instanceof Error ? err.message : ACTION_LABELS.dryRun.failHint,
        );
      }
    });
  }

  if (allowed === false) {
    return (
      <main className="min-h-screen bg-zinc-50 px-6 py-10">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
          <ProductNav />
          <section className="rounded-xl border border-amber-200 bg-amber-50 p-6">
            <h1 className="text-xl font-semibold text-amber-950">无权限</h1>
            <p className="mt-2 text-sm text-amber-900">
              系统域名与 HTTPS 仅工作区管理员（OWNER / ADMIN）可访问。
            </p>
            <Link
              className="mt-4 inline-flex rounded-lg bg-zinc-900 px-4 py-2 text-sm text-white"
              href="/dashboard"
            >
              返回工作台
            </Link>
          </section>
        </div>
      </main>
    );
  }

  if (!config || allowed === null) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-50 text-sm text-zinc-500">
        {error ?? '加载中…'}
      </main>
    );
  }

  const bound = config.providerAccount;
  const dnsVerified = Boolean(config.dnsProviderVerifiedAt);
  const txtPassed = Boolean(config.dnsProviderTxtTestAt);
  const automaticOn = config.renewalMode === 'AUTOMATIC_DNS';
  const anyActionLoading = Object.values(actions).some((a) => a.phase === 'loading');

  const canVerify =
    Boolean(config.dnsProviderAccountId) && actions.verify.phase !== 'loading' && !anyActionLoading;
  const canTxt =
    dnsVerified && actions.txt.phase !== 'loading' && !anyActionLoading;
  const canEnable =
    !automaticOn &&
    config.canEnableAutomatic &&
    txtPassed &&
    actions.enable.phase !== 'loading' &&
    !anyActionLoading;
  const canDryRun =
    automaticOn && actions.dryRun.phase !== 'loading' && !anyActionLoading;

  const latest = activeAction ? actions[activeAction] : null;

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <ProductNav />
        <nav className="text-sm text-zinc-500">
          <Link className="hover:text-zinc-800" href="/settings">
            系统设置
          </Link>
          <span className="mx-2">›</span>
          <span className="text-zinc-800">系统域名与 HTTPS</span>
        </nav>
        <div>
          <h1 className="text-3xl font-semibold text-zinc-900">系统域名与 HTTPS</h1>
          <p className="mt-2 text-sm text-zinc-600">
            管理 LaunchOS 系统域名、DNS 验证和 HTTPS 自动续期。
          </p>
        </div>

        {error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        <section className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-medium text-zinc-900">1. 添加 DNS 凭证</h2>
          <p className="mt-1 text-sm text-zinc-500">
            仅用于系统域名 {config.rootDomain} 的 DNS 自动验证与证书续期。Secret 加密保存且不可再次查看。
          </p>
          <div className="mt-4 grid gap-3">
            <label className="text-sm">
              名称
              <input
                className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2"
                value={form.label}
                onChange={(e) => setForm((c) => ({ ...c, label: e.target.value }))}
              />
            </label>
            <label className="text-sm">
              AccessKey ID
              <input
                className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-mono"
                autoComplete="off"
                value={form.accessKey}
                onChange={(e) => setForm((c) => ({ ...c, accessKey: e.target.value }))}
              />
            </label>
            <label className="text-sm">
              AccessKey Secret
              <input
                className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 font-mono"
                type="password"
                autoComplete="new-password"
                value={form.secretKey}
                onChange={(e) => setForm((c) => ({ ...c, secretKey: e.target.value }))}
              />
            </label>
            <button
              className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
              type="button"
              disabled={pending || anyActionLoading || !form.accessKey.trim() || !form.secretKey}
              onClick={() => void createDnsAccount()}
            >
              保存凭证
            </button>
          </div>
        </section>

        <section className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-medium text-zinc-900">2. 绑定到系统域名</h2>
          {accounts.length === 0 ? (
            <p className="mt-2 text-sm text-zinc-500">暂无可用 DNS 账户</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {accounts.map((account) => (
                <li
                  key={account.id}
                  className="flex items-center justify-between rounded-lg border border-zinc-100 px-3 py-2 text-sm"
                >
                  <div>
                    <div className="font-medium">{account.label || account.provider.name}</div>
                    <div className="text-zinc-500">
                      {account.accessKeyMasked ?? '—'} ·{' '}
                      {account.status === 'VERIFIED'
                        ? '验证通过'
                        : account.status === 'FAILED'
                          ? '验证失败'
                          : account.status === 'PENDING'
                            ? '待验证'
                            : account.status}
                    </div>
                  </div>
                  <button
                    className="rounded-lg border border-zinc-300 px-3 py-1 text-xs disabled:opacity-60"
                    type="button"
                    disabled={
                      pending || anyActionLoading || config.dnsProviderAccountId === account.id
                    }
                    onClick={() => void bindAccount(account.id)}
                  >
                    {config.dnsProviderAccountId === account.id ? '已绑定' : '绑定'}
                  </button>
                </li>
              ))}
            </ul>
          )}
          {bound ? (
            <p className="mt-3 text-sm text-zinc-600">
              当前绑定：{bound.label || bound.providerType} · {bound.accessKeyMasked} · Secret{' '}
              {bound.secretMasked}
            </p>
          ) : null}
        </section>

        <section className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-medium text-zinc-900">3–6. 验证与启用</h2>
          <p className="mt-1 text-sm text-zinc-500">按顺序完成：验证凭证 → 测试写入 → 开启自动续期 → 测试续期流程。</p>

          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            <button
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-zinc-300 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
              type="button"
              disabled={!canVerify}
              onClick={() => void verifyCredentials()}
            >
              {actions.verify.phase === 'loading' ? <Spinner /> : null}
              {actions.verify.phase === 'loading'
                ? ACTION_LABELS.verify.loading
                : ACTION_LABELS.verify.idle}
            </button>

            <button
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-zinc-300 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
              type="button"
              disabled={!canTxt}
              title={!dnsVerified ? '请先完成上一步' : undefined}
              onClick={() => void runTxtTest()}
            >
              {actions.txt.phase === 'loading' ? <Spinner /> : null}
              {actions.txt.phase === 'loading' ? ACTION_LABELS.txt.loading : ACTION_LABELS.txt.idle}
            </button>

            {automaticOn ? (
              <div className="inline-flex items-center justify-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-800">
                ✓ 自动续期已开启
              </div>
            ) : (
              <button
                className="inline-flex items-center justify-center gap-2 rounded-lg bg-emerald-700 px-3 py-2 text-sm text-white disabled:cursor-not-allowed disabled:opacity-50"
                type="button"
                disabled={!canEnable}
                title={!txtPassed ? '请先完成上一步' : undefined}
                onClick={() => void enableAutomatic()}
              >
                {actions.enable.phase === 'loading' ? <Spinner /> : null}
                {actions.enable.phase === 'loading'
                  ? ACTION_LABELS.enable.loading
                  : ACTION_LABELS.enable.idle}
              </button>
            )}

            <button
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-zinc-300 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-50"
              type="button"
              disabled={!canDryRun}
              title={!automaticOn ? '请先完成上一步' : undefined}
              onClick={() => void dryRunRenew()}
            >
              {actions.dryRun.phase === 'loading' ? <Spinner /> : null}
              {actions.dryRun.phase === 'loading'
                ? ACTION_LABELS.dryRun.loading
                : ACTION_LABELS.dryRun.idle}
            </button>
          </div>

          {!config.dnsProviderAccountId ? (
            <p className="mt-2 text-xs text-amber-700">请先绑定 DNS 账户后再验证。</p>
          ) : !dnsVerified ? (
            <p className="mt-2 text-xs text-zinc-500">请先完成上一步：验证 DNS 凭证。</p>
          ) : !txtPassed ? (
            <p className="mt-2 text-xs text-zinc-500">请先完成上一步：测试 DNS 写入。</p>
          ) : !automaticOn ? (
            <p className="mt-2 text-xs text-zinc-500">请先完成上一步：开启自动续期。</p>
          ) : null}

          {latest?.phase === 'loading' ? (
            <div className="mt-4 rounded-lg border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
              <div className="flex items-center gap-2 font-medium">
                <Spinner />
                {latest.title}
              </div>
              <p className="mt-1 text-sky-800">{latest.summary}</p>
              {latest.bullets?.length ? (
                <ol className="mt-2 list-decimal space-y-1 pl-5 text-sky-800">
                  {latest.bullets.map((item) => (
                    <li key={item}>{item.replace(/^\d+\.\s*/, '')}</li>
                  ))}
                </ol>
              ) : null}
              <p className="mt-2 text-xs text-sky-700">无实时进度百分比，完成后会自动更新结果。</p>
            </div>
          ) : null}

          <ul className="mt-4 space-y-1 text-sm text-zinc-700">
            <li>DNS 凭证：{dnsVerified ? '验证通过' : '未验证'}</li>
            <li>DNS 写入测试：{txtPassed ? '测试通过' : '未测试'}</li>
            <li>证书自动续期：{automaticOn ? '已开启' : '未开启'}</li>
          </ul>

          {showTech ? (
            <pre className="mt-3 overflow-x-auto rounded bg-zinc-100 p-3 text-xs text-zinc-600">
              {`accountStatus=${bound?.status ?? 'n/a'}
renewalMode=${config.renewalMode}
verifiedAt=${config.dnsProviderVerifiedAt ?? 'null'}
txtTestAt=${config.dnsProviderTxtTestAt ?? 'null'}`}
            </pre>
          ) : null}
          <button
            className="mt-2 text-xs text-zinc-500 underline"
            type="button"
            onClick={() => setShowTech((v) => !v)}
          >
            {showTech ? '隐藏高级状态' : '显示高级状态'}
          </button>
        </section>

        {latest && latest.phase !== 'loading' && latest.phase !== 'idle' ? (
          <section
            className={`rounded-xl border p-5 shadow-sm ${
              latest.phase === 'success'
                ? 'border-emerald-200 bg-emerald-50'
                : 'border-red-200 bg-red-50'
            }`}
          >
            <h2
              className={`text-lg font-medium ${
                latest.phase === 'success' ? 'text-emerald-900' : 'text-red-900'
              }`}
            >
              最近一次操作
            </h2>
            <p
              className={`mt-2 text-sm font-medium ${
                latest.phase === 'success' ? 'text-emerald-800' : 'text-red-800'
              }`}
            >
              {latest.phase === 'success' ? `✅ ${latest.title}` : `操作失败 · ${latest.title}`}
            </p>
            <p
              className={`mt-1 text-sm ${
                latest.phase === 'success' ? 'text-emerald-800' : 'text-red-700'
              }`}
            >
              {latest.summary}
            </p>
            {latest.bullets?.length ? (
              <ul
                className={`mt-3 space-y-1 text-sm ${
                  latest.phase === 'success' ? 'text-emerald-800' : 'text-red-700'
                }`}
              >
                {latest.bullets.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            ) : null}
            {latest.phase === 'error' && latest.detail ? (
              <details className="mt-3">
                <summary className="cursor-pointer text-xs text-red-700 underline">
                  查看高级详情
                </summary>
                <pre className="mt-2 overflow-x-auto rounded bg-white/80 p-3 text-xs text-red-800">
                  {latest.detail}
                </pre>
              </details>
            ) : null}
          </section>
        ) : null}
      </div>
    </main>
  );
}
