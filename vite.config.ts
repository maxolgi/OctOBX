import { defineConfig } from "vite";
import { readFileSync } from "fs";

export default defineConfig({
    publicDir: "wasm/build",
    server: {
        host: "0.0.0.0",
        port: 8080,
        https: {
            key: readFileSync("./certs/key.pem"),
            cert: readFileSync("./certs/cert.pem"),
        },
        headers: {
            "Cross-Origin-Opener-Policy": "same-origin",
            "Cross-Origin-Embedder-Policy": "require-corp",
            "Cross-Origin-Resource-Policy": "same-origin",
        },
    },
    optimizeDeps: {
        exclude: ["@opendaw/studio-core"],
    },
    build: {
        target: "es2022",
    },
});
