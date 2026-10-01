# 阿里云最小权限（LaunchOS · RDS）

> 由 `scripts/generate-aliyun-required-actions.mjs` 根据 Provider 实际 OpenAPI 调用生成。
> 不要授予 `AdministratorAccess`。

## 账户职责

| ProviderAccount | 用途 |
|-----------------|------|
| `ALIYUN_DNS` | 域名 / DNS / ACME TXT |
| `ALIYUN` | ECS / RDS / Redis / VPC 等云资源 |

RDS / Redis 创建**禁止**使用 `ALIYUN_DNS` 凭证。

## RDS RAM Actions

```json
[
  "rds:AllocateInstancePublicConnection",
  "rds:CreateAccount",
  "rds:CreateDBInstance",
  "rds:CreateDatabase",
  "rds:DeleteDBInstance",
  "rds:DescribeAvailableClasses",
  "rds:DescribeDBInstanceAttribute",
  "rds:DescribeDBInstanceNetInfo",
  "rds:DescribeDBInstances",
  "rds:GrantAccountPrivilege",
  "rds:ModifySecurityIps"
]
```

## ECS RAM Actions

```json
[
  "ecs:AllocatePublicIpAddress",
  "ecs:AuthorizeSecurityGroup",
  "ecs:CreateSecurityGroup",
  "ecs:DeleteInstance",
  "ecs:DescribeAvailableResource",
  "ecs:DescribeImages",
  "ecs:DescribeInstanceTypes",
  "ecs:DescribeInstances",
  "ecs:DescribePrice",
  "ecs:DescribeSecurityGroups",
  "ecs:DescribeZones",
  "ecs:RunInstances",
  "ecs:TagResources"
]
```

## VPC RAM Actions

```json
[
  "vpc:CreateVSwitch",
  "vpc:CreateVpc",
  "vpc:DescribeVSwitches",
  "vpc:DescribeVpcs"
]
```

生成时间：2026-09-17T08:39:54.579Z
