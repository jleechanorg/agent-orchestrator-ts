/**
 * MCP tool definitions for prose-polish.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, normalize, resolve } from "node:path";
import { scanLines, RULE_DESCRIPTIONS } from "./detector.js";
import { autoFixFile } from "./fixer.js";
import type { ScanResult, FixResult } from "./types.js";

function safePath(filePath: string): string | null {
  if (!filePath) return null;
  // Resolve relative paths (e.g. "README.md", "./docs/ch1.md") against cwd
  // Absolute paths (POSIX /foo or Windows C:\) are used as-is
  const resolved = isAbsolute(filePath) ? filePath : resolve(filePath);
  // Normalize and reject actual path traversal (.. path segments)
  const normalized = normalize(resolved);
  if (normalized.includes("..")) return null;
  return normalized;
}

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

// ---- Tool definitions ----

export const TOOL_DEFINITIONS: McpToolDefinition[] = [
  {
    name: "prose_polish_scan",
    description: "Scan a markdown or prose file for common fiction prose patterns",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Path to the file to scan" },
        min_severity: {
          type: "string",
          enum: ["info", "warn", "critical"],
          default: "info",
          description: "Minimum severity to report",
        },
      },
      required: ["file_path"],
    },
  },
  {
    name: "prose_polish_fix",
    description: "Apply auto-fixable prose corrections to a file (creates .bak backup)",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Path to the file to fix" },
        min_severity: {
          type: "string",
          enum: ["info", "warn", "critical"],
          default: "warn",
          description: "Minimum severity to fix",
        },
      },
      required: ["file_path"],
    },
  },
  {
    name: "prose_polish_rules",
    description: "List all prose pattern rules with descriptions",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

// ---- Tool handlers ----

function handleScan(args: { file_path: string; min_severity?: string }): McpToolResult {
  try {
    const resolved = safePath(args.file_path);
    if (!resolved) return { success: false, error: "Invalid file path: absolute or relative paths accepted, path traversal ('..' segments) is rejected" };
    const content = readFileSync(resolved, "utf-8");
    const lines = content.split("\n");
    const minSeverity = (args.min_severity as "info" | "warn" | "critical") ?? "info";
    const result: ScanResult = scanLines(resolved, lines, minSeverity);
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

function handleFix(args: { file_path: string; min_severity?: string }): McpToolResult {
  try {
    const resolved = safePath(args.file_path);
    if (!resolved) return { success: false, error: "Invalid file path: absolute or relative paths accepted, path traversal ('..' segments) is rejected" };
    const content = readFileSync(resolved, "utf-8");
    const result: FixResult = autoFixFile(
      resolved,
      content,
      (args.min_severity as "info" | "warn" | "critical") ?? "warn"
    );
    return { success: true, data: result };
  } catch (err) {
    return { success: false, error: String(err) };
  }
}

function handleRules(): McpToolResult {
  const rules = Object.entries(RULE_DESCRIPTIONS).map(([rule, description]) => ({
    rule,
    description,
  }));
  return { success: true, data: rules };
}

/**
 * Dispatch a tool call by name.
 */
export function dispatchTool(name: string, args: Record<string, unknown>): McpToolResult {
  switch (name) {
    case "prose_polish_scan":
      return handleScan(args as { file_path: string; min_severity?: string });
    case "prose_polish_fix":
      return handleFix(args as { file_path: string; min_severity?: string });
    case "prose_polish_rules":
      return handleRules();
    default:
      return { success: false, error: `Unknown tool: ${name}` };
  }
}

/**
 * Create MCP tool definitions for use in AO agent plugin.
 */
export function createMcpTools() {
  return {
    definitions: TOOL_DEFINITIONS,
    dispatch: dispatchTool,
  };
}
