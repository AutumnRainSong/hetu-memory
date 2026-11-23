import { describe, it, expect } from 'vitest';
import { ErrorCodes } from '../src/errors/registry.ts';

describe('工程骨架 smoke', () => {
  it('错误码注册表可导入', () => {
    expect(ErrorCodes.STATE_CONFLICT).toBe('STATE_CONFLICT');
    expect(Object.keys(ErrorCodes).length).toBeGreaterThanOrEqual(17);
  });
});
