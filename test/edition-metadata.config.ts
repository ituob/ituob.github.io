import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["test/edition-metadata.node.ts"] } });
