import { useState, useCallback, useEffect, useRef } from 'react';
import {
  ARM_CONTROLLER_CONFIG,
  buildArmApiUrl,
  parseServerResponse,
  parseResourceHandle,
} from '../arm/armController';
import './ControlPanel.css';

/**
 * Import all sequence definitions from electron/mcp/sequences.
 * This is the single source of truth for all automation sequences!
 * Both QA Auto Hardware UI and MCP tools use the same sequence definitions.
 */
import {
  type AutoSequence,
  type AutoStep,
} from '../../electron/mcp/sequences';
import {
  DEFAULT_DEVICE_TEST_SET_ID,
  DEVICE_TEST_SETS,
  getAllCategories,
  getDeviceHomeCoord,
  getAllSequenceIds,
  getFullSteps,
  getSequence,
  getSequencesByCategory,
  type DeviceTestSetId,
} from '../../electron/mcp/sequenceSets';
import { DEVICE_OCR_SCENES } from '../ocr/deviceScenes';
import { executeClickStep, executeSwipeStep } from '../../electron/mcp/utils/executeStep';
import {
  getAutomationPresetEntries,
  resolveAutomationPresetSteps,
  type AutomationPresetSuite,
} from '../../electron/mcp/automationActionPresets';
import { executeDeviceActionSequence } from '../../electron/mcp/deviceActionRuntime';
import { getStoredDeviceTestSet, storeDeviceTestSet } from '../deviceTestSetPreference';

// Get all sequences from the shared definition
const DEFAULT_OPERATION_SEQUENCES: AutoSequence[] = getAllSequenceIds(DEFAULT_DEVICE_TEST_SET_ID)
  .map((id: string) => getSequence(id, DEFAULT_DEVICE_TEST_SET_ID))
  .filter((seq): seq is AutoSequence => seq !== undefined);

// Get all categories for the sequence panel
const DEFAULT_SEQUENCE_CATEGORIES = getAllCategories(DEFAULT_DEVICE_TEST_SET_ID);
const SECURITY_CHECK_PRESETS = getAutomationPresetEntries('securityCheck');
const CHAIN_METHOD_BATCH_PRESETS = getAutomationPresetEntries('chainMethodBatch');

interface ControlPanelState {
  isConnected: boolean;
  resourceHandle: number;
  serverIP: string;
  comPort: string;
  stepSize: number;
  zDepth: number;
  currentX: number;
  currentY: number;
  isLoading: boolean;
  isReady: boolean;
  error: string | null;
  isAutoRunning: boolean;
  autoProgress: number;
  autoTotalSteps: number;
  activeOperationKey: string;
  selectedSequenceId: string;
  selectedCategory: string;
  selectedDeviceTestSet: DeviceTestSetId;
  /** Words captured via OCR during create-wallet flow */
  capturedWords: string[];
  /** SLIP39: each recognized share's words (index 0 = share 1, ...) */
  capturedShares: string[][];
}

interface LogEntry {
  id: number;
  time: string;
  action: string;
  detail: string;
}

interface SequenceOcrResult {
  success: boolean;
  words: string[];
  confidence?: number;
  expectedWordCount?: number;
  hasCompleteSequence?: boolean;
  bip39Valid?: boolean;
  reason?: string;
}

interface SequenceVerifyOcrResult {
  success: boolean;
  optionIndex: number;
  wordIndex: number;
  correctWord: string;
  rawOptions?: string[];
  matchedOptions?: string[];
  mnemonicWords?: string[];
  reason?: string;
}

interface SequenceExecutionArmContext {
  isConnected: boolean;
  resourceHandle: number;
  serverIP: string;
}

interface SequenceExecutionResult {
  success: boolean;
  message: string;
  sequenceId: string;
  sequenceName?: string;
  deviceTestSetId?: string;
  stepsCompleted: number;
  totalSteps: number;
  mnemonicState?: {
    words: string[];
    shares?: string[][];
    shareCount?: number;
    threshold?: number;
    walletType?: 'bip39' | 'slip39';
    flowType?: 'create' | 'import';
  };
}

const SEQUENCE_OCR_TIMEOUT_MS = 2 * 60 * 1000;

function hasSwipeTarget(step: AutoStep): step is AutoStep & { swipeTo: { x: number; y: number } } {
  return step.swipeTo !== undefined;
}

function ControlPanel() {
  const [state, setState] = useState<ControlPanelState>(() => {
    const selectedDeviceTestSet = getStoredDeviceTestSet();
    const sequenceCategories = getAllCategories(selectedDeviceTestSet);
    const selectedCategory = sequenceCategories[0] ?? DEFAULT_SEQUENCE_CATEGORIES[0] ?? '';
    const selectedSequence = getSequencesByCategory(selectedCategory, selectedDeviceTestSet)[0];

    return {
      isConnected: false,
      resourceHandle: 0,
      serverIP: ARM_CONTROLLER_CONFIG.defaultServerIP,
      comPort: ARM_CONTROLLER_CONFIG.defaultComPort,
      stepSize: ARM_CONTROLLER_CONFIG.defaultStepSize,
      zDepth: ARM_CONTROLLER_CONFIG.defaultZDepth,
      currentX: 0,
      currentY: 0,
      isLoading: false,
      isReady: false,
      error: null,
      isAutoRunning: false,
      autoProgress: 0,
      autoTotalSteps: 0,
      activeOperationKey: '',
      selectedSequenceId: selectedSequence?.id ?? DEFAULT_OPERATION_SEQUENCES[0].id,
      selectedCategory,
      selectedDeviceTestSet,
      capturedWords: [],
      capturedShares: [],
    };
  });

  // Ref to track if auto operation should be cancelled
  const autoOperationCancelledRef = useRef(false);

  const [logs, setLogs] = useState<LogEntry[]>([]);

  /** Feedback flag for the captured-words copy button. */
  const [copiedWords, setCopiedWords] = useState(false);
  /** Which SLIP39 share's copy button was just pressed (for feedback). */
  const [copiedShareIndex, setCopiedShareIndex] = useState<number | null>(null);

  /** Swipe debug panel parameters (start point, axis direction, distance). */
  const [swipeDebug, setSwipeDebug] = useState({
    x: 213,
    y: 85,
    direction: 'up' as 'up' | 'down' | 'left' | 'right',
    length: 30,
    segments: 1,
    holdMs: 300,
  });

  useEffect(() => {
    storeDeviceTestSet(state.selectedDeviceTestSet);
  }, [state.selectedDeviceTestSet]);

  // Reflect arm state pushed from main process (e.g. MCP-side connect/disconnect)
  // so the UI shows the real connection status regardless of which side connected.
  useEffect(() => {
    if (!window.electronAPI?.onArmStateChanged) return;
    return window.electronAPI.onArmStateChanged((armState) => {
      setState(prev => {
        if (
          prev.isConnected === armState.isConnected &&
          prev.resourceHandle === armState.resourceHandle &&
          prev.serverIP === armState.serverIP &&
          prev.comPort === armState.comPort &&
          prev.currentX === armState.currentX &&
          prev.currentY === armState.currentY
        ) {
          return prev;
        }
        return {
          ...prev,
          isConnected: armState.isConnected,
          resourceHandle: armState.resourceHandle,
          serverIP: armState.serverIP,
          comPort: armState.comPort,
          currentX: armState.currentX,
          currentY: armState.currentY,
          isReady: armState.isConnected,
          error: armState.isConnected ? null : prev.error,
        };
      });
    });
  }, []);

  const addLog = useCallback((action: string, detail: string) => {
    const now = new Date();
    const time = now.toLocaleTimeString('zh-CN', { hour12: false });
    setLogs(prev => [
      { id: Date.now(), time, action, detail },
      ...prev.slice(0, 49),
    ]);
  }, []);

  const resolveSequenceStepsForUi = useCallback(async (
    sequence: AutoSequence,
    deviceTestSetId: DeviceTestSetId
  ): Promise<AutoStep[]> => {
    if (window.electronAPI?.resolveSequenceSteps) {
      return window.electronAPI.resolveSequenceSteps(sequence.id, deviceTestSetId);
    }
    return getFullSteps(sequence, deviceTestSetId);
  }, []);

  /**
   * Sends a command to the arm controller via HTTP.
   * Uses Electron IPC to bypass CORS restrictions.
   * Falls back to fetch API when Electron is unavailable (development mode).
   *
   * @param params - Command parameters (duankou, hco, daima)
   * @returns Server response as string
   * @throws Error if request fails
   */
  const sendCommandToServer = useCallback(async (
    serverIP: string,
    params: { duankou: string; hco: number; daima: string }
  ): Promise<string> => {
    const url = buildArmApiUrl(serverIP, params);
    console.log('[ControlPanel] sendCommand ->', { url, params });
    try {
      if (window.electronAPI?.httpRequest) {
        const response = await window.electronAPI.httpRequest(url);
        return response.data;
      } else {
        const response = await fetch(url);
        const text = await response.text();
        return text;
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('[ControlPanel] sendCommand failed:', { url, params, error: errorMessage });
      throw new Error(`Request failed: ${errorMessage}（请求地址：${url}）`);
    }
  }, []);

  const sendCommand = useCallback(async (params: { duankou: string; hco: number; daima: string }): Promise<string> => {
    return sendCommandToServer(state.serverIP, params);
  }, [sendCommandToServer, state.serverIP]);

  const delay = (ms: number): Promise<void> => new Promise<void>(resolve => setTimeout(resolve, ms));

  const syncArmStateToMain = useCallback(
    async (updates: Partial<ControlPanelState>) => {
      if (!window.electronAPI?.syncArmState) return;

      const nextState = { ...state, ...updates };
      await window.electronAPI.syncArmState({
        isConnected: nextState.isConnected,
        resourceHandle: nextState.resourceHandle,
        serverIP: nextState.serverIP,
        comPort: nextState.comPort,
        currentX: nextState.currentX,
        currentY: nextState.currentY,
        zDepth: nextState.zDepth,
      });
    },
    [state]
  );

  useEffect(() => {
    const handleBeforeUnload = () => {
      if (!window.electronAPI?.notifyRendererUnload) return;

      window.electronAPI.notifyRendererUnload({
        isConnected: state.isConnected,
        resourceHandle: state.resourceHandle,
        serverIP: state.serverIP,
        comPort: state.comPort,
        currentX: state.currentX,
        currentY: state.currentY,
        zDepth: state.zDepth,
      });
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
    };
  }, [
    state.isConnected,
    state.resourceHandle,
    state.serverIP,
    state.comPort,
    state.currentX,
    state.currentY,
    state.zDepth,
  ]);

  /**
   * Connects to the arm controller by opening the COM port.
   * After successful connection, waits for device to be ready before enabling controls.
   */
  const handleConnect = async () => {
    if (state.isLoading) return;

    setState(prev => ({ ...prev, isLoading: true, error: null }));

    try {
      let result = await sendCommand({
        duankou: state.comPort,
        hco: 0,
        daima: '0',
      });

      let resourceHandle = parseResourceHandle(result);

      if (resourceHandle <= 0) {
        // --- Recovery path 1: Electron IPC (when available) ---
        if (window.electronAPI?.tryRecoverArmConnection) {
          const recovery = await window.electronAPI.tryRecoverArmConnection({
            serverIP: state.serverIP,
            comPort: state.comPort,
          });

          addLog(
            '连接',
            recovery.attempted
              ? `检测到可能存在旧连接，已尝试自动释放 ${state.comPort}`
              : `连接失败后未执行自动恢复：${recovery.reason}`
          );

          if (recovery.attempted) {
            result = await sendCommand({
              duankou: state.comPort,
              hco: 0,
              daima: '0',
            });
            resourceHandle = parseResourceHandle(result);
          }
        }

        // --- Recovery path 2: close last known handle from localStorage ---
        if (resourceHandle <= 0) {
          const lastHandleKey = `arm_last_handle_${state.comPort}`;
          const savedHandle = parseInt(localStorage.getItem(lastHandleKey) ?? '0', 10);
          if (savedHandle > 0) {
            addLog('连接', `端口占用，尝试关闭上次句柄 ${savedHandle} 后重连...`);
            try {
              await sendCommand({ duankou: '0', hco: savedHandle, daima: '0' });
            } catch {
              // ignore
            }
            await delay(500);
            result = await sendCommand({
              duankou: state.comPort,
              hco: 0,
              daima: '0',
            });
            resourceHandle = parseResourceHandle(result);
            if (resourceHandle > 0) {
              addLog('连接', `重连成功，句柄: ${resourceHandle}`);
            } else {
              localStorage.removeItem(lastHandleKey);
            }
          } else {
            addLog('连接', `端口占用，无上次句柄记录，请检查 ${state.comPort} 是否被其他程序占用`);
          }
        }
      }

      if (resourceHandle > 0) {
        // Persist handle so recovery can close it on the next session
        localStorage.setItem(`arm_last_handle_${state.comPort}`, resourceHandle.toString());

        setState(prev => ({
          ...prev,
          isConnected: true,
          resourceHandle,
          isLoading: false,
          isReady: false,
        }));

        // Sync state to MCP
        await syncArmStateToMain({
          isConnected: true,
          resourceHandle,
          serverIP: state.serverIP,
          comPort: state.comPort,
          currentX: 0,
          currentY: 0,
          zDepth: state.zDepth,
        });

        await delay(ARM_CONTROLLER_CONFIG.deviceReadyDelay);

        setState(prev => ({ ...prev, isReady: true }));
      } else {
        const cleanResponse = parseServerResponse(result);
        setState(prev => ({
          ...prev,
          isLoading: false,
          error: cleanResponse
            ? `Failed to open port. Controller response: ${cleanResponse}`
            : 'Failed to open port. Check if port is occupied.',
        }));
      }
    } catch (error) {
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Connection failed',
      }));
    }
  };

  /**
   * Disconnects from the arm controller.
   * First resets machine position to origin, then closes the COM port.
   * Can be called even when not connected to release any previous connection.
   */
  const handleDisconnect = async () => {
    if (state.isLoading) return;

    setState(prev => ({ ...prev, isLoading: true, error: null }));

    try {
      if (state.isConnected && state.resourceHandle > 0) {
        await sendCommand({
          duankou: '0',
          hco: state.resourceHandle,
          daima: 'X0Y0Z0',
        });

        await delay(ARM_CONTROLLER_CONFIG.commandDelay);

        await sendCommand({
          duankou: '0',
          hco: state.resourceHandle,
          daima: '0',
        });

        // Port closed cleanly — remove saved handle so recovery won't re-use it
        localStorage.removeItem(`arm_last_handle_${state.comPort}`);
      }

      setState(prev => ({
        ...prev,
        isConnected: false,
        resourceHandle: 0,
        currentX: 0,
        currentY: 0,
        isLoading: false,
        isReady: false,
      }));

      // Sync state to MCP
      await syncArmStateToMain({
        isConnected: false,
        resourceHandle: 0,
        serverIP: state.serverIP,
        comPort: state.comPort,
        currentX: 0,
        currentY: 0,
        zDepth: state.zDepth,
      });
    } catch (error) {
      setState(prev => ({
        ...prev,
        isConnected: false,
        resourceHandle: 0,
        currentX: 0,
        currentY: 0,
        isLoading: false,
        isReady: false,
      }));

      // Sync state to MCP
      await syncArmStateToMain({
        isConnected: false,
        resourceHandle: 0,
        serverIP: state.serverIP,
        comPort: state.comPort,
        currentX: 0,
        currentY: 0,
        zDepth: state.zDepth,
      });
    }
  };

  /**
   * Moves the arm in the specified direction by the current step size.
   * Y axis is inverted: Y decreases when moving up, increases when moving down.
   * Coordinates are clamped to non-negative values.
   *
   * @param direction - Movement direction (up, down, left, right)
   */
  const handleMove = async (direction: 'up' | 'down' | 'left' | 'right') => {
    if (state.isLoading || !state.isConnected || !state.isReady) return;
    
    let newX = state.currentX;
    let newY = state.currentY;
    
    switch (direction) {
      case 'up':
        newY -= state.stepSize;
        break;
      case 'down':
        newY += state.stepSize;
        break;
      case 'left':
        newX -= state.stepSize;
        break;
      case 'right':
        newX += state.stepSize;
        break;
    }
    
    newX = Math.max(0, newX);
    newY = Math.max(0, newY);
    
    setState(prev => ({ ...prev, isLoading: true, error: null }));
    
    const directionLabel = { up: '上', down: '下', left: '左', right: '右' }[direction];
    
    try {
      await sendCommand({
        duankou: '0',
        hco: state.resourceHandle,
        daima: `X${newX}Y${newY}`,
      });
      
      addLog('移动', `${directionLabel} (${state.currentX},${state.currentY}) → (${newX},${newY})`);
      
      setState(prev => ({
        ...prev,
        currentX: newX,
        currentY: newY,
        isLoading: false,
      }));
      await syncArmStateToMain({
        currentX: newX,
        currentY: newY,
      });
    } catch (error) {
      addLog('错误', `移动失败: ${error instanceof Error ? error.message : 'Unknown'}`);
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Move failed',
      }));
    }
  };

  /**
   * Performs a click operation at the current position.
   * Lowers the pen (Z6), waits briefly, then raises it (Z0).
   */
  const handleClick = async () => {
    if (state.isLoading || !state.isConnected || !state.isReady) return;
    
    setState(prev => ({ ...prev, isLoading: true, error: null }));
    
    try {
      await sendCommand({
        duankou: '0',
        hco: state.resourceHandle,
        daima: `Z${state.zDepth}`,
      });
      
      await delay(ARM_CONTROLLER_CONFIG.clickDelay);
      
      await sendCommand({
        duankou: '0',
        hco: state.resourceHandle,
        daima: `Z${ARM_CONTROLLER_CONFIG.zUp}`,
      });
      
      addLog('点击', `位置 (${state.currentX},${state.currentY}) 深度 Z${state.zDepth}`);
      await syncArmStateToMain({
        zDepth: state.zDepth,
      });
      
      setState(prev => ({ ...prev, isLoading: false }));
    } catch (error) {
      addLog('错误', `点击失败: ${error instanceof Error ? error.message : 'Unknown'}`);
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Click operation failed',
      }));
    }
  };

  /**
   * Debug swipe: performs a pen-down drag from a start point along one axis,
   * mirroring the sequence runtime's swipe implementation (executeSwipeStep)
   * so parameters tuned here can be copied into page actions directly.
   */
  const handleDebugSwipe = async () => {
    if (state.isLoading || !state.isConnected || !state.isReady) return;
    const { x, y, direction, length, segments, holdMs } = swipeDebug;
    const to = {
      x: direction === 'left' ? x - length : direction === 'right' ? x + length : x,
      y: direction === 'up' ? y - length : direction === 'down' ? y + length : y,
    };
    if (to.x < 0 || to.y < 0) {
      addLog('滑动', `目标坐标越界 (${to.x},${to.y})，请调整起点或长度`);
      return;
    }

    setState(prev => ({ ...prev, isLoading: true, error: null }));
    try {
      await sendCommand({ duankou: '0', hco: state.resourceHandle, daima: `X${x}Y${y}` });
      await sendCommand({ duankou: '0', hco: state.resourceHandle, daima: `Z${state.zDepth}` });
      await delay(50);

      const segs = Math.max(1, Math.floor(segments));
      for (let i = 1; i <= segs; i++) {
        const t = i / segs;
        const ix = Math.round(x + (to.x - x) * t);
        const iy = Math.round(y + (to.y - y) * t);
        await sendCommand({ duankou: '0', hco: state.resourceHandle, daima: `X${ix}Y${iy}` });
        if (i < segs) await delay(45);
      }

      await delay(holdMs);
      await sendCommand({ duankou: '0', hco: state.resourceHandle, daima: `Z${ARM_CONTROLLER_CONFIG.zUp}` });

      addLog('滑动', `(${x},${y}) → (${to.x},${to.y}) 深度Z${state.zDepth} 分段${segs} 停留${holdMs}ms`);
      setState(prev => ({ ...prev, isLoading: false, currentX: to.x, currentY: to.y }));
      await syncArmStateToMain({ currentX: to.x, currentY: to.y });
    } catch (error) {
      addLog('错误', `滑动失败: ${error instanceof Error ? error.message : 'Unknown'}`);
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Swipe operation failed',
      }));
    }
  };

  const handleResetPosition = async () => {
    if (state.isLoading || !state.isConnected || !state.isReady || state.isAutoRunning) return;

    const homeCoord = getDeviceHomeCoord(state.selectedDeviceTestSet);
    setState(prev => ({ ...prev, isLoading: true, error: null }));

    try {
      await sendCommand({
        duankou: '0',
        hco: state.resourceHandle,
        daima: `Z${ARM_CONTROLLER_CONFIG.zUp}`,
      });
      await sendCommand({
        duankou: '0',
        hco: state.resourceHandle,
        daima: `X${homeCoord.x}Y${homeCoord.y}`,
      });

      addLog('复位', `${state.selectedDeviceTestSet} home (${homeCoord.x},${homeCoord.y})`);
      setState(prev => ({
        ...prev,
        currentX: homeCoord.x,
        currentY: homeCoord.y,
        isLoading: false,
      }));
      await syncArmStateToMain({
        currentX: homeCoord.x,
        currentY: homeCoord.y,
        zDepth: ARM_CONTROLLER_CONFIG.zUp,
      });
    } catch (error) {
      addLog('错误', `复位失败: ${error instanceof Error ? error.message : 'Unknown'}`);
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Reset position failed',
      }));
    }
  };

  /**
   * Executes an auto operation sequence.
   * If sequenceId is provided, runs that sequence; otherwise uses the currently selected one.
   */
  const runSequenceExecution = useCallback(
    async (
      targetId: string,
      armContext: SequenceExecutionArmContext,
      deviceTestSetId: DeviceTestSetId,
      options?: { updateSelectedSequence?: boolean }
    ): Promise<SequenceExecutionResult> => {
      const sequence = getSequence(targetId, deviceTestSetId);
      if (!sequence) {
        return {
          success: false,
          message: `Unknown ${deviceTestSetId} sequence ID: ${targetId}`,
          sequenceId: targetId,
          deviceTestSetId,
          stepsCompleted: 0,
          totalSteps: 0,
        };
      }

      if (options?.updateSelectedSequence) {
        setState((prev) => ({ ...prev, selectedSequenceId: targetId }));
      }

      const steps = await resolveSequenceStepsForUi(sequence, deviceTestSetId);
      const totalVerifySteps = steps.filter((step) => !!step.ocrVerify).length;
      let finishedVerifySteps = 0;
      let stepsCompleted = 0;
      let latestCapturedWords: string[] = [];
      const capturedShares: string[][] = [];
      const isSlip39Create = targetId.startsWith('create-slip39-');

      autoOperationCancelledRef.current = false;
      setState((prev) => ({
        ...prev,
        isAutoRunning: true,
        autoProgress: 0,
        autoTotalSteps: steps.length,
        activeOperationKey: `sequence:${targetId}`,
        error: null,
        capturedWords: [],
        capturedShares: [],
      }));
      addLog('自动', `开始执行 ${deviceTestSetId} 自动操作序列: ${sequence.name}`);

      const send = async (daima: string) => {
        await sendCommandToServer(armContext.serverIP, {
          duankou: '0',
          hco: armContext.resourceHandle,
          daima,
        });
      };
      const stepConfig = { clickDelay: ARM_CONTROLLER_CONFIG.clickDelay, zUp: ARM_CONTROLLER_CONFIG.zUp };

      try {
        for (let i = 0; i < steps.length; i++) {
          if (autoOperationCancelledRef.current) {
            addLog('自动', '操作已取消');
            return {
              success: false,
              message: `Sequence "${sequence.name}" stopped by user at step ${stepsCompleted + 1}`,
              sequenceId: targetId,
              sequenceName: sequence.name,
              deviceTestSetId,
              stepsCompleted,
              totalSteps: steps.length,
            };
          }

          const step = steps[i];
          setState((prev) => ({ ...prev, autoProgress: i + 1 }));

          if ((step.delayBefore ?? 0) > 0) {
            await delay(step.delayBefore ?? 0);
          }

          if (step.moveOnly) {
            await send(`X${step.x}Y${step.y}`);
            addLog('自动', `${step.label} - 移动到 (${step.x},${step.y})`);
          } else if (step.ocrVerify) {
            const ocrVerifyConfig = step.ocrVerify;
            const isLoopVerify = !!ocrVerifyConfig.loop;
            // 循环模式：持续答题直到不再出现验证题；上限调高以容纳"不正确"重做
            const maxQuestions = isLoopVerify ? 30 : 1;
            let answeredCount = 0;
            // "助记词不正确"自愈的次数上限：超过则判定为真失败，避免无限重做
            let mnemonicIncorrectRecoveries = 0;
            const MAX_INCORRECT_RECOVERIES = 2;

            const tapAt = async (x: number, y: number) => {
              await send(`X${x}Y${y}`);
              await send(`Z${step.depth}`);
              await delay(ARM_CONTROLLER_CONFIG.clickDelay);
              await send(`Z${ARM_CONTROLLER_CONFIG.zUp}`);
            };

            const runVerifyOcrOnce = (): Promise<SequenceVerifyOcrResult> => Promise.race([
              new Promise<SequenceVerifyOcrResult>((resolve) => {
                const handler = (e: Event) => {
                  window.removeEventListener('qa-auto-hw:verify-ocr-result', handler);
                  resolve((e as CustomEvent).detail);
                };
                window.addEventListener('qa-auto-hw:verify-ocr-result', handler);
                const verifyScenes = DEVICE_OCR_SCENES[deviceTestSetId].verifyWallet;
                window.dispatchEvent(
                  new CustomEvent('qa-auto-hw:trigger-verify-ocr', {
                    detail: {
                      deviceTestSetId,
                      numberSceneConfig: verifyScenes?.number,
                      optionsSceneConfig: verifyScenes?.options,
                    },
                  })
                );
              }),
              new Promise<SequenceVerifyOcrResult>((resolve) =>
                setTimeout(
                  () =>
                    resolve({
                      success: false,
                      optionIndex: -1,
                      wordIndex: -1,
                      correctWord: '',
                      mnemonicWords: [],
                      reason: 'Verify OCR timed out',
                    }),
                  SEQUENCE_OCR_TIMEOUT_MS
                )
              ),
            ]);

            // 是否检测到验证正常结束(完成页/无新题)。用于区分"正常退出"与"耗尽上限退出"
            let verifyCompleted = false;
            for (let questionIdx = 0; questionIdx < maxQuestions; questionIdx++) {
              const verifyRound = finishedVerifySteps + 1;
              addLog('验证', isLoopVerify ? `开始第 ${verifyRound} 题确认 OCR` : `开始第 ${verifyRound}/${totalVerifySteps} 次确认题 OCR`);
              await send(`X${step.x}Y${step.y}`);
              addLog('自动', `${step.label} - 移动到 (${step.x},${step.y})，等待验证OCR...`);
              // 选项弹层有滑入动画，settle 时间不足会读到残缺/动画中的帧，
              // 是"只读到2行→点错行"的主因。加长到 2600ms 等动画彻底结束
              await delay(2600);

              // 选项弹层可能仍在滑入动画中，导致选项误读/漏读；失败后稍等重拍
              // (设备错误页"助记词不正确"重拍也不会变化，直接跳过快速重试)
              let verifyResult = await runVerifyOcrOnce();
              // 提高重试次数(5)：读不满3行/找不到目标词都属于可自愈的坏帧。
              // 但"助记词不正确"错误页和锁屏页无需在这里重试(交给下方的恢复分支)
              for (
                let retry = 1;
                retry <= 5 && !verifyResult.success &&
                  !String(verifyResult.reason || '').includes('不正确') &&
                  !/onekey/i.test(String(verifyResult.reason || ''));
                retry++
              ) {
                addLog('验证', `第 ${verifyRound} 题OCR失败(${verifyResult.reason || 'unknown'})，重试 ${retry}/5...`);
                await delay(1500);
                verifyResult = await runVerifyOcrOnce();
              }

              if (!verifyResult.success) {
                const reason = verifyResult.reason || 'unknown reason';
                if (isLoopVerify && /onekey/i.test(reason)) {
                  // OCR 读到锁屏页的"OneKey Pro 2"字样：设备在等待期间自动锁屏了。
                  // 自愈：双击点亮 -> 点击解锁 -> PIN 1111 -> 确认，解锁后回到原验证题
                  addLog('验证', '检测到设备已锁屏，自动解锁恢复...');
                  await tapAt(213, 45);
                  await delay(500);
                  await tapAt(213, 45);
                  await delay(1500);
                  await tapAt(212, 92);
                  await delay(1800);
                  for (let k = 0; k < 4; k++) {
                    await tapAt(198, 59);
                    await delay(300);
                  }
                  await tapAt(227, 94);
                  await delay(2500);
                  continue;
                }
                if (isLoopVerify && reason.includes('不正确')) {
                  // 设备提示助记词不正确：点 重试 -> 验证 重新进入验证轮次。
                  // 限制重做次数，避免残留"不正确"帧触发无限重做（分片其实已完成）
                  if (mnemonicIncorrectRecoveries >= MAX_INCORRECT_RECOVERIES) {
                    // 已重做多次仍读到"不正确"：多为分片其实已完成、只是扫到残留错误帧。
                    // 退出循环交给后续步骤(点确认/继续)；若真未完成，下一步截图会重新报错
                    addLog('验证', `已重做${MAX_INCORRECT_RECOVERIES}次仍读到"不正确"，判定分片已完成并退出循环`);
                    verifyCompleted = true;
                    break;
                  }
                  mnemonicIncorrectRecoveries += 1;
                  addLog('验证', `设备提示"助记词不正确"，自动点击 重试 -> 验证 重新验证 (${mnemonicIncorrectRecoveries}/${MAX_INCORRECT_RECOVERIES})...`);
                  await tapAt(212, 94); // 错误页底部"重试"按钮
                  await delay(2000);
                  await tapAt(214, 82); // "即将完成"页的"验证"按钮
                  await delay(2200);
                  // 重做整分片，之前已答计数清零
                  answeredCount = 0;
                  continue;
                }
                if (
                  isLoopVerify &&
                  answeredCount > 0 &&
                  (reason.startsWith('Failed to detect verification word index') ||
                    reason.startsWith('No option words recognized'))
                ) {
                  // 已答过题且当前页面检测不到新题号/选项（如"助记词已确认"提示页）：
                  // 验证流程已经通过，退出循环交给后续步骤点继续
                  addLog('验证', `未检测到新的验证题，验证完成(共答 ${answeredCount} 题)`);
                  verifyCompleted = true;
                  break;
                }
                throw new Error(`验证OCR失败: ${reason}`);
              }
              if (
                verifyResult.optionIndex < 0 ||
                verifyResult.optionIndex >= ocrVerifyConfig.options.length
              ) {
                throw new Error(
                  `验证OCR返回了无效选项索引 ${verifyResult.optionIndex} (可选范围: 0-${ocrVerifyConfig.options.length - 1})`
                );
              }

              const option = ocrVerifyConfig.options[verifyResult.optionIndex];
              addLog(
                '验证',
                `单词 #${verifyResult.wordIndex} -> ${verifyResult.correctWord.toUpperCase()} (选项${verifyResult.optionIndex + 1})`
              );
              if (Array.isArray(verifyResult.mnemonicWords) && verifyResult.mnemonicWords.length > 0) {
                addLog(
                  '验证',
                  `助记词表: ${verifyResult.mnemonicWords.map((word, idx) => `${idx + 1}.${word}`).join(', ')}`
                );
              }
              if (Array.isArray(verifyResult.rawOptions) && verifyResult.rawOptions.length > 0) {
                addLog('验证', `OCR选项: ${verifyResult.rawOptions.join(', ')}`);
              }
              if (Array.isArray(verifyResult.matchedOptions) && verifyResult.matchedOptions.length > 0) {
                addLog('验证', `匹配选项: ${verifyResult.matchedOptions.join(', ')}`);
              }

              await tapAt(option.x, option.y);

              answeredCount += 1;
              finishedVerifySteps += 1;
              addLog(
                '验证',
                isLoopVerify
                  ? `第 ${verifyRound} 题已点击选项${verifyResult.optionIndex + 1} (${option.x},${option.y})`
                  : `第 ${verifyRound}/${totalVerifySteps} 题已点击选项${verifyResult.optionIndex + 1} (${option.x},${option.y})`
              );

              if (!isLoopVerify) break;
              // 等待设备切换到下一题或完成页
              await delay(2200);
            }
            // 循环模式下若跑满上限仍未检测到"完成"，说明验证卡住(反复锁屏/持续误读)，
            // 不能静默当成通过——抛错让整条序列失败暴露问题
            if (isLoopVerify && !verifyCompleted) {
              throw new Error(`验证循环达到最大轮次(${maxQuestions})仍未检测到完成页，判定验证卡住失败`);
            }
          } else if (step.ocrCapture) {
            const ocrCaptureConfig = typeof step.ocrCapture === 'object' ? step.ocrCapture : {};
            await send(`X${step.x}Y${step.y}`);
            addLog('自动', `${step.label} - 移动到 (${step.x},${step.y})，等待OCR识别...`);
            await delay(1600);

            const runMnemonicOcrOnce = (): Promise<SequenceOcrResult> => Promise.race([
              new Promise<SequenceOcrResult>((resolve) => {
                const handler = (e: Event) => {
                  window.removeEventListener('qa-auto-hw:ocr-result', handler);
                  resolve((e as CustomEvent).detail);
                };
                window.addEventListener('qa-auto-hw:ocr-result', handler);
                window.dispatchEvent(
                  new CustomEvent('qa-auto-hw:trigger-ocr', {
                    detail: {
                      ...ocrCaptureConfig,
                      deviceTestSetId,
                    },
                  })
                );
              }),
              new Promise<SequenceOcrResult>((resolve) =>
                setTimeout(
                  () =>
                    resolve({
                      success: false,
                      words: [],
                      reason: 'Mnemonic OCR timed out',
                    }),
                  SEQUENCE_OCR_TIMEOUT_MS
                )
              ),
            ]);

            // OCR 引擎瞬时挂起/超时时稍等重拍，避免整条序列因一次抖动而失败。
            // 注意：两段截图的第一页(allowPartial)正常就返回 success=false，只要读到了词
            // 就不算失败，不应触发重试——否则每次第一页都白白重拍浪费数秒。
            const allowPartialCapture = !!ocrCaptureConfig.allowPartial;
            const isOcrRetryNeeded = (res: SequenceOcrResult): boolean =>
              !res.success && !(allowPartialCapture && res.words.length > 0);
            let ocrResult = await runMnemonicOcrOnce();
            for (let retry = 1; retry <= 2 && isOcrRetryNeeded(ocrResult); retry++) {
              addLog('OCR', `助记词OCR失败(${ocrResult.reason || 'unknown'})，重试 ${retry}/2...`);
              await delay(2000);
              ocrResult = await runMnemonicOcrOnce();
            }

            latestCapturedWords = Array.isArray(ocrResult.words) ? ocrResult.words : [];
            setState((prev) => ({ ...prev, capturedWords: latestCapturedWords }));
            addLog(
              'OCR',
              `识别到 ${latestCapturedWords.filter((word) => !!word).length}/${latestCapturedWords.length} 个单词: ${latestCapturedWords.join(', ')}`
            );

            const canContinueWithPartial = allowPartialCapture && ocrResult.words.length > 0;
            if ((!ocrResult.success && !canContinueWithPartial) || ocrResult.words.length === 0) {
              throw new Error(`助记词OCR失败: ${ocrResult.reason || 'no words recognized'}`);
            }

            if (
              isSlip39Create &&
              step.label.includes('(20词-2)') &&
              latestCapturedWords.filter((word) => !!word).length > 0
            ) {
              capturedShares.push([...latestCapturedWords]);
              setState((prev) => ({ ...prev, capturedShares: capturedShares.map((s) => [...s]) }));
              addLog('OCR', `已记录 SLIP39 share ${capturedShares.length}`);
            }
          } else if (hasSwipeTarget(step)) {
            await executeSwipeStep(step, send, delay, stepConfig);
            addLog('自动', `${step.label} (${step.x},${step.y}) → (${step.swipeTo.x},${step.swipeTo.y})`);
          } else {
            await executeClickStep(step, send, delay, stepConfig);
            addLog('自动', `${step.label} (${step.x},${step.y})`);
          }

          stepsCompleted += 1;
          await delay(step.delayAfter ?? 250);
        }

        addLog('自动', '自动操作序列完成');

        const mnemonicState = isSlip39Create
          ? {
              words: capturedShares[capturedShares.length - 1] || latestCapturedWords,
              shares: capturedShares,
              shareCount: targetId.includes('single')
                ? 1
                : targetId.includes('2of2')
                  ? 2
                  : targetId.includes('8of8')
                    ? 8
                    : targetId.includes('16of2')
                      ? 16
                      : undefined,
              threshold: targetId.includes('single')
                ? 1
                : targetId.includes('2of2')
                  ? 2
                  : targetId.includes('8of8')
                    ? 8
                    : targetId.includes('16of2')
                      ? 2
                      : undefined,
              walletType: 'slip39' as const,
              flowType: 'create' as const,
            }
          : targetId.startsWith('create-wallet')
            ? {
                words: latestCapturedWords,
                walletType: 'bip39' as const,
                flowType: 'create' as const,
              }
            : undefined;

        return {
          success: true,
          message: `Sequence "${sequence.name}" completed successfully`,
          sequenceId: targetId,
          sequenceName: sequence.name,
          deviceTestSetId,
          stepsCompleted,
          totalSteps: steps.length,
          mnemonicState,
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Auto operation failed';
        addLog('错误', `自动操作失败: ${message}`);
        setState((prev) => ({
          ...prev,
          error: message,
        }));
        return {
          success: false,
          message: `Sequence execution failed at step ${stepsCompleted + 1}: ${message}`,
          sequenceId: targetId,
          sequenceName: sequence.name,
          deviceTestSetId,
          stepsCompleted,
          totalSteps: steps.length,
        };
      } finally {
        setState((prev) => ({
          ...prev,
          isAutoRunning: false,
          autoProgress: 0,
          autoTotalSteps: 0,
          activeOperationKey: '',
        }));
      }
    },
    [addLog, resolveSequenceStepsForUi, sendCommandToServer]
  );

  const handleAutoOperation = useCallback(async (sequenceId?: string) => {
    if (state.isLoading || !state.isConnected || !state.isReady || state.isAutoRunning) return;

    const targetId = sequenceId || state.selectedSequenceId;
    await runSequenceExecution(
      targetId,
      {
        isConnected: state.isConnected,
        resourceHandle: state.resourceHandle,
        serverIP: state.serverIP,
      },
      state.selectedDeviceTestSet,
      { updateSelectedSequence: !!sequenceId }
    );
  }, [
    runSequenceExecution,
    state.isAutoRunning,
    state.isConnected,
    state.isLoading,
    state.isReady,
    state.resourceHandle,
    state.selectedSequenceId,
    state.selectedDeviceTestSet,
    state.serverIP,
  ]);

  useEffect(() => {
    if (!window.electronAPI?.onMcpExecuteSequenceRequest) {
      return undefined;
    }

    return window.electronAPI.onMcpExecuteSequenceRequest(async (payload) => {
      const requestedDeviceTestSet = payload.deviceTestSetId === 'pro2' ? 'pro2' : DEFAULT_DEVICE_TEST_SET_ID;
      if (state.isAutoRunning) {
        window.electronAPI?.sendMcpExecuteSequenceResponse?.({
          success: false,
          message: 'Renderer sequence execution is already running',
          sequenceId: payload.sequenceId,
          deviceTestSetId: requestedDeviceTestSet,
          stepsCompleted: 0,
          totalSteps: 0,
        });
        return;
      }

      const result = await runSequenceExecution(
        payload.sequenceId,
        payload.armState,
        requestedDeviceTestSet
      );
      window.electronAPI?.sendMcpExecuteSequenceResponse?.(result);
    });
  }, [runSequenceExecution, state.isAutoRunning]);

  const handleAutomationPresetRun = useCallback(async (
    suite: Exclude<AutomationPresetSuite, 'deviceSettings'>,
    presetId: string
  ) => {
    if (state.isLoading || !state.isConnected || !state.isReady || state.isAutoRunning) return;

    const steps = resolveAutomationPresetSteps({
      suite,
      presetId,
      expectedResult: suite === 'securityCheck' ? true : undefined,
    });

    setState(prev => ({
      ...prev,
      isAutoRunning: true,
      autoProgress: 0,
      autoTotalSteps: steps.length,
      activeOperationKey: `preset:${suite}:${presetId}`,
      error: null,
    }));
    addLog('Preset', `开始执行 ${suite} / ${presetId}`);

    try {
      const send = async (daima: string) => {
        await sendCommand({ duankou: '0', hco: state.resourceHandle, daima });
      };

      if (steps.length === 0) {
        addLog('Preset', `${suite} / ${presetId} 当前无设备动作`);
      } else {
        await executeDeviceActionSequence(
          steps,
          send,
          delay,
          {
            clickDelay: ARM_CONTROLLER_CONFIG.clickDelay,
            zUp: ARM_CONTROLLER_CONFIG.zUp,
            defaultZDepth: ARM_CONTROLLER_CONFIG.defaultZDepth,
          },
          {
            startDelayMs: 500,
            betweenStepsDelayMs: 300,
          }
        );
        setState(prev => ({ ...prev, autoProgress: steps.length }));
        addLog('Preset', `${suite} / ${presetId}: ${steps.join(' -> ')}`);
      }
    } catch (error) {
      addLog('错误', `Preset 执行失败: ${error instanceof Error ? error.message : 'Unknown'}`);
      setState(prev => ({
        ...prev,
        error: error instanceof Error ? error.message : 'Preset execution failed',
      }));
    } finally {
      setState(prev => ({
        ...prev,
        isAutoRunning: false,
        autoProgress: 0,
        autoTotalSteps: 0,
        activeOperationKey: '',
      }));
    }
  }, [addLog, sendCommand, state.isAutoRunning, state.isConnected, state.isLoading, state.isReady, state.resourceHandle]);

  /**
   * Cancels the ongoing auto operation.
   */
  const handleCancelAutoOperation = () => {
    autoOperationCancelledRef.current = true;
  };

  const isControlDisabled = !state.isConnected || !state.isReady || state.isLoading || state.isAutoRunning;

  const sequenceCategories = getAllCategories(state.selectedDeviceTestSet);
  const activeSequenceCategory = sequenceCategories.includes(state.selectedCategory)
    ? state.selectedCategory
    : sequenceCategories[0] ?? '';
  const categorySequences = getSequencesByCategory(activeSequenceCategory, state.selectedDeviceTestSet);
  const selectedDeviceTestSetName = DEVICE_TEST_SETS.find(
    device => device.id === state.selectedDeviceTestSet
  )?.name ?? state.selectedDeviceTestSet;
  const capturedFilledCount = state.capturedWords.filter((word) => !!word).length;

  return (
    <div className="control-panel">
      {/* Connection Settings - full width top */}
      <div className="control-section connection-section">
        <h3>连接设置</h3>
        <div className="connection-row">
          <input
            type="text"
            value={state.serverIP}
            onChange={(e) => setState(prev => ({ ...prev, serverIP: e.target.value }))}
            disabled={state.isConnected}
            placeholder="IP 地址"
            className="input-ip"
          />
          <input
            type="text"
            value={state.comPort}
            onChange={(e) => setState(prev => ({ ...prev, comPort: e.target.value }))}
            disabled={state.isConnected}
            placeholder="串口"
            className="input-port"
          />
          <div className="position-display">
            <span className="coordinate">X: {state.currentX}</span>
            <span className="coordinate">Y: {state.currentY}</span>
          </div>
          <button
            className="btn btn-secondary btn-connect"
            onClick={handleResetPosition}
            disabled={isControlDisabled}
            title={`复位到 ${state.selectedDeviceTestSet === 'pro2' ? 'Pro2' : 'Pro'} home`}
          >
            复位
          </button>
          <button
            className={`btn btn-connect ${state.isConnected ? 'btn-secondary' : 'btn-primary'}`}
            onClick={state.isConnected ? handleDisconnect : handleConnect}
            disabled={state.isLoading || state.isAutoRunning}
          >
            {state.isLoading
              ? (state.isConnected ? '断开中...' : '连接中...')
              : (state.isConnected ? '断开连接' : '连接')}
          </button>
        </div>
      </div>

      {state.error && (
        <div className="error-message">
          {state.error}
        </div>
      )}

      {/* Main body: left manual + right sequences */}
      <div className="control-body">
        {/* Left: Manual Operation */}
        <div className="manual-section">
          <h3>手动操作</h3>
          <div className="control-selectors">
            <label>
              <span>步长</span>
              <select
                value={state.stepSize}
                onChange={(e) => setState(prev => ({ ...prev, stepSize: parseInt(e.target.value, 10) }))}
                disabled={isControlDisabled}
              >
                {ARM_CONTROLLER_CONFIG.stepOptions.map(step => (
                  <option key={step} value={step}>{step}</option>
                ))}
              </select>
            </label>
            <label>
              <span>深度</span>
              <select
                value={state.zDepth}
                onChange={(e) => setState(prev => ({ ...prev, zDepth: parseInt(e.target.value, 10) }))}
                disabled={isControlDisabled}
              >
                {ARM_CONTROLLER_CONFIG.zDepthOptions.map(depth => (
                  <option key={depth} value={depth}>Z{depth}</option>
                ))}
              </select>
            </label>
          </div>

          <div className="direction-controls">
            <div className="direction-grid">
              <div className="grid-cell"></div>
              <div className="grid-cell">
                <button className="direction-btn" onClick={() => handleMove('up')} disabled={isControlDisabled} title="向上">↑</button>
              </div>
              <div className="grid-cell"></div>
              <div className="grid-cell">
                <button className="direction-btn" onClick={() => handleMove('left')} disabled={isControlDisabled} title="向左">←</button>
              </div>
              <div className="grid-cell">
                <button className="click-btn" onClick={handleClick} disabled={isControlDisabled} title="点击">点击</button>
              </div>
              <div className="grid-cell">
                <button className="direction-btn" onClick={() => handleMove('right')} disabled={isControlDisabled} title="向右">→</button>
              </div>
              <div className="grid-cell"></div>
              <div className="grid-cell">
                <button className="direction-btn" onClick={() => handleMove('down')} disabled={isControlDisabled} title="向下">↓</button>
              </div>
              <div className="grid-cell"></div>
            </div>
          </div>

          <div className="swipe-debug" style={{ marginTop: 16, padding: 12, border: '1px solid #eee', borderRadius: 8 }}>
            <h4 style={{ margin: '0 0 10px' }}>滑动调试</h4>
            <div className="control-selectors" style={{ marginBottom: 8 }}>
              <label>
                <span>方向</span>
                <select
                  value={swipeDebug.direction}
                  onChange={(e) => setSwipeDebug(prev => ({ ...prev, direction: e.target.value as 'up' | 'down' | 'left' | 'right' }))}
                  disabled={isControlDisabled}
                >
                  <option value="up">竖向·上滑</option>
                  <option value="down">竖向·下滑</option>
                  <option value="left">横向·左滑</option>
                  <option value="right">横向·右滑</option>
                </select>
              </label>
              <label>
                <span>长度</span>
                <input
                  type="number" min={1} max={200} value={swipeDebug.length} style={{ width: 56 }}
                  onChange={(e) => setSwipeDebug(prev => ({ ...prev, length: parseInt(e.target.value, 10) || 0 }))}
                  disabled={isControlDisabled}
                />
              </label>
            </div>
            <div className="control-selectors" style={{ marginBottom: 8 }}>
              <label>
                <span>起点X</span>
                <input
                  type="number" min={0} value={swipeDebug.x} style={{ width: 56 }}
                  onChange={(e) => setSwipeDebug(prev => ({ ...prev, x: parseInt(e.target.value, 10) || 0 }))}
                  disabled={isControlDisabled}
                />
              </label>
              <label>
                <span>起点Y</span>
                <input
                  type="number" min={0} value={swipeDebug.y} style={{ width: 56 }}
                  onChange={(e) => setSwipeDebug(prev => ({ ...prev, y: parseInt(e.target.value, 10) || 0 }))}
                  disabled={isControlDisabled}
                />
              </label>
            </div>
            <div className="control-selectors" style={{ marginBottom: 8 }}>
              <label>
                <span>分段</span>
                <input
                  type="number" min={1} max={20} value={swipeDebug.segments} style={{ width: 48 }}
                  onChange={(e) => setSwipeDebug(prev => ({ ...prev, segments: parseInt(e.target.value, 10) || 1 }))}
                  disabled={isControlDisabled}
                />
              </label>
              <label>
                <span>停留ms</span>
                <input
                  type="number" min={0} max={5000} step={50} value={swipeDebug.holdMs} style={{ width: 64 }}
                  onChange={(e) => setSwipeDebug(prev => ({ ...prev, holdMs: parseInt(e.target.value, 10) || 0 }))}
                  disabled={isControlDisabled}
                />
              </label>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button
                onClick={handleDebugSwipe}
                disabled={isControlDisabled}
                title="执行滑动"
                style={{
                  padding: '8px 18px',
                  borderRadius: 8,
                  border: 'none',
                  background: '#f60',
                  color: '#fff',
                  fontSize: 14,
                  cursor: isControlDisabled ? 'not-allowed' : 'pointer',
                  opacity: isControlDisabled ? 0.5 : 1,
                  whiteSpace: 'nowrap',
                }}
              >
                执行滑动
              </button>
              <span style={{ fontSize: 12, color: '#888' }}>
                ({swipeDebug.x},{swipeDebug.y}) → (
                {swipeDebug.direction === 'left' ? swipeDebug.x - swipeDebug.length : swipeDebug.direction === 'right' ? swipeDebug.x + swipeDebug.length : swipeDebug.x}
                ,
                {swipeDebug.direction === 'up' ? swipeDebug.y - swipeDebug.length : swipeDebug.direction === 'down' ? swipeDebug.y + swipeDebug.length : swipeDebug.y}
                )
              </span>
            </div>
          </div>
        </div>

        {/* Right: Preset Sequences */}
        <div className="sequence-section">
          <div className="sequence-header-row">
            <div className="sequence-title-group">
              <h3>预置指令</h3>
              <span className="sequence-device-badge">{selectedDeviceTestSetName} 用例</span>
            </div>
            <label className="device-test-set-select">
              <span>设备</span>
              <select
                value={state.selectedDeviceTestSet}
                onChange={(e) => {
                  const nextDevice = e.target.value === 'pro2' ? 'pro2' : DEFAULT_DEVICE_TEST_SET_ID;
                  const nextCategories = getAllCategories(nextDevice);
                  const nextCategory = nextCategories[0] ?? '';
                  const nextSequence = getSequencesByCategory(nextCategory, nextDevice)[0];
                  setState(prev => ({
                    ...prev,
                    selectedDeviceTestSet: nextDevice,
                    selectedCategory: nextCategory,
                    selectedSequenceId: nextSequence?.id ?? prev.selectedSequenceId,
                  }));
                }}
                disabled={state.isAutoRunning}
              >
                {DEVICE_TEST_SETS.map(device => (
                  <option key={device.id} value={device.id}>{device.name}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="sequence-category-tabs">
            {sequenceCategories.map(cat => (
              <button
                key={`${state.selectedDeviceTestSet}:${cat}`}
                className={`seq-cat-tab ${activeSequenceCategory === cat ? 'active' : ''}`}
                onClick={() => {
                  const nextSequence = getSequencesByCategory(cat, state.selectedDeviceTestSet)[0];
                  setState(prev => ({
                    ...prev,
                    selectedCategory: cat,
                    selectedSequenceId: nextSequence?.id ?? prev.selectedSequenceId,
                  }));
                }}
              >
                {cat}
              </button>
            ))}
          </div>
          <div className="sequence-list" key={`sequence-list:${state.selectedDeviceTestSet}:${activeSequenceCategory}`}>
            {categorySequences.map(seq => {
              const isRunning = state.isAutoRunning && state.activeOperationKey === `sequence:${seq.id}`;
              return (
                <button
                  key={`${state.selectedDeviceTestSet}:${seq.id}`}
                  className={`sequence-btn ${isRunning ? 'running' : ''}`}
                  onClick={() => {
                    if (isRunning) {
                      handleCancelAutoOperation();
                    } else {
                      handleAutoOperation(seq.id);
                    }
                  }}
                  disabled={(!isRunning && isControlDisabled) || (state.isAutoRunning && !isRunning)}
                  title={`${selectedDeviceTestSetName}: ${seq.id}`}
                >
                  {state.selectedDeviceTestSet === 'pro2' && (
                    <span className="seq-btn-device">Pro2</span>
                  )}
                  <span className="seq-btn-name">{seq.name}</span>
                  {isRunning && (
                    <span className="seq-btn-progress">
                      {state.autoProgress}/{state.autoTotalSteps}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
          {state.isAutoRunning && state.autoTotalSteps > 0 && (
            <div className="auto-progress">
              <div
                className="auto-progress-bar"
                style={{
                  width: `${(state.autoProgress / Math.max(1, state.autoTotalSteps)) * 100}%`,
                }}
              />
            </div>
          )}
          <div className="automation-preset-section">
            <div className="automation-preset-block">
              <div className="automation-preset-header">
                <h4>Security Check</h4>
                <span>共享 preset</span>
              </div>
              <div className="sequence-list">
                {SECURITY_CHECK_PRESETS.map(preset => {
                  const key = `preset:securityCheck:${preset.id}`;
                  const isRunning = state.isAutoRunning && state.activeOperationKey === key;
                  return (
                    <button
                      key={preset.id}
                      className={`sequence-btn ${isRunning ? 'running' : ''}`}
                      onClick={() => handleAutomationPresetRun('securityCheck', preset.id)}
                      disabled={isControlDisabled || (state.isAutoRunning && !isRunning)}
                      title={preset.steps.join(' -> ')}
                    >
                      <span className="seq-btn-name">{preset.id}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="automation-preset-block">
              <div className="automation-preset-header">
                <h4>ChainMethodBatch</h4>
                <span>共享 preset</span>
              </div>
              <div className="sequence-list">
                {CHAIN_METHOD_BATCH_PRESETS.map(preset => {
                  const key = `preset:chainMethodBatch:${preset.id}`;
                  const isRunning = state.isAutoRunning && state.activeOperationKey === key;
                  return (
                    <button
                      key={preset.id}
                      className={`sequence-btn ${isRunning ? 'running' : ''}`}
                      onClick={() => handleAutomationPresetRun('chainMethodBatch', preset.id)}
                      disabled={isControlDisabled || (state.isAutoRunning && !isRunning)}
                      title={preset.steps.join(' -> ')}
                    >
                      <span className="seq-btn-name">{preset.id}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Captured Words Display */}
      {state.capturedWords.length > 0 && (
        <div className="captured-words-section">
          <div className="captured-words-header">
            <h3>识别到的助记词</h3>
            <span className="captured-words-count">{capturedFilledCount}/{state.capturedWords.length} 个</span>
            <button
              type="button"
              onClick={async () => {
                const phrase = state.capturedWords.filter((word) => !!word).join(' ');
                if (!phrase) return;
                try {
                  await navigator.clipboard.writeText(phrase);
                  setCopiedWords(true);
                  setTimeout(() => setCopiedWords(false), 2000);
                } catch {
                  addLog('错误', '复制失败：剪贴板不可用');
                }
              }}
              style={{
                marginLeft: 8,
                padding: '2px 12px',
                fontSize: 13,
                borderRadius: 6,
                border: '1px solid #f60',
                background: copiedWords ? '#f60' : 'transparent',
                color: copiedWords ? '#fff' : '#f60',
                cursor: 'pointer',
              }}
            >
              {copiedWords ? '已复制' : '复制'}
            </button>
          </div>
          <div className="captured-words-grid">
            {state.capturedWords.map((word, i) => (
              <span key={i} className="captured-word">
                <span className="word-index">{i + 1}.</span>
                <span className="word-text">{word}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* SLIP39: multiple shares display, each with its own copy button */}
      {state.capturedShares.length > 0 && (
        <div className="captured-words-section">
          <div className="captured-words-header">
            <h3>SLIP39 分片助记词</h3>
            <span className="captured-words-count">{state.capturedShares.length} 个分片</span>
          </div>
          {state.capturedShares.map((share, si) => {
            const phrase = share.filter((w) => !!w).join(' ');
            const filled = share.filter((w) => !!w).length;
            const copied = copiedShareIndex === si;
            return (
              <div key={si} style={{ marginTop: si === 0 ? 4 : 12 }}>
                <div className="captured-words-header" style={{ marginBottom: 4 }}>
                  <strong style={{ fontSize: 14 }}>分片 {si + 1}</strong>
                  <span className="captured-words-count">{filled}/{share.length} 个</span>
                  <button
                    type="button"
                    onClick={async () => {
                      if (!phrase) return;
                      try {
                        await navigator.clipboard.writeText(phrase);
                        setCopiedShareIndex(si);
                        setTimeout(() => setCopiedShareIndex(null), 2000);
                      } catch {
                        addLog('错误', '复制失败：剪贴板不可用');
                      }
                    }}
                    style={{
                      marginLeft: 8, padding: '2px 12px', fontSize: 13, borderRadius: 6,
                      border: '1px solid #f60', background: copied ? '#f60' : 'transparent',
                      color: copied ? '#fff' : '#f60', cursor: 'pointer',
                    }}
                  >
                    {copied ? '已复制' : '复制'}
                  </button>
                </div>
                <div className="captured-words-grid">
                  {share.map((word, i) => (
                    <span key={i} className="captured-word">
                      <span className="word-index">{i + 1}.</span>
                      <span className="word-text">{word}</span>
                    </span>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Bottom: Operation Logs */}
      <div className="logs-section">
        <div className="action-logs">
          {logs.length === 0 ? (
            <div className="logs-empty">暂无操作日志</div>
          ) : (
            <div className="logs-list">
              {logs.map(log => (
                <div key={log.id} className="log-entry">
                  <span className="log-time">{log.time}</span>
                  <span className="log-action">{log.action}</span>
                  <span className="log-detail">{log.detail}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default ControlPanel;
