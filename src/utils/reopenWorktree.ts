import path from 'path';
import * as fs from 'fs';
import { TmuxService } from '../services/TmuxService.js';
import {
  ensurePaneBorderStatusForCurrentSession,
  setupSidebarLayout,
  getTerminalDimensions,
  splitPane,
} from './tmux.js';
import { SIDEBAR_WIDTH, recalculateAndApplyLayout } from './layoutManager.js';
import type { DmuxPane, DmuxConfig } from '../types.js';
import { atomicWriteJsonSync } from './atomicWrite.js';
import { DMUX_BOOTSTRAP_PANE_TITLE_PREFIX } from './paneBootstrapConfig.js';
import {
  AGENT_IDS,
  buildAgentResumeOrLaunchCommand,
  shouldEnableCodexGoals,
  type AgentName,
} from './agentLaunch.js';
import { ensureGeminiFolderTrusted } from './geminiTrust.js';
import { SettingsManager } from './settingsManager.js';
import { filterEnabledAgents, getInstalledAgents } from './agentDetection.js';
import { getCurrentBranch } from './git.js';
import { readWorktreeMetadata } from './worktreeMetadata.js';
import {
  buildCodexHookedCommand,
  installCodexPaneHooks,
} from './codexHooks.js';
import { installClaudePaneHooks } from './claudeHooks.js';
import { installGrokPaneHooks } from './grokHooks.js';
import { resolveProjectColorTheme } from './paneColors.js';
import type { SidebarProject } from '../types.js';

export interface ReopenWorktreeOptions {
  agent?: AgentName;
  slug: string;
  worktreePath: string;
  projectRoot: string; // Target repo root for the reopened pane
  sessionConfigPath?: string; // Shared dmux config path for this session
  sessionProjectRoot?: string; // Session root for welcome pane/layout state
  existingPanes: DmuxPane[];
}

export interface ReopenWorktreeResult {
  pane: DmuxPane;
}

/**
 * Reopens a closed worktree by creating a new pane in the existing worktree
 * and launching the best available agent resume command.
 */
export async function reopenWorktree(
  options: ReopenWorktreeOptions
): Promise<ReopenWorktreeResult> {
  const {
    agent: requestedAgent,
    slug,
    worktreePath,
    projectRoot,
    existingPanes,
    sessionConfigPath: optionsSessionConfigPath,
    sessionProjectRoot: optionsSessionProjectRoot,
  } = options;
  const paneProjectName = path.basename(projectRoot);
  const settings = new SettingsManager(projectRoot).getSettings();
  const metadata = readWorktreeMetadata(worktreePath);
  const sessionProjectRoot = optionsSessionProjectRoot
    || (optionsSessionConfigPath ? path.dirname(path.dirname(optionsSessionConfigPath)) : projectRoot);

  const tmuxService = TmuxService.getInstance();
  const originalPaneId = tmuxService.getCurrentPaneIdSync();

  // Load config to get control pane info
  const configPath = optionsSessionConfigPath
    || path.join(sessionProjectRoot, '.dmux', 'dmux.config.json');
  let controlPaneId: string | undefined;
  let configSidebarProjects: SidebarProject[] = [];

  try {
    const configContent = fs.readFileSync(configPath, 'utf-8');
    const config: DmuxConfig = JSON.parse(configContent);
    controlPaneId = config.controlPaneId;
    configSidebarProjects = Array.isArray(config.sidebarProjects) ? config.sidebarProjects : [];

    // Verify the control pane ID from config still exists
    if (controlPaneId) {
      const exists = await tmuxService.paneExists(controlPaneId);
      if (!exists) {
        controlPaneId = originalPaneId;
        config.controlPaneId = controlPaneId;
        config.controlPaneSize = SIDEBAR_WIDTH;
        config.lastUpdated = new Date().toISOString();
        atomicWriteJsonSync(configPath, config);
      }
    }

    if (!controlPaneId) {
      controlPaneId = originalPaneId;
      config.controlPaneId = controlPaneId;
      config.controlPaneSize = SIDEBAR_WIDTH;
      config.lastUpdated = new Date().toISOString();
      atomicWriteJsonSync(configPath, config);
    }
  } catch {
    controlPaneId = originalPaneId;
  }

  // Enable pane borders to show titles
  try {
    ensurePaneBorderStatusForCurrentSession();
  } catch {
    // Ignore if already set or fails
  }

  // Determine if this is the first content pane
  const isFirstContentPane = existingPanes.length === 0;

  let paneInfo: string;

  if (isFirstContentPane) {
    paneInfo = setupSidebarLayout(controlPaneId, projectRoot);
  } else {
    // Subsequent panes - always split horizontally
    const dmuxPaneIds = existingPanes.map(p => p.paneId);
    const targetPane = dmuxPaneIds[dmuxPaneIds.length - 1];
    paneInfo = splitPane({ targetPane });
  }

  // Mark the pane as dmux-owned IMMEDIATELY after creation (before the settle
  // delay below) so the shell-pane detector never sees it untitled during the
  // config-save race. Mirrors createPane's guard — without this, a reopened
  // pane can be re-adopted as a plain shell pane (no worktreePath /
  // mergeTargetChain). The real worktree title is applied later by
  // enforcePaneTitles once the pane is persisted to config.
  try {
    await tmuxService.setPaneTitle(paneInfo, `${DMUX_BOOTSTRAP_PANE_TITLE_PREFIX}${slug}`);
  } catch {
    // Ignore if setting title fails
  }

  await new Promise((resolve) => setTimeout(resolve, isFirstContentPane ? 800 : 500));

  // Apply optimal layout
  if (controlPaneId) {
    const dimensions = getTerminalDimensions();
    const allContentPaneIds = [...existingPanes.map(p => p.paneId), paneInfo];

    await recalculateAndApplyLayout(
      controlPaneId,
      allContentPaneIds,
      dimensions.width,
      dimensions.height
    );

    await tmuxService.refreshClient();
  }

  // CD into the worktree
  await tmuxService.sendShellCommand(paneInfo, `cd "${worktreePath}"`);
  await tmuxService.sendTmuxKeys(paneInfo, 'Enter');

  // Wait for CD to complete
  await new Promise((resolve) => setTimeout(resolve, 300));

  // Detect which agent to use - prefer stored metadata, then fall back to enabled/installed order.
  const installedAgents = await getInstalledAgents();
  const enabledAgents = filterEnabledAgents(installedAgents, settings.enabledAgents);
  const candidateAgents = enabledAgents.length > 0 ? enabledAgents : installedAgents;
  const preferredOrder: AgentName[] = [
    'claude',
    'codex',
    'opencode',
    ...AGENT_IDS.filter((agent) =>
      !['claude', 'codex', 'opencode'].includes(agent)
    ),
  ];
  const configuredAgent = metadata?.agent;
  const agent = requestedAgent
    || (configuredAgent && candidateAgents.includes(configuredAgent)
      ? configuredAgent
      : preferredOrder.find((candidate) => candidateAgents.includes(candidate)));
  const permissionMode = metadata?.permissionMode ?? settings.permissionMode;
  const goalMode = metadata?.goalMode ?? settings.enableGoalModeByDefault ?? false;
  const dmuxPaneId = `dmux-${Date.now()}`;

  // Build + persist the pane object BEFORE launching the agent so the pane is
  // tracked (by paneId) while the agent TUI overwrites the pane title during
  // startup. The dmux-bootstrap: guard above only protects the split→save
  // window; once opencode/claude replaces the title, the shell-pane detector
  // would re-adopt the pane unless it is already in config.
  const currentBranch = getCurrentBranch(worktreePath);
  const newPane: DmuxPane = {
    id: dmuxPaneId,
    slug,
    displayName: metadata?.displayName,
    branchName: (metadata?.branchName || currentBranch) !== slug
      ? (metadata?.branchName || currentBranch)
      : undefined,
    prompt: '(Reopened session)',
    paneId: paneInfo,
    projectRoot,
    projectName: paneProjectName,
    colorTheme: resolveProjectColorTheme(projectRoot, configSidebarProjects),
    worktreePath,
    agent,
    permissionMode,
    autopilot: settings.enableAutopilotByDefault ?? false,
    goalMode,
    mergeTargetChain: metadata?.mergeTargetChain,
  };

  try {
    const configContent = fs.readFileSync(configPath, 'utf-8');
    const config: DmuxConfig = JSON.parse(configContent);
    config.panes = [...existingPanes, newPane];
    config.lastUpdated = new Date().toISOString();
    atomicWriteJsonSync(configPath, config);
  } catch {
    // Log but don't fail
  }

  // Resume the agent session (or start interactive mode when no resume command is available).
  if (agent) {
    if (agent === 'gemini') {
      ensureGeminiFolderTrusted(worktreePath);
    }

    let resumeCommand = buildAgentResumeOrLaunchCommand(agent, permissionMode);
    if (agent === 'codex') {
      let codexHookEventFile: string | undefined;
      try {
        codexHookEventFile = installCodexPaneHooks({
          worktreePath,
          dmuxPaneId,
          tmuxPaneId: paneInfo,
        }).eventFile;
      } catch {
        // Hook installation is best effort; Codex can still resume normally.
      }

      resumeCommand = buildCodexHookedCommand(resumeCommand, {
        dmuxPaneId,
        tmuxPaneId: paneInfo,
        eventFile: codexHookEventFile,
      }, {
        enableGoals: shouldEnableCodexGoals(agent, goalMode),
      });
    }

    if (agent === 'claude') {
      try {
        installClaudePaneHooks({
          worktreePath,
          dmuxPaneId,
          tmuxPaneId: paneInfo,
        });
      } catch {
        // Hook installation is best effort; Claude can still resume normally.
      }
    }

    if (agent === 'grok') {
      try {
        installGrokPaneHooks({
          worktreePath,
          dmuxPaneId,
          tmuxPaneId: paneInfo,
        });
      } catch {
        // Hook installation is best effort; Grok can still resume normally.
      }
    }

    await tmuxService.sendShellCommand(paneInfo, resumeCommand);
    await tmuxService.sendTmuxKeys(paneInfo, 'Enter');
  }

  // Keep focus on the new pane
  await tmuxService.selectPane(paneInfo);

  // Always destroy welcome pane if one exists — shell panes can make isFirstContentPane
  // false even when no real content pane exists yet.
  try {
    const { destroyWelcomePaneCoordinated } = await import('./welcomePaneManager.js');
    destroyWelcomePaneCoordinated(sessionProjectRoot);
  } catch {
    // Ignore - welcome pane cleanup is not critical
  }

  // Switch back to the original pane
  await tmuxService.selectPane(originalPaneId);

  return {
    pane: newPane,
  };
}
