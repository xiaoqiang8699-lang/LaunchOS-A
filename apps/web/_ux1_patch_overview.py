# -*- coding: utf-8 -*-
from pathlib import Path

path = Path(r"D:\临时文件-2\zidonghua\apps\web\src\app\projects\[id]\page.tsx")
text = path.read_text(encoding="utf-8")
lines = text.splitlines(keepends=True)

start = None
end = None
for i, l in enumerate(lines):
    if start is None and "{dependencySummary && dependencySummary.required > 0" in l:
        start = i
    if "{/* Advanced (collapsed) */}" in l:
        # include advanced through its closing section; find matching end
        pass
    if start is not None and end is None and "    </ControlCenter>" in l:
        # walk back to find last </section> of advanced before the closing div
        for j in range(i - 1, start, -1):
            if lines[j].strip() == "</div>" and lines[j - 1].strip() == "</section>":
                end = j  # exclusive? we want to keep </div>
                # actually structure is:
                # </section> advanced
                # </div>
                # </ControlCenter>
                end = j  # keep from </div>
                break
        break

print("start", start + 1 if start is not None else None)
print("end", end + 1 if end is not None else None)

replacement = r'''        {/* Current status */}
        <section className="rounded-xl border border-[var(--los-border)] bg-white p-5">
          <h2 className="text-[15px] font-semibold text-[var(--los-text)]">当前状态</h2>
          <dl className="mt-3 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-[var(--los-secondary)]">运行状态</dt>
              <dd className="mt-0.5 font-medium text-[var(--los-text)]">
                <StatusBadge status={running} label={statusLabel.replace(/^🟢\s*/, '')} />
              </dd>
            </div>
            <div>
              <dt className="text-[var(--los-secondary)]">公网访问</dt>
              <dd className="mt-0.5 font-medium text-[var(--los-text)]">
                {canVisit ? '正常' : healthLabel ?? (app?.visitUrlPreparing ? '准备中' : '待确认')}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--los-secondary)]">当前版本</dt>
              <dd className="mt-0.5 font-medium text-[var(--los-text)]">
                {currentVersion?.version ?? versions[0]?.version ?? '—'}
              </dd>
            </div>
            <div>
              <dt className="text-[var(--los-secondary)]">最近检查</dt>
              <dd className="mt-0.5 font-medium text-[var(--los-text)]">
                {healthChecked ?? '—'}
              </dd>
            </div>
          </dl>
        </section>

        {/* Visit URL */}
        <section className="rounded-xl border border-[var(--los-border)] bg-white p-5">
          <h2 className="text-[15px] font-semibold text-[var(--los-text)]">访问地址</h2>
          {app?.visitEntries && app.visitEntries.length > 1 ? (
            <ul className="mt-3 space-y-2 text-sm">
              {app.visitEntries.map((entry) => (
                <li key={entry.unitId} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{entry.name}</span>
                  {entry.visitUrlReady && entry.visitUrl ? (
                    <a className="break-all text-[var(--los-secondary)] underline" href={entry.visitUrl} target="_blank" rel="noreferrer">
                      {entry.visitUrl}
                    </a>
                  ) : (
                    <span className="text-[var(--los-muted)]">暂无地址</span>
                  )}
                </li>
              ))}
            </ul>
          ) : app?.visitUrlPreparing && !visitUrl ? (
            <p className="mt-2 text-sm text-[var(--los-secondary)]">访问地址准备中…</p>
          ) : visitUrl ? (
            <>
              <p className="mt-2 break-all text-sm font-medium text-[var(--los-text)]">{visitUrl}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                {canVisit ? (
                  <a
                    className="rounded-lg bg-[var(--los-action)] px-3 py-1.5 text-sm font-medium text-white"
                    href={visitUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    打开应用
                  </a>
                ) : null}
                <button
                  className="rounded-lg border border-[var(--los-border)] px-3 py-1.5 text-sm"
                  type="button"
                  onClick={() => void copyVisitUrl(visitUrl)}
                >
                  {copied ? '已复制' : '复制'}
                </button>
              </div>
            </>
          ) : (
            <p className="mt-2 text-sm text-[var(--los-secondary)]">完成上线后即可获得访问地址。</p>
          )}
        </section>

        {dependencySummary && dependencySummary.required > 0 ? (
          <section className="rounded-xl border border-[var(--los-border)] bg-white p-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-[15px] font-semibold">应用依赖</h2>
                <p className="mt-1 text-sm text-[var(--los-secondary)]">
                  {dependencySummary.required} 个依赖 · {dependencySummary.statusLabel}
                  {dependencySummary.missing > 0 ? ` · ${dependencySummary.missing} 个需要处理` : ''}
                </p>
              </div>
              <Link
                className="rounded-lg border border-[var(--los-border)] px-3 py-1.5 text-sm"
                href={`/projects/${project.id}/dependencies`}
              >
                管理依赖
              </Link>
            </div>
          </section>
        ) : null}

        <AppComposition
          projectId={project.id}
          units={units}
          loading={unitsLoading}
          ready={canGoLive}
          canManage={canManage}
          compact
          onChanged={() => {
            void api<{ units: DeployableUnitCard[]; aggregateLabel?: string }>(
              `/projects/${project.id}/deployable-units`,
            )
              .then((payload) => {
                setUnits(payload.units ?? []);
                setAggregateLabel(payload.aggregateLabel ?? null);
              })
              .catch(() => undefined);
            void api<AppSummary>(`/apps/${project.id}`)
              .then(setApp)
              .catch(() => undefined);
          }}
        />

        {/* Recent deploys */}
        <section className="rounded-xl border border-[var(--los-border)] bg-white p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-[15px] font-semibold">最近上线</h2>
            <Link
              className="text-sm text-[var(--los-secondary)] underline"
              href={`/projects/${params.id}/deployments`}
            >
              查看全部上线记录
            </Link>
          </div>
          {deployments.length === 0 ? (
            <p className="mt-3 text-sm text-[var(--los-secondary)]">还没有上线记录。</p>
          ) : (
            <ul className="mt-3 divide-y divide-[var(--los-border)]">
              {deployments.slice(0, 3).map((d) => (
                <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{d.version ?? '上线'}</span>
                    <StatusBadge status={d.status} />
                    {d.isCurrent || d.id === currentVersion?.deploymentId ? (
                      <span className="text-xs text-[var(--los-muted)]">当前运行</span>
                    ) : null}
                  </div>
                  <span className="text-[var(--los-secondary)]">{formatDateTime(d.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* Code source */}
        <section id="code-source" className="rounded-xl border border-[var(--los-border)] bg-white p-5">
          <h2 className="text-[15px] font-semibold">代码来源</h2>
          {!source ? (
            <p className="mt-2 text-sm text-[var(--los-secondary)]">请先连接代码仓库</p>
          ) : (
            <dl className="mt-3 space-y-2 text-sm">
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-[var(--los-secondary)]">来源</dt>
                <dd className="font-medium">{SOURCE_TYPE_LABELS[source.type]}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-[var(--los-secondary)]">仓库</dt>
                <dd className="break-all">{source.fullName || simplifyRepoUrl(source.url)}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-20 shrink-0 text-[var(--los-secondary)]">分支</dt>
                <dd>{source.branch || 'main'}</dd>
              </div>
              {source.isPrivate && source.authStatus === 'NEEDS_REAUTH' ? (
                <p className="text-sm text-[var(--los-warning)]">
                  GitHub 连接已失效，请{' '}
                  <Link className="underline" href="/code-platforms">
                    重新授权
                  </Link>
                </p>
              ) : null}
            </dl>
          )}
        </section>

        {issues.length > 0 || running === 'WARNING' || running === 'FAILED' ? (
          <section id="issues" className="rounded-xl border border-[var(--los-border)] bg-white p-5">
            <h2 className="text-[15px] font-semibold">需要关注</h2>
            <div className="mt-3 space-y-2">
              {running === 'WARNING' && issues.length === 0 ? (
                <p className="text-sm text-amber-800">应用可访问，但最近检测发现异常。</p>
              ) : null}
              {issues.slice(0, 3).map((issue) => (
                <div key={issue.id} className="rounded-lg border border-[var(--los-border)] px-3 py-2">
                  <p className="text-sm font-medium">{issue.title}</p>
                  <p className="mt-0.5 text-xs text-[var(--los-secondary)]">{issue.cause}</p>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {/* Advanced (collapsed) */}
        <section className="rounded-xl border border-dashed border-[var(--los-border)] bg-white p-5">
          <button
            className="flex w-full items-center justify-between text-left"
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
          >
            <div>
              <h2 className="text-sm font-medium text-[var(--los-secondary)]">高级</h2>
              <p className="mt-0.5 text-xs text-[var(--los-muted)]">技术排查工具，日常不必使用。</p>
            </div>
            <span className="text-[var(--los-muted)]">{showAdvanced ? '收起' : '展开'}</span>
          </button>
          {showAdvanced ? (
            <div className="mt-4 space-y-3 border-t border-[var(--los-border)] pt-4">
              <div className="flex flex-wrap gap-2">
                <Link className="rounded-lg border border-[var(--los-border)] px-3 py-1.5 text-sm" href={`/projects/${project.id}/analyze`}>
                  代码检测
                </Link>
                <Link className="rounded-lg border border-[var(--los-border)] px-3 py-1.5 text-sm" href={`/projects/${project.id}/runtime`}>
                  运行状态
                </Link>
                <Link className="rounded-lg border border-[var(--los-border)] px-3 py-1.5 text-sm" href={`/projects/${project.id}/versions`}>
                  版本
                </Link>
              </div>
              <CodeSyncSettings appId={params.id} settings={settings} />
            </div>
          ) : null}
        </section>

'''

if start is None or end is None:
    raise SystemExit("markers not found")

new_lines = lines[:start] + [replacement] + lines[end:]
path.write_text("".join(new_lines), encoding="utf-8")
print("patched", start + 1, "to", end, "new total lines", len(new_lines))
