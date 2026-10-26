#!/usr/bin/env node
// Friday on your own computer: `npx github:splashxmoon/friday`, or `npm start` in a clone.
const [major] = process.versions.node.split(".").map(Number);
if (major < 22) {
  console.error(`Friday needs Node.js 22 or newer; this is ${process.versions.node}. Get it from https://nodejs.org.`);
  process.exit(1);
}
const { register } = await import("tsx/esm/api");
register();
await import("../src/local/main.ts");
