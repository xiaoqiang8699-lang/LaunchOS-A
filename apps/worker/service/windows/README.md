# LaunchOS Deployment Worker — Windows long-running host

## Why Scheduled Task (not WinSW LocalSystem)

On this development host, WinSW installed as a Windows Service under `LocalSystem`
could not start `node.exe` (`exit -1073741502` / `STATUS_DLL_INIT_FAILED`), even with
an ASCII junction working directory.

The chosen manager is therefore:

- **Windows Scheduled Task**: `LaunchOS-Deployment-Worker`
- **Trigger**: At user logon (survives reboot after login)
- **Single instance**: `MultipleInstances=IgnoreNew` + `.deployment-worker.lock`
- **Crash recovery**: `run-deployment-worker.cmd` supervisor loop with **10s** delay
- **Task restart policy**: Restart every 1 minute, up to 999 times (backup)

## Install

```powershell
pnpm --filter @launchos/worker build
powershell -NoProfile -ExecutionPolicy Bypass -File apps/worker/service/windows/install-scheduled-task.ps1
```

## Start command

`D:\launchos-zidonghua\apps\worker\service\windows\run-deployment-worker.cmd`

which runs:

- `WORKER_PROFILE=deployment`
- `node dist/main.js`
- working directory: `D:\launchos-zidonghua\apps\worker` (junction → repo `apps/worker`)

## Environment

Service/task does **not** embed secrets.

Worker loads existing:

- `apps/worker/.env` (optional)
- repo root `.env`

via `apps/worker/src/env.ts`.

## Uninstall

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File apps/worker/service/windows/uninstall-scheduled-task.ps1
```

WinSW files under `service/windows/*.exe` remain optional tooling; LocalSystem install
is documented as failed on this host.
