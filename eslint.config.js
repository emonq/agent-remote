// 合理的 lint: 推荐规则集打底 + 关键质量/异步规则, 不含纯风格约束 (风格交给 formatter)
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

// 浏览器全局 (前端脚本)
const browser = Object.fromEntries(
  ['document', 'location', 'fetch', 'localStorage', 'navigator', 'alert', 'confirm',
    'setTimeout', 'setInterval', 'clearInterval', 'URLSearchParams', 'console']
    .map((g) => [g, 'readonly']),
);
// Node 全局 (测试/配置脚本)
const node = { ...browser, process: 'readonly' };

const noUnused = ['error', { argsIgnorePattern: '^_' }];
// recommended 不含、但值得开的跨语言质量规则
const quality = {
  // === 强制, 但放行 == null (null/undefined 双关检查的惯用法)
  eqeqeq: ['error', 'always', { null: 'ignore' }],
  'no-throw-literal': 'error',
};

export default tseslint.config(
  { ignores: ['dist/', 'data/', 'node_modules/'] },

  {
    // TS 源码: typescript-eslint 推荐集 + 两条类型感知异步规则
    //   no-floating-promises: 未处理(无 await/.catch)的 promise — 本项目大量 .catch() 模式正好被规范
    //   await-thenable: await 非 promise
    // no-unsafe-* / no-misused-promises 不开: 飞书动态事件/卡片结构用 any 是合理的, 开了全是噪音
    files: ['src/**/*.ts'],
    extends: [tseslint.configs.recommended],
    languageOptions: { parserOptions: { projectService: true } },
    rules: {
      ...quality,
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': noUnused,
      '@typescript-eslint/no-explicit-any': 'warn', // 动态外部数据用 any 合理, 但提示一下便于审视
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/await-thenable': 'error',
      // 锁死 any 流入: 任何从 any 上取属性/传参/赋值/调用/返回都报错, 防止 any 静默扩散
      '@typescript-eslint/no-unsafe-argument': 'error',
      '@typescript-eslint/no-unsafe-assignment': 'error',
      '@typescript-eslint/no-unsafe-call': 'error',
      '@typescript-eslint/no-unsafe-member-access': 'error',
      '@typescript-eslint/no-unsafe-return': 'error',
    },
  },

  {
    // 前端脚本: 无类型系统, 走 ESLint 推荐集 + no-undef (未定义变量)
    files: ['public/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: browser },
    rules: { ...quality, 'no-unused-vars': noUnused },
  },

  {
    // 测试/配置脚本: Node 环境 (process 等), 走 ESLint 推荐集
    files: ['tests/**/*.mjs', 'eslint.config.js'],
    extends: [js.configs.recommended],
    languageOptions: { ecmaVersion: 2024, sourceType: 'module', globals: node },
    rules: { ...quality, 'no-unused-vars': noUnused },
  },
);