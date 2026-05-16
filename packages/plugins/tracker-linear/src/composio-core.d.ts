/**
 * Minimal type declarations for @jleechanorg/core (optional peer dependency).
 * Only the subset used by the Composio transport is declared here.
 */
declare module "@jleechanorg/core" {
  interface ComposioExecuteResult {
    data?: Record<string, unknown>;
    error?: string;
    successful?: boolean;
  }

  interface ComposioTools {
    execute(action: string, params: Record<string, unknown>): Promise<ComposioExecuteResult>;
  }

  export class Composio {
    constructor(opts: { apiKey: string });
    tools: ComposioTools;
  }
}
