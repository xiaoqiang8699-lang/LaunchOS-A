'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { FormEvent, useCallback, useEffect, useState } from 'react';
import { ControlCenter } from '@/components/control-center';
import { ProjectTabs } from '@/components/control-center/project-tabs';
import { InlineAlert, Skeleton } from '@/components/ui/feedback';
import { Card, PageHeader, Section } from '@/components/ui/section';
import { PrimaryButton, SecondaryLink } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { api, ApiError } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';
import { isBetaEntitlementSource } from '@/lib/plan-prices';
import type { AppSummary } from '@/lib/types';

type DomainRecordView = {
  id: string;
  domain: string;
  type: string;
  status: string;
  certificates?: Array<{ status: string; issuer?: string | null; expiresAt?: string | null }>;
};

type UsageEntitlements = {
  source?: string;
  override?: { reason?: string | null } | null;
  entitlements?: { customDomainEnabled?: boolean };
};

function dnsStatusLabel(status: string | null | undefined): string {
  switch (status) {
    case 'ACTIVE':
      return '已生效';
    case 'PENDING':
      return '等待解析';
    case 'FAILED':
      return '配置错误';
    default:
      return status || '验证中';
  }
}

function domainStatusLabel(status: string): string {
  switch (status) {
    case 'ACTIVE':
      return '已启用';
    case 'PENDING':
    case 'CREATING':
      return '验证中';
    case 'FAILED':
      return '配置错误';
    default:
      return status;
  }
}

export default function ProjectDomainsPage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const [app, setApp] = useState<AppSummary | null>(null);
  const [domains, setDomains] = useState<DomainRecordView[] | null>(null);
  const [customEnabled, setCustomEnabled] = useState(false);
  const [beta, setBeta] = useState(false);
  const [domainInput, setDomainInput] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);

  const load = useCallback(async () => {
    const [appDetail, domainList, usage] = await Promise.all([
      api<AppSummary>(`/apps/${params.id}`),
      api<DomainRecordView[]>(`/projects/${params.id}/domains`).catch(() => [] as DomainRecordView[]),
      api<UsageEntitlements>('/account/usage').catch(() => null),
    ]);
    setApp(appDetail);
    setDomains(domainList);
    setCustomEnabled(Boolean(usage?.entitlements?.customDomainEnabled));
    setBeta(isBetaEntitlementSource(usage?.source, usage?.override?.reason));
  }, [params.id]);

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }
    void load().catch((err: unknown) =>
      setError(err instanceof Error ? err.message : '加载失败'),
    );
  }, [load, router]);

  async function addDomain(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError('');
    setMessage('');
    const value = domainInput.trim().toLowerCase();
    if (!value) {
      setError('请输入域名，例如 www.example.com');
      return;
    }
    setPending(true);
    try {
      await api(`/projects/${params.id}/domains`, {
        method: 'POST',
        body: JSON.stringify({ domain: value, type: 'CUSTOM' }),
      });
      setDomainInput('');
      setMessage('已创建绑定。请按下方指引完成 DNS，验证通过后会启用 HTTPS。');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : '添加失败');
    } finally {
      setPending(false);
    }
  }

  const systemHost = app?.systemDomain || (app?.visitUrl ? app.visitUrl.replace(/^https?:\/\//, '') : null);
  const systemUrl = app?.visitUrl || (systemHost ? `https://${systemHost}` : null);
  const systemReady = Boolean(app?.visitUrlReady && systemUrl);
  const httpsOn = Boolean(systemUrl?.startsWith('https://') && (app?.dnsStatus === 'ACTIVE' || app?.visitUrlReady));
  const customDomains = (domains || []).filter((item) => item.type === 'CUSTOM');
  const activeCustom = customDomains.find((item) => item.status === 'ACTIVE');
  const primaryUrl = activeCustom
    ? `https://${activeCustom.domain}`
    : systemUrl;

  return (
    <ControlCenter>
      <nav className="mb-4 text-sm text-[var(--los-secondary)]">
        <Link className="hover:text-[var(--los-text)]" href="/projects">
          我的应用
        </Link>
        <span className="mx-2">›</span>
        <Link className="hover:text-[var(--los-text)]" href={`/projects/${params.id}`}>
          {app?.name || '应用'}
        </Link>
        <span className="mx-2">›</span>
        <span className="text-[var(--los-text)]">域名与访问</span>
      </nav>

      <ProjectTabs projectId={params.id} />

      <PageHeader
        title="域名与访问"
        description="管理公网访问地址。域名属于部署层配置，不需要写进代码。"
      />

      <InlineAlert
        className="mb-5"
        tone="info"
        title="你不需要把域名写进代码"
        description="在 LaunchOS 的「域名与访问」中绑定即可。重新上线会复用已有系统域名与自定义域名。"
      />

      {error ? <InlineAlert className="mb-4" tone="error" title={error} /> : null}
      {message ? <InlineAlert className="mb-4" tone="success" title={message} /> : null}

      {!app || domains == null ? (
        <Skeleton className="h-40" />
      ) : (
        <>
          <Section title="系统访问地址">
            <Card className="p-5 text-sm">
              {systemUrl ? (
                <>
                  <p className="break-all text-base font-medium">{systemUrl}</p>
                  <div className="mt-3 flex flex-wrap gap-3">
                    <span>
                      状态：
                      <StatusBadge
                        status={systemReady ? 'RUNNING' : 'READY'}
                        label={systemReady ? '正常' : dnsStatusLabel(app.dnsStatus)}
                      />
                    </span>
                    <span>HTTPS：{httpsOn ? '已启用' : '准备中'}</span>
                  </div>
                  <p className="mt-3 text-[var(--los-secondary)]">
                    系统域名（*.zsaos.com）由平台自动配置，无需你操作 DNS。
                  </p>
                </>
              ) : (
                <p className="text-[var(--los-secondary)]">
                  应用完成上线后，将自动分配系统访问地址。
                </p>
              )}
              {primaryUrl && activeCustom ? (
                <p className="mt-3 text-[var(--los-secondary)]">
                  当前优先展示自定义域名：{primaryUrl}
                </p>
              ) : null}
            </Card>
          </Section>

          <Section className="mt-8" title="自定义域名">
            <Card className="p-5">
              {!customEnabled ? (
                <>
                  <p className="text-sm text-[var(--los-secondary)]">
                    自定义域名需要 Pro 或更高套餐。
                    {beta ? ' 当前 Beta 测试额度未包含自定义域名。' : ''}
                  </p>
                  <div className="mt-4">
                    <SecondaryLink href="/plan">查看套餐</SecondaryLink>
                  </div>
                </>
              ) : (
                <>
                  <p className="text-sm text-[var(--los-secondary)]">
                    可在 Cloudflare、阿里云、腾讯云、GoDaddy 或其他 DNS 服务商自行添加记录。LaunchOS
                    只验证最终 DNS，不要求你改项目代码。
                  </p>
                  <form className="mt-4 flex flex-col gap-3 sm:flex-row" onSubmit={(e) => void addDomain(e)}>
                    <input
                      className="flex-1 rounded-lg border border-[var(--los-border)] px-3 py-2 text-sm"
                      value={domainInput}
                      onChange={(e) => setDomainInput(e.target.value)}
                      placeholder="www.example.com"
                    />
                    <PrimaryButton type="submit" disabled={pending}>
                      {pending ? '添加中…' : '添加域名'}
                    </PrimaryButton>
                  </form>

                  <div className="mt-5 rounded-xl bg-zinc-50 px-4 py-3 text-sm">
                    <p className="font-medium">DNS 指引</p>
                    <ul className="mt-2 space-y-1 text-[var(--los-secondary)]">
                      <li>记录类型：CNAME（推荐）或 A</li>
                      <li>主机记录：www（或你使用的子域）</li>
                      <li>目标：添加域名后按页面提示指向 LaunchOS 网关</li>
                      <li>状态：等待解析 → 验证中 → 已生效 / 配置错误</li>
                    </ul>
                  </div>
                </>
              )}

              {customDomains.length > 0 ? (
                <ul className="mt-5 space-y-3">
                  {customDomains.map((item) => {
                    const cert = item.certificates?.[0];
                    const enabled =
                      item.status === 'ACTIVE' &&
                      (!cert || cert.status === 'ACTIVE');
                    return (
                      <li
                        key={item.id}
                        className="rounded-xl border border-[var(--los-border)] px-4 py-3 text-sm"
                      >
                        <p className="font-medium">{item.domain}</p>
                        <p className="mt-1 text-[var(--los-secondary)]">
                          状态：{enabled ? '已启用' : domainStatusLabel(item.status)}
                          {cert ? ` · HTTPS：${cert.status === 'ACTIVE' ? '已启用' : '准备中'}` : ''}
                        </p>
                      </li>
                    );
                  })}
                </ul>
              ) : customEnabled ? (
                <p className="mt-4 text-sm text-[var(--los-muted)]">还没有自定义域名。</p>
              ) : null}
            </Card>
          </Section>
        </>
      )}
    </ControlCenter>
  );
}
