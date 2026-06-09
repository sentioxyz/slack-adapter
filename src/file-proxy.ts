// src/file-proxy.ts
// Self-contained localhost HTTP proxy that streams Slack url_private files to
// the (same-host) agent, injecting the bot token. Agents fetch lazily; no token
// is ever exposed to the agent.
import http from "node:http";
import crypto from "node:crypto";
import type { Logger } from "./types.js";

export interface FileProxyEntry {
  url_private: string;
  mimetype: string;
  name: string;
}

interface StoredEntry extends FileProxyEntry {
  expiresAt: number;
}

export interface FileProxyOptions {
  botToken: string;
  log?: Logger;
  fetchImpl?: typeof fetch;
  now?: () => number;
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export class SlackFileProxy {
  private server?: http.Server;
  private port?: number;
  private entries = new Map<string, StoredEntry>();
  private readonly botToken: string;
  private readonly log: Logger;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly ttlMs: number;

  constructor(opts: FileProxyOptions) {
    this.botToken = opts.botToken;
    this.log = opts.log ?? { info() {}, warn() {}, error() {}, debug() {} };
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  }

  async start(): Promise<void> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", () => {
        const addr = this.server!.address();
        if (addr && typeof addr === "object") this.port = addr.port;
        resolve();
      });
    });
    this.log.info({ port: this.port }, "Slack file proxy listening");
  }

  get baseUrl(): string {
    if (this.port === undefined) throw new Error("SlackFileProxy not started");
    return `http://127.0.0.1:${this.port}`;
  }

  /** Register a file and return a localhost URL the agent can download. */
  register(entry: FileProxyEntry): string {
    const token = crypto.randomBytes(16).toString("hex");
    this.entries.set(token, { ...entry, expiresAt: this.now() + this.ttlMs });
    return `${this.baseUrl}/slack-file/${token}`;
  }

  async stop(): Promise<void> {
    this.entries.clear();
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
    this.port = undefined;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const match = /^\/slack-file\/([a-f0-9]+)$/.exec(req.url ?? "");
    const token = match?.[1];
    const entry = token ? this.entries.get(token) : undefined;
    if (!entry || entry.expiresAt < this.now()) {
      if (entry) this.entries.delete(token!);
      res.writeHead(404).end("not found");
      return;
    }
    try {
      const upstream = await this.fetchImpl(entry.url_private, {
        headers: { Authorization: `Bearer ${this.botToken}` },
      });
      const ct = upstream.headers.get("content-type") ?? "";
      if (!upstream.ok || ct.includes("text/html")) {
        this.log.warn(
          { name: entry.name, status: upstream.status },
          "Slack file proxy upstream failed (bad status or HTML login — check files:read scope)",
        );
        res.writeHead(502).end("upstream error");
        return;
      }
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.writeHead(200, {
        "content-type": entry.mimetype || ct || "application/octet-stream",
        "content-length": String(buf.length),
        "content-disposition": `inline; filename="${entry.name.replace(/"/g, "")}"`,
      }).end(buf);
    } catch (err) {
      this.log.error({ err, name: entry.name }, "Slack file proxy error");
      res.writeHead(502).end("upstream error");
    }
  }
}
