import { z } from "zod";

/**
 * A Slack channel id as carried in API payloads. Ids are opaque Slack
 * identifiers, so only basic hygiene is checked. Defined once so every surface
 * that binds Slack channels (environments, provider-account defaults, session
 * origin) accepts exactly the same ids.
 */
export const slackChannelIdSchema = z.string().trim().min(1).max(64);
