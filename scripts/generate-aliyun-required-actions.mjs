/**
 * Scan LaunchOS Aliyun providers for OpenAPI usage and emit required RAM actions.
 * No credentials are read or printed.
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Per-file token → RAM action (avoids cross-product key collisions). */
const FILE_ACTIONS = {
  'packages/providers/src/aliyun/alibaba-cloud-database-provider.ts': [
    ['CreateDBInstanceRequest', 'rds', 'rds:CreateDBInstance'],
    ['DescribeDBInstanceAttributeRequest', 'rds', 'rds:DescribeDBInstanceAttribute'],
    ['DescribeDBInstancesRequest', 'rds', 'rds:DescribeDBInstances'],
    ['DescribeDBInstanceNetInfoRequest', 'rds', 'rds:DescribeDBInstanceNetInfo'],
    ['DescribeAvailableClassesRequest', 'rds', 'rds:DescribeAvailableClasses'],
    ['CreateDatabaseRequest', 'rds', 'rds:CreateDatabase'],
    ['CreateAccountRequest', 'rds', 'rds:CreateAccount'],
    ['GrantAccountPrivilegeRequest', 'rds', 'rds:GrantAccountPrivilege'],
    ['ModifySecurityIpsRequest', 'rds', 'rds:ModifySecurityIps'],
    ['AllocateInstancePublicConnectionRequest', 'rds', 'rds:AllocateInstancePublicConnection'],
    ['DeleteDBInstanceRequest', 'rds', 'rds:DeleteDBInstance'],
    ['DescribeInstancesRequest', 'ecs', 'ecs:DescribeInstances'],
    ['DescribeVpcsRequest', 'vpc', 'vpc:DescribeVpcs'],
    ['DescribeVSwitchesRequest', 'vpc', 'vpc:DescribeVSwitches'],
    ['DescribeZonesRequest', 'ecs', 'ecs:DescribeZones'],
    ['CreateVpcRequest', 'vpc', 'vpc:CreateVpc'],
    ['CreateVSwitchRequest', 'vpc', 'vpc:CreateVSwitch'],
  ],
  'packages/providers/src/aliyun/alibaba-cloud-redis-provider.ts': [
    ['CreateInstanceRequest', 'redis', 'kvstore:CreateInstance'],
    ['DescribeInstanceAttributeRequest', 'redis', 'kvstore:DescribeInstanceAttribute'],
    ['DescribeInstancesRequest', 'redis', 'kvstore:DescribeInstances'],
    ['DescribeDBInstanceNetInfoRequest', 'redis', 'kvstore:DescribeDBInstanceNetInfo'],
    ['DescribeAvailableResourceRequest', 'redis', 'kvstore:DescribeAvailableResource'],
    ['ModifySecurityIpsRequest', 'redis', 'kvstore:ModifySecurityIps'],
    ['AllocateInstancePublicConnectionRequest', 'redis', 'kvstore:AllocateInstancePublicConnection'],
    ['DeleteInstanceRequest', 'redis', 'kvstore:DeleteInstance'],
  ],
  'packages/providers/src/aliyun/alibaba-cloud-capability-service.ts': [
    ['CreateDBInstanceRequest', 'rds', 'rds:CreateDBInstance'],
    ['DescribeDBInstancesRequest', 'rds', 'rds:DescribeDBInstances'],
    ['DescribeAvailableClassesRequest', 'rds', 'rds:DescribeAvailableClasses'],
    ['CreateInstanceRequest', 'redis', 'kvstore:CreateInstance'],
    ['DescribeRedisInstancesRequest', 'redis', 'kvstore:DescribeInstances'],
    ['DescribeInstancesRequest', 'ecs', 'ecs:DescribeInstances'],
    ['DescribeVpcsRequest', 'vpc', 'vpc:DescribeVpcs'],
    ['DescribePriceRequest', 'ecs', 'ecs:DescribePrice'],
    ['DescribeAvailableResourceRequest', 'ecs', 'ecs:DescribeAvailableResource'],
  ],
  'packages/providers/src/aliyun/real-cloud-provider.ts': [
    ['RunInstancesRequest', 'ecs', 'ecs:RunInstances'],
    ['DeleteInstanceRequest', 'ecs', 'ecs:DeleteInstance'],
    ['DescribeImagesRequest', 'ecs', 'ecs:DescribeImages'],
    ['CreateSecurityGroupRequest', 'ecs', 'ecs:CreateSecurityGroup'],
    ['DescribeSecurityGroupsRequest', 'ecs', 'ecs:DescribeSecurityGroups'],
    ['AuthorizeSecurityGroupRequest', 'ecs', 'ecs:AuthorizeSecurityGroup'],
    ['AllocatePublicIpAddressRequest', 'ecs', 'ecs:AllocatePublicIpAddress'],
    ['DescribeInstancesRequest', 'ecs', 'ecs:DescribeInstances'],
    ['DescribeVpcsRequest', 'vpc', 'vpc:DescribeVpcs'],
    ['DescribeVSwitchesRequest', 'vpc', 'vpc:DescribeVSwitches'],
    ['DescribeZonesRequest', 'ecs', 'ecs:DescribeZones'],
    ['CreateVpcRequest', 'vpc', 'vpc:CreateVpc'],
    ['CreateVSwitchRequest', 'vpc', 'vpc:CreateVSwitch'],
  ],
  'packages/providers/src/aliyun/alibaba-cloud-ecs-planner.ts': [
    ['DescribeAvailableResourceRequest', 'ecs', 'ecs:DescribeAvailableResource'],
    ['DescribeInstanceTypesRequest', 'ecs', 'ecs:DescribeInstanceTypes'],
    ['DescribeZonesRequest', 'ecs', 'ecs:DescribeZones'],
    ['DescribeImagesRequest', 'ecs', 'ecs:DescribeImages'],
    ['DescribePriceRequest', 'ecs', 'ecs:DescribePrice'],
    ['DescribeInstancesRequest', 'ecs', 'ecs:DescribeInstances'],
    ['DescribeVpcsRequest', 'vpc', 'vpc:DescribeVpcs'],
    ['DescribeVSwitchesRequest', 'vpc', 'vpc:DescribeVSwitches'],
  ],
  'packages/providers/src/aliyun/alibaba-cloud-ecs-provisioner.ts': [
    ['RunInstancesRequest', 'ecs', 'ecs:RunInstances'],
    ['DeleteInstanceRequest', 'ecs', 'ecs:DeleteInstance'],
    ['DescribeImagesRequest', 'ecs', 'ecs:DescribeImages'],
    ['DescribeInstancesRequest', 'ecs', 'ecs:DescribeInstances'],
    ['AllocatePublicIpAddressRequest', 'ecs', 'ecs:AllocatePublicIpAddress'],
    ['CreateSecurityGroupRequest', 'ecs', 'ecs:CreateSecurityGroup'],
    ['DescribeSecurityGroupsRequest', 'ecs', 'ecs:DescribeSecurityGroups'],
    ['AuthorizeSecurityGroupRequest', 'ecs', 'ecs:AuthorizeSecurityGroup'],
    ['TagResourcesRequest', 'ecs', 'ecs:TagResources'],
    ['DescribeVpcsRequest', 'vpc', 'vpc:DescribeVpcs'],
    ['DescribeVSwitchesRequest', 'vpc', 'vpc:DescribeVSwitches'],
    ['DescribeZonesRequest', 'ecs', 'ecs:DescribeZones'],
    ['CreateVpcRequest', 'vpc', 'vpc:CreateVpc'],
    ['CreateVSwitchRequest', 'vpc', 'vpc:CreateVSwitch'],
  ],
};

const byProduct = {
  rds: new Set(),
  redis: new Set(),
  ecs: new Set(),
  vpc: new Set(),
  dns: new Set([
    'alidns:AddDomainRecord',
    'alidns:DescribeDomainRecords',
    'alidns:DeleteDomainRecord',
  ]),
};

const sourceFiles = Object.keys(FILE_ACTIONS);
for (const rel of sourceFiles) {
  const text = readFileSync(resolve(root, rel), 'utf8');
  for (const [token, product, action] of FILE_ACTIONS[rel]) {
    if (text.includes(token)) {
      byProduct[product]?.add(action);
    }
  }
}

const out = {
  generatedAt: new Date().toISOString(),
  sourceFiles,
  actions: Object.fromEntries(
    Object.entries(byProduct).map(([k, v]) => [k, [...v].sort()]),
  ),
};

mkdirSync(resolve(root, 'docs'), { recursive: true });
writeFileSync(
  resolve(root, 'docs/aliyun-required-actions.json'),
  JSON.stringify(out, null, 2) + '\n',
);

const rdsActions = [...byProduct.rds].sort();
const redisActions = [...byProduct.redis].sort();
const ecsActions = [...byProduct.ecs].sort();
const vpcActions = [...byProduct.vpc].sort();

const rdsMd = `# 阿里云最小权限（LaunchOS · RDS）

> 由 \`scripts/generate-aliyun-required-actions.mjs\` 根据 Provider 实际 OpenAPI 调用生成。
> 不要授予 \`AdministratorAccess\`。

## 账户职责

| ProviderAccount | 用途 |
|-----------------|------|
| \`ALIYUN_DNS\` | 域名 / DNS / ACME TXT |
| \`ALIYUN\` | ECS / RDS / Redis / VPC 等云资源 |

RDS / Redis 创建**禁止**使用 \`ALIYUN_DNS\` 凭证。

## RDS RAM Actions

\`\`\`json
${JSON.stringify(rdsActions, null, 2)}
\`\`\`

## ECS RAM Actions

\`\`\`json
${JSON.stringify(ecsActions, null, 2)}
\`\`\`

## VPC RAM Actions

\`\`\`json
${JSON.stringify(vpcActions, null, 2)}
\`\`\`

生成时间：${out.generatedAt}
`;

const redisMd = `# 阿里云最小权限（LaunchOS · Redis）

> 由 \`scripts/generate-aliyun-required-actions.mjs\` 根据 \`AlibabaCloudRedisProvider\` 实际 OpenAPI 调用生成。
> 不要授予 \`AdministratorAccess\`。

## 账户职责

| ProviderAccount | 用途 |
|-----------------|------|
| \`ALIYUN\` | Redis / ECS 网络探测 / VPC |
| \`ALIYUN_DNS\` | 仅 DNS，不可用于 Redis 创建 |

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

\`\`\`json
${JSON.stringify(redisActions, null, 2)}
\`\`\`

## 推荐自定义策略模板（Redis）

\`\`\`json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ${JSON.stringify(redisActions, null, 8).replace(/\n/g, '\n      ')},
      "Resource": "*"
    }
  ]
}
\`\`\`

生成时间：${out.generatedAt}
`;

writeFileSync(resolve(root, 'docs/aliyun-rds-permissions.md'), rdsMd);
writeFileSync(resolve(root, 'docs/aliyun-redis-permissions.md'), redisMd);

const ecsMd = `# 阿里云最小权限（LaunchOS · ECS）

> 由 \`scripts/generate-aliyun-required-actions.mjs\` 根据 ECS Provider / Planner 实际 OpenAPI 调用生成。
> 不要授予 \`AdministratorAccess\`。

## 账户职责

| ProviderAccount | 用途 |
|-----------------|------|
| \`ALIYUN\` | ECS / VPC / 询价 / 规格发现 |
| \`ALIYUN_DNS\` | 仅 DNS，不可用于 ECS |

## Step 26.1 说明

服务器规划阶段会调用：

- DescribeAvailableResource
- DescribeInstanceTypes
- DescribeZones
- DescribeImages
- DescribePrice
- DescribeInstances（评估已有服务器）
- VPC / VSwitch 读取

规划阶段**不会**调用 \`RunInstances\`。

## Step 26.2 说明

托管创建阶段会额外调用：

- RunInstances（仅在 confirmBilling + 全部门禁就绪后）
- DescribeInstances（创建前 reconcile / 等待 Running）
- CreateSecurityGroup / AuthorizeSecurityGroup / DescribeSecurityGroups
- AllocatePublicIpAddress（如 RunInstances 未带公网 IP）
- DeleteInstance（显式释放）
- TagResources
- 必要时 CreateVpc / CreateVSwitch（优先复用 NetworkPlan）

\`ecs:DescribePrice\` 必须 READY，否则禁止进入真实创建。

## ECS RAM Actions

\`\`\`json
${JSON.stringify(ecsActions, null, 2)}
\`\`\`

## VPC RAM Actions

\`\`\`json
${JSON.stringify(vpcActions, null, 2)}
\`\`\`

## 推荐自定义策略模板（ECS 规划 + 后续创建）

\`\`\`json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": ${JSON.stringify([...ecsActions, ...vpcActions].sort(), null, 8).replace(/\n/g, '\n      ')},
      "Resource": "*"
    }
  ]
}
\`\`\`

生成时间：${out.generatedAt}
`;

writeFileSync(resolve(root, 'docs/aliyun-ecs-permissions.md'), ecsMd);
console.log('wrote docs/aliyun-required-actions.json');
console.log('wrote docs/aliyun-rds-permissions.md');
console.log('wrote docs/aliyun-redis-permissions.md');
console.log('wrote docs/aliyun-ecs-permissions.md');
console.log(
  `counts rds=${rdsActions.length} redis=${redisActions.length} ecs=${ecsActions.length} vpc=${vpcActions.length}`,
);
