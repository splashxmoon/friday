// The client imports CSS modules, which only the bundler understands. Tests
// that import client code get each class name back as itself instead.
import { register } from "node:module";

register(
  "data:text/javascript," +
    encodeURIComponent(
      `export async function load(url, context, next) {
        if (url.endsWith(".css")) return { format: "module", shortCircuit: true, source: "export default new Proxy({}, { get: (_, k) => String(k) });" };
        return next(url, context);
      }`,
    ),
);
