import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

const here = import.meta.dirname;

export default defineConfig({
  plugins: [react()],
  // `--host` alone is not enough: phones load this page over the LAN, and the pages import two
  // things from OUTSIDE this package — `clients/sdk` (the one wrapper over the generated
  // bindings) and the module's pure `inventory.ts`, which the admin calls to preview exactly
  // what `start_countdown` will compute. Vite refuses to serve files above its root unless the
  // paths are allowed here.
  server: {
    host: true,
    fs: { allow: [resolve(here, ".."), resolve(here, "../../fair-drop-db")] },
  },
  build: {
    rollupOptions: {
      input: {
        participant: resolve(here, "index.html"),
        admin: resolve(here, "admin.html"),
      },
    },
  },
});
