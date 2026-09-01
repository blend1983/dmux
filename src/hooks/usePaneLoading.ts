import fs from 'fs/promises';
import path from 'path';
import type { DmuxPane, SidebarProject } from '../types.js';
import { splitPane } from '../utils/tmux.js';
import { rebindPaneByTitle } from '../utils/paneRebinding.js';
import { LogService } from '../services/LogService.js';
import { TmuxService } from '../services/TmuxService.js';
import { PaneLifecycleManager } from '../services/PaneLifecycleManager.js';
import { TMUX_RETRY_DELAY } from '../constants/timing.js';
import { syncPaneColorThemes } from '../utils/paneColors.js';
import {
  buildAgentResumeOrLaunchCommand,
  shouldEnableCodexGoals,
} from '../utils/agentLaunch.js';
import { ensureGeminiFolderTrusted } from '../utils/geminiTrust.js';
import {
  buildCodexHookedCommand,
  installCodexPaneHooks,
} from '../utils/codexHooks.js';
import { installClaudePaneHooks } from '../utils/claudeHooks.js';
import { getPaneTmuxTitle } from '../utils/paneTitle.js';
import {
  getVisiblePanes,
  syncHiddenStateFromCurrentWindow,
} from '../utils/paneVisibility.js';
import { normalizeSidebarProjects } from '../utils/sidebarProjects.js';

// Separate config structure to match new format
export interface DmuxConfig {
  projectName?: string;
  projectRoot?: string;
  panes: DmuxPane[];
  sidebarProjects?: SidebarProject[];
  settings?: any;
  lastUpdated?: string;
  controlPaneId?: string;
  welcomePaneId?: string;
}

interface PaneLoadResult {
  panes: DmuxPane[];
  allPaneIds: string[];
  titleToId: Map<string, string>;
  paneMetadataChanged: boolean;
}

async function resolveRestoreCwd(
  pane: DmuxPane,
  sessionProjectRoot: string
): Promise<string> {
  const candidates = [
    pane.shellCwd,
    pane.browserPath,
    pane.worktreePath,
    pane.projectRoot,
    sessionProjectRoot,
    process.cwd(),
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) return candidate;
    } catch {
      // Try the next persisted fallback when a directory was removed.
    }
  }

  return process.cwd();
}

function syncShellRuntimeMetadata(
  panes: DmuxPane[],
  panePathById: Map<string, string>
): { panes: DmuxPane[]; changed: boolean } {
  let changed = false;
  const syncedPanes = panes.map((pane) => {
    if (pane.type !== 'shell') return pane;
    const currentPath = panePathById.get(pane.paneId);
    if (!currentPath || currentPath === pane.shellCwd) return pane;
    changed = true;
    return { ...pane, shellCwd: currentPath };
  });

  return { panes: syncedPanes, changed };
}

async function restoreAgentSessionForPane(
  tmuxService: TmuxService,
  pane: DmuxPane,
  paneId: string
): Promise<void> {
  if (!pane.agent) {
    return;
  }

  if (pane.agent === 'gemini' && pane.worktreePath) {
    ensureGeminiFolderTrusted(pane.worktreePath);
  }

  await new Promise((resolve) => setTimeout(resolve, 200));
  let command = buildAgentResumeOrLaunchCommand(
    pane.agent,
    pane.permissionMode,
    pane.agentSessionId
  );

  if (pane.agent === 'codex' && pane.worktreePath) {
    let codexHookEventFile: string | undefined;
    try {
      codexHookEventFile = installCodexPaneHooks({
        worktreePath: pane.worktreePath,
        dmuxPaneId: pane.id,
        tmuxPaneId: paneId,
      }).eventFile;
    } catch {
      // Hook installation is best effort; Codex can still resume normally.
    }

    command = buildCodexHookedCommand(command, {
      dmuxPaneId: pane.id,
      tmuxPaneId: paneId,
      eventFile: codexHookEventFile,
    }, {
      enableGoals: shouldEnableCodexGoals(pane.agent, pane.goalMode),
    });
  }

  if (pane.agent === 'claude' && pane.worktreePath) {
    try {
      installClaudePaneHooks({
        worktreePath: pane.worktreePath,
        dmuxPaneId: pane.id,
        tmuxPaneId: paneId,
      });
    } catch {
      // Hook installation is best effort; Claude can still resume normally.
    }
  }

  await tmuxService.sendShellCommand(paneId, command);
  await tmuxService.sendTmuxKeys(paneId, 'Enter');
}

/**
 * Fetches all tmux pane IDs and titles for the current session
 * Retries up to maxRetries times with delay between attempts
 */
export async function fetchTmuxPaneIds(maxRetries = 2): Promise<{
  allPaneIds: string[];
  titleToId: Map<string, string>;
  currentWindowPaneIds: string[];
  panePathById: Map<string, string>;
}> {
  const tmuxService = TmuxService.getInstance();
  let retryCount = 0;

  while (retryCount <= maxRetries) {
    try {
      const paneInfo = await tmuxService.getAllPaneInfo('session');
      const currentWindowPaneIds = await tmuxService.getAllPaneIds('window');
      const allPaneIds: string[] = [];
      const titleToId = new Map<string, string>();
      const panePathById = new Map<string, string>();

      for (const pane of paneInfo) {
        if (!pane.paneId || !pane.paneId.startsWith('%') || pane.title === 'dmux-spacer') {
          continue;
        }
        allPaneIds.push(pane.paneId);
        if (pane.title) {
          titleToId.set(pane.title.trim(), pane.paneId);
        }
        if (pane.currentPath) {
          panePathById.set(pane.paneId, pane.currentPath);
        }
      }

      if (allPaneIds.length > 0 || retryCount === maxRetries) {
        return { allPaneIds, titleToId, currentWindowPaneIds, panePathById };
      }
    } catch (error) {
      // Retry on tmux command failure (common during rapid pane creation/destruction)
  //       LogService.getInstance().debug(
  //         `Tmux fetch failed (attempt ${retryCount + 1}/${maxRetries}): ${error instanceof Error ? error.message : String(error)}`,
  //         'usePaneLoading'
  //       );
      if (retryCount < maxRetries) await new Promise(r => setTimeout(r, TMUX_RETRY_DELAY));
    }
    retryCount++;
  }

  return {
    allPaneIds: [],
    titleToId: new Map(),
    currentWindowPaneIds: [],
    panePathById: new Map(),
  };
}

/**
 * Reads and parses the panes config file
 * Handles both old array format and new config format
 */
export async function loadPanesFromFile(panesFile: string): Promise<DmuxPane[]> {
  const fallbackProjectRoot = path.dirname(path.dirname(panesFile));

  try {
    const content = await fs.readFile(panesFile, 'utf-8');
    const parsed: any = JSON.parse(content);

    if (Array.isArray(parsed)) {
      return syncPaneColorThemes(parsed as DmuxPane[], [], fallbackProjectRoot);
    } else {
      const config = parsed as DmuxConfig;
      const projectRoot = config.projectRoot || fallbackProjectRoot;
      const panes = Array.isArray(config.panes) ? config.panes : [];
      const sidebarProjects = Array.isArray(config.sidebarProjects) ? config.sidebarProjects : [];
      return syncPaneColorThemes(panes, sidebarProjects, projectRoot);
    }
  } catch (error) {
    // Return empty array if config file doesn't exist or is invalid
    // This is expected on first run
  //     LogService.getInstance().debug(
  //       `Config file not found or invalid: ${error instanceof Error ? error.message : String(error)}`,
  //       'usePaneLoading'
  //     );
    return [];
  }
}

export async function loadSidebarProjectsFromFile(
  panesFile: string,
  panes?: DmuxPane[]
): Promise<SidebarProject[]> {
  const fallbackProjectRoot = path.dirname(path.dirname(panesFile));

  try {
    const content = await fs.readFile(panesFile, 'utf-8');
    const parsed: any = JSON.parse(content);
    const config = Array.isArray(parsed)
      ? { panes: parsed as DmuxPane[] }
      : parsed as DmuxConfig;
    const configPanes = Array.isArray(config.panes) ? config.panes : [];
    const effectivePanes = panes || configPanes;
    const projectRoot = config.projectRoot || fallbackProjectRoot;
    const projectName = config.projectName || path.basename(projectRoot);

    return normalizeSidebarProjects(
      config.sidebarProjects,
      effectivePanes,
      projectRoot,
      projectName
    );
  } catch {
    return normalizeSidebarProjects(
      undefined,
      panes || [],
      fallbackProjectRoot,
      path.basename(fallbackProjectRoot)
    );
  }
}

/**
 * Recreates missing worktree and regular terminal panes that exist in config
 * but not in tmux.
 * Only called on initial load
 */
export async function recreateMissingPanes(
  missingPanes: DmuxPane[],
  panesFile: string
): Promise<void> {
  if (missingPanes.length === 0) return;

  const tmuxService = TmuxService.getInstance();
  const sessionProjectRoot = path.dirname(path.dirname(panesFile));

  for (const missingPane of missingPanes) {
    try {
      // Create new pane
      const restoreCwd = await resolveRestoreCwd(missingPane, sessionProjectRoot);
      const newPaneId = splitPane({
        cwd: restoreCwd,
        command: missingPane.type === 'shell' ? missingPane.shellCommand : undefined,
      });

      // Set pane title
      await tmuxService.setPaneTitle(newPaneId, getPaneTmuxTitle(missingPane, sessionProjectRoot));

      // Update the pane with new ID
      missingPane.paneId = newPaneId;

      if (missingPane.type !== 'shell') {
        // Worktree panes also resume their agent session after recreation.
        await tmuxService.sendKeys(newPaneId, `"echo '# Pane restored: ${missingPane.slug}'" Enter`);
        const promptPreview = missingPane.prompt?.substring(0, 50) || '';
        await tmuxService.sendKeys(newPaneId, `"echo '# Original prompt: ${promptPreview}...'" Enter`);
        await tmuxService.sendKeys(newPaneId, `"cd ${restoreCwd}" Enter`);
        await restoreAgentSessionForPane(tmuxService, missingPane, newPaneId);
      } else if (missingPane.activeAgent && !missingPane.shellCommand) {
        // A regular terminal that disappeared while an agent was active should
        // return directly to that conversation after a machine/session restart.
        await restoreAgentSessionForPane(tmuxService, missingPane, newPaneId);
      }
    } catch (error) {
      // If we can't create the pane, skip it
    }
  }

  // Apply even-horizontal layout after creating panes
  try {
    await tmuxService.selectLayout('even-horizontal');
    await tmuxService.refreshClient();
  } catch {}
}

/**
 * Recreates worktree panes that were killed by the user (e.g., via Ctrl+b x)
 * Called during periodic polling after initial load
 *
 * IMPORTANT: Checks PaneLifecycleManager to avoid recreating panes that are
 * being intentionally closed (prevents race condition with close/merge actions)
 */
export async function recreateKilledPanes(
  panes: DmuxPane[],
  allPaneIds: string[],
  panesFile: string
): Promise<DmuxPane[]> {
  const lifecycleManager = PaneLifecycleManager.getInstance();
  const sessionProjectRoot = path.dirname(path.dirname(panesFile));

  // Filter out panes that are being intentionally closed
  const panesToRecreate = panes.filter(pane => {
    // Pane must be missing from tmux and be a tracked, restorable content pane.
    if (
      allPaneIds.includes(pane.paneId)
      || (pane.type !== 'shell' && !pane.worktreePath)
    ) {
      return false;
    }

    // CRITICAL: Check if this pane is being intentionally closed
    // This is a safety belt - the main protection is that close action
    // removes pane from config BEFORE killing tmux pane
    if (lifecycleManager.isClosing(pane.id) || lifecycleManager.isClosing(pane.paneId)) {
      LogService.getInstance().debug(
        `Skipping recreation of pane ${pane.id} (${pane.slug}) - intentionally being closed`,
        'shellDetection'
      );
      return false;
    }

    return true;
  });

  if (panesToRecreate.length === 0) return panes;

  const tmuxService = TmuxService.getInstance();

  const updatedPanes = [...panes];

  for (const pane of panesToRecreate) {
    try {
      const restoreCwd = await resolveRestoreCwd(pane, sessionProjectRoot);
      const newPaneId = splitPane({
        cwd: restoreCwd,
        command: pane.type === 'shell' ? pane.shellCommand : undefined,
        detached: true,
      });

      // Set pane title
      await tmuxService.setPaneTitle(newPaneId, getPaneTmuxTitle(pane, sessionProjectRoot));

      // Update the pane with new ID
      const paneIndex = updatedPanes.findIndex(p => p.id === pane.id);
      if (paneIndex !== -1) {
        updatedPanes[paneIndex] = { ...pane, paneId: newPaneId };
      }

      if (pane.type !== 'shell') {
        await tmuxService.sendKeys(newPaneId, `"echo '# Pane restored: ${pane.slug}'" Enter`);
        if (pane.prompt) {
          const promptPreview = pane.prompt.substring(0, 50) || '';
          await tmuxService.sendKeys(newPaneId, `"echo '# Original prompt: ${promptPreview}...'" Enter`);
        }
        await tmuxService.sendKeys(newPaneId, `"cd ${restoreCwd}" Enter`);
        await restoreAgentSessionForPane(tmuxService, pane, newPaneId);
      } else if (pane.activeAgent && !pane.shellCommand) {
        await restoreAgentSessionForPane(tmuxService, pane, newPaneId);
      }

  //       LogService.getInstance().debug(
  //         `Recreated pane ${pane.id} (${pane.slug}) with new ID ${newPaneId}`,
  //         'shellDetection'
  //       );
    } catch (error) {
  //       LogService.getInstance().debug(
  //         `Failed to recreate worktree pane ${pane.id} (${pane.slug})`,
  //         'shellDetection'
  //       );
    }
  }

  // Recalculate layout after recreating panes
  try {
    const configContent = await fs.readFile(panesFile, 'utf-8');
    const config = JSON.parse(configContent);
    if (config.controlPaneId) {
      const { recalculateAndApplyLayout } = await import('../utils/layoutManager.js');
      const { getTerminalDimensions } = await import('../utils/tmux.js');
      const dimensions = getTerminalDimensions();

      const contentPaneIds = getVisiblePanes(updatedPanes).map(p => p.paneId);
      recalculateAndApplyLayout(
        config.controlPaneId,
        contentPaneIds,
        dimensions.width,
        dimensions.height
      );

  //       LogService.getInstance().debug(
  //         `Recalculated layout after recreating panes`,
  //         'shellDetection'
  //       );
    }
  } catch (error) {
  //     LogService.getInstance().debug(
  //       'Failed to recalculate layout after recreating worktree panes',
  //       'shellDetection'
  //     );
  }

  return updatedPanes;
}

// Backward-compatible export for integrations that imported the old name.
export const recreateKilledWorktreePanes = recreateKilledPanes;

/**
 * Loads panes from config file, rebinds IDs, and recreates missing panes
 * Returns the loaded and processed panes along with tmux state
 *
 * Regular terminal panes are durable config entries, just like worktree panes.
 * Missing panes are recreated from their stable title and last observed cwd.
 */
export async function loadAndProcessPanes(
  panesFile: string,
  isInitialLoad: boolean
): Promise<PaneLoadResult> {
  const loadedPanes = await loadPanesFromFile(panesFile);
  let { allPaneIds, titleToId, currentWindowPaneIds, panePathById } = await fetchTmuxPaneIds();

  // Attempt to rebind panes whose IDs changed by matching on their stable tmux title.
  let reboundPanes = syncHiddenStateFromCurrentWindow(
    loadedPanes.map(p => rebindPaneByTitle(p, titleToId, allPaneIds)),
    currentWindowPaneIds
  );

  let shellMetadata = syncShellRuntimeMetadata(reboundPanes, panePathById);
  reboundPanes = shellMetadata.panes;

  // Recreate every tracked content pane that is missing on initial load.
  const missingPanes = (allPaneIds.length > 0 && reboundPanes.length > 0 && isInitialLoad)
    ? reboundPanes.filter(pane => !allPaneIds.includes(pane.paneId))
    : [];

  // Recreate missing panes (only on initial load)
  await recreateMissingPanes(missingPanes, panesFile);

  // Re-fetch pane IDs after recreation
  if (missingPanes.length > 0) {
    const freshData = await fetchTmuxPaneIds();
    allPaneIds = freshData.allPaneIds;
    titleToId = freshData.titleToId;
    currentWindowPaneIds = freshData.currentWindowPaneIds;
    panePathById = freshData.panePathById;

    // Re-rebind after recreation
    reboundPanes = syncHiddenStateFromCurrentWindow(
      reboundPanes.map(p => rebindPaneByTitle(p, titleToId, allPaneIds)),
      currentWindowPaneIds
    );
    const refreshedShellMetadata = syncShellRuntimeMetadata(reboundPanes, panePathById);
    reboundPanes = refreshedShellMetadata.panes;
    shellMetadata = {
      panes: reboundPanes,
      changed: shellMetadata.changed || refreshedShellMetadata.changed,
    };
  }

  return {
    panes: reboundPanes,
    allPaneIds,
    titleToId,
    paneMetadataChanged: shellMetadata.changed || missingPanes.length > 0,
  };
}
