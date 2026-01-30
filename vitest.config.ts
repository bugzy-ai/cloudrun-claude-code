import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    root: ".",
  },
  resolve: {
    conditions: ["import", "node"],
    extensions: [".ts", ".js"],
  },
});
