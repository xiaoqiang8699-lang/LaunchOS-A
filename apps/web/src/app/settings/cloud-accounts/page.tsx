'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { ProductNav } from '@/components/product-nav';
import { api, ApiError } from '@/lib/api';
import { clearAccessToken, getAccessToken } from '@/lib/auth';
import { isWorkspaceAdmin } from '@/lib/workspace-role';
import type { ProviderAccount, WorkspaceSummary } from '@/lib/types';

type CapabilityLabel = {
  key: string;
  label: string;
  status: string;
  statusLabel: string;
};

type AliyunReadiness = {
  provider: string;
  credentialsConfigured: boolean;
  accountId: string | null;
  message?: string;
  rdsCreateBlocked?: boolean;
  labels: CapabilityLabel[];
  capabilities?: {
    rds?: { status?: string; missingCapabilities?: string[] };
    redis?: { status?: string; missingCapabilities?: string[]; actions?: Record<string, string> };
    billing?: { status?: string; missingCapabilities?: string[]; detail?: string };
  };
  BILLING_ORDER_PERMISSION?: string;
};

const STATUS_COLOR: Record<string, string> = {
  READY: 'text-emerald-700',
  MISSING_PERMISSION: 'text-amber-700',
  NOT_CONFIGURED: 'text-zinc-500',
  UNKNOWN: 'text-zinc-500',
};

export default function CloudAccountsSettingsPage() {
  const router = useRouter();
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<ProviderAccount[]>([]);
  const [readiness, setReadiness] = useState<AliyunReadiness | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showHelp, setShowHelp] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    accessKey: '',
    secretKey: '',
    region: 'cn-hangzhou',
    label: '阿里云云资源',
  });

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }
    let cancelled = false;

    async function bootstrap(): Promise<void> {
      try {
        const workspaces = await api<WorkspaceSummary[]>('/workspaces');
        if (!isWorkspaceAdmin(workspaces[0]?.role)) {
          if (!cancelled) setAllowed(false);
          return;
        }
        if (!cancelled) setAllowed(true);
        const [accountList, ready] = await Promise.all([
          api<ProviderAccount[]>('/provider-accounts'),
          api<AliyunReadiness>('/providers/aliyun/readiness'),
        ]);
        if (cancelled) return;
        setAccounts(accountList);
        setReadiness(ready);
      } catch (err) {
        if (cancelled) return;
        if (err instanceof ApiError && err.status === 401) {
          clearAccessToken();
          router.replace('/login');
          return;
        }
        if (err instanceof ApiError && err.status === 403) {
          setAllowed(false);
          return;
        }
        setError(err instanceof Error ? err.message : '加载失败');
        setAllowed(true);
      }
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [router]);

  const refresh = useCallback(async () => {
    const [accountList, ready] = await Promise.all([
      api<ProviderAccount[]>('/provider-accounts'),
      api<AliyunReadiness>('/providers/aliyun/readiness'),
    ]);
    setAccounts(accountList);
    setReadiness(ready);
  }, []);

  const aliyun = accounts.find((item) => item.provider.type === 'ALIYUN');
  const dns = accounts.find((item) => item.provider.type === 'ALIYUN_DNS');

  const labels: CapabilityLabel[] = (() => {
    const base = readiness?.labels?.length
      ? [...readiness.labels]
      : [
          { key: 'ecs', label: '云服务器', status: 'NOT_CONFIGURED', statusLabel: '未配置' },
          {
            key: 'rds',
            label: 'PostgreSQL 数据库',
            status: 'NOT_CONFIGURED',
            statusLabel: '未配置',
          },
          { key: 'redis', label: 'Redis', status: 'NOT_CONFIGURED', statusLabel: '未配置' },
        ];
    const dnsStatus =
      dns?.status === 'VERIFIED' || dns?.status === 'ACTIVE'
        ? { status: 'READY', statusLabel: '已就绪' }
        : dns
          ? { status: 'UNKNOWN', statusLabel: dns.status }
          : { status: 'NOT_CONFIGURED', statusLabel: '未配置' };
    const withoutDns = base.filter((item) => item.key !== 'dns');
    return [
      { key: 'dns', label: '域名与 DNS', ...dnsStatus },
      ...withoutDns.filter((item) => item.key !== 'vpc'),
    ];
  })();

  async function recheck(): Promise<void> {
    setBusy('recheck');
    setError(null);
    setFeedback(null);
    try {
      await refresh();
      setFeedback('权限检查已完成');
    } catch (err) {
      setError(err instanceof Error ? err.message : '检查失败');
    } finally {
      setBusy(null);
    }
  }

  async function saveCredentials(): Promise<void> {
    if (!form.accessKey.trim() || !form.secretKey.trim()) {
      setError('请填写 AccessKey ID 与 AccessKey Secret');
      return;
    }
    setBusy('save');
    setError(null);
    setFeedback(null);
    try {
      if (aliyun) {
        await api(`/provider-accounts/${aliyun.id}`, {
          method: 'PATCH',
          body: JSON.stringify({
            accessKey: form.accessKey.trim(),
            secretKey: form.secretKey.trim(),
            region: form.region.trim() || undefined,
            label: form.label.trim() || undefined,
          }),
        });
      } else {
        await api('/provider-accounts', {
          method: 'POST',
          body: JSON.stringify({
            providerType: 'ALIYUN',
            accessKey: form.accessKey.trim(),
            secretKey: form.secretKey.trim(),
            region: form.region.trim() || 'cn-hangzhou',
            label: form.label.trim() || '阿里云云资源',
          }),
        });
      }
      setForm((prev) => ({ ...prev, accessKey: '', secretKey: '' }));
      setShowForm(false);
      setFeedback('凭证已保存（Secret 不会回显）');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败');
    } finally {
      setBusy(null);
    }
  }

  if (allowed === null) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-50 text-sm text-zinc-500">
        加载中…
      </main>
    );
  }

  if (!allowed) {
    return (
      <main className="min-h-screen bg-zinc-50 px-6 py-10">
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
          <ProductNav />
          <section className="rounded-xl border border-amber-200 bg-amber-50 p-6">
            <h1 className="text-xl font-semibold text-amber-950">无权限</h1>
            <p className="mt-2 text-sm text-amber-900">云账号设置仅工作区管理员可访问。</p>
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

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
        <ProductNav />
        <div>
          <nav className="text-sm text-zinc-500">
            <Link className="hover:text-zinc-800" href="/settings">
              系统设置
            </Link>
            <span className="mx-2">›</span>
            <span className="text-zinc-800">云账号 / 云服务</span>
          </nav>
          <h1 className="mt-2 text-3xl font-semibold text-zinc-900">云账号 / 云服务</h1>
          <p className="mt-1 text-sm text-zinc-500">
            管理阿里云云资源账户权限。DNS 账户与云资源账户职责分离。
          </p>
        </div>

        {error ? (
          <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        ) : null}
        {feedback ? (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            {feedback}
          </div>
        ) : null}

        <section className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-medium text-zinc-900">阿里云</h2>
              <p className="mt-1 text-sm text-zinc-500">
                账号状态：
                {aliyun?.hasCredential
                  ? '已连接'
                  : readiness?.credentialsConfigured
                    ? '已连接'
                    : '未配置'}
              </p>
              {aliyun?.accessKeyMasked ? (
                <p className="mt-1 text-xs text-zinc-400">AccessKey：{aliyun.accessKeyMasked}</p>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-800 disabled:opacity-60"
                disabled={busy !== null}
                onClick={() => void recheck()}
              >
                {busy === 'recheck' ? '检查中…' : '重新检查权限'}
              </button>
              <button
                type="button"
                className="rounded-lg bg-zinc-900 px-3 py-1.5 text-sm text-white disabled:opacity-60"
                disabled={busy !== null}
                onClick={() => setShowForm((v) => !v)}
              >
                {aliyun ? '更新授权' : '添加云资源账户'}
              </button>
              <button
                type="button"
                className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-800"
                onClick={() => setShowHelp((v) => !v)}
              >
                查看需要的权限
              </button>
            </div>
          </div>

          <ul className="mt-5 space-y-3">
            {labels.map((item) => (
              <li
                key={item.key}
                className="flex items-center justify-between border-b border-zinc-100 pb-3 last:border-0 last:pb-0"
              >
                <span className="text-sm text-zinc-800">{item.label}</span>
                <span
                  className={`text-sm font-medium ${STATUS_COLOR[item.status] || 'text-zinc-600'}`}
                >
                  {item.statusLabel}
                </span>
              </li>
            ))}
          </ul>

          {readiness?.capabilities?.rds?.missingCapabilities?.length ? (
            <p className="mt-4 text-sm text-amber-800">
              缺失能力：{readiness.capabilities.rds.missingCapabilities.join('、')}
            </p>
          ) : null}
          {readiness?.capabilities?.billing?.missingCapabilities?.length ? (
            <p className="mt-2 text-sm text-amber-800">
              订单/支付：{readiness.capabilities.billing.missingCapabilities.join('、')}
              。建议授予 AliyunBSSOrderAccess（不要授予 AliyunBSSFullAccess）。
            </p>
          ) : null}
          {readiness?.BILLING_ORDER_PERMISSION === 'READY' &&
          readiness?.capabilities?.billing?.detail ? (
            <p className="mt-2 text-sm text-emerald-700">{readiness.capabilities.billing.detail}</p>
          ) : null}

          {dns ? (
            <p className="mt-4 text-xs text-zinc-500">
              DNS 账户（ALIYUN_DNS）独立管理，不会用于创建 RDS / ECS。可在
              <Link className="mx-1 underline" href="/system-domain">
                系统域名
              </Link>
              中维护。
            </p>
          ) : (
            <p className="mt-4 text-xs text-zinc-500">
              尚未配置 DNS 账户。域名解析请前往系统域名页面单独添加 ALIYUN_DNS。
            </p>
          )}
        </section>

        {showForm ? (
          <section className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
            <h3 className="text-base font-medium text-zinc-900">
              {aliyun ? '更新阿里云云资源凭证' : '添加阿里云云资源账户'}
            </h3>
            <p className="mt-1 text-sm text-zinc-500">
              请在 LaunchOS 本页填写。不要把 AccessKey / Secret 发到聊天或写入代码。
            </p>
            <div className="mt-4 grid gap-3">
              <label className="text-sm text-zinc-700">
                显示名称
                <input
                  className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2"
                  value={form.label}
                  onChange={(e) => setForm((prev) => ({ ...prev, label: e.target.value }))}
                />
              </label>
              <label className="text-sm text-zinc-700">
                默认地域
                <input
                  className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2"
                  value={form.region}
                  onChange={(e) => setForm((prev) => ({ ...prev, region: e.target.value }))}
                />
              </label>
              <label className="text-sm text-zinc-700">
                AccessKey ID
                <input
                  className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2"
                  autoComplete="off"
                  value={form.accessKey}
                  onChange={(e) => setForm((prev) => ({ ...prev, accessKey: e.target.value }))}
                />
              </label>
              <label className="text-sm text-zinc-700">
                AccessKey Secret
                <input
                  className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2"
                  type="password"
                  autoComplete="new-password"
                  value={form.secretKey}
                  onChange={(e) => setForm((prev) => ({ ...prev, secretKey: e.target.value }))}
                />
              </label>
              <button
                type="button"
                className="rounded-lg bg-zinc-900 px-3 py-2 text-sm text-white disabled:opacity-60"
                disabled={busy === 'save'}
                onClick={() => void saveCredentials()}
              >
                {busy === 'save' ? '保存中…' : '保存凭证'}
              </button>
            </div>
          </section>
        ) : null}

        {showHelp ? (
          <section className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
            <h3 className="text-base font-medium text-zinc-900">创建 PostgreSQL 需要的权限</h3>
            <p className="mt-2 text-sm text-zinc-600">
              不要授予 AdministratorAccess。建议为 LaunchOS 创建专用 RAM 用户，并按能力授权：
            </p>
            <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-zinc-700">
              <li>查看 RDS 可用规格</li>
              <li>创建 / 查询 / 删除 RDS</li>
              <li>创建数据库与数据库账号</li>
              <li>修改数据库账号权限</li>
              <li>配置访问白名单</li>
              <li>查询 VPC / VSwitch</li>
              <li>查询目标 ECS 网络信息</li>
            </ul>
            <p className="mt-3 text-sm text-zinc-500">
              详细 RAM Action 清单见仓库文档{' '}
              <code className="rounded bg-zinc-100 px-1">docs/aliyun-rds-permissions.md</code>
              ，可由{' '}
              <code className="rounded bg-zinc-100 px-1">
                node scripts/generate-aliyun-required-actions.mjs
              </code>{' '}
              根据 Provider 实际调用重新生成。
            </p>
          </section>
        ) : null}
      </div>
    </main>
  );
}
