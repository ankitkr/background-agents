import { providerAccountSettingsProxy, validProviderAccountId } from "@/lib/provider-account-proxy";

type Params = { id: string };
const { GET, PUT } = providerAccountSettingsProxy<Params>(
  ({ id }) => `/model-provider-accounts/${encodeURIComponent(id)}/channel-associations`,
  "provider account channel associations",
  ({ id }) => validProviderAccountId(id)
);

export { GET, PUT };
