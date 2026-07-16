/// <reference types="vite/client" />

interface McpLogPayload {
  type: 'request' | 'response' | 'error' | 'info';
  action: string;
  detail: string;
}

interface MnemonicOcrPayload {
  success: boolean;
  words: string[];
  confidence: number;
  expectedWordCount?: number;
  hasCompleteSequence?: boolean;
  bip39Valid?: boolean;
  reason?: string;
}

interface MnemonicOcrRequestPayload {
  expectedWordCount?: number;
  mergeWithStored?: boolean;
  allowPartial?: boolean;
  requireBip39?: boolean;
  sceneConfig?: {
    roi: { x: number; y: number; width: number; height: number };
    scale?: number;
    useNearestNeighbor?: boolean;
  };
}

interface RendererSequenceExecutionRequestPayload {
  sequenceId: string;
  deviceTestSetId?: string;
  armState: {
    isConnected: boolean;
    resourceHandle: number;
    serverIP: string;
    currentX?: number;
    currentY?: number;
    zDepth?: number;
  };
}

interface RendererSequenceExecutionResponsePayload {
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

interface VerifyOcrPayload {
  success: boolean;
  wordIndex: number;
  optionIndex: number;
  correctWord: string;
  rawOptions: string[];
  matchedOptions: string[];
  mnemonicWords?: string[];
  reason?: string;
}

interface PaddleOcrEnPayload {
  text: string;
  confidence: number;
  backend: 'PP-OCRv6_medium_rec_onnx';
  elapsedMs: number;
}

interface ResolvedSequenceStepPayload {
  label: string;
  x: number;
  y: number;
  depth: number;
  delayBefore?: number;
  delayAfter?: number;
  swipeTo?: { x: number; y: number };
  swipeSegments?: number;
  swipeSegmentDelay?: number;
  swipeHoldDelay?: number;
  moveOnly?: boolean;
  ocrCapture?: boolean | {
    expectedWordCount?: number;
    mergeWithStored?: boolean;
    allowPartial?: boolean;
    requireBip39?: boolean;
    sceneConfig?: {
      roi: { x: number; y: number; width: number; height: number };
      scale?: number;
      useNearestNeighbor?: boolean;
    };
    deviceTestSetId?: 'pro' | 'pro2';
  };
  ocrVerify?: {
    options: { x: number; y: number; depth: number }[];
  };
}

interface Window {
  electronAPI: {
    getAppVersion: () => Promise<string>;
    getPlatform: () => Promise<string>;
    onMainProcessMessage: (callback: (message: string) => void) => void;
    sendMessage: (channel: string, data: unknown) => void;
    httpRequest: (url: string) => Promise<{ status: number; data: string }>;
    resolveSequenceSteps: (sequenceId: string, deviceTestSetId?: string) => Promise<ResolvedSequenceStepPayload[]>;
    tryRecoverArmConnection: (payload: {
      serverIP: string;
      comPort: string;
    }) => Promise<{
      attempted: boolean;
      reason: string;
    }>;
    notifyRendererUnload: (state: {
      isConnected: boolean;
      resourceHandle: number;
      serverIP?: string;
      comPort: string;
      currentX?: number;
      currentY?: number;
      zDepth?: number;
    }) => void;
    // Sync arm connection state with MCP
    syncArmState: (state: {
      isConnected: boolean;
      resourceHandle: number;
      serverIP?: string;
      comPort: string;
      currentX?: number;
      currentY?: number;
      zDepth?: number;
    }) => Promise<void>;
    // MCP Frame capture
    onCaptureFrameRequest: (callback: () => void) => () => void;
    sendCaptureFrameResponse: (frame: string | null) => void;
    onCapturePreOcrRequest: (callback: () => void) => () => void;
    sendCapturePreOcrResponse: (payload: string | null) => void;
    onMcpOcrRequest: (callback: (payload?: MnemonicOcrRequestPayload | null) => void) => () => void;
    sendMcpOcrResponse: (payload: MnemonicOcrPayload | null) => void;
    onMcpExecuteSequenceRequest: (
      callback: (payload: RendererSequenceExecutionRequestPayload) => void
    ) => () => void;
    sendMcpExecuteSequenceResponse: (
      payload: RendererSequenceExecutionResponsePayload | null
    ) => void;
    onMcpVerifyOcrRequest: (callback: () => void) => () => void;
    sendMcpVerifyOcrResponse: (payload: VerifyOcrPayload | null) => void;
    saveCaptureToDownloads: (dataUrlOrBase64: string, hint: string) => Promise<string>;
    paddleOcrEnRecognize: (
      imageDataUrl: string,
      layoutHint?: 'mnemonic' | 'verify-options' | 'verify-number' | 'generic',
      expectedWordCount?: number,
      recVariantCount?: number,
      wordlistHint?: 'bip39' | 'slip39'
    ) => Promise<PaddleOcrEnPayload>;
    onMcpServerReady: (callback: (info: { port: number }) => void) => void;
    // MCP Logs
    onMcpLog: (callback: (log: McpLogPayload) => void) => () => void;
  };
}
