import { type Config } from '@opencode-ai/plugin';
import { errorMessage, SECRET_PATTERN } from './utils.js';
import { isSecretSanitizationEnabled } from './recall-gate.js';
import { statusJson, launchUi, unmergedBranchesText } from './memoir-ops.js';

export type CommandOutput = {
  parts: unknown[];
};

export type OpenCodeConfig = Config & {
  command?: Config['command'];
};

function pushText(output: CommandOutput, text: string): void {
  output.parts.length = 0;
  output.parts.push({ type: 'text', text });
}

export function registerCommands(config: OpenCodeConfig): void {
  config.command = config.command ?? {};

  config.command['memoir:status'] = {
    description: 'Show Memoir status for the current OpenCode project',
    template: 'Show Memoir status for this OpenCode project.',
  };

  config.command['memoir:ui'] = {
    description: 'Launch or reopen the Memoir web UI for this project store',
    template: 'Launch or reopen the Memoir UI for this project.',
  };

  config.command['memoir:remember'] = {
    description: 'Save a durable fact, preference, rule, or decision to Memoir',
    template: `Use Memoir to save this durable memory now.\n\nUSER REQUEST:\n$ARGUMENTS\n\nExtract the memory content, choose a semantic path if none is supplied, then call the memoir_remember tool. Never save secrets.`,
  };

  config.command['memoir:recall'] = {
    description: 'Recall relevant facts from Memoir before answering',
    template: `Recall relevant Memoir memories for this request.\n\nUSER REQUEST:\n$ARGUMENTS\n\nUse memoir_recall first. It checks default plus onboard namespaces unless a namespace is specified. Then call memoir_get with the matching namespace for exact values before answering.`,
  };

  config.command['memoir:onboard'] = {
    description: 'Populate or refresh Memoir onboarding for this project',
    template: `Populate or refresh Memoir onboarding for the CURRENT OpenCode project only.\n\nUSER REQUEST:\n$ARGUMENTS\n\nWorkflow:\n- Stay inside the current project/worktree. Do not inspect parent directories.\n- First obtain a project file tree to understand structure.\n- Start studying from project documentation.\n- Continue only based on what the tree and documentation show.\n\nMemory rules:\n- Record only verified facts from files/docs/code or explicit user statements.\n- Do not write inferred user thoughts, intentions, preferences, or opinions.\n- Do not use preferences.* paths unless the user explicitly stated a preference.\n- If a fact is your interpretation, do not save it; report it as uncertain instead.\n\nThen call memoir_remember with replace=true for durable onboarding facts. Use namespace codebase:onboard in git repositories and project:onboard outside git. Do not install or invoke separate skills/scripts.`,
  };

  config.command['memoir:unmerged'] = {
    description: 'List memoir branches with changes not yet merged into main',
    template: 'List memoir branches that have diverged from main.',
  };
}

export async function handleCommandExecuteBefore(storeRoot: string, input: { command?: string }, output: CommandOutput): Promise<void> {
  try {
    if (input.command === 'memoir:status') {
      pushText(output, await statusJson(storeRoot));
    }
    if (input.command === 'memoir:ui') {
      pushText(output, await launchUi(storeRoot));
    }
    if (input.command === 'memoir:remember') {
      const args = (input as { arguments?: string }).arguments;
      if (args && isSecretSanitizationEnabled() && SECRET_PATTERN.test(args)) {
        pushText(output, 'Memoir: cannot remember content that matches secret patterns. Please remove sensitive data and try again.');
      }
    }
    if (input.command === 'memoir:unmerged') {
      pushText(output, await unmergedBranchesText(storeRoot));
    }
  } catch (error) {
    pushText(output, `Memoir command failed: ${errorMessage(error)}`);
  }
}
