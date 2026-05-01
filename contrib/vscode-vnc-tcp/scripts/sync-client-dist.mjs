import { cp, rm } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const sourceDir = resolve(root, "..", "web-vnc-client", "dist");
const targetDir = resolve(root, "media", "client-dist");

await rm(targetDir, { recursive: true, force: true });
await cp(sourceDir, targetDir, { recursive: true });

console.log(`Synced client dist: ${sourceDir} -> ${targetDir}`);
