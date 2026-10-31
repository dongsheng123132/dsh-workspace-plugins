import type { WorkspaceHubService } from './service.js';
/**
 * Build the two tool definitions bound to one service instance.
 * @param hub the owning workspace-hub service
 * @returns registry-ready tool definitions, list first
 */
export declare function createWorkspaceHubTools(hub: WorkspaceHubService): readonly [import("@deepseek-ai/dsh-tools").ToolDefinition, import("@deepseek-ai/dsh-tools").ToolDefinition, import("@deepseek-ai/dsh-tools").ToolDefinition, import("@deepseek-ai/dsh-tools").ToolDefinition];
