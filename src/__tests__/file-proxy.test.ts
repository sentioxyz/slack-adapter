import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackFileProxy } from "../file-proxy.js";

let proxy: SlackFileProxy | undefined;
afterEach(async () => { await proxy?.stop(); proxy = undefined; });

function okFetch(body: string, contentType = "application/pdf") {
  return vi.fn(async (_url: string, init?: any) => {
    return new Response(body, { status: 200, headers: { "content-type": contentType } });
  });
}

describe("SlackFileProxy", () => {
  it("streams the upstream file with the bot token injected", async () => {
    const fetchImpl = okFetch("PDFBYTES");
    proxy = new SlackFileProxy({ botToken: "xoxb-123", fetchImpl: fetchImpl as any });
    await proxy.start();
    const url = proxy.register({ url_private: "https://files.slack.com/F1", mimetype: "application/pdf", name: "a.pdf" });
    expect(url.startsWith(proxy.baseUrl)).toBe(true);

    const resp = await fetch(url);
    expect(resp.status).toBe(200);
    expect(await resp.text()).toBe("PDFBYTES");

    const init = (fetchImpl as any).mock.calls[0][1];
    expect(init.headers.Authorization).toBe("Bearer xoxb-123");
  });

  it("returns 404 for unknown tokens", async () => {
    proxy = new SlackFileProxy({ botToken: "xoxb-123", fetchImpl: okFetch("x") as any });
    await proxy.start();
    const resp = await fetch(`${proxy.baseUrl}/slack-file/nope`);
    expect(resp.status).toBe(404);
  });

  it("returns 502 when Slack responds with an HTML login page", async () => {
    const htmlFetch = vi.fn(async () => new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } }));
    proxy = new SlackFileProxy({ botToken: "xoxb-123", fetchImpl: htmlFetch as any });
    await proxy.start();
    const url = proxy.register({ url_private: "https://files.slack.com/F1", mimetype: "application/pdf", name: "a.pdf" });
    const resp = await fetch(url);
    expect(resp.status).toBe(502);
  });

  it("refuses to proxy a non-Slack url_private without fetching", async () => {
    const fetchImpl = vi.fn(async () => new Response("x", { status: 200 }));
    proxy = new SlackFileProxy({ botToken: "xoxb-123", fetchImpl: fetchImpl as any });
    await proxy.start();
    const url = proxy.register({ url_private: "https://169.254.169.254/meta", mimetype: "application/pdf", name: "a.pdf" });
    const resp = await fetch(url);
    expect(resp.status).toBe(502);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("returns 404 for expired tokens", async () => {
    let t = 1000;
    proxy = new SlackFileProxy({ botToken: "xoxb-123", fetchImpl: okFetch("x") as any, ttlMs: 50, now: () => t });
    await proxy.start();
    const url = proxy.register({ url_private: "https://files.slack.com/F1", mimetype: "application/pdf", name: "a.pdf" });
    t = 2000; // advance past ttl
    const resp = await fetch(url);
    expect(resp.status).toBe(404);
  });
});
