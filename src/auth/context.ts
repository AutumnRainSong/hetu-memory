/** 授权上下文（P0-A）：查询必须携带可信身份，缺失即失败关闭。
 *
 *  身份来源约定（与 README 产品目标一致）：
 *  - `ownerId` = 工作空间边界（一个用户或一个组织），**不是** Agent ID
 *  - `agentId` = 人格/私有注解归属，由 Token 绑定，**不可由调用方任意声称**
 *  - `projectIds` = 该 Agent 在当前工作空间中**经可信成员关系验证**的项目集合
 *
 *  Provider 不接受调用方传入的裸 `project_id` 作为授权依据——
 *  只能与 AuthContext 中的成员集合求交。
 */
export interface AuthContext {
  /** 工作空间边界 */
  readonly ownerId: string;
  /** 请求发起 Agent（由 token 绑定解析） */
  readonly agentId: string;
  /** 该 Agent 被授权访问的项目（可信成员关系，非客户端自述） */
  readonly projectIds: readonly string[];
  /** 是否可读整个工作空间的 global 层（由授权策略决定） */
  readonly canReadGlobal: boolean;
}

/** 查询可用的层：由 AuthContext 推导，调用方不可扩展 */
export const readableLayers = (auth: AuthContext): string[] => {
  const layers = ['project', 'user_identity'];
  if (auth.canReadGlobal) layers.push('global');
  // persona / private_annotation 只能读自己的
  layers.push('agent_persona', 'private_annotation');
  return layers;
};

export class AuthRequiredError extends Error {
  readonly code = 'PERMISSION_DENIED';
  constructor(message = 'AUTH_CONTEXT_REQUIRED: 查询必须提供可信授权上下文（缺失即失败关闭）') {
    super(message);
    this.name = 'AuthRequiredError';
  }
}
