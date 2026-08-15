import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

/**
 * Unit tests only, and deliberately so.
 *
 * What is worth testing here is the arithmetic and the cryptography: the
 * commission calculator against every worked example in SPEC §8, and the
 * signature checks that decide whether a payment is real. Both are pure
 * functions over integers and bytes, which is why they were written as pure
 * functions over integers and bytes.
 *
 * Anything that needs a database is not tested here. The rules that live in
 * Postgres — the row lock, the balanced-ledger constraint trigger, the RLS
 * policies — are enforced by Postgres, and a mock of Postgres would only test
 * the mock.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
