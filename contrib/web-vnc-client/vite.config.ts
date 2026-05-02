import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5173,
  },
  build: {
    target: "es2020",
    rollupOptions: {
      output: {
        // Ensure workers are bundled as separate files, not inlined as data URLs
        // This preserves module import paths that would otherwise break
      },
    },
  },
  worker: {
    // Use a separate file for workers instead of inlining as data URL
    format: "es",
  },
});
