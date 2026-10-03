import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "src/generated", "coverage", "storage"] },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        projectService: { allowDefaultProject: ["eslint.config.js"] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: { arguments: false } }],
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/only-throw-error": "error",
      "no-console": "error",
      "eqeqeq": ["error", "always"],
      "no-restricted-syntax": [
        "error",
        {
          "selector": "CallExpression[callee.property.name=/^\\$(queryRawUnsafe|executeRawUnsafe)$/]",
          "message": "Use parameterized $queryRaw/$executeRaw tagged templates."
        }
      ]
    },
  },
  {
    files: ["scripts/**/*.ts", "src/scripts/**/*.ts"],
    rules: { "no-console": "off" },
  },
  {
    files: ["test/**/*.ts", "scripts/**/*.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/no-explicit-any": "off",
      "no-restricted-syntax": "off",
    },
  },
);
