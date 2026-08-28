// Kept deliberately close to the frontend's config. The two repos cannot share a
// file without publishing a package, so the next best thing is that a rule means
// the same in both.
module.exports = {
  root: true,
  env: { node: true, es2022: true },
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  ignorePatterns: ['dist', 'node_modules', '.eslintrc.cjs'],
  parser: '@typescript-eslint/parser',
  rules: {
    // Provider SDKs and webhook payloads arrive as shapes we do not own, and
    // writing a type for every one of them would be fiction.
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }]
  }
};
