export default [
  { files: ['src/**/*.ts', 'tests/**/*.ts'],
    languageOptions: { parser: undefined },
    rules: { 'no-throw-literal': 'error' } }
];
