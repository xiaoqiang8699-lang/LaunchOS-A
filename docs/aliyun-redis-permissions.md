# 阿里云最小权限（LaunchOS · Redis）

> 由 `scripts/generate-aliyun-required-actions.mjs` 根据 `AlibabaCloudRedisProvider` 实际 OpenAPI 调用生成。
> 不要授予 `AdministratorAccess`。

## 账户职责

| ProviderAccount | 用途 |
|-----------------|------|
| `ALIYUN` | Redis / ECS 网络探测 / VPC |
| `ALIYUN_DNS` | 仅 DNS，不可用于 Redis 创建 |

## 产品能力

创建阿里云 Redis（R-kvstore / Tair 社区版兼容）时 LaunchOS 需要：

- 查看可用规格
- 创建 / 查询 / 删除实例
- 配置白名单
- 查询连接地址 / 分配公网（受限）
- 复用 ECS/VPC 读取做网络放置

## 前置说明

首次使用阿里云 Redis 可能需要完成云服务授权（Service Linked Role）。
LaunchOS 会在 capability readiness 与错误文案中提示。

## Redis (kvstore) RAM Actions

```json
[
  "kvstore:AllocateInstancePublicConnection",
  "kvstore:CreateInstance",
  "kvstore:DeleteInstance",
  "kvstore:DescribeAvailableResource",
  "kvstore:DescribeDBInstanceNetInfo",
  "kvstore:DescribeInstanceAttribute",
  "kvstore:DescribeInstances",
  "kvstore:ModifySecurityIps"
]
```

## 推荐自定义策略模板（Redis）

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
              "kvstore:AllocateInstancePublicConnection",
              "kvstore:CreateInstance",
              "kvstore:DeleteInstance",
              "kvstore:DescribeAvailableResource",
              "kvstore:DescribeDBInstanceNetInfo",
              "kvstore:DescribeInstanceAttribute",
              "kvstore:DescribeInstances",
              "kvstore:ModifySecurityIps"
      ],
      "Resource": "*"
    }
  ]
}
```

生成时间：2026-09-17T08:39:54.579Z
