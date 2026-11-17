import { defineConfig } from "vitest/config";
export default defineConfig({ test: { environment: "node", include: ["test/general-messages.node.ts"] } });
