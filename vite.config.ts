import { defineConfig } from "vite";
import { readFileSync, existsSync, statSync, createReadStream, readdirSync, copyFileSync, mkdirSync } from "fs";
import { join, normalize } from "path";
import { fileURLToPath } from "url";

const MIME: Record<string, string> = {
    ".svg": "image/svg+xml",
    ".ttf": "font/ttf",
    ".png": "image/png",
    ".js": "text/javascript",
    ".wasm": "application/wasm",
    ".json": "application/json",
    ".css": "text/css",
    ".html": "text/html",
};

// Vite only supports one publicDir; this plugin adds public/ as a second
// static root so OB-Xf SVG assets are served alongside the wasm/build/ files.
// In dev (configureServer) it serves public/ live; at build time
// (closeBundle) it copies public/ into dist/ so `vite build` output is
// complete — without this the OB-Xf editor's SVGs/fonts would 404 in the
// production bundle.
function servePublicDir() {
    const pubDir = join(process.cwd(), "public");
    function copyPublicToDist(outDir: string) {
        const walk = (dir: string, rel: string) => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
                const relPath = rel ? `${rel}/${entry.name}` : entry.name;
                if (entry.isDirectory()) walk(join(dir, entry.name), relPath);
                else if (entry.isFile()) {
                    mkdirSync(join(outDir, rel), { recursive: true });
                    copyFileSync(join(dir, entry.name), join(outDir, relPath));
                }
            }
        };
        walk(pubDir, "");
    }
    return {
        name: "serve-public-dir",
        configureServer(server: { middlewares: { use: (fn: any) => void } }) {
            server.middlewares.use((req: any, res: any, next: () => void) => {
                if (!req.url || (req.method !== "GET" && req.method !== "HEAD")) return next();
                const pathname = decodeURIComponent(new URL(req.url, "http://x").pathname);
                const filePath = normalize(join(pubDir, pathname));
                if (!filePath.startsWith(pubDir)) return next();
                if (!existsSync(filePath) || !statSync(filePath).isFile()) return next();
                const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
                res.setHeader("Content-Type", MIME[ext] || "application/octet-stream");
                res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
                if (req.method === "HEAD") { res.end(); return; }
                createReadStream(filePath).pipe(res);
            });
        },
        closeBundle() {
            copyPublicToDist(join(process.cwd(), "dist"));
        },
    };
}

export default defineConfig({
    publicDir: "wasm/build",
    plugins: [servePublicDir()],
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
    build: {
        target: "es2022",
    },
});
