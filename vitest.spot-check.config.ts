import { defineConfig } from "vitest/config";

// The downloads spot-check reads real files (a temp dist tree), so it runs in Node, not workerd.
export default defineConfig({ test: { environment: "node", include: ["test/downloads-spot-check.node.ts"] } });
