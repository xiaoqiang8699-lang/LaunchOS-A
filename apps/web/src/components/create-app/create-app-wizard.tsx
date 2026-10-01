'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { FormEvent, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';
import { DEMO_GITHUB_URL, detectCodeVersion } from '@/lib/detect-git-version';
import { PRODUCT_COPY } from '@/lib/product-language';
import { APPLICATION_PURPOSE_HINTS, APPLICATION_PURPOSE_LABELS } from '@/lib/project-labels';
import type {
  ApplicationPurpose,
  GitHubConnectionStatus,
  GitHubRepoOption,
  ProjectSummary,
  SourceType,
} from '@/lib/types';

type CodeMode = 'github' | 'zip' | 'public';
type WizardStep = 'source' | 'confirm';

const PURPOSE_OPTIONS: ApplicationPurpose[] = ['WEBSITE', 'APP_WEBSITE', 'API', 'ADMIN', 'OTHER'];

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export type CreateAppWizardProps = {
  /** When true, keep simplified onboarding shell behavior after create. */
  fromOnboarding?: boolean;
  backHref?: string;
  backLabel?: string;
};

export function CreateAppWizard(props: CreateAppWizardProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const zipInputRef = useRef<HTMLInputElement>(null);
  const githubConnected = searchParams.get('github') === 'connected';
  const fromOnboarding =
    props.fromOnboarding || searchParams.get('from') === 'onboarding';

  const [step, setStep] = useState<WizardStep>(githubConnected ? 'source' : 'source');
  const [codeMode, setCodeMode] = useState<CodeMode>(githubConnected ? 'github' : 'github');
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState<ApplicationPurpose | ''>('');
  const [sourceType, setSourceType] = useState<SourceType>('GITHUB');
  const [sourceUrl, setSourceUrl] = useState('');
  const [sourceBranch, setSourceBranch] = useState('');
  const [autoBranch, setAutoBranch] = useState(true);
  const [detectOk, setDetectOk] = useState(false);
  const [privateHint, setPrivateHint] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [githubStatus, setGithubStatus] = useState<GitHubConnectionStatus | null>(null);
  const [repos, setRepos] = useState<GitHubRepoOption[]>([]);
  const [repoQuery, setRepoQuery] = useState('');
  const [selectedRepo, setSelectedRepo] = useState<GitHubRepoOption | null>(null);
  const [connectionId, setConnectionId] = useState<string | null>(null);
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [detecting, setDetecting] = useState(false);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [connectingGithub, setConnectingGithub] = useState(false);

  const returnTo = fromOnboarding
    ? '/projects/new?from=onboarding&github=connected'
    : '/projects/new?github=connected';

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
      return;
    }
    if (fromOnboarding) {
      void api('/onboarding/source/viewed', { method: 'POST' }).catch(() => undefined);
    }
    if (searchParams.get('github') === 'connected') {
      setBanner('GitHub 已连接');
      setCodeMode('github');
    } else if (searchParams.get('github') === 'error') {
      setError(
        searchParams.get('reason') === 'cancelled'
          ? 'GitHub 连接没有完成，请重新尝试。'
          : 'GitHub 连接没有完成，请重新尝试。',
      );
    }

    let cancelled = false;
    void (async () => {
      try {
        const status = await api<GitHubConnectionStatus>('/git/github/status');
        if (cancelled) return;
        setGithubStatus(status);
        setConnectionId(status.connectionId);
        if (status.connected) {
          const result = await api<{ connectionId: string; repositories: GitHubRepoOption[] }>(
            '/git/github/repositories',
          );
          if (cancelled) return;
          setConnectionId(result.connectionId);
          setRepos(result.repositories);
        }
      } catch {
        if (!cancelled) setGithubStatus(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router, searchParams, fromOnboarding]);

  async function loadRepos(q?: string): Promise<void> {
    setLoadingRepos(true);
    setError(null);
    try {
      const query = q?.trim() ? `?q=${encodeURIComponent(q.trim())}` : '';
      const result = await api<{ connectionId: string; repositories: GitHubRepoOption[] }>(
        `/git/github/repositories${query}`,
      );
      setConnectionId(result.connectionId);
      setRepos(result.repositories);
    } catch (err) {
      setError(err instanceof Error ? err.message : '无法读取仓库列表');
      setRepos([]);
    } finally {
      setLoadingRepos(false);
    }
  }

  async function connectGithub(): Promise<void> {
    setConnectingGithub(true);
    setError(null);
    try {
      const result = await api<{ url: string }>(
        `/git/github/authorize?returnTo=${encodeURIComponent(returnTo)}`,
      );
      window.location.href = result.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : PRODUCT_COPY.githubNotConfigured);
      setConnectingGithub(false);
    }
  }

  function selectRepo(repo: GitHubRepoOption): void {
    setSelectedRepo(repo);
    setSourceUrl(repo.cloneUrl);
    setSourceBranch(repo.defaultBranch);
    setSourceType('GITHUB');
    setDetectOk(true);
    setPrivateHint(false);
    setError(null);
    if (!name.trim()) setName(repo.name);
  }

  async function detectGithub(url = sourceUrl): Promise<void> {
    const trimmed = url.trim();
    if (!trimmed) {
      setError(PRODUCT_COPY.githubUrlRequired);
      return;
    }
    setError(null);
    setPrivateHint(false);
    setDetectOk(false);
    setSelectedRepo(null);
    setDetecting(true);
    try {
      const detected = await detectCodeVersion(trimmed);
      setSourceUrl(trimmed);
      setSourceType('GITHUB');
      if (!name.trim()) setName(detected.name);
      if (autoBranch) setSourceBranch(detected.version);
      setDetectOk(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : PRODUCT_COPY.detectCodeFailed;
      const isPrivate =
        Boolean((err as { privateHint?: boolean })?.privateHint) || message.includes('授权');
      setPrivateHint(isPrivate);
      setDetectOk(false);
      if (autoBranch) setSourceBranch('');
      setError(isPrivate ? PRODUCT_COPY.detectCodePrivate : message || PRODUCT_COPY.detectCodeFailed);
      setAdvancedOpen(true);
    } finally {
      setDetecting(false);
    }
  }

  function goConfirm(): void {
    setError(null);
    if (codeMode === 'github' && !selectedRepo) {
      setError('请选择一个 GitHub 仓库');
      return;
    }
    if (codeMode === 'public' && !detectOk && !(sourceBranch.trim() && !autoBranch)) {
      setError('请先检测公开仓库');
      return;
    }
    if (codeMode === 'zip' && !zipFile) {
      setError('请选择 ZIP 文件');
      return;
    }
    if (codeMode === 'zip' && zipFile && !name.trim()) {
      setName(zipFile.name.replace(/\.zip$/i, '') || 'uploaded-app');
    }
    setStep('confirm');
  }

  function afterCreate(projectId: string): void {
    if (fromOnboarding) {
      window.sessionStorage.setItem('launchos-onboarding-console', '1');
    }
    router.push(`/projects/${projectId}/analyzing`);
  }

  async function onCreate(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    setError(null);
    if (!purpose) {
      setError('请选择应用用途');
      return;
    }
    if (!name.trim()) {
      setError('请填写应用名称');
      return;
    }

    setPending(true);
    try {
      if (codeMode === 'zip') {
        if (!zipFile) throw new Error('请选择 ZIP 文件');
        const token = window.localStorage.getItem('accessToken');
        const form = new FormData();
        form.append('file', zipFile);
        const response = await fetch(`${API_BASE}/api/v1/projects/source/zip`, {
          method: 'POST',
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          body: form,
        });
        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as
            | { message?: string; code?: string }
            | null;
          throw new ApiError(
            response.status,
            typeof payload?.message === 'string' ? payload.message : '上传失败',
            payload?.code,
            payload,
          );
        }
        const project = (await response.json()) as ProjectSummary;
        if (purpose) {
          await api(`/projects/${project.id}`, {
            method: 'PATCH',
            body: JSON.stringify({
              name: name.trim(),
              applicationPurpose: purpose,
            }),
          }).catch(() => undefined);
        }
        afterCreate(project.id);
        return;
      }

      if (!sourceUrl.trim()) {
        setError(PRODUCT_COPY.githubUrlRequired);
        setPending(false);
        return;
      }
      if (!sourceBranch.trim()) {
        setError(PRODUCT_COPY.codeVersionDetectFailed);
        setPending(false);
        setStep('source');
        return;
      }

      const project = await api<ProjectSummary>('/projects', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          applicationPurpose: purpose,
          source: {
            type: sourceType,
            url: sourceUrl.trim(),
            branch: sourceBranch.trim(),
            connectionId: selectedRepo ? connectionId : undefined,
            providerRepositoryId: selectedRepo?.id,
            fullName: selectedRepo?.fullName,
            isPrivate: selectedRepo?.private ?? false,
          },
        }),
      });
      afterCreate(project.id);
    } catch (err) {
      const message =
        err instanceof ApiError && err.code === 'PROJECT_LIMIT_REACHED'
          ? err.message
          : err instanceof Error
            ? err.message
            : PRODUCT_COPY.createAppFailed;
      setError(message);
      setPending(false);
    }
  }

  return (
    <div className="mx-auto w-full max-w-xl">
      <Link
        className="text-sm text-[var(--los-secondary)]"
        href={props.backHref || (fromOnboarding ? '/onboarding' : '/projects')}
      >
        {props.backLabel || (fromOnboarding ? '返回引导' : PRODUCT_COPY.backToApps)}
      </Link>
      <h1 className="mt-3 text-3xl font-semibold text-[var(--los-text)]">{PRODUCT_COPY.createApp}</h1>
      <p className="mt-2 text-sm text-[var(--los-secondary)]">
        选择代码来源 → 智能检测 → 确认应用 → 上线方案
      </p>
      <StepIndicator current={step} />

      {banner ? (
        <p className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">
          {banner}
        </p>
      ) : null}

      {step === 'source' ? (
        <section className="mt-6 space-y-4 rounded-2xl border border-[var(--los-border)] bg-white p-6">
          <h2 className="text-lg font-medium text-[var(--los-text)]">选择代码来源</h2>
          <div className="grid gap-2 sm:grid-cols-3">
            {(
              [
                ['github', 'GitHub', '连接私有或组织仓库'],
                ['zip', '上传 ZIP', '本地代码打包上传'],
                ['public', '公开仓库地址', '粘贴公开 Git 地址'],
              ] as const
            ).map(([id, title, hint]) => (
              <button
                key={id}
                type="button"
                className={`rounded-xl border px-3 py-3 text-left text-sm ${
                  codeMode === id
                    ? 'border-zinc-900 bg-zinc-50'
                    : 'border-[var(--los-border)] hover:border-zinc-300'
                }`}
                onClick={() => {
                  setCodeMode(id);
                  setError(null);
                  if (id !== 'github') setSelectedRepo(null);
                }}
              >
                <p className="font-medium">{title}</p>
                <p className="mt-1 text-xs text-[var(--los-secondary)]">{hint}</p>
              </button>
            ))}
          </div>

          {codeMode === 'github' ? (
            <div className="space-y-3">
              {githubStatus?.connected ? (
                <p className="text-sm font-medium text-emerald-700">{PRODUCT_COPY.githubConnected}</p>
              ) : (
                <button
                  className="rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-60"
                  type="button"
                  disabled={connectingGithub || githubStatus?.configured === false}
                  onClick={() => void connectGithub()}
                >
                  {connectingGithub ? '跳转中…' : PRODUCT_COPY.connectGithub}
                </button>
              )}
              {githubStatus && !githubStatus.configured ? (
                <p className="text-sm text-amber-800">{PRODUCT_COPY.githubNotConfigured}</p>
              ) : null}
              {githubStatus?.connected ? (
                <>
                  <input
                    className="w-full rounded-lg border border-[var(--los-border)] px-3 py-2 text-sm outline-none focus:border-zinc-400"
                    value={repoQuery}
                    onChange={(event) => setRepoQuery(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        void loadRepos(repoQuery);
                      }
                    }}
                    placeholder={PRODUCT_COPY.searchRepos}
                  />
                  <button
                    className="text-sm text-[var(--los-secondary)] underline"
                    type="button"
                    onClick={() => void loadRepos(repoQuery)}
                    disabled={loadingRepos}
                  >
                    {loadingRepos ? '加载中…' : PRODUCT_COPY.selectGithubRepo}
                  </button>
                  <ul className="max-h-64 space-y-2 overflow-auto">
                    {repos.map((repo) => {
                      const selected = selectedRepo?.id === repo.id;
                      return (
                        <li key={repo.id}>
                          <button
                            className={`w-full rounded-xl border px-4 py-3 text-left ${
                              selected ? 'border-zinc-900 bg-zinc-50' : 'border-[var(--los-border)]'
                            }`}
                            type="button"
                            onClick={() => selectRepo(repo)}
                          >
                            <p className="font-medium text-[var(--los-text)]">{repo.fullName}</p>
                            <p className="mt-1 text-xs text-[var(--los-secondary)]">
                              {PRODUCT_COPY.codeVersion}：{repo.defaultBranch} ·{' '}
                              {repo.private
                                ? PRODUCT_COPY.githubRepoPrivate
                                : PRODUCT_COPY.githubRepoPublic}
                            </p>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </>
              ) : null}
            </div>
          ) : null}

          {codeMode === 'zip' ? (
            <div className="space-y-3">
              <p className="text-sm text-[var(--los-secondary)]">
                上传本地项目 ZIP。无需把域名写进代码，上线后在「域名与访问」中绑定即可。
              </p>
              <input
                ref={zipInputRef}
                type="file"
                accept=".zip,application/zip"
                className="block w-full text-sm"
                onChange={(event) => {
                  const file = event.target.files?.[0] ?? null;
                  setZipFile(file);
                  if (file && !name.trim()) {
                    setName(file.name.replace(/\.zip$/i, '') || 'uploaded-app');
                  }
                }}
              />
              {zipFile ? (
                <p className="text-sm text-emerald-700">已选择：{zipFile.name}</p>
              ) : null}
            </div>
          ) : null}

          {codeMode === 'public' ? (
            <div className="space-y-4">
              <button
                className="rounded-lg border border-[var(--los-border)] px-3 py-1.5 text-sm"
                type="button"
                onClick={() => {
                  setSourceUrl(DEMO_GITHUB_URL);
                  void detectGithub(DEMO_GITHUB_URL);
                }}
                disabled={detecting}
              >
                {PRODUCT_COPY.demoProject}
              </button>
              <label className="block text-sm font-medium">
                {PRODUCT_COPY.githubUrl}
                <input
                  className="mt-1 w-full rounded-lg border border-[var(--los-border)] px-3 py-2 outline-none focus:border-zinc-400"
                  value={sourceUrl}
                  onChange={(event) => {
                    setSourceUrl(event.target.value);
                    setDetectOk(false);
                  }}
                  placeholder="https://github.com/example/app.git"
                />
              </label>
              <div className="rounded-xl bg-zinc-50 px-4 py-3 text-sm">
                <p>
                  {PRODUCT_COPY.codeVersion}
                  <span className="ml-2 text-[var(--los-secondary)]">
                    {autoBranch ? sourceBranch || PRODUCT_COPY.codeVersionAuto : sourceBranch || '手动填写'}
                  </span>
                </p>
                {detectOk && sourceBranch ? (
                  <p className="mt-2 text-emerald-700">
                    {PRODUCT_COPY.detectCodeVersionSuccess}：{sourceBranch}
                  </p>
                ) : null}
                <button
                  className="mt-3 text-sm underline"
                  type="button"
                  onClick={() => setAdvancedOpen((v) => !v)}
                >
                  {PRODUCT_COPY.advanced}
                </button>
                {advancedOpen ? (
                  <div className="mt-3 space-y-2">
                    <label className="flex items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={autoBranch}
                        onChange={(event) => {
                          setAutoBranch(event.target.checked);
                          if (event.target.checked) {
                            setSourceBranch('');
                            setDetectOk(false);
                          }
                        }}
                      />
                      {PRODUCT_COPY.codeVersionAuto}
                    </label>
                    {!autoBranch ? (
                      <input
                        className="w-full rounded-lg border border-[var(--los-border)] px-3 py-2 text-sm"
                        value={sourceBranch}
                        onChange={(event) => setSourceBranch(event.target.value)}
                        placeholder="main / master / develop"
                      />
                    ) : null}
                  </div>
                ) : null}
              </div>
              {privateHint ? (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                  <p className="font-medium">{PRODUCT_COPY.detectCodePrivate}</p>
                  <button
                    className="mt-3 rounded-lg bg-zinc-900 px-3 py-1.5 text-sm text-white"
                    type="button"
                    onClick={() => {
                      setCodeMode('github');
                      void connectGithub();
                    }}
                  >
                    {PRODUCT_COPY.connectGithub}
                  </button>
                </div>
              ) : null}
            </div>
          ) : null}

          {error ? <p className="text-sm text-red-600">{error}</p> : null}

          <div className="flex flex-col gap-2 sm:flex-row">
            {codeMode === 'public' ? (
              <button
                className="rounded-lg border border-[var(--los-border)] px-4 py-2.5 text-sm disabled:opacity-60"
                type="button"
                disabled={detecting || pending}
                onClick={() => void detectGithub()}
              >
                {detecting ? PRODUCT_COPY.detectingCode : PRODUCT_COPY.detectCode}
              </button>
            ) : null}
            <button
              className="flex-1 rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-60"
              type="button"
              disabled={
                pending ||
                detecting ||
                (codeMode === 'github' && !selectedRepo) ||
                (codeMode === 'zip' && !zipFile) ||
                (codeMode === 'public' && !detectOk && !(sourceBranch.trim() && !autoBranch))
              }
              onClick={goConfirm}
            >
              下一步：确认应用
            </button>
          </div>
        </section>
      ) : null}

      {step === 'confirm' ? (
        <form
          className="mt-6 space-y-5 rounded-2xl border border-[var(--los-border)] bg-white p-6"
          onSubmit={(event) => void onCreate(event)}
        >
          <h2 className="text-lg font-medium">确认应用</h2>
          <p className="text-sm text-[var(--los-secondary)]">
            来源：
            {codeMode === 'github'
              ? selectedRepo?.fullName || 'GitHub'
              : codeMode === 'zip'
                ? zipFile?.name || 'ZIP'
                : sourceUrl}
          </p>
          <label className="block text-sm font-medium">
            {PRODUCT_COPY.appName}
            <input
              className="mt-1 w-full rounded-lg border border-[var(--los-border)] px-3 py-2 outline-none focus:border-zinc-400"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
            />
          </label>
          <div>
            <p className="text-sm font-medium">{PRODUCT_COPY.appPurpose}</p>
            <ul className="mt-3 space-y-2">
              {PURPOSE_OPTIONS.map((item) => {
                const selected = purpose === item;
                return (
                  <li key={item}>
                    <button
                      className={`w-full rounded-xl border px-4 py-3 text-left ${
                        selected ? 'border-zinc-900 bg-zinc-50' : 'border-[var(--los-border)]'
                      }`}
                      type="button"
                      onClick={() => setPurpose(item)}
                    >
                      <p className="font-medium">{APPLICATION_PURPOSE_LABELS[item]}</p>
                      <p className="mt-1 text-sm text-[var(--los-secondary)]">
                        {APPLICATION_PURPOSE_HINTS[item]}
                      </p>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
          {error ? <p className="text-sm text-red-600">{error}</p> : null}
          <div className="flex flex-col gap-2 sm:flex-row">
            <button
              className="rounded-lg border border-[var(--los-border)] px-4 py-2.5 text-sm"
              type="button"
              disabled={pending}
              onClick={() => {
                setError(null);
                setStep('source');
              }}
            >
              上一步
            </button>
            <button
              className="flex-1 rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-60"
              type="submit"
              disabled={pending || !purpose || !name.trim()}
            >
              {pending ? '创建中…' : '继续智能检测'}
            </button>
          </div>
          <p className="text-center text-xs text-[var(--los-muted)]">
            下一步将进入智能检测，随后可确认上线方案（含运行位置）
          </p>
        </form>
      ) : null}
    </div>
  );
}

function StepIndicator(props: { current: WizardStep }) {
  const steps = [
    { id: 'source' as const, label: '选择代码' },
    { id: 'confirm' as const, label: '确认应用' },
    { id: 'detect' as const, label: '智能检测' },
  ];
  const currentIndex = props.current === 'source' ? 0 : 1;
  return (
    <ol className="mt-4 flex flex-wrap gap-2 text-xs text-[var(--los-secondary)]">
      {steps.map((item, index) => (
        <li
          key={item.id}
          className={`rounded-full px-2.5 py-1 ${
            index === currentIndex
              ? 'bg-zinc-900 text-white'
              : index < currentIndex
                ? 'bg-zinc-200 text-zinc-700'
                : 'bg-zinc-100'
          }`}
        >
          {index + 1}. {item.label}
        </li>
      ))}
    </ol>
  );
}
