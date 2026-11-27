import path from "path";
import { defineConfig, type Plugin } from "vite";
import preact from "@preact/preset-vite";
import tailwindcss from "@tailwindcss/vite";

/** In development, /book and /book/* show the client booking page (book.html). */
function bookingPage(): Plugin {
  return {
    name: "tolly-booking-page",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const path = (req.url ?? "").split("?")[0];
        if ((path === "/book" || path.startsWith("/book/")) && !path.includes(".")) req.url = "/book.html";
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [bookingPage(), preact(), tailwindcss()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: path.resolve(__dirname, "index.html"),
        book: path.resolve(__dirname, "book.html"),
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src/client"),
      react: "preact/compat",
      "react-dom": "preact/compat",
      "react/jsx-runtime": "preact/jsx-runtime",
      "react-dom/test-utils": "preact/test-utils",
    },
  },
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:8787",
        changeOrigin: true,
      },
    },
  },
});
