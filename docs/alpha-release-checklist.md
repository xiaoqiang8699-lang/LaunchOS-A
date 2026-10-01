# LaunchOS Alpha Release Checklist

验收日期：2026-09-28  
范围：Step 1–30 已交付能力的只读终验。本清单不授权新建 ECS / RDS / Redis / DNS / Deployment。

判定：`ALPHA_RELEASE_DECISION=NO-GO`  
Blocker 数：2

| 项 | 状态 | 证据 / 说明 |
| --- | --- | --- |
| Source | PASS | 创建应用时提交 `source.url` 会在同一事务写入 `SourceRepository` |
| Analyze | PASS | Analyzer 输出单元类型与依赖需求；不确定时要求确认，不自动改源码 |
| Plan | PASS | 计划区分已准备 / 需创建；无新收费资源时显示「无需创建新的收费云资源」 |
| Billing Confirmation | PASS | `PROVISION_SERVER` / PostgreSQL / Redis 的 EXECUTE 需要确认；确认哈希不匹配或计划过期会停止 |
| Dependencies | PASS | PostgreSQL / Redis 引擎与连接路径已在前期真实环境验收 |
| Server | PASS | 托管服务器创建、初始化、复用均有已验收路径；旧主机 `8.138.113.134` 在部署白名单中被拒绝 |
| Build | PASS | One-click run `lr_p4a_d025b18fa6bc` 的 `BUILD_UNIT=SUCCESS` |
| Deploy | PASS | 同一次 run `DEPLOY_WEB=SUCCESS`，`targetType=MANAGED_SERVER`，`--pull=never` |
| Gateway | PASS | 同一次 run `APPLY_WEB_ROUTE=SUCCESS`；当前 nginx 仍在响应（返回 502 而非连接失败） |
| DNS | PASS | `oneclick-web` A 记录已创建且当时 propagation 成功；HTTP 仍 301 到 HTTPS |
| HTTPS | FAIL | 2026-09-28 公网复查：生产 Web、生产 API、one-click Web 均为 nginx `502` |
| Orchestrator | BLOCKED | 脚本路径 `executeControlledLaunchRun` 已 SUCCESS；产品 API `executeLaunch` 仍拒绝真实执行 |
| Recovery | PASS | Provider unknown 走 reconcile、不盲建；失败 Deployment 历史保持 `FAILED` |
| Security | PASS | 事件/制品元数据有 secret scan；凭证加密存储；Web 单元不注入 DB/Redis/JWT |
| Permissions | PASS | Viewer 不能创建部署、改 DNS、改 Provider 凭证。Launch 计划写入未单独限制 Viewer，不构成云资源写 |
| UX | PASS | 主按钮为「立即上线 / 重新上线」；阶段中文；技术码在技术详情 |
| Known Limitations | PASS | 见文末。不把未承诺能力写成已支持 |

## Alpha blockers

1. **公网 HTTPS 当前不可用**  
   风险：外部用户打不开已验收地址。  
   事实：`https://web-launchos.zsaos.com/`、`https://api-launchos.zsaos.com/health`、`https://oneclick-web.zsaos.com/` 返回 `502 Bad Gateway`（nginx/1.24.0）。对应 ServiceInstance 为 `RUNNING` / `UNHEALTHY`（端口 39000 / 39002 / 39001）。  
   修复：在现有服务器上恢复 loopback 上游，不新建云资源、不改生产 DNS。恢复后三项 URL 必须重新为 HTTP 200。

2. **产品内一键上线仍锁定**  
   风险：普通用户点击「开始上线」只会得到「真实执行暂未开放」，不会走到已验收的 Orchestrator。  
   事实：`LaunchService.executeLaunch` 在非 gate-only 时调用 `refuseRealExecution()`。Step 30 成功证据来自受控脚本，不是产品按钮。  
   修复：仅当计划无未确认收费动作时，把产品执行接到 Orchestrator；`CREATE_ECS` / `CREATE_RDS` / `CREATE_REDIS` 仍必须先显式确认。确认前、retry、resume、reconcile 都不得创建收费资源。

## 非阻塞限制

- UI 精细度、高级日志搜索、多云、Kubernetes、复杂 Compose、自动改用户源码、大规模流量均不在 Alpha 承诺内。
- 证书 `*.zsaos.com` 到期 `2026-12-14`。已有 30 天续期窗口；14 天 / 7 天分级告警未单独产品化。
- 测试项目 `cmucerx5e0001ri4w0x6sx5cz` 名称带 `ONE_CLICK_ALPHA_TEST`，但没有独立 `testResource` 字段，仍会出现在应用列表。
- 成本预估、移动端、可视化回滚不是 Alpha 门槛。

## Cleanup plan（未执行）

可清理对象（需管理员显式确认，本阶段不自动删除）：

- DNS：`oneclick-web.zsaos.com` A → `116.62.198.184`（record `2102591215786482688`）
- GatewayRoute：`oneclick-web.zsaos.com`
- 容器 / ServiceInstance：`cmudi7z3t1autritkew7edk6c`（`127.0.0.1:39001`）
- Artifact：`cmudi7taz000lri18ab62m901`、`cmudi7wn2000nri180jl8gmzi`
- 测试 Project：`cmucerx5e0001ri4w0x6sx5cz`

禁止在清理中删除生产 Project `cmu3j24mv0001ri7wcsoa30hj` 或其 Gateway / DNS。
