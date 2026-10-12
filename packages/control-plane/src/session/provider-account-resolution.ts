import {
  SUBSCRIPTION_PROVIDER_IDS,
  type ModelProviderSelections,
  type SubscriptionProviderId,
} from "@open-inspect/shared/types/provider-accounts";
import { harnessSupportsProviderAuth, type HarnessId } from "@open-inspect/shared/harnesses";
import { ProviderDefaultStore } from "../db/provider-account-defaults";
import {
  ChannelProviderAccountDefaultStore,
  type ChannelSource,
} from "../db/channel-provider-account-defaults";
import { createLogger } from "../logger";
import { ModelProviderAccountStore } from "../db/model-provider-accounts";
import type { SessionModelProviderAuthInput } from "../model-provider-accounts/provider-auth-contracts";
import type { SqlDatabase } from "../db/sql-database";
import { modelProviderAccountAdapterRegistry } from "../auth/model-provider-account-default-adapters";
import {
  ProviderAccountSelectionPolicy,
  ProviderAccountSelectionPolicyError,
  type ProviderAccountAdapterLookup,
} from "../model-provider-accounts/selection-policy";

const logger = createLogger("provider-account-resolution");

interface ProviderAccountResolutionStores {
  defaults: Pick<ProviderDefaultStore, "get">;
  accounts: Pick<ModelProviderAccountStore, "getById">;
  channelDefaults: Pick<ChannelProviderAccountDefaultStore, "getAccountId">;
  adapters: ProviderAccountAdapterLookup;
}

/**
 * What a provider resolves to when nothing was selected and no default exists.
 * OpenAI and xAI keep the legacy scoped-OAuth path their plugins understand;
 * Anthropic never had one, so it falls back to the API key (the platform key
 * or a user secret), never to a placeholder.
 */
function noSelectionFallback(provider: SubscriptionProviderId): SessionModelProviderAuthInput {
  if (LEGACY_SCOPED_OAUTH_PROVIDERS.has(provider)) {
    return { provider, authMode: "legacy_scoped_oauth", selectionSource: "legacy_fallback" };
  }
  return apiKey(provider, "api_key_fallback");
}

const LEGACY_SCOPED_OAUTH_PROVIDERS: ReadonlySet<SubscriptionProviderId> = new Set([
  "openai",
  "xai",
]);

/** The chat channel a bot-launched session came from. */
export interface SessionChannelOrigin {
  source: ChannelSource;
  channelId: string;
}

export interface ProviderAccountResolutionInput {
  explicit?: ModelProviderSelections;
  unattended: boolean;
  /**
   * The session's harness. An installation default only applies where the
   * harness can select a provider account; otherwise the provider resolves
   * to api_key (selectionSource "harness_fallback") rather than binding an
   * account the harness cannot use.
   */
  harness: HarnessId;
  /**
   * Channel the session was launched from. Its default account, when usable,
   * outranks the workspace default: an admin bound that channel to a specific
   * subscription on purpose.
   */
  channel?: SessionChannelOrigin;
}

function apiKey(
  provider: SubscriptionProviderId,
  selectionSource: string
): SessionModelProviderAuthInput {
  return { provider, authMode: "api_key", selectionSource };
}

/**
 * The channel's default account, when it can serve a new session. This is the
 * one place the channel's candidates are chosen: when exhausted accounts start
 * falling back to the provider's other active accounts, that logic lands here.
 */
async function resolveChannelDefault(
  provider: SubscriptionProviderId,
  input: ProviderAccountResolutionInput,
  stores: ProviderAccountResolutionStores,
  policy: ProviderAccountSelectionPolicy
): Promise<SessionModelProviderAuthInput | null> {
  const channel = input.channel;
  if (!channel) return null;
  // A harness that cannot run the provider's accounts keeps today's path
  // (harness or API-key fallback) rather than binding an unusable account.
  if (!harnessSupportsProviderAuth(input.harness, provider, "provider_account")) return null;
  const defaultId = await stores.channelDefaults.getAccountId(
    channel.source,
    channel.channelId,
    provider
  );
  if (!defaultId) return null;
  try {
    const account = await policy.validateDefault(provider, defaultId);
    return {
      provider,
      authMode: "provider_account",
      providerAccountId: account.id,
      selectionSource: "channel_default",
    };
  } catch (cause) {
    if (!(cause instanceof ProviderAccountSelectionPolicyError)) throw cause;
    // An unhealthy channel default must not break the channel: the session
    // continues on the workspace policy, and this log is how an admin notices.
    logger.warn("provider_account.channel_default_skipped", {
      event: "provider_account.channel_default_skipped",
      channel_source: channel.source,
      channel_id: channel.channelId,
      provider,
      provider_account_id: defaultId,
      status: cause.status,
      reason: cause.message,
    });
    return null;
  }
}

async function resolveProvider(
  provider: SubscriptionProviderId,
  input: ProviderAccountResolutionInput,
  stores: ProviderAccountResolutionStores,
  policy: ProviderAccountSelectionPolicy
): Promise<SessionModelProviderAuthInput> {
  const explicit = input.explicit?.[provider];
  if (explicit?.mode === "api_key") return apiKey(provider, "explicit");
  if (explicit?.mode === "provider_account") {
    const account = await policy.validateSelection(provider, explicit.accountId);
    return {
      provider,
      authMode: "provider_account",
      providerAccountId: account.id,
      selectionSource: "explicit",
    };
  }

  const channelDefault = await resolveChannelDefault(provider, input, stores, policy);
  if (channelDefault) return channelDefault;

  const providerDefault = await stores.defaults.get(provider);
  if (!providerDefault) return noSelectionFallback(provider);
  if (!harnessSupportsProviderAuth(input.harness, provider, "provider_account")) {
    return apiKey(provider, "harness_fallback");
  }
  if (input.unattended && providerDefault.unattendedMode === "api_key") {
    return apiKey(provider, "unattended_policy");
  }

  const account = await policy.validateDefault(provider, providerDefault.providerAccountId);
  return {
    provider,
    authMode: "provider_account",
    providerAccountId: account.id,
    selectionSource: input.unattended ? "unattended_policy" : "installation_default",
  };
}

export async function resolveProviderAccountSelections(
  input: ProviderAccountResolutionInput,
  stores: ProviderAccountResolutionStores
): Promise<SessionModelProviderAuthInput[]> {
  const policy = new ProviderAccountSelectionPolicy(stores.accounts, stores.adapters);
  return Promise.all(
    SUBSCRIPTION_PROVIDER_IDS.map((provider) => resolveProvider(provider, input, stores, policy))
  );
}

export function resolveSessionProviderAuth(
  db: SqlDatabase,
  input: ProviderAccountResolutionInput
): Promise<SessionModelProviderAuthInput[]> {
  return resolveProviderAccountSelections(input, {
    defaults: new ProviderDefaultStore(db),
    accounts: new ModelProviderAccountStore(db),
    channelDefaults: new ChannelProviderAccountDefaultStore(db),
    adapters: modelProviderAccountAdapterRegistry,
  });
}
