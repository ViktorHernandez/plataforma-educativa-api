import { defineConfig } from "vitest/config";

const shared = {
  environment: "node" as const,
  setupFiles: ["test/setup-env.ts"],
  fileParallelism: false,
  testTimeout: 30_000,
  hookTimeout: 60_000,
  pool: "forks" as const,
};

export default defineConfig({
  test: {
    reporters: ["default"],
    projects: [
      { test: { ...shared, name: "unit", include: ["test/unit/**/*.test.ts"] } },
      { test: { ...shared, name: "integration", include: ["test/integration/**/*.test.ts"], globalSetup: ["test/global-setup.ts"] } },
    ],
  },
});
