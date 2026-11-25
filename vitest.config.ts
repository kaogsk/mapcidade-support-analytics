import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Every suite pins its own clock; the process TZ is set to something that is
    // NOT Brasília so a hidden dependency on the local timezone fails loudly.
    env: { TZ: "Asia/Tokyo" },
  },
});
