import { describe, expect, it } from "vitest";
import type { ModelProviderAccount } from "../db/model-provider-accounts";
import type { ProviderDefault } from "../db/provider-account-defaults";
import { resolveProviderAccountSelections } from "./provider-account-resolution";

const CHANNEL_ACCOUNT = "a".repeat(32);
const WORKSPACE_ACCOUNT = "b".repeat(32);
const SLACK_CHANNEL = { source: "slack", channelId: "C1" } as const;

function account(id: string, overrides: Partial<ModelProviderAccount> = {}): ModelProviderAccount {
  return {
    id,
    provider: "anthropic",
    displayName: id,
    externalAccountId: null,
    status: "active",
    createdBy: null,
    updatedBy: null,
    lastVerifiedAt: null,
    lastUsedAt: null,
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    ...overrides,
  };
}

function stores(
  options: {
    accounts?: ModelProviderAccount[];
    channelDefault?: string | null;
    workspaceDefault?: Pick<ProviderDefault, "providerAccountId" | "unattendedMode"> | null;
  } = {}
) {
  const accounts = options.accounts ?? [account(CHANNEL_ACCOUNT), account(WORKSPACE_ACCOUNT)];
  const channelDefault =
    options.channelDefault === undefined ? CHANNEL_ACCOUNT : options.channelDefault;
  const workspaceDefault =
    options.workspaceDefault === undefined
      ? { providerAccountId: WORKSPACE_ACCOUNT, unattendedMode: "provider_account" as const }
      : options.workspaceDefault;
  return {
    accounts: { getById: async (id: string) => accounts.find((a) => a.id === id) ?? null },
    defaults: {
      get: async (provider: string): Promise<ProviderDefault | null> =>
        provider === "anthropic" && workspaceDefault
          ? {
              provider: "anthropic",
              ...workspaceDefault,
              createdBy: null,
              updatedBy: null,
              createdAt: 1,
              updatedAt: 1,
            }
          : null,
    },
    channelDefaults: {
      getAccountId: async (_source: string, _channelId: string, provider: string) =>
        provider === "anthropic" ? channelDefault : null,
    },
    adapters: { get: () => ({}) },
  };
}

async function anthropic(
  input: Partial<Parameters<typeof resolveProviderAccountSelections>[0]>,
  resolutionStores = stores()
) {
  const resolved = await resolveProviderAccountSelections(
    { unattended: true, harness: "claude", ...input },
    resolutionStores
  );
  return resolved.find((auth) => auth.provider === "anthropic");
}

describe("channel default provider account", () => {
  it("starts a channel's sessions on its default account", async () => {
    expect(await anthropic({ channel: SLACK_CHANNEL })).toEqual({
      provider: "anthropic",
      authMode: "provider_account",
      providerAccountId: CHANNEL_ACCOUNT,
      selectionSource: "channel_default",
    });
  });

  it("wins over the workspace's unattended API-key policy", async () => {
    const result = await anthropic(
      { channel: SLACK_CHANNEL },
      stores({
        workspaceDefault: { providerAccountId: WORKSPACE_ACCOUNT, unattendedMode: "api_key" },
      })
    );
    expect(result).toMatchObject({
      providerAccountId: CHANNEL_ACCOUNT,
      selectionSource: "channel_default",
    });
  });

  it("applies without a workspace default", async () => {
    const result = await anthropic({ channel: SLACK_CHANNEL }, stores({ workspaceDefault: null }));
    expect(result).toMatchObject({
      providerAccountId: CHANNEL_ACCOUNT,
      selectionSource: "channel_default",
    });
  });

  it("yields to an explicit selection", async () => {
    expect(
      await anthropic({
        channel: SLACK_CHANNEL,
        explicit: { anthropic: { mode: "provider_account", accountId: WORKSPACE_ACCOUNT } },
      })
    ).toMatchObject({ providerAccountId: WORKSPACE_ACCOUNT, selectionSource: "explicit" });
    expect(
      await anthropic({ channel: SLACK_CHANNEL, explicit: { anthropic: { mode: "api_key" } } })
    ).toMatchObject({ authMode: "api_key", selectionSource: "explicit" });
  });

  it("is ignored on a harness that cannot use the provider's accounts", async () => {
    expect(await anthropic({ channel: SLACK_CHANNEL, harness: "opencode" })).toEqual({
      provider: "anthropic",
      authMode: "api_key",
      selectionSource: "harness_fallback",
    });
  });

  it.each([
    ["disabled", account(CHANNEL_ACCOUNT, { status: "disabled" })],
    ["reconnect required", account(CHANNEL_ACCOUNT, { status: "reconnect_required" })],
    ["archived", account(CHANNEL_ACCOUNT, { archivedAt: 5 })],
  ])(
    "falls through to the workspace default when the channel default is %s",
    async (_, unusable) => {
      const result = await anthropic(
        { channel: SLACK_CHANNEL },
        stores({ accounts: [unusable, account(WORKSPACE_ACCOUNT)] })
      );
      expect(result).toMatchObject({
        providerAccountId: WORKSPACE_ACCOUNT,
        selectionSource: "unattended_policy",
      });
    }
  );

  it("falls through when the channel has no default", async () => {
    const result = await anthropic({ channel: SLACK_CHANNEL }, stores({ channelDefault: null }));
    expect(result).toMatchObject({
      providerAccountId: WORKSPACE_ACCOUNT,
      selectionSource: "unattended_policy",
    });
  });

  it("changes nothing for a session without a channel", async () => {
    expect(await anthropic({})).toMatchObject({
      providerAccountId: WORKSPACE_ACCOUNT,
      selectionSource: "unattended_policy",
    });
  });
});
