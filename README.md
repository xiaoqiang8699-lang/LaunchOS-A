# LaunchOS

LaunchOS 是面向 AI Coding 用户的应用部署编排平台，目标是让部署变得像安装软件一样简单。

当前仓库处于工程初始化阶段：Monorepo 骨架、Web / API / Worker 可独立启动，业务能力尚未接入。

## Tech Stack

- **Web**: Next.js, TypeScript, Tailwind CSS, shadcn/ui
- **API**: NestJS, TypeScript
- **Worker**: Node.js, TypeScript
- **Monorepo**: pnpm, Turborepo

## Project Structure

```text
apps/
  web/          Next.js 前端（端口 3000）
  api/          NestJS API（端口 3001）
  worker/       后台 Worker
packages/
  shared/       共享类型、常量、工具、schemas
  database/     Prisma 与数据库客户端
  providers/    云厂商适配层
  deployment/   部署引擎
  ui/           共享 UI 组件
docs/           文档
scripts/        脚本
```

## Windows快速启动

在仓库根目录双击：

启动 LaunchOS.bat

检查：

检查 LaunchOS.bat

停止：

停止 LaunchOS.bat

对应脚本：

```text
scripts/start-launchos.ps1
scripts/check-launchos.ps1
scripts/stop-launchos.ps1
```

启动前请先打开 Docker Desktop。启动脚本会执行 `docker compose up -d` 拉起 postgres / redis / minio，校验数据库，然后用 `pnpm dev` 一次启动 Web / API / Worker / Gateway。检查脚本会输出中文环境报告。停止脚本只关闭这些应用进程，不会删除 Docker 数据。

## Local Development

```bash
pnpm install
pnpm dev
```

复制 `.env.example` 为 `.env` 后按需填写（当前无需真实密钥即可启动）。

其他常用命令：

```bash
pnpm build
pnpm lint
```

## Available Apps

| App | 说明 | 开发命令 | 地址 |
| --- | --- | --- | --- |
| `@launchos/web` | 前端控制台 | `pnpm --filter @launchos/web dev` | http://localhost:3000 |
| `@launchos/api` | HTTP API | `pnpm --filter @launchos/api dev` | http://localhost:3001 |
| `@launchos/worker` | 后台 Worker | `pnpm --filter @launchos/worker dev` | 控制台输出启动日志 |

健康检查：

```text
GET http://localhost:3001/api/v1/health
```
