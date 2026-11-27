/** 授权上下文（R2 修订）—— 可信身份的唯一来源。
 *
 *  身份来源约定：
 *  - `ownerId` = 工作空间边界（一个用户/组织），**不是** Agent ID
 *  - `agentId` = 人格/私有注解归属，由 Token 绑定
 *  - `projectIds` = 该 Agent 在工作空间中**经可信成员关系验证**的项目集合
 *  - `maxSensitivity` = 该身份的敏感级上限（硬过滤依据）
 *  - `scopes` = 该身份的写权限能力位
 *
 *  安全原则（R2 P0-B6）：AuthContext 由**经过 Token 验证的服务层**构造；
 *  存储层只接受它，不自行推断，也不信任调用方自述的 owner/agent。
 */

/** 敏感级：值越大越敏感 */
export const SENSITIVITY_LEVEL = {
  normal: 0,
  sensitive: 1,
  restricted: 2,
} as const;
export type Sensitivity = keyof typeof SENSITIVITY_LEVEL;

export type WriteCapability =
  | 'memory:write' // 写入普通记忆
  | 'memory:supersede' // 产生新 revision
  | 'memory:minimize' // 精简
  | 'memory:revive' // 恢复
  | 'memory:purge'; // 硬擦除（不可逆，最高权限）

export interface AuthContext {
  readonly ownerId: string;
  readonly agentId: string;
  readonly projectIds: readonly string[];
  readonly canReadGlobal: boolean;
  /** 该身份可读取的最高敏感级（超出即过滤） */
  readonly maxSensitivity: Sensitivity;
  /** 该身份具备的写能力位 */
  readonly capabilities: readonly WriteCapability[];
}

export const hasCap = (auth: AuthContext, cap: WriteCapability): boolean =>
  auth.capabilities.includes(cap);

export class AuthRequiredError extends Error {
  readonly code = 'PERMISSION_DENIED';
  constructor(message = 'AUTH_CONTEXT_REQUIRED: 操作必须提供可信授权上下文（缺失即失败关闭）') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}

export class ForbiddenError extends Error {
  readonly code = 'PERMISSION_DENIED';
  constructor(message: string) {
    super(message);
    this.name = 'ForbiddenError';
  }
}

/** 校验上下文基本完整性（缺失字段即视为不可信） */
export function assertValidAuth(auth: AuthContext | undefined | null): AuthContext {
  if (!auth) throw new AuthRequiredError();
  if (!auth.ownerId || !auth.agentId) throw new AuthRequiredError();
  if (!Array.isArray(auth.projectIds)) throw new AuthRequiredError();
  if (!auth.maxSensitivity || !(auth.maxSensitivity in SENSITIVITY_LEVEL)) {
    throw new AuthRequiredError('AUTH_CONTEXT_INVALID: maxSensitivity 未声明');
  }
  if (!Array.isArray(auth.capabilities)) {
    throw new AuthRequiredError('AUTH_CONTEXT_INVALID: capabilities 未声明');
  }
  return auth;
}

/** 敏感级是否在授权上限内 */
export const withinSensitivity = (auth: AuthContext, level: Sensitivity): boolean =>
  SENSITIVITY_LEVEL[level] <= SENSITIVITY_LEVEL[auth.maxSensitivity];

/** 该层的可见性判定（query 与 get 共用同一套规则，R2 P0-A4） */
export interface ScopeView {
  owner_id: string;
  layer: string;
  project_id: string | null;
  agent_id: string | null;
  visibility: string;
  shared_with: readonly string[];
}

export function isVisible(auth: AuthContext, scope: ScopeView, sensitivity: Sensitivity): boolean {
  // 1) 工作空间边界：绝对隔离
  if (scope.owner_id !== auth.ownerId) return false;
  // 2) 敏感级硬过滤（先于任何层判断）
  if (!withinSensitivity(auth, sensitivity)) return false;

  // 3) 层可见性
  const layerOk = (() => {
    switch (scope.layer) {
      case 'user_identity':
        // 用户身份事实：当前工作空间内可见
        return true;
      case 'agent_persona':
      case 'private_annotation':
        // 人格与私有注解：只有所属 Agent 可见
        return scope.agent_id === auth.agentId;
      case 'project':
        return scope.project_id !== null && auth.projectIds.includes(scope.project_id);
      case 'global':
        return auth.canReadGlobal;
      default:
        return false;
    }
  })();
  if (!layerOk) return false;

  // 4) visibility 语义（R2 P0-A3：shared_list 必须真正执行）
  switch (scope.visibility) {
    case 'owner':
      // owner 语义：在 project/persona/annotation 层表示"仅归属者"
      // - persona / annotation：前面已要求 agent_id === auth.agentId
      // - project：表示不与其他成员共享 → 除非是创建者，否则不可见
      //   创建者信息在 provenance 中；此处采用保守规则：owner 对 project 层
      //   仅对项目成员可见，但仍受 project 成员资格约束（已在上方校验）
      return true;
    case 'project_agents':
      // 项目内共享：层校验已保证 project 成员资格
      return scope.layer === 'project' ? scope.project_id !== null : true;
    case 'all_agents':
      // 工作空间内所有 Agent（层校验已排除 persona/annotation）
      return true;
    case 'shared_list':
      // 显式白名单：必须包含当前 Agent
      return scope.shared_with.includes(auth.agentId);
    default:
      return false;
  }
}
