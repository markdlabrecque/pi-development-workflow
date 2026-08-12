/**
 * Per-role configuration for development-workflow.
 *
 * Each role has a thinking level, max output tokens, and a provider-qualified model.
 * The workflow extension uses this to configure child subagent dispatches.
 */

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type RoleName = "planner" | "implementer" | "test-writer" | "reviewer" | "reporter";

export interface RoleConfig {
  /** Role identifier matching the agent profile name. */
  name: RoleName;
  /** Thinking level for this role. Overrides the agent profile's thinking field. */
  thinking: ThinkingLevel;
  /** Maximum output tokens for this role. null means use the default (32k). */
  maxTokens: number | null;
  /** Provider-qualified model matching the Claude role analogue. */
  model: string;
  /** Whether this role is read-only (no mutation tools). */
  readOnly: boolean;
  /** Description used in status output. */
  description: string;
}

/**
 * Pi GPT-5.6 mappings for Claude role analogues. Planner is retained only to
 * resume legacy workflows already in planning; new planning stays foreground.
 */
export const ACTIVE_ROLE_NAMES = ["implementer", "test-writer", "reviewer", "reporter"] as const satisfies readonly RoleName[];

export const DEFAULT_ROLE_CONFIG: Record<RoleName, RoleConfig> = {
  planner: {
    name: "planner",
    thinking: "high",
    maxTokens: 16384,
    model: "openai-codex/gpt-5.6-sol",
    readOnly: true,
    description: "Legacy-only planning role for pre-existing workflows",
  },
  implementer: {
    name: "implementer",
    thinking: "medium",
    maxTokens: 32768,
    model: "openai-codex/gpt-5.6-luna",
    readOnly: false,
    description: "Implement approved plans and required review fixes",
  },
  "test-writer": {
    name: "test-writer",
    thinking: "low",
    maxTokens: 16384,
    model: "openai-codex/gpt-5.6-luna",
    readOnly: false,
    description: "Add meaningful tests and edge cases after implementation",
  },
  reviewer: {
    name: "reviewer",
    thinking: "medium",
    maxTokens: 8192,
    model: "openai-codex/gpt-5.6-sol",
    readOnly: true,
    description: "Review changes for regressions, security, contracts, concurrency, and tests",
  },
  reporter: {
    name: "reporter",
    thinking: "low",
    maxTokens: 8192,
    model: "openai-codex/gpt-5.6-luna",
    readOnly: true,
    description: "Record workflow results and approved follow-up work",
  },
};

/**
 * Look up the config for a role by name. Throws if unknown.
 */
export function getRoleConfig(name: string): RoleConfig {
  const config = (DEFAULT_ROLE_CONFIG as Record<string, RoleConfig>)[name];
  if (!config) throw new Error(`Unknown workflow role: ${name}. Available: ${Object.keys(DEFAULT_ROLE_CONFIG).join(", ")}`);
  return config;
}

/**
 * Get the thinking level for a role. Returns undefined if the agent profile
 * has no override and we should inherit from the parent session.
 */
export function getRoleThinking(roleName: string): ThinkingLevel | undefined {
  const config = (DEFAULT_ROLE_CONFIG as Record<string, RoleConfig>)[roleName];
  return config?.thinking;
}

/**
 * Get the maxTokens for a role. Returns null to use the model default.
 */
export function getRoleMaxTokens(roleName: string): number | null {
  const config = (DEFAULT_ROLE_CONFIG as Record<string, RoleConfig>)[roleName];
  return config?.maxTokens ?? null;
}

/**
 * Check if a role is read-only (no mutation tools).
 */
export function isRoleReadOnly(roleName: string): boolean {
  const config = (DEFAULT_ROLE_CONFIG as Record<string, RoleConfig>)[roleName];
  return config?.readOnly ?? false;
}
