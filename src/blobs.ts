import { createHash, createHmac } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Where uploaded files actually live.
 *
 * On a laptop that's a folder. On a host it can't be: the filesystem is wiped
 * on every deploy, so attachments quietly disappeared between releases — the
 * session log still referenced them and the agent was told the file "is no
 * longer available".
 *
 * S3 is spoken directly rather than through a client library. One PUT and one
 * GET need one signature, and SigV4 is a documented recipe; a dependency that
 * brings a credential chain, a retry policy and a region resolver to do it is
 * more surface than the forty lines below. Works against any S3-compatible
 * endpoint — R2, B2, MinIO, S3 itself — because that is all the API this uses.
 */

export interface Blobs {
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  /** Everything under this key prefix gone (a deleted session's files). Disk only: S3 objects are left to its lifecycle rules. */
  removeAll?(prefix: string): Promise<void>;
  readonly kind: "disk" | "s3";
}

class DiskBlobs implements Blobs {
  readonly kind = "disk";
  constructor(private root: string) {}

  private path(key: string) {
    // Keys are built by us from ids, never from a filename, but a store that
    // can be made to write outside its root is a bug waiting for a caller.
    const safe = key.replace(/[^\w./-]/g, "_");
    const full = path.resolve(this.root, safe);
    if (full !== this.root && !full.startsWith(this.root + path.sep)) throw new Error("bad key");
    return full;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const p = this.path(key);
    await mkdir(path.dirname(p), { recursive: true });
    await writeFile(p, body);
  }

  async get(key: string): Promise<Buffer | null> {
    return readFile(this.path(key)).catch(() => null);
  }

  async removeAll(prefix: string): Promise<void> {
    const p = this.path(prefix);
    if (p !== this.root) await rm(p, { recursive: true, force: true });
  }
}

export interface S3Config {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** For R2/MinIO. Defaults to AWS S3 for the region. */
  endpoint?: string;
}

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
const hmac = (key: Buffer | string, data: string) => createHmac("sha256", key).update(data).digest();

class S3Blobs implements Blobs {
  readonly kind = "s3";
  private host: string;
  private base: string;
  /** Path-style, so a bucket name with a dot in it doesn't break TLS. */
  constructor(private cfg: S3Config) {
    const endpoint = cfg.endpoint?.replace(/\/+$/, "") || `https://s3.${cfg.region}.amazonaws.com`;
    const u = new URL(endpoint);
    this.host = u.host;
    this.base = `${u.protocol}//${u.host}`;
  }

  private async send(method: "PUT" | "GET", key: string, body?: Buffer, contentType?: string): Promise<Response> {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
    const date = amzDate.slice(0, 8);
    const payloadHash = sha256(body ?? "");
    // Every segment is escaped, but slashes stay slashes: the key is a path.
    const canonicalUri = `/${this.cfg.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;

    const headers: Record<string, string> = {
      host: this.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": amzDate,
      ...(contentType ? { "content-type": contentType } : {}),
    };
    const signedHeaders = Object.keys(headers).sort().join(";");
    const canonicalHeaders = Object.keys(headers)
      .sort()
      .map((h) => `${h}:${headers[h]!.trim()}\n`)
      .join("");
    const canonicalRequest = [method, canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
    const scope = `${date}/${this.cfg.region}/s3/aws4_request`;
    const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
    const signing = ["s3", "aws4_request"].reduce((k, part) => hmac(k, part), hmac(hmac(`AWS4${this.cfg.secretAccessKey}`, date), this.cfg.region));
    const signature = createHmac("sha256", signing).update(toSign).digest("hex");

    return fetch(`${this.base}${canonicalUri}`, {
      method,
      headers: {
        ...headers,
        Authorization: `AWS4-HMAC-SHA256 Credential=${this.cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      ...(body ? { body: new Uint8Array(body) } : {}),
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    const res = await this.send("PUT", key, body, contentType);
    if (!res.ok) throw new Error(`Storing the file failed (${res.status} ${(await res.text()).slice(0, 200)})`);
  }

  async get(key: string): Promise<Buffer | null> {
    const res = await this.send("GET", key);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Reading the file failed (${res.status})`);
    return Buffer.from(await res.arrayBuffer());
  }
}

/** Exported for the signature test; the canonical parts are what can silently rot. */
export const s3ForTest = (cfg: S3Config) => new S3Blobs(cfg);

/**
 * Object storage when it's configured, a folder when it isn't.
 *
 * Deliberately not silent: a host that meant to configure S3 and mistyped one
 * variable would otherwise write to a disk it is about to throw away.
 */
export function blobStore(dir: string, env: NodeJS.ProcessEnv = process.env): Blobs {
  const { S3_BUCKET, S3_REGION, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_ENDPOINT } = env;
  const some = S3_BUCKET || S3_ACCESS_KEY_ID || S3_SECRET_ACCESS_KEY || S3_ENDPOINT;
  const all = S3_BUCKET && S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY;
  if (all) {
    return new S3Blobs({
      bucket: S3_BUCKET,
      region: S3_REGION || "auto",
      accessKeyId: S3_ACCESS_KEY_ID,
      secretAccessKey: S3_SECRET_ACCESS_KEY,
      endpoint: S3_ENDPOINT,
    });
  }
  if (some) throw new Error("Object storage is half-configured: set S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY together (S3_ENDPOINT and S3_REGION for R2 and friends).");
  return new DiskBlobs(path.resolve(dir));
}
