// src/agent/llm.ts
export const MODEL = "claude-opus-4-8";

export interface RawAnthropic {
  messages: { create(req: any): Promise<any> };
}

export interface SystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

export function cachedSystem(instructions: string, staticProfile: string): SystemBlock[] {
  return [
    { type: "text", text: instructions },
    { type: "text", text: `# Standing context\n${staticProfile}`, cache_control: { type: "ephemeral" } },
  ];
}

export const dynamicSystemMessage = (dynamicProfile: string) =>
  ({ role: "system" as const, content: dynamicProfile });

const BASE = {
  model: MODEL,
  max_tokens: 4096,
  // Cost-tuned: no adaptive thinking (the expensive part) and low effort — these are
  // structured extraction/synthesis steps, not deep reasoning. Bump effort back up if quality dips.
  output_config: { effort: "low" as const },
};

const firstText = (content: any[]): string =>
  content.find((b) => b.type === "text")?.text ?? "";

export class Llm {
  constructor(private readonly client: RawAnthropic) {}

  async structured<T>(a: { system: SystemBlock[]; messages: any[]; schema: object }): Promise<T> {
    const res = await this.client.messages.create({
      ...BASE,
      system: a.system,
      messages: a.messages,
      output_config: { ...BASE.output_config, format: { type: "json_schema", schema: a.schema } },
    });
    const text = firstText(res.content);
    try { return JSON.parse(text) as T; }
    catch { throw new Error(`structured(): model returned no parseable JSON (got ${text.length} chars)`); }
  }

  async toolLoop(a: {
    system: SystemBlock[];
    messages: any[];
    tools: object[];
    maxIterations: number;
    onToolUse: (name: string, input: any) => Promise<string>;
  }): Promise<string> {
    const messages = [...a.messages];
    for (let i = 0; i < a.maxIterations; i++) {
      const last = i === a.maxIterations - 1;
      const res = await this.client.messages.create({
        ...BASE, system: a.system,
        ...(last ? { tool_choice: { type: "none" } } : { tools: a.tools }),
        messages,
      });
      messages.push({ role: "assistant", content: res.content });
      if (last || res.stop_reason !== "tool_use") return firstText(res.content);

      const toolUses = res.content.filter((b: any) => b.type === "tool_use");
      const results = [];
      for (const tu of toolUses) {
        const out = await a.onToolUse(tu.name, tu.input);
        results.push({ type: "tool_result", tool_use_id: tu.id, content: out });
      }
      messages.push({ role: "user", content: results });
    }
    return "";
  }
}
