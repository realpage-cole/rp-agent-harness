import type { CmdGroup } from './claudeCommands';
import { COMMAND_GROUPS as CLAUDE_COMMAND_GROUPS } from './claudeCommands';
import { CODEX_COMMAND_GROUPS } from './codexCommands';

export type AgentProvider = 'claude' | 'codex' | 'custom';

export interface AgentProviderPreset {
  id: AgentProvider;
  label: string;
  defaultCommand: string;
  /** Slash / CLI command reference for this provider. */
  commandGroups: CmdGroup[];
  /** Environment variable to set for non-interactive / first-run suppression. */
  nonInteractiveEnv?: Record<string, string>;
  /** Flag(s) appended to the command string when auto mode is active. */
  autoModeFlag: string;
}

export const AGENT_PROVIDER_PRESETS: AgentProviderPreset[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    defaultCommand: 'claude',
    commandGroups: CLAUDE_COMMAND_GROUPS,
    autoModeFlag: '--permission-mode bypassPermissions'
  },
  {
    id: 'codex',
    label: 'Codex',
    defaultCommand: 'codex',
    commandGroups: CODEX_COMMAND_GROUPS,
    // -a never: never prompt for approval; -s workspace-write: sandbox scoped to
    // the workspace (no outbound network). Matches the non-interactive intent of
    // Claude's bypassPermissions while retaining a safety boundary.
    autoModeFlag: '-a never -s workspace-write',
    // Suppresses first-run interactive prompts (directory-trust gate, installer).
    nonInteractiveEnv: { CODEX_NON_INTERACTIVE: '1' }
  },
  {
    id: 'custom',
    label: 'Custom',
    defaultCommand: '',
    commandGroups: [],
    autoModeFlag: ''
  }
];

export function isAgentProvider(value: unknown): value is AgentProvider {
  return value === 'claude' || value === 'codex' || value === 'custom';
}

export function normalizeAgentProvider(value: unknown): AgentProvider | undefined {
  return isAgentProvider(value) ? value : undefined;
}

export function isClaudeProvider(provider: AgentProvider | undefined): boolean {
  return provider === 'claude';
}

function commandBinary(command: string | undefined): string {
  const first = (command ?? '').trim().split(/\s+/)[0] ?? '';
  const base = first.split(/[\\/]/).pop() ?? first;
  return base.replace(/\.(cmd|exe)$/i, '').toLowerCase();
}

export function inferAgentProvider(command: string | undefined, explicit?: unknown): AgentProvider {
  const normalized = normalizeAgentProvider(explicit);
  if (normalized) return normalized;
  const bin = commandBinary(command);
  if (bin === 'codex') return 'codex';
  if (bin === 'claude' || !bin) return 'claude';
  return 'custom';
}

export function defaultCommandForProvider(provider: AgentProvider, fallback = ''): string {
  if (provider === 'custom') return fallback;
  return AGENT_PROVIDER_PRESETS.find((p) => p.id === provider)?.defaultCommand ?? fallback;
}

/** Returns the preset's auto-mode CLI flag for the given provider. Empty string = no flag. */
export function autoModeFlagForProvider(provider: AgentProvider): string {
  return AGENT_PROVIDER_PRESETS.find((p) => p.id === provider)?.autoModeFlag ?? '';
}

/** Returns any env vars the provider needs for non-interactive / first-run suppression. */
export function nonInteractiveEnvForProvider(provider: AgentProvider): Record<string, string> {
  return AGENT_PROVIDER_PRESETS.find((p) => p.id === provider)?.nonInteractiveEnv ?? {};
}

/** Returns the command reference groups for the given provider. */
export function commandGroupsForProvider(provider: AgentProvider): CmdGroup[] {
  return AGENT_PROVIDER_PRESETS.find((p) => p.id === provider)?.commandGroups ?? [];
}
