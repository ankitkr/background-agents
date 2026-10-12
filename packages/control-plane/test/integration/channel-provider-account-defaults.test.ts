import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  ChannelDefaultConflictError,
  ChannelProviderAccountDefaultStore,
} from "../../src/db/channel-provider-account-defaults";
import { ModelProviderAccountStore } from "../../src/db/model-provider-accounts";
import { ProviderDefaultStore } from "../../src/db/provider-account-defaults";
import { cleanD1Tables } from "./cleanup";

const CLAUDE_A = "a".repeat(32);
const CLAUDE_B = "b".repeat(32);
const OPENAI = "c".repeat(32);
const claudeA = { id: CLAUDE_A, provider: "anthropic" } as const;
const claudeB = { id: CLAUDE_B, provider: "anthropic" } as const;
const openai = { id: OPENAI, provider: "openai" } as const;

describe("channel provider account defaults", () => {
  let accounts: ModelProviderAccountStore;
  let channels: ChannelProviderAccountDefaultStore;

  beforeEach(async () => {
    await cleanD1Tables();
    accounts = new ModelProviderAccountStore(env.DB);
    channels = new ChannelProviderAccountDefaultStore(env.DB);
    await accounts.create({ id: CLAUDE_A, provider: "anthropic", displayName: "Claude A" });
    await accounts.create({ id: CLAUDE_B, provider: "anthropic", displayName: "Claude B" });
    await accounts.create({ id: OPENAI, provider: "openai", displayName: "ChatGPT" });
  });

  it("replaces an account's channel set wholesale", async () => {
    await channels.replaceForAccount("slack", claudeA, ["C2", "C1", "C1"]);
    expect(await channels.listChannelIds("slack", CLAUDE_A)).toEqual(["C1", "C2"]);

    await channels.replaceForAccount("slack", claudeA, ["C3"]);
    expect(await channels.listChannelIds("slack", CLAUDE_A)).toEqual(["C3"]);

    await channels.replaceForAccount("slack", claudeA, []);
    expect(await channels.listChannelIds("slack", CLAUDE_A)).toEqual([]);
  });

  it("resolves a channel's default per provider", async () => {
    await channels.replaceForAccount("slack", claudeA, ["C1"]);
    await channels.replaceForAccount("slack", openai, ["C1"]);

    expect(await channels.getAccountId("slack", "C1", "anthropic")).toBe(CLAUDE_A);
    expect(await channels.getAccountId("slack", "C1", "openai")).toBe(OPENAI);
    expect(await channels.getAccountId("slack", "C9", "anthropic")).toBeNull();
  });

  it("refuses a channel that already defaults to another account of the provider", async () => {
    await channels.replaceForAccount("slack", claudeA, ["C1"]);

    const attempt = channels.replaceForAccount("slack", claudeB, ["C1", "C2"]);

    await expect(attempt).rejects.toBeInstanceOf(ChannelDefaultConflictError);
    await expect(attempt).rejects.toMatchObject({
      conflicts: [{ channelId: "C1", providerAccountId: CLAUDE_A, displayName: "Claude A" }],
    });
    expect(await channels.listChannelIds("slack", CLAUDE_B)).toEqual([]);
    expect(await channels.getAccountId("slack", "C1", "anthropic")).toBe(CLAUDE_A);
  });

  it("rejects a row whose provider does not match its account", async () => {
    await expect(
      env.DB.prepare(
        `INSERT INTO channel_provider_account_defaults
           (channel_source, channel_id, provider, provider_account_id, created_at)
         VALUES ('slack', 'C1', 'openai', ?, 1)`
      )
        .bind(CLAUDE_A)
        .run()
    ).rejects.toThrow(/FOREIGN KEY/i);
  });

  it("keeps a disabled account's channels and releases an archived account's", async () => {
    await channels.replaceForAccount("slack", claudeA, ["C1"]);

    await accounts.setStatus(CLAUDE_A, "disabled", null);
    expect(await channels.getAccountId("slack", "C1", "anthropic")).toBe(CLAUDE_A);

    expect(await accounts.archive(CLAUDE_A, null)).toBe(true);
    expect(await channels.getAccountId("slack", "C1", "anthropic")).toBeNull();

    await channels.replaceForAccount("slack", claudeB, ["C1"]);
    expect(await channels.getAccountId("slack", "C1", "anthropic")).toBe(CLAUDE_B);
  });

  it("keeps the channels when the archive itself is refused", async () => {
    await channels.replaceForAccount("slack", claudeA, ["C1"]);
    await new ProviderDefaultStore(env.DB).set("anthropic", CLAUDE_A, "provider_account", null);

    // The service maps this exact trigger text to a 409; the batch must keep it.
    await expect(accounts.archive(CLAUDE_A, null)).rejects.toThrow(
      /provider default account must remain active/i
    );

    expect(await channels.getAccountId("slack", "C1", "anthropic")).toBe(CLAUDE_A);
  });

  it("binds nothing to an account archived before the write lands", async () => {
    await accounts.archive(CLAUDE_A, null);

    expect(await channels.replaceForAccount("slack", claudeA, ["C1"])).toBe(false);
    expect(await channels.getAccountId("slack", "C1", "anthropic")).toBeNull();
  });
});
