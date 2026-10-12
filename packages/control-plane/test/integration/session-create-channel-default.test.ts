import { env } from "cloudflare:test";
import type { ServiceName } from "@open-inspect/shared/service-auth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ChannelProviderAccountDefaultStore } from "../../src/db/channel-provider-account-defaults";
import { ModelProviderAccountStore } from "../../src/db/model-provider-accounts";
import { cleanD1Tables } from "./cleanup";
import { serviceFetch } from "./helpers";

const CLAUDE = "a".repeat(32);
const ORIGIN = { source: "slack", channelId: "C-BOUND" };

async function createClaudeSession(service: ServiceName, origin?: unknown) {
  const response = await serviceFetch("https://test.local/sessions", {
    service,
    method: "POST",
    actor: service === "slack-bot" ? "slack:U-CHANNEL-DEFAULT" : undefined,
    body: JSON.stringify({
      title: "Channel default",
      harness: "claude",
      model: "anthropic/claude-haiku-4-5",
      origin,
    }),
  });
  expect(response.status).toBe(201);
  const { sessionId } = await response.json<{ sessionId: string }>();
  return env.DB.prepare(
    `SELECT auth_mode AS "authMode", provider_account_id AS "providerAccountId",
            selection_source AS "selectionSource"
     FROM session_model_provider_auth WHERE session_id = ? AND provider = 'anthropic'`
  )
    .bind(sessionId)
    .first();
}

describe("session create with a channel default", () => {
  beforeEach(async () => {
    await cleanD1Tables();
    await new ModelProviderAccountStore(env.DB).create({
      id: CLAUDE,
      provider: "anthropic",
      displayName: "Channel Claude",
    });
    await new ChannelProviderAccountDefaultStore(env.DB).replaceForAccount(
      "slack",
      { id: CLAUDE, provider: "anthropic" },
      [ORIGIN.channelId]
    );
  });
  afterEach(cleanD1Tables);

  it("starts a Slack session from a bound channel on that channel's account", async () => {
    expect(await createClaudeSession("slack-bot", ORIGIN)).toEqual({
      authMode: "provider_account",
      providerAccountId: CLAUDE,
      selectionSource: "channel_default",
    });
  });

  it("ignores an origin asserted by anyone but the Slack bot", async () => {
    expect(await createClaudeSession("web", ORIGIN)).toMatchObject({
      authMode: "api_key",
      selectionSource: "api_key_fallback",
    });
  });

  it("keeps today's behaviour for a Slack session without an origin", async () => {
    expect(await createClaudeSession("slack-bot")).toMatchObject({
      authMode: "api_key",
      selectionSource: "api_key_fallback",
    });
  });
});
