# Worker

`pnpm --filter @launchos/worker dev` 保持原来的完整行为，profile 默认为 `all`。

安全部署验收使用 deployment profile。它只消费 `deploymentQueue` 和 `systemCertQueue`，不会注册会创建服务器、数据库或 Redis 的队列。

```bash
pnpm --filter @launchos/worker dev:deployment
pnpm --filter @launchos/worker start:deployment
```

开通基础设施时单独使用：

```bash
pnpm --filter @launchos/worker dev:provisioning
```

持续运行方式和 API 相同：用 `start:deployment` 跑一个长期 Node 进程。不要和 `all` 同时跑两套会重复消费部署队列的进程。
