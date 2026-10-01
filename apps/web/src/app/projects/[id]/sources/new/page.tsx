'use client';

import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { FormEvent, useEffect, useState } from 'react';
import { AdvancedGitSettings } from '@/components/advanced-git-settings';
import { CodeVersionHint } from '@/components/code-version-hint';
import { api } from '@/lib/api';
import { getAccessToken } from '@/lib/auth';
import { detectCodeVersion } from '@/lib/detect-git-version';
import { PRODUCT_COPY } from '@/lib/product-language';
import type { SourceRepository, SourceType } from '@/lib/types';

export default function NewSourcePage() {
  const router = useRouter();
  const params = useParams<{ id: string }>();
  const [type] = useState<SourceType>('GITHUB');
  const [url, setUrl] = useState('');
  const [branch, setBranch] = useState('');
  const [branchMessage, setBranchMessage] = useState('');
  const [runtime, setRuntime] = useState('');
  const [port, setPort] = useState('');
  const [buildCommand, setBuildCommand] = useState('');
  const [detected, setDetected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [detecting, setDetecting] = useState(false);

  useEffect(() => {
    if (!getAccessToken()) {
      router.replace('/login');
    }
  }, [router]);

  async function detect(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setDetecting(true);
    try {
      const result = await detectCodeVersion(url.trim());
      setBranch(result.version);
      setBranchMessage(result.message);
      setDetected(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : '检测失败');
    } finally {
      setDetecting(false);
    }
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setError(null);
    setPending(true);

    try {
      await api<SourceRepository>(`/projects/${params.id}/sources`, {
        method: 'POST',
        body: JSON.stringify({ type, url: url.trim(), branch: branch.trim() || undefined }),
      });
      router.push(`/projects/${params.id}/analyzing`);
    } catch (err) {
      setError(err instanceof Error ? err.message : '添加失败');
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="min-h-screen bg-zinc-50 px-6 py-10">
      <div className="mx-auto w-full max-w-xl">
        <Link className="text-sm text-zinc-500" href={`/projects/${params.id}`}>
          ← 返回应用
        </Link>
        <h1 className="mt-3 text-3xl font-semibold text-zinc-900">{PRODUCT_COPY.bindCode}</h1>
        <p className="mt-2 text-sm text-zinc-500">{PRODUCT_COPY.codeSourceHint}</p>

        {!detected ? (
          <form className="mt-8 space-y-4 rounded-2xl border border-zinc-200 bg-white p-6" onSubmit={(event) => void detect(event)}>
            <label className="block text-sm font-medium text-zinc-700">
              GitHub 地址
              <span className="mt-0.5 block text-xs font-normal text-zinc-500">
                {PRODUCT_COPY.githubUrlHint}
              </span>
              <input
                className="mt-1 w-full rounded-lg border border-zinc-200 px-3 py-2 outline-none focus:border-zinc-400"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
                placeholder="https://github.com/example/app.git"
                required
              />
            </label>
            <CodeVersionHint />
            {error ? <p className="text-sm text-red-600">{error}</p> : null}
            <button
              className="w-full rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-60"
              type="submit"
              disabled={detecting}
            >
              {detecting ? PRODUCT_COPY.detecting : PRODUCT_COPY.detectProject}
            </button>
          </form>
        ) : (
          <form className="mt-8 space-y-4 rounded-2xl border border-zinc-200 bg-white p-6" onSubmit={(event) => void onSubmit(event)}>
            <p className="text-sm font-medium text-emerald-700">{PRODUCT_COPY.detectSuccess}</p>
            <div className="rounded-xl bg-zinc-50 px-4 py-3 text-sm text-zinc-700">
              <p>
                {PRODUCT_COPY.autoDetectBranch}：{branch || '创建时自动检测'}
              </p>
              <p className="text-zinc-500">{branchMessage || PRODUCT_COPY.keepDefaultBranch}</p>
              <p className="mt-2 text-zinc-500">{PRODUCT_COPY.keepDefaultBranch}</p>
              <p className="mt-2 text-zinc-500">{PRODUCT_COPY.defaultReady}</p>
            </div>
            <AdvancedGitSettings
              version={branch}
              onVersionChange={setBranch}
              runtime={runtime}
              onRuntimeChange={setRuntime}
              port={port}
              onPortChange={setPort}
              buildCommand={buildCommand}
              onBuildCommandChange={setBuildCommand}
            />
            {error ? <p className="text-sm text-red-600">{error}</p> : null}
            <div className="flex gap-2">
              <button
                className="flex-1 rounded-lg border border-zinc-200 px-4 py-2.5 text-sm text-zinc-700"
                type="button"
                onClick={() => setDetected(false)}
                disabled={pending}
              >
                重新检测
              </button>
              <button
                className="flex-1 rounded-lg bg-zinc-900 px-4 py-2.5 text-sm font-medium text-white disabled:opacity-60"
                type="submit"
                disabled={pending}
              >
                {pending ? '连接中…' : PRODUCT_COPY.bindCode}
              </button>
            </div>
          </form>
        )}
      </div>
    </main>
  );
}
