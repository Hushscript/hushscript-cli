// @ts-check
import eslint from "@eslint/js";
import { defineConfig } from "eslint/config";
import n from "eslint-plugin-n";
import * as regexp from "eslint-plugin-regexp";
import globals from "globals";
import { fileURLToPath } from "node:url";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    ignores: ["dist/**", "coverage/**", "reports/**", "node_modules/**", ".sdk/**"],
  },
  eslint.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  regexp.configs["flat/recommended"],
  n.configs["flat/recommended-module"],
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: fileURLToPath(new URL(".", import.meta.url)),
      },
    },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      // Conflicts with noPropertyAccessFromIndexSignature.
      "@typescript-eslint/dot-notation": "off",
      "@typescript-eslint/restrict-template-expressions": ["error", { allowNumber: true }],
      // TypeScript resolves imports (bundler resolution, .ts extensions); the plugin cannot.
      "n/no-missing-import": "off",
      // The bin's shebang is added by tsup's banner, not by the source.
      "n/hashbang": "off",
    },
  },
  {
    // JavaScript files are type-checked by their own project.
    files: ["**/*.{js,mjs}"],
    languageOptions: {
      parserOptions: { projectService: false, project: ["./tsconfig.scripts.json"] },
    },
  },
);
