import { defineConfig } from "@lovable.dev/vite-tanstack-config";
import { loadEnv } from "vite";

const envLoaded = loadEnv(
  process.env["NODE_ENV"] || "development",
  process.cwd(),
  ""
);

Object.assign(process.env, envLoaded);

export default defineConfig({
  tanstackStart: {
    server: { entry: "server" },
  },

  nitro: {
    preset: "node-server",
  },

  vite: {
    optimizeDeps: {
      include: [
        "react",
        "react-dom",
        "react-dom/client",
        "@tanstack/react-query",
        "@radix-ui/react-tooltip",
        "@radix-ui/react-dialog",
        "@radix-ui/react-select",
        "@radix-ui/react-tabs",
        "xlsx",
        "sonner",
        "recharts",
      ],
    },
  },
});