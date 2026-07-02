export interface Config {
  botToken: string; appToken: string; signingSecret: string;
  workspaceToken: string; ledgerChannelId: string; anthropicKey: string;
  observerEnabled: boolean;
  observerIntervalMs: number;
  observerThreshold: number;
  observerRecentK: number;
  observerFoldWindow: number;
  observerMaxFoldsPerTick: number;
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
  cfg.observerEnabled = env.OBSERVER_ENABLED === "true";
  cfg.observerIntervalMs = Number(env.OBSERVER_INTERVAL_MS ?? "300000");
  cfg.observerThreshold = Number(env.OBSERVER_CONSOLIDATE_THRESHOLD ?? "8");
  cfg.observerRecentK = Number(env.OBSERVER_RECENT_K ?? "3");
  cfg.observerFoldWindow = Number(env.OBSERVER_FOLD_WINDOW ?? "50");
  cfg.observerMaxFoldsPerTick = Number(env.OBSERVER_MAX_FOLDS_PER_TICK ?? "3");

  return cfg as Config;
}
