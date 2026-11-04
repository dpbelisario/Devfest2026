import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// In dev, forward /api to the local FastAPI server so code can always use
// relative URLs (in production Firebase Hosting rewrites /api to Cloud Run).
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": "http://localhost:8080" },
  },
});
