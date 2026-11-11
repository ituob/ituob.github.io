import { defineConfig } from "vitest/config";

// Form-foundation tests are pure TypeScript over files on disk, so they run
// in plain node (the Worker suite in vitest.config.ts runs in workerd, which
// has no filesystem). `npm run test:form`.
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/lib/form/**/*.test.ts"],
    testTimeout: 900_000,
  },
});
