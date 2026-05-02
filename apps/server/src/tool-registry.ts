export interface ToolRunRecord {
  tool: string;
  status: "success" | "failed";
  latencyMs: number;
  error?: string;
}

type ToolHandler = (input: Record<string, unknown>) => unknown | Promise<unknown>;

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  timeoutMs?: number;
  retryable?: boolean;
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolHandler>();
  private readonly definitions = new Map<string, ToolDefinition>();

  register(definition: ToolDefinition, handler: ToolHandler) {
    const name = definition.name;
    if (!name.trim()) throw new Error("工具名称不能为空");
    this.tools.set(name, handler);
    this.definitions.set(name, definition);
  }

  has(name: string) {
    return this.tools.has(name);
  }

  describe(name?: string) {
    if (name) return this.definitions.get(name);
    return [...this.definitions.values()];
  }

  async run<T>(name: string, input: Record<string, unknown>): Promise<{ result?: T; run: ToolRunRecord }> {
    const handler = this.tools.get(name);
    if (!handler) throw new Error(`工具未注册：${name}`);
    const started = Date.now();
    try {
      const result = await handler(input);
      return {
        result: result as T,
        run: {
          tool: name,
          status: "success",
          latencyMs: Date.now() - started
        }
      };
    } catch (error) {
      return {
        run: {
          tool: name,
          status: "failed",
          latencyMs: Date.now() - started,
          error: error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)
        }
      };
    }
  }
}
