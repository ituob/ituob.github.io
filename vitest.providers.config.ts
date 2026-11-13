import { defineConfig } from "vitest/config";

// Provider protocol tests use real WebCrypto and an HTTP transport seam.
// D1/workerd integration remains covered by the main Worker test config.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/email.test.ts", "test/publisher.test.ts", "test/access.test.ts", "test/deployment-config.test.ts"],
  },
});
