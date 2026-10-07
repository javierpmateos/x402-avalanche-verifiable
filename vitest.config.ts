import { defineConfig } from "vitest/config";

// Local-chain tests share one node and the same sender accounts, so files run
// one at a time to keep transaction nonces ordered.
export default defineConfig({ test: { fileParallelism: false } });
