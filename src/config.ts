export interface Config {
  botToken: string; appToken: string; signingSecret: string;
  workspaceToken: string; ledgerChannelId: string; anthropicKey: string;
}

const REQUIRED: Array<[keyof Config, string]> = [
  ["botToken", "SLACK_BOT_TOKEN"], ["appToken", "SLACK_APP_TOKEN"],
  ["signingSecret", "SLACK_SIGNING_SECRET"], ["workspaceToken", "SLACK_WORKSPACE_TOKEN"],
  ["ledgerChannelId", "LEDGER_CHANNEL_ID"], ["anthropicKey", "ANTHROPIC_API_KEY"],
];

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const cfg: any = {};
  for (const [key, envName] of REQUIRED) {
    const v = env[envName];
    if (!v) throw new Error(`Missing required env var: ${envName}`);
    cfg[key] = v;
  }
  return cfg as Config;
}
