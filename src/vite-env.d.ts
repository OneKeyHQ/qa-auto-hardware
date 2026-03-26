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
  backend: 'en_PP-OCRv5_mobile_rec';
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
  ocrCapture?: boolean | {
    expectedWordCount?: number;
    mergeWithStored?: boolean;
    allowPartial?: boolean;
    requireBip39?: boolean;
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
    resolveSequenceSteps: (sequenceId: string) => Promise<ResolvedSequenceStepPayload[]>;
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
    onMcpVerifyOcrRequest: (callback: () => void) => () => void;
    sendMcpVerifyOcrResponse: (payload: VerifyOcrPayload | null) => void;
    saveCaptureToDownloads: (dataUrlOrBase64: string, hint: string) => Promise<string>;
    paddleOcrEnRecognize: (
      imageDataUrl: string,
      layoutHint?: 'mnemonic' | 'verify-options' | 'verify-number' | 'generic',
      expectedWordCount?: number
    ) => Promise<PaddleOcrEnPayload>;
    onMcpServerReady: (callback: (info: { port: number }) => void) => void;
    // MCP Logs
    onMcpLog: (callback: (log: McpLogPayload) => void) => () => void;
  };
}
