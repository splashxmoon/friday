// ioredis, with its Redis replaced by the in-memory stand-in Friday runs on (redis-stand-in.mjs says when and why).
// Every client, wherever it points, reaches the same data, as connections to one server would.
import { Command } from "ioredis";
import RedisMock from "ioredis-mock";

// The mock calls ioredis's reply shapers without the context a real connection gives them (src/local/kv.ts does the same).
const reply = Command._transformer.reply;
for (const [name, fn] of Object.entries(reply)) reply[name] = (r, c) => fn(r, c ?? { protocol: 2, replyMapping: "legacy" });

export * from "ioredis";
export class Redis extends RedisMock {
  constructor() {
    super();
  }
}
export default Redis;
