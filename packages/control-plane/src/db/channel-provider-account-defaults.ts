import type { ModelProviderId } from "../model-provider-accounts/provider-auth-contracts";
import { isUniqueConstraintError } from "./errors";
import type { SqlDatabase } from "./sql-database";

/** Where a channel id comes from. Only Slack binds channels to accounts today. */
export type ChannelSource = "slack";

export interface ChannelDefaultConflict {
  channelId: string;
  providerAccountId: string;
  displayName: string;
}

/**
 * A channel already starts its sessions on a different account of the same
 * provider. Moving it silently would change which subscription another team's
 * channel bills, so the caller must release it from that account first.
 */
export class ChannelDefaultConflictError extends Error {
  constructor(readonly conflicts: ChannelDefaultConflict[]) {
    super("Channel already defaults to another provider account");
    this.name = "ChannelDefaultConflictError";
  }
}

export class ChannelProviderAccountDefaultStore {
  constructor(private readonly db: SqlDatabase) {}

  async getAccountId(
    source: ChannelSource,
    channelId: string,
    provider: ModelProviderId
  ): Promise<string | null> {
    const row = await this.db
      .prepare(
        `SELECT provider_account_id AS "providerAccountId" FROM channel_provider_account_defaults
         WHERE channel_source = ? AND channel_id = ? AND provider = ?`
      )
      .bind(source, channelId, provider)
      .first<{ providerAccountId: string }>();
    return row?.providerAccountId ?? null;
  }

  async listChannelIds(source: ChannelSource, providerAccountId: string): Promise<string[]> {
    const rows = await this.db
      .prepare(
        `SELECT channel_id AS "channelId" FROM channel_provider_account_defaults
         WHERE channel_source = ? AND provider_account_id = ? ORDER BY channel_id`
      )
      .bind(source, providerAccountId)
      .all<{ channelId: string }>();
    return rows.results.map((row) => row.channelId);
  }

  /**
   * Make `channelIds` exactly the channels that default to `account`. The
   * primary key is the real guarantee of one default per channel; the
   * pre-check only turns the common case into a readable conflict.
   *
   * Returns false when the account was archived before the write landed: the
   * insert is gated on a live account (as ProviderDefaultStore.set is), so an
   * archive racing this call can never strand a channel on a dead account.
   */
  async replaceForAccount(
    source: ChannelSource,
    account: { id: string; provider: ModelProviderId },
    channelIds: readonly string[],
    now = Date.now()
  ): Promise<boolean> {
    const unique = [...new Set(channelIds)];
    const conflicts = await this.findConflicts(source, account, unique);
    if (conflicts.length > 0) throw new ChannelDefaultConflictError(conflicts);
    let results;
    try {
      results = await this.db.batch([
        this.db
          .prepare(
            "DELETE FROM channel_provider_account_defaults WHERE channel_source = ? AND provider_account_id = ?"
          )
          .bind(source, account.id),
        ...unique.map((channelId) =>
          this.db
            .prepare(
              `INSERT INTO channel_provider_account_defaults
                 (channel_source, channel_id, provider, provider_account_id, created_at)
               SELECT ?, ?, provider, id, ? FROM model_provider_accounts
               WHERE id = ? AND provider = ? AND archived_at IS NULL`
            )
            .bind(source, channelId, now, account.id, account.provider)
        ),
      ]);
    } catch (cause) {
      if (!isUniqueConstraintError(cause)) throw cause;
      // Another write claimed a channel between the check and the batch; the
      // batch rolled back, so report what holds the channel now.
      throw new ChannelDefaultConflictError(await this.findConflicts(source, account, unique));
    }
    const inserted = results.slice(1).reduce((total, result) => total + result.meta.changes, 0);
    return inserted === unique.length;
  }

  private async findConflicts(
    source: ChannelSource,
    account: { id: string; provider: ModelProviderId },
    channelIds: readonly string[]
  ): Promise<ChannelDefaultConflict[]> {
    if (channelIds.length === 0) return [];
    const placeholders = channelIds.map(() => "?").join(", ");
    const rows = await this.db
      .prepare(
        `SELECT bindings.channel_id AS "channelId",
                bindings.provider_account_id AS "providerAccountId",
                accounts.display_name AS "displayName"
         FROM channel_provider_account_defaults bindings
         JOIN model_provider_accounts accounts ON accounts.id = bindings.provider_account_id
         WHERE bindings.channel_source = ? AND bindings.provider = ?
           AND bindings.provider_account_id <> ? AND bindings.channel_id IN (${placeholders})
         ORDER BY bindings.channel_id`
      )
      .bind(source, account.provider, account.id, ...channelIds)
      .all<ChannelDefaultConflict>();
    return rows.results;
  }
}
