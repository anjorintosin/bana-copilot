import * as esbuild from "esbuild";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { configs } from "./build.mjs";
import { cpSync, mkdirSync, existsSync, readFileSync } from "node:fs";

const require = createRequire(import.meta.url);
const electronPath = require("electron");

mkdirSync("dist", { recursive: true });
cpSync("src/renderer/index.html", "dist/index.html");
cpSync("src/renderer/styles.css", "dist/styles.css");
cpSync("src/renderer/audio/pcm-worklet.js", "dist/pcm-worklet.js");
cpSync("src/home/home.html", "dist/home.html");
cpSync("src/home/home.css", "dist/home.css");
cpSync("src/onboard/onboard.html", "dist/onboard.html");
cpSync("src/onboard/onboard.css", "dist/onboard.css");

let ec2Host = "";
try {
  if (existsSync("../../infra/ec2-host.txt")) {
    ec2Host = readFileSync("../../infra/ec2-host.txt", "utf8").trim();
  } else if (existsSync("infra/ec2-host.txt")) {
    ec2Host = readFileSync("infra/ec2-host.txt", "utf8").trim();
  }
} catch {
  /* optional */
}

const defaultHttp = process.env.MEETING_COPILOT_HTTP || (ec2Host ? `http://${ec2Host}:8787` : "http://127.0.0.1:8787");
const defaultWs = process.env.MEETING_COPILOT_API || (ec2Host ? `ws://${ec2Host}:8787/ws` : "ws://127.0.0.1:8787/ws");

const contexts = await Promise.all(configs.map((c) => esbuild.context(c)));
await Promise.all(contexts.map((ctx) => ctx.rebuild()));

for (const ctx of contexts) {
  await ctx.watch();
}

const child = spawn(electronPath, ["."], {
  stdio: "inherit",
  env: {
    ...process.env,
    ELECTRON_DISABLE_SECURITY_WARNINGS: "true",
    MEETING_COPILOT_HTTP: defaultHttp,
    MEETING_COPILOT_API: defaultWs,
  },
});

child.on("exit", async (code) => {
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
  process.exit(code ?? 0);
});
