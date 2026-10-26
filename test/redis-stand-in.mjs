// The tests talk to Redis, as Friday's stores do; Friday on your own computer runs on an in-memory stand-in instead
// (src/local/kv.ts), and so do its tests: nothing to install or start. Every `import … from "ioredis"` outside
// node_modules gets ioredis-stand-in.mjs, whose Redis is that stand-in. Set REDIS_URL to run them against a real Redis.
import { register } from "node:module";

if (!process.env.REDIS_URL) {
  const shim = new URL("./ioredis-stand-in.mjs", import.meta.url).href;
  register(
    "data:text/javascript," +
      encodeURIComponent(
        `export async function resolve(specifier, context, next) {
          const from = context.parentURL ?? "";
          if (specifier === "ioredis" && !from.includes("/node_modules/") && from !== ${JSON.stringify(shim)}) return { url: ${JSON.stringify(shim)}, shortCircuit: true };
          return next(specifier, context);
        }`,
      ),
  );
}
