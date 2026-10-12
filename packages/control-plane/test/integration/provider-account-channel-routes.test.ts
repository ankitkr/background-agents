import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ModelProviderAccountStore } from "../../src/db/model-provider-accounts";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";

const CLAUDE_A = "a".repeat(32);
const CLAUDE_B = "b".repeat(32);

function channelsUrl(accountId: string): string {
  return `https://test.local/model-provider-accounts/${accountId}/channel-associations`;
}

function putChannels(accountId: string, body: unknown, initialUserRole?: "member") {
  return serviceFetch(channelsUrl(accountId), {
    method: "PUT",
    body: JSON.stringify(body),
    initialUserRole,
  });
}

describe("provider account channel associations", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    const accounts = new ModelProviderAccountStore(env.DB);
    await accounts.create({ id: CLAUDE_A, provider: "anthropic", displayName: "Claude A" });
    await accounts.create({ id: CLAUDE_B, provider: "anthropic", displayName: "Claude B" });
  });
  afterEach(cleanD1Tables);

  it("replaces and reads an account's channels", async () => {
    const put = await putChannels(CLAUDE_A, { channelAssociations: [" C2 ", "C1", "C1"] });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ channelAssociations: ["C1", "C2"] });

    const get = await serviceFetch(channelsUrl(CLAUDE_A));
    expect(get.status).toBe(200);
    expect(get.headers.get("Cache-Control")).toBe("private, no-store");
    expect(await get.json()).toEqual({ channelAssociations: ["C1", "C2"] });
  });

  it("refuses a channel held by another account with the holder's details", async () => {
    await putChannels(CLAUDE_A, { channelAssociations: ["C1"] });

    const conflict = await putChannels(CLAUDE_B, { channelAssociations: ["C1"] });

    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({
      conflicts: [{ channelId: "C1", providerAccountId: CLAUDE_A, displayName: "Claude A" }],
    });
  });

  it("requires provider_accounts.manage to write but only read to list", async () => {
    expect((await putChannels(CLAUDE_A, { channelAssociations: ["C1"] }, "member")).status).toBe(
      403
    );
    const read = await serviceFetch(channelsUrl(CLAUDE_A), { initialUserRole: "member" });
    expect(read.status).toBe(200);
  });

  it.each([
    [{ channelAssociations: [""] }],
    [{ channelAssociations: ["C".repeat(65)] }],
    [{ channelAssociations: Array.from({ length: 51 }, (_, i) => `C${i}`) }],
    [{}],
    [{ channelAssociations: ["C1"], extra: true }],
  ])("rejects an invalid body %#", async (body) => {
    expect((await putChannels(CLAUDE_A, body)).status).toBe(400);
  });

  it("treats an archived or unknown account as not found", async () => {
    await new ModelProviderAccountStore(env.DB).archive(CLAUDE_A, null);
    expect((await putChannels(CLAUDE_A, { channelAssociations: ["C1"] })).status).toBe(404);
    expect((await serviceFetch(channelsUrl(CLAUDE_A))).status).toBe(404);
    expect((await serviceFetch(channelsUrl("f".repeat(32)))).status).toBe(404);
  });
});
