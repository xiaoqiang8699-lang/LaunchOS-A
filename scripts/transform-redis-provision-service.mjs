import { readFileSync, writeFileSync } from 'node:fs';

const path = 'apps/api/src/redis-provision/redis-provision.service.ts';
let t = readFileSync(path, 'utf8');
const pairs = [
  ['DATABASE_PROVISION_PHASE_LABELS', 'REDIS_PROVISION_PHASE_LABELS'],
  ['DATABASE_PROVISION_QUEUE_STALL_USER_MESSAGE', 'REDIS_PROVISION_QUEUE_STALL_USER_MESSAGE'],
  ['cloudDatabaseErrorUserMessage', 'cloudRedisErrorUserMessage'],
  ['databaseProvisionJobId', 'redisProvisionJobId'],
  ['generateManagedDbPassword', 'generateManagedRedisPassword'],
  ['generateManagedDbUsername', 'UNUSED_generateManagedDbUsername'],
  ['sanitizeDatabaseName', 'sanitizeRedisInstanceName'],
  ['CloudDatabaseErrorCode', 'CloudRedisErrorCode'],
  ['DatabaseProvisionPhase', 'RedisProvisionPhase'],
  ['DatabaseProvisionTier', 'RedisProvisionTier'],
  ['AlibabaCloudDatabaseProvider', 'AlibabaCloudRedisProvider'],
  ['DatabaseConnectionsService', 'RedisConnectionsService'],
  ['DatabaseProvisionQueueService', 'RedisProvisionQueueService'],
  ['database-connections/database-connections.service', 'redis-connections/redis-connections.service'],
  ['database-provision-queue.service', 'redis-provision-queue.service'],
  ['CreateDatabaseProvisionDto', 'CreateRedisProvisionDto'],
  ['DeleteDatabaseProvisionDto', 'DeleteRedisProvisionDto'],
  ['database-provision.dto', 'redis-provision.dto'],
  ['DatabaseProvisionService', 'RedisProvisionService'],
  ['CloudResourceType.DATABASE', 'CloudResourceType.CACHE'],
  ["resourceKind: 'RDS_POSTGRESQL'", "resourceKind: 'ALIYUN_REDIS'"],
  ["displayName: 'PostgreSQL 数据库'", "displayName: '阿里云 Redis'"],
  ['databaseName', 'instanceName'],
  ['databaseConnections', 'redisConnections'],
  ['databaseConnectionId', 'redisConnectionId'],
  ['CreateDBInstance', 'CreateInstance'],
  ['RDS_PERMISSION_DENIED', 'REDIS_PERMISSION_DENIED'],
  ["'创建数据库'", "'创建 Redis'"],
  ['缺少数据库创建权限', '缺少 Redis 创建权限'],
  ['数据库正在创建中', 'Redis 正在创建中'],
  ['数据库创建只能使用', 'Redis 创建只能使用'],
  ['当前数据库状态不可重试', '当前 Redis 状态不可重试'],
  ['未找到数据库资源', '未找到 Redis 资源'],
  ['无权限创建或管理云数据库', '无权限创建或管理云 Redis'],
  ['删除云数据库', '删除云 Redis'],
  ['PostgreSQL 数据库', '阿里云 Redis'],
  ['正在创建 PostgreSQL 数据库', '正在创建 Redis'],
  ['正在配置数据库网络', '正在配置 Redis 网络'],
  ['正在创建数据库账号', '正在准备访问凭证'],
  ['正在测试数据库连接', '正在测试 Redis 连接'],
  ['创建云数据库', '创建 Redis'],
  ['创建数据库账号', '准备访问凭证'],
  ['测试数据库连接', '测试 Redis 连接'],
  ['数据库创建失败', 'Redis 创建失败'],
  ['数据库已就绪', 'Redis 已就绪'],
  ['requireProjectDatabase', 'requireProjectCache'],
  ["engine: 'PostgreSQL'", "engine: 'Redis'"],
  ['suggestedDatabaseName', 'suggestedInstanceName'],
  ['DATABASE_PROVISION_IN_PROGRESS', 'REDIS_PROVISION_IN_PROGRESS'],
  ['.rds?', '.redis?'],
  ['queueReady.databaseProvision', 'queueReady.redisProvision'],
  ['CREATING_ACCOUNT', 'PREPARING_AUTH'],
];
for (const [a, b] of pairs) t = t.split(a).join(b);

t = t.replace(/const username = UNUSED_generateManagedDbUsername\([^)]*\);\r?\n/, '');
t = t.replace(/\n\s*username,\r?\n/, '\n');
t = t.replace(
  /usernameConfigured: Boolean\(meta\.username\)/,
  'passwordConfigured: Boolean(meta.passwordEncrypted)',
);
t = t.replace(
  /const instanceName = sanitizeRedisInstanceName\(\s*dto\.instanceName \|\| project\.slug,\s*`app_\$\{project\.slug\}`,\s*\);/,
  'const instanceName = sanitizeRedisInstanceName(dto.instanceName || project.slug);',
);
t = t.replace(
  `const STEP_ORDER: RedisProvisionPhase[] = [
  'CREATING_INSTANCE',
  'PREPARING_NETWORK',
  'PREPARING_AUTH',
  'TESTING_CONNECTION',
  'BINDING',
];`,
  `const STEP_ORDER: RedisProvisionPhase[] = [
  'CREATING_INSTANCE',
  'WAITING_INSTANCE',
  'PREPARING_NETWORK',
  'PREPARING_AUTH',
  'TESTING_CONNECTION',
  'BINDING',
];`,
);
t = t.replace(
  `const STEP_LABELS = [
  '创建 Redis',
  '准备网络',
  '准备访问凭证',
  '测试 Redis 连接',
  '绑定应用',
];`,
  `const STEP_LABELS = [
  '创建 Redis',
  '等待 Redis 就绪',
  '准备网络',
  '准备访问凭证',
  '测试 Redis 连接',
  '绑定应用',
];`,
);

// Fix resolveCurrentAction cases for redis phases
t = t.replace(
  `case 'PREPARING_AUTH':
      return '正在准备访问凭证…';`,
  `case 'WAITING_INSTANCE':
      return '正在等待 Redis 就绪…';
    case 'PREPARING_AUTH':
      return '正在准备访问凭证…';`,
);

writeFileSync(path, t);
console.log('ok', t.includes('UNUSED_generate'), t.includes('RedisProvisionService'));
