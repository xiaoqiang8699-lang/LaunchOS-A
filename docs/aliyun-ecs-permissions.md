# 阿里云最小权限（LaunchOS · ECS）

> 由 `scripts/generate-aliyun-required-actions.mjs` 根据 ECS Provider / Planner 实际 OpenAPI 调用生成。
> 不要授予 `AdministratorAccess`。

## 账户职责

| ProviderAccount | 用途 |
|-----------------|------|
| `ALIYUN` | ECS / VPC / 询价 / 规格发现 |
| `ALIYUN_DNS` | 仅 DNS，不可用于 ECS |

## Step 26.1 说明

服务器规划阶段会调用：

- DescribeAvailableResource
- DescribeInstanceTypes
- DescribeZones
- DescribeImages
- DescribePrice
- DescribeInstances（评估已有服务器）
- VPC / VSwitch 读取

规划阶段**不会**调用 `RunInstances`。

## Step 26.2 说明

托管创建阶段会额外调用：

- RunInstances（仅在 confirmBilling + 全部门禁就绪后）
- DescribeInstances（创建前 reconcile / 等待 Running）
- CreateSecurityGroup / AuthorizeSecurityGroup / DescribeSecurityGroups
- AllocatePublicIpAddress（如 RunInstances 未带公网 IP）
- DeleteInstance（显式释放）
- TagResources
- 必要时 CreateVpc / CreateVSwitch（优先复用 NetworkPlan）

`ecs:DescribePrice` 必须 READY，否则禁止进入真实创建。

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

## 推荐自定义策略模板（ECS 规划 + 后续创建）

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
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
              "ecs:TagResources",
              "vpc:CreateVSwitch",
              "vpc:CreateVpc",
              "vpc:DescribeVSwitches",
              "vpc:DescribeVpcs"
      ],
      "Resource": "*"
    }
  ]
}
```

生成时间：2026-09-17T08:39:54.579Z
