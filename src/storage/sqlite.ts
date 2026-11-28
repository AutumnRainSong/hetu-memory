/** node:sqlite 间接层 —— 绕过 Vite 对 node: 内建模块外部化的解析问题。
 *  Node 22+/24 内置 SQLite（DatabaseSync），零原生依赖。
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
