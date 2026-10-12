import type { SubscriptionProviderId } from "@open-inspect/shared/types/provider-accounts";
import { describe, expect, it, vi } from "vitest";
import type { ModelProviderAccount } from "../db/model-provider-accounts";
import type { ProviderDefault } from "../db/provider-account-defaults";
import { resolveProviderAccountSelections } from "./provider-account-resolution";

const OPENAI_ACCOUNT_ID = "1".repeat(32);
const XAI_ACCOUNT_ID = "2".repeat(32);
const ANTHROPIC_ACCOUNT_ID = "3".repeat(32);

function account(
  id: string,
  provider: SubscriptionProviderId,
  overrides: Partial<ModelProviderAccount> = {}
): ModelProviderAccount {
  return {
    id,
    provider,
    displayName: provider,
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

function providerDefault(
  provider: SubscriptionProviderId,
  providerAccountId: string,
  unattendedMode: "provider_account" | "api_key" = "provider_account"
): ProviderDefault {
  return {
    provider,
    providerAccountId,
    unattendedMode,
    createdBy: null,
    updatedBy: null,
    createdAt: 1,
    updatedAt: 1,
  };
}

function stores(
  options: {
    defaults?: ProviderDefault[];
    accounts?: ModelProviderAccount[];
  } = {}
) {
  const defaults = new Map((options.defaults ?? []).map((item) => [item.provider, item]));
  const accounts = new Map((options.accounts ?? []).map((item) => [item.id, item]));
  return {
    defaults: { get: vi.fn(async (provider: "openai" | "xai") => defaults.get(provider) ?? null) },
    accounts: { getById: vi.fn(async (id: string) => accounts.get(id) ?? null) },
    channelDefaults: { getAccountId: vi.fn(async () => null) },
    adapters: { get: vi.fn(() => ({})) },
  };
}

describe("Codex connected-account scope", () => {
  it("falls back to the API key with no selection or default, never legacy OAuth", async () => {
    const fallback = await resolveProviderAccountSelections(
      { harness: "codex", unattended: false },
      stores()
    );
    expect(fallback.find((item) => item.provider === "openai")).toEqual({
      provider: "openai",
      authMode: "api_key",
      selectionSource: "api_key_fallback",
    });
    const resolved = await resolveProviderAccountSelections(
      { harness: "codex", unattended: false, explicit: { openai: { mode: "api_key" } } },
      stores()
    );
    expect(resolved[0]).toEqual({
      provider: "openai",
      authMode: "api_key",
      selectionSource: "explicit",
    });
  });
  it("ignores unreachable stale provider selections without validating their accounts", async () => {
    const deps = stores();
    const resolved = await resolveProviderAccountSelections(
      {
        harness: "codex",
        unattended: false,
        explicit: {
          openai: { mode: "api_key" },
          anthropic: { mode: "provider_account", accountId: ANTHROPIC_ACCOUNT_ID },
          xai: { mode: "provider_account", accountId: XAI_ACCOUNT_ID },
        },
      },
      deps
    );
    expect(deps.accounts.getById).not.toHaveBeenCalled();
    expect(resolved).toEqual([
      { provider: "openai", authMode: "api_key", selectionSource: "explicit" },
      { provider: "xai", authMode: "api_key", selectionSource: "harness_fallback" },
      { provider: "anthropic", authMode: "api_key", selectionSource: "harness_fallback" },
    ]);
  });
  it("binds a connected Settings default and preserves unattended API policy", async () => {
    const deps = stores({
      defaults: [providerDefault("openai", OPENAI_ACCOUNT_ID, "api_key")],
      accounts: [account(OPENAI_ACCOUNT_ID, "openai")],
    });
    const interactive = await resolveProviderAccountSelections(
      { harness: "codex", unattended: false },
      deps
    );
    expect(interactive[0]).toMatchObject({
      authMode: "provider_account",
      providerAccountId: OPENAI_ACCOUNT_ID,
    });
    const unattended = await resolveProviderAccountSelections(
      { harness: "codex", unattended: true },
      deps
    );
    expect(unattended[0]).toEqual({
      provider: "openai",
      authMode: "api_key",
      selectionSource: "unattended_policy",
    });
  });
});

const CHANNEL_ACCOUNT = "a".repeat(32);
const WORKSPACE_ACCOUNT = "b".repeat(32);
const SLACK_CHANNEL = { source: "slack", channelId: "C1" } as const;

function anthropicAccount(
  id: string,
  overrides: Partial<ModelProviderAccount> = {}
): ModelProviderAccount {
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

function channelStores(
  options: {
    accounts?: ModelProviderAccount[];
    channelDefault?: string | null;
    workspaceDefault?: Pick<ProviderDefault, "providerAccountId" | "unattendedMode"> | null;
  } = {}
) {
  const accounts = options.accounts ?? [
    anthropicAccount(CHANNEL_ACCOUNT),
    anthropicAccount(WORKSPACE_ACCOUNT),
  ];
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
  resolutionStores = channelStores()
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
      channelStores({
        workspaceDefault: { providerAccountId: WORKSPACE_ACCOUNT, unattendedMode: "api_key" },
      })
    );
    expect(result).toMatchObject({
      providerAccountId: CHANNEL_ACCOUNT,
      selectionSource: "channel_default",
    });
  });

  it("applies without a workspace default", async () => {
    const result = await anthropic(
      { channel: SLACK_CHANNEL },
      channelStores({ workspaceDefault: null })
    );
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
    ["disabled", anthropicAccount(CHANNEL_ACCOUNT, { status: "disabled" })],
    ["reconnect required", anthropicAccount(CHANNEL_ACCOUNT, { status: "reconnect_required" })],
    ["archived", anthropicAccount(CHANNEL_ACCOUNT, { archivedAt: 5 })],
  ])(
    "falls through to the workspace default when the channel default is %s",
    async (_, unusable) => {
      const result = await anthropic(
        { channel: SLACK_CHANNEL },
        channelStores({ accounts: [unusable, anthropicAccount(WORKSPACE_ACCOUNT)] })
      );
      expect(result).toMatchObject({
        providerAccountId: WORKSPACE_ACCOUNT,
        selectionSource: "unattended_policy",
      });
    }
  );

  it("falls through when the channel has no default", async () => {
    const result = await anthropic(
      { channel: SLACK_CHANNEL },
      channelStores({ channelDefault: null })
    );
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
