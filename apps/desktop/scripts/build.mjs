import * as esbuild from "esbuild";
import { cpSync, mkdirSync } from "node:fs";

function copyStatic() {
  mkdirSync("dist", { recursive: true });
  cpSync("src/renderer/index.html", "dist/index.html");
  cpSync("src/renderer/styles.css", "dist/styles.css");
  cpSync("src/renderer/audio/pcm-worklet.js", "dist/pcm-worklet.js");
  cpSync("src/home/home.html", "dist/home.html");
  cpSync("src/home/home.css", "dist/home.css");
  cpSync("src/onboard/onboard.html", "dist/onboard.html");
  cpSync("src/onboard/onboard.css", "dist/onboard.css");
}

const buildId = process.env.GITHUB_SHA || process.env.BUILD_ID || `${Date.now()}`;

export const configs = [
  {
    entryPoints: ["src/main/index.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: "dist/main.js",
    sourcemap: true,
    external: ["electron"],
    define: {
      __BUILD_ID__: JSON.stringify(buildId),
    },
  },
  {
    entryPoints: ["src/preload/index.ts"],
    bundle: true,
    platform: "node",
    format: "cjs",
    outfile: "dist/preload.js",
    sourcemap: true,
    external: ["electron"],
  },
  {
    entryPoints: ["src/renderer/app.ts"],
    bundle: true,
    platform: "browser",
    format: "iife",
    outfile: "dist/renderer.js",
    sourcemap: true,
  },
  {
    entryPoints: ["src/home/home.ts"],
    bundle: true,
    platform: "browser",
    format: "iife",
    outfile: "dist/home.js",
    sourcemap: true,
  },
  {
    entryPoints: ["src/onboard/onboard.ts"],
    bundle: true,
    platform: "browser",
    format: "iife",
    outfile: "dist/onboard.js",
    sourcemap: true,
  },
];

export async function buildOnce() {
  copyStatic();
  await Promise.all(configs.map((c) => esbuild.build(c)));
}

const isMain = process.argv[1]?.endsWith("build.mjs");
if (isMain) {
  await buildOnce();
}
