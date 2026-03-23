/**
 * Shared state management for MCP Server.
 * Maintains arm connection status, position, and provides state accessors.
 */

export interface ArmState {
  /** Whether the arm is connected */
  isConnected: boolean;
  /** Resource handle returned from connection (> 0 = valid) */
  resourceHandle: number;
  /** Server IP address */
  serverIP: string;
  /** COM port */
  comPort: string;
  /** Current X position in millimeters */
  currentX: number;
  /** Current Y position in millimeters */
  currentY: number;
  /** Z-axis depth for click operations */
  zDepth: number;
}

/** Default arm controller configuration */
export const ARM_CONFIG = {
  defaultServerIP: '192.168.5.106',
  apiPort: '8082',
  defaultComPort: 'COM3',
  apiPath: '/MyWcfService/getstring',
  deviceReadyDelay: 2000,
  commandDelay: 300,
  /** Stylus down time per click (ms). Lower = faster steps, may need increase if taps are missed. */
  clickDelay: 150,
  defaultZDepth: 12,
  zUp: 0,
} as const;

/** Global arm state instance */
let armState: ArmState = {
  isConnected: false,
  resourceHandle: 0,
  serverIP: ARM_CONFIG.defaultServerIP,
  comPort: ARM_CONFIG.defaultComPort,
  currentX: 0,
  currentY: 0,
  zDepth: ARM_CONFIG.defaultZDepth,
};

/** Frame capture callback type */
type FrameCaptureCallback = () => Promise<string | null>;

/** OCR-input image capture callback (returns data URL or base64 of the image sent to OCR) */
type PreOcrCaptureCallback = () => Promise<string | null>;

/** OCR capture result from renderer */
export interface MnemonicOcrResult {
  success: boolean;
  words: string[];
  confidence: number;
  expectedWordCount?: number;
  hasCompleteSequence?: boolean;
  bip39Valid?: boolean;
  reason?: string;
}

/** OCR capture request options (passed to renderer). */
export interface MnemonicOcrRequest {
  expectedWordCount?: number;
  mergeWithStored?: boolean;
  allowPartial?: boolean;
  requireBip39?: boolean;
}

export interface MnemonicStoreMetadata {
  capturedAt?: string;
  wordCount?: number;
  source?: string;
}

export interface StructuredMnemonicStoreState {
  words: string[];
  shares?: string[][];
  shareCount?: number;
  threshold?: number;
  sequenceId?: string;
  walletType?: 'bip39' | 'slip39';
  flowType?: 'create' | 'import' | 'manual';
  metadata: MnemonicStoreMetadata;
}

/** Verify-page OCR result from renderer */
export interface VerifyOcrResult {
  success: boolean;
  wordIndex: number;
  optionIndex: number;
  correctWord: string;
  rawOptions: string[];
  matchedOptions: string[];
  mnemonicWords?: string[];
  reason?: string;
}

type MnemonicOcrCallback = (request?: MnemonicOcrRequest) => Promise<MnemonicOcrResult | null>;
type VerifyOcrCallback = () => Promise<VerifyOcrResult | null>;

/** Frame capture function (set by main process when renderer is ready) */
let frameCaptureCallback: FrameCaptureCallback | null = null;

/** OCR-input capture function (set by main process when renderer is ready) */
let preOcrCaptureCallback: PreOcrCaptureCallback | null = null;
let mnemonicOcrCallback: MnemonicOcrCallback | null = null;
let verifyOcrCallback: VerifyOcrCallback | null = null;

/** MCP Log entry type */
export interface McpLogEntry {
  type: 'request' | 'response' | 'error' | 'info';
  action: string;
  detail: string;
}

/** MCP log callback type */
type McpLogCallback = (log: McpLogEntry) => void;

/** MCP log function (set by main process) */
let mcpLogCallback: McpLogCallback | null = null;

/** Global stop flag for interrupting sequences */
let shouldStopSequence = false;

/** Structured mnemonic storage shared with MCP tools */
let mnemonicStoreState: StructuredMnemonicStoreState = {
  words: [],
  metadata: {},
};

/**
 * Gets the current arm state.
 */
export function getArmState(): Readonly<ArmState> {
  return { ...armState };
}

/**
 * Updates the arm state with partial values.
 */
export function updateArmState(updates: Partial<ArmState>): void {
  armState = { ...armState, ...updates };
}

/**
 * Resets the arm state to defaults.
 */
export function resetArmState(): void {
  armState = {
    isConnected: false,
    resourceHandle: 0,
    serverIP: ARM_CONFIG.defaultServerIP,
    comPort: ARM_CONFIG.defaultComPort,
    currentX: 0,
    currentY: 0,
    zDepth: ARM_CONFIG.defaultZDepth,
  };
}

/**
 * Sets the frame capture callback function.
 * Called by main process when renderer is ready.
 */
export function setFrameCaptureCallback(callback: FrameCaptureCallback): void {
  frameCaptureCallback = callback;
}

/**
 * Captures a frame from the camera.
 * Returns base64-encoded JPEG image or null if capture fails.
 */
export async function captureFrame(): Promise<string | null> {
  if (!frameCaptureCallback) {
    console.warn('Frame capture callback not set');
    return null;
  }
  return frameCaptureCallback();
}

/**
 * Sets the OCR-input image capture callback.
 * Used by main process to request the image that will be sent to the OCR library (cropped and scaled).
 */
export function setPreOcrCaptureCallback(callback: PreOcrCaptureCallback): void {
  preOcrCaptureCallback = callback;
}

/**
 * Captures the OCR-input image (same pipeline as recognition: crop ROI + scale).
 * Returns data URL or base64 of the image that would be sent to the OCR library, or null.
 */
export async function capturePreOcrFrame(): Promise<string | null> {
  if (!preOcrCaptureCallback) {
    console.warn('OCR-input capture callback not set');
    return null;
  }
  return preOcrCaptureCallback();
}

export function setMnemonicOcrCallback(callback: MnemonicOcrCallback): void {
  mnemonicOcrCallback = callback;
}

export async function runMnemonicOcr(request?: MnemonicOcrRequest): Promise<MnemonicOcrResult | null> {
  if (!mnemonicOcrCallback) {
    console.warn('Mnemonic OCR callback not set');
    return null;
  }
  return mnemonicOcrCallback(request);
}

export function setVerifyOcrCallback(callback: VerifyOcrCallback): void {
  verifyOcrCallback = callback;
}

export async function runVerifyOcr(): Promise<VerifyOcrResult | null> {
  if (!verifyOcrCallback) {
    console.warn('Verify OCR callback not set');
    return null;
  }
  return verifyOcrCallback();
}

/**
 * Builds the API URL for arm controller commands.
 */
export function buildArmApiUrl(params: {
  duankou: string;
  hco: number;
  daima: string;
}): string {
  const baseUrl = `http://${armState.serverIP}:${ARM_CONFIG.apiPort}${ARM_CONFIG.apiPath}`;
  const queryParams = new URLSearchParams({
    duankou: params.duankou,
    hco: params.hco.toString(),
    daima: params.daima,
  });
  return `${baseUrl}?${queryParams.toString()}`;
}

/**
 * Parses server response by removing surrounding quotes.
 */
export function parseServerResponse(response: string): string {
  return response.replace(/^"|"$/g, '');
}

/**
 * Parses resource handle from server response.
 */
export function parseResourceHandle(response: string): number {
  const cleanResult = parseServerResponse(response);
  const handle = parseInt(cleanResult, 10);
  return isNaN(handle) ? 0 : handle;
}

/**
 * Delays execution for specified milliseconds.
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Sets the MCP log callback function.
 * Called by main process to enable log forwarding to renderer.
 */
export function setMcpLogCallback(callback: McpLogCallback): void {
  mcpLogCallback = callback;
}

/**
 * Sends an MCP log entry to the renderer process.
 */
export function sendMcpLog(log: McpLogEntry): void {
  if (mcpLogCallback) {
    mcpLogCallback(log);
  }
  // Also log to console
  console.log(`[MCP ${log.type.toUpperCase()}] ${log.action}: ${log.detail}`);
}

/**
 * Sets the stop flag to interrupt sequence execution.
 */
export function setStopSequenceFlag(value: boolean): void {
  shouldStopSequence = value;
}

/**
 * Checks if sequence should stop.
 */
export function shouldStopSequenceExecution(): boolean {
  return shouldStopSequence;
}

/**
 * Stores mnemonic words for later verification.
 * @param words - Array of mnemonic words in order
 * @param source - Source of the mnemonic (e.g., 'ocr', 'manual')
 */
export function storeMnemonicWords(words: string[], source: string = 'ocr'): void {
  mnemonicStoreState = {
    words: [...words],
    metadata: {
      capturedAt: new Date().toISOString(),
      wordCount: words.length,
      source,
    },
  };
  console.log(`[MCP] Stored ${words.length} mnemonic words from ${source}`);
}

export function storeStructuredMnemonicState(
  input: Omit<StructuredMnemonicStoreState, 'metadata'>,
  source: string = 'ocr'
): void {
  mnemonicStoreState = {
    words: [...input.words],
    shares: input.shares?.map((share) => [...share]),
    shareCount: input.shareCount,
    threshold: input.threshold,
    sequenceId: input.sequenceId,
    walletType: input.walletType,
    flowType: input.flowType,
    metadata: {
      capturedAt: new Date().toISOString(),
      wordCount: input.words.length,
      source,
    },
  };
  console.log(
    `[MCP] Stored structured mnemonic state: ${input.walletType || 'unknown'} ${input.flowType || 'unknown'}`
  );
}

/**
 * Gets the stored mnemonic words.
 */
export function getStoredMnemonicWords(): string[] {
  return [...mnemonicStoreState.words];
}

export function getStoredMnemonicState(): StructuredMnemonicStoreState {
  return {
    words: [...mnemonicStoreState.words],
    shares: mnemonicStoreState.shares?.map((share) => [...share]),
    shareCount: mnemonicStoreState.shareCount,
    threshold: mnemonicStoreState.threshold,
    sequenceId: mnemonicStoreState.sequenceId,
    walletType: mnemonicStoreState.walletType,
    flowType: mnemonicStoreState.flowType,
    metadata: { ...mnemonicStoreState.metadata },
  };
}

/**
 * Gets a specific mnemonic word by index (1-based).
 * @param index - 1-based index of the word
 */
export function getMnemonicWordByIndex(index: number): string | null {
  if (index < 1 || index > mnemonicStoreState.words.length) {
    return null;
  }
  return mnemonicStoreState.words[index - 1];
}

/**
 * Gets mnemonic storage metadata.
 */
export function getMnemonicMetadata(): MnemonicStoreMetadata {
  return { ...mnemonicStoreState.metadata };
}

/**
 * Clears stored mnemonic words.
 */
export function clearMnemonicWords(): void {
  mnemonicStoreState = {
    words: [],
    metadata: {},
  };
  console.log('[MCP] Cleared stored mnemonic words');
}

/**
 * Checks if mnemonic words are stored.
 */
export function hasMnemonicWords(): boolean {
  return mnemonicStoreState.words.length > 0;
}
