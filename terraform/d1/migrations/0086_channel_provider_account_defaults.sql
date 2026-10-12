-- A channel's default provider account: where sessions started from that
-- channel begin. It is a starting point, not an exclusive assignment, so this
-- holds exactly one row per channel and provider. If the account is unusable,
-- the channel's sessions fall back to the workspace policy.
--
-- Archiving an account deletes its rows in the same batch as the archive
-- (ModelProviderAccountStore.archive). That lives in the store, not a trigger,
-- per docs/PORTABLE_SQL.md.
CREATE TABLE channel_provider_account_defaults (
  channel_source TEXT NOT NULL CHECK (channel_source IN ('slack')),
  channel_id TEXT NOT NULL CHECK (length(channel_id) BETWEEN 1 AND 64),
  provider TEXT NOT NULL,
  provider_account_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (channel_source, channel_id, provider),
  FOREIGN KEY (provider_account_id, provider)
    REFERENCES model_provider_accounts(id, provider)
);

CREATE INDEX idx_channel_provider_account_defaults_account
  ON channel_provider_account_defaults(provider_account_id);
