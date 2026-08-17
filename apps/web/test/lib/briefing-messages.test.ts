import { describe, expect, it } from "vitest";
import { readBriefingMessages } from "@/lib/briefing-messages";

describe("readBriefingMessages", () => {
  it("accepts a valid A2UI message sequence", async () => {
    const messages = [
      {
        version: "v1.0",
        createSurface: {
          surfaceId: "briefing-ceo",
          catalogId: "openneko",
        },
      },
      {
        version: "v1.0",
        updateDataModel: {
          surfaceId: "briefing-ceo",
          value: {},
        },
      },
    ];

    await expect(readBriefingMessages(Response.json(messages))).resolves.toEqual(
      messages,
    );
  });

  it("rejects an HTTP error before applying its JSON body", async () => {
    const response = Response.json(
      { error: "database unavailable" },
      { status: 503 },
    );

    await expect(readBriefingMessages(response)).rejects.toThrow("HTTP 503");
  });

  it("rejects non-array and malformed A2UI payloads", async () => {
    await expect(
      readBriefingMessages(Response.json({ error: "not a message list" })),
    ).rejects.toThrow("valid A2UI message sequence");

    await expect(
      readBriefingMessages(
        Response.json([{ version: "v1.0", updateComponents: null }]),
      ),
    ).rejects.toThrow("valid A2UI message sequence");
  });
});
