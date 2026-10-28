import { defineConfig } from "vite";
import { build } from "esbuild";
import { version } from "./package.json";
export default defineConfig({
  plugins: [
    {
      name: "embedded-worker",
      async transformIndexHtml(html) {
        const worker = await build({
          entryPoints: ["src/crypto/worker.ts"],
          bundle: true,
          write: false,
          platform: "browser",
          format: "iife",
          target: "es2022",
        });
        return html
          .replaceAll("__APP_VERSION__", version.replace(/\.0$/, ""))
          .replace("__WORKER_SOURCE__", () =>
            worker.outputFiles[0].text.replace(/<\/script/gi, "<\\/script"),
          );
      },
    },
  ],
});
