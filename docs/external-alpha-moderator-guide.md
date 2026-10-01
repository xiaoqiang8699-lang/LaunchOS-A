# 第一批用户测试主持人任务书

内部人员使用。不要把这份文档交给测试用户。

用户只收到一句话：「请把你的应用通过 LaunchOS 发布到公网，并打开最终访问地址。」

不要提前告诉用户该点哪个按钮、大概要等几分钟、这个项目要不要数据库或缓存，以及最后会生成哪些资源。只有用户完全无法继续时，才可以解释。

## 测试前准备

第一批只收这些项目：

- Vite / React 网页
- Node 接口
- 网页 + 接口
- 带 PostgreSQL
- 带 Redis

先不要测 Docker Compose、Kubernetes、复杂微服务、复杂 Java / Python 项目、自定义网络拓扑。

每个用户必须使用自己的 GitHub 仓库，而且 LaunchOS 第一次接触这个仓库。不要使用 launchos demo、ONE_CLICK_ALPHA_TEST，或已经调通的 fixture。

开始前确认：

- GitHub 账号可用
- 用户自己的仓库可访问
- 已在 `/alpha-tests` 创建 AlphaTestSession

创建时选择用户、已有 Project（如果有）、项目类型、Framework、Dependencies。状态必须是 PLANNED。不要填写 LaunchRunId。

## 观察点

每个阶段记下：用户是否知道下一步、是否出现看不懂的技术词、是否需要解释、是否等太久、是否报错、是否需要人工介入。

重点看这些阶段：

- 创建应用
- 绑定 GitHub
- 分析结果
- 上线计划
- 费用确认
- 开始上线
- 上线进度
- 失败页面
- 成功页面

## 何时介入

不要立刻指导。

用户大约 2 分钟不知道下一步：只记录体验摩擦。不要增加人工介入次数。

用户大约 5 分钟仍然无法继续：记录一次人工介入。

因为产品报错而无法继续：记 P1。

未确认收费、密钥泄漏、生产破坏：记 P0，并立刻停止继续操作。

## 如何记录 Intervention

每次介入必须填写：

- stage
- reason
- actionTaken
- resolved = true 或 false

保存后 manualInterventionCount 加 1。

体验摩擦走「记录摩擦」，不要走介入表单。

## P0–P4

- P0：安全、密钥泄漏、未确认收费、生产破坏
- P1：产品报错导致无法完成上线
- P2：用户需要帮助才能继续
- P3：体验问题，用户还能自己继续
- P4：建议

## 如何结束 Session

用户真正开始操作时，在测试记录里点「用户已开始」。状态变为 IN_PROGRESS，并写入 startedAt。

LaunchRun 由用户创建上线计划或开始上线后自动绑定。不要手工提前填写。

成功：用户打开公网地址，HTTP 或 HTTPS 正常，launchSucceeded = true。

失败：用户无法完成上线，或产品阻断。记下 blockedStage、blockedStep、primaryFailureCode。

结束后只问现有五个问题，1–5 分，外加一句自由反馈：

1. 你知道下一步该做什么吗？
2. 费用确认是否清楚？
3. 上线失败时，你看得懂原因吗？
4. 你是否需要别人帮助才能完成？
5. 如果这是正式产品，你愿意继续使用吗？

## 如何记录失败

主持人额外补上：

- 最大卡点
- 最困惑文案
- 是否需要人工解释技术概念
- 是否需要查看技术详情
- 人工介入次数
- 失败根因：PRODUCT、USER_CODE、CLOUD_PROVIDER、PERMISSION、NETWORK、UNKNOWN

成功项目安排 10 分钟、1 小时、24 小时健康复查。使用现有健康复查，不要另建一套监控。

## 每个 Session 的清单

开始前：

- GitHub account ready
- Repo accessible
- AlphaTestSession created

进行中：

- No coaching
- Record friction
- Record intervention
- Record error

结束后：

- Feedback submitted
- Public URL checked
- 10m check scheduled
- 1h check scheduled
- 24h check scheduled

## 第一轮结束标准

3–5 个 Session 完成后：

- P0 = 0
- 未解决 P1 不超过 1
- 首次上线成功率至少 60%
- 平均人工介入不超过 2
- 成功项目 24 小时健康率至少 80%

未达到时，不要继续扩大 Alpha 用户。先进入后续修复，不要在本轮开始真实 Session。
