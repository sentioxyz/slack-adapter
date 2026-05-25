import { describe, it, expect, vi } from "vitest";
import { makeArchiveCommandHandler } from "../adapter.js";

describe("/openacp-archive handler", () => {
  it("archives the channel of the current session and posts an ephemeral confirmation", async () => {
    const archiveChannel = vi.fn().mockResolvedValue(undefined);
    const postEphemeral = vi.fn().mockResolvedValue(undefined);
    const findSessionByChannel = vi.fn().mockReturnValue({
      sessionId: "sess-1",
      meta: { channelId: "C123", channelSlug: "openacp-x" },
    });
    const ack = vi.fn().mockResolvedValue(undefined);

    const handler = makeArchiveCommandHandler({
      findSessionByChannel,
      archiveChannel,
      postEphemeral,
    });

    await handler({
      ack,
      command: { channel_id: "C123", user_id: "U1" },
    });

    expect(ack).toHaveBeenCalled();
    expect(archiveChannel).toHaveBeenCalledWith("C123");
    expect(postEphemeral).toHaveBeenCalledWith({
      channel: "C123",
      user: "U1",
      text: expect.stringMatching(/archiv/i),
    });
  });

  it("posts an ephemeral 'no session' message when invoked in an unrelated channel", async () => {
    const archiveChannel = vi.fn();
    const postEphemeral = vi.fn().mockResolvedValue(undefined);
    const findSessionByChannel = vi.fn().mockReturnValue(undefined);
    const ack = vi.fn().mockResolvedValue(undefined);

    const handler = makeArchiveCommandHandler({
      findSessionByChannel,
      archiveChannel,
      postEphemeral,
    });

    await handler({
      ack,
      command: { channel_id: "C999", user_id: "U1" },
    });

    expect(ack).toHaveBeenCalled();
    expect(archiveChannel).not.toHaveBeenCalled();
    expect(postEphemeral).toHaveBeenCalledWith({
      channel: "C999",
      user: "U1",
      text: expect.stringMatching(/no.*session/i),
    });
  });

  it("always acks before doing any work (Slack 3s timeout)", async () => {
    const order: string[] = [];
    const ack = vi.fn().mockImplementation(async () => { order.push("ack"); });
    const archiveChannel = vi.fn().mockImplementation(async () => { order.push("archive"); });
    const postEphemeral = vi.fn().mockImplementation(async () => { order.push("ephemeral"); });
    const findSessionByChannel = vi.fn().mockReturnValue({
      sessionId: "s", meta: { channelId: "C1", channelSlug: "x" },
    });

    const handler = makeArchiveCommandHandler({ findSessionByChannel, archiveChannel, postEphemeral });
    await handler({ ack, command: { channel_id: "C1", user_id: "U1" } });

    expect(order[0]).toBe("ack");
  });

  it("posts ephemeral BEFORE archiving (Slack rejects ephemeral to archived channel)", async () => {
    const order: string[] = [];
    const ack = vi.fn().mockResolvedValue(undefined);
    const archiveChannel = vi.fn().mockImplementation(async () => { order.push("archive"); });
    const postEphemeral = vi.fn().mockImplementation(async () => { order.push("ephemeral"); });
    const findSessionByChannel = vi.fn().mockReturnValue({
      sessionId: "s", meta: { channelId: "C1", channelSlug: "x" },
    });

    const handler = makeArchiveCommandHandler({ findSessionByChannel, archiveChannel, postEphemeral });
    await handler({ ack, command: { channel_id: "C1", user_id: "U1" } });

    expect(order).toEqual(["ephemeral", "archive"]);
  });
});
