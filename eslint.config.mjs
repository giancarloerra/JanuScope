// SPDX-License-Identifier: AGPL-3.0-only
// ESLint v9 flat config. See https://eslint.org/docs/latest/use/configure/configuration-files
//
// Mirrors the rules from the previous .eslintrc.json so CONTRIBUTING.md and
// `npm run lint` work on a fresh clone. TypeScript type-checked rules are
// deliberately not enabled — they require `parserOptions.project` and slow
// lint to several seconds per run, which hurts the contributor loop.

import js from "@eslint/js";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

const nodeGlobals = {
  process: "readonly",
  console: "readonly",
  Buffer: "readonly",
  NodeJS: "readonly",
  setTimeout: "readonly",
  clearTimeout: "readonly",
  setImmediate: "readonly",
  clearImmediate: "readonly",
  setInterval: "readonly",
  clearInterval: "readonly",
  structuredClone: "readonly",
  globalThis: "readonly",
};

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "coverage/**",
      ".benchmarks/**",
      "private/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["src/**/*.ts", "test/**/*.ts", "scripts/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: "module",
      globals: nodeGlobals,
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...tsPlugin.configs["eslint-recommended"].overrides?.[0]?.rules,
      ...tsPlugin.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
      "@typescript-eslint/explicit-function-return-type": "off",
      "no-console": "off",
      // Doc comments deliberately use U+200B (zero-width space) to
      // disambiguate `/**\u200B/` from a block-comment terminator.
      // The rule still runs on source outside comments.
      "no-irregular-whitespace": ["error", { skipComments: true }],
    },
  },
  {
    files: ["test/fixtures/**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: nodeGlobals,
    },
  },
];
