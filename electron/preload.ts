import { contextBridge, ipcRenderer } from 'electron';

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

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  // App info
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getPlatform: () => ipcRenderer.invoke('get-platform'),

  // Receive messages from main process
  onMainProcessMessage: (callback: (message: string) => void) => {
    ipcRenderer.on('main-process-message', (_event, message) =>
      callback(message)
    );
  },

  // Example: Send message to main process
  sendMessage: (channel: string, data: unknown) => {
    // Whitelist channels
    const validChannels = ['toMain'];
    if (validChannels.includes(channel)) {
      ipcRenderer.send(channel, data);
    }
  },

  // HTTP request (bypasses CORS by going through main process)
  httpRequest: (url: string) => ipcRenderer.invoke('http-request', url),

  tryRecoverArmConnection: (payload: { serverIP: string; comPort: string }) =>
    ipcRenderer.invoke('try-recover-arm-connection', payload) as Promise<{
      attempted: boolean;
      reason: string;
    }>,

  notifyRendererUnload: (state: {
    isConnected: boolean;
    resourceHandle: number;
    serverIP?: string;
    comPort: string;
    currentX?: number;
    currentY?: number;
    zDepth?: number;
  }) => ipcRenderer.send('renderer-unload-arm', state),

  // Sync arm connection state with MCP
  syncArmState: (state: {
    isConnected: boolean;
    resourceHandle: number;
    serverIP?: string;
    comPort: string;
    currentX?: number;
    currentY?: number;
    zDepth?: number;
  }) => ipcRenderer.invoke('sync-arm-state', state),

  // MCP Frame capture: Listen for capture requests from main process
  onCaptureFrameRequest: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('mcp-capture-frame-request', handler);
    // Return unsubscribe function
    return () => {
      ipcRenderer.removeListener('mcp-capture-frame-request', handler);
    };
  },

  // MCP Frame capture: Send captured frame back to main process
  sendCaptureFrameResponse: (frame: string | null) => {
    ipcRenderer.send('mcp-capture-frame-response', frame);
  },

  // Pre-OCR image capture: Listen for request from main process
  onCapturePreOcrRequest: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('capture-pre-ocr-request', handler);
    return () => {
      ipcRenderer.removeListener('capture-pre-ocr-request', handler);
    };
  },

  // Pre-OCR image capture: Send pre-OCR image (data URL) back to main process
  sendCapturePreOcrResponse: (payload: string | null) => {
    ipcRenderer.send('capture-pre-ocr-response', payload);
  },

  onMcpOcrRequest: (callback: (payload?: MnemonicOcrRequestPayload | null) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload?: MnemonicOcrRequestPayload | null) =>
      callback(payload);
    ipcRenderer.on('mcp-ocr-request', handler);
    return () => {
      ipcRenderer.removeListener('mcp-ocr-request', handler);
    };
  },

  sendMcpOcrResponse: (payload: MnemonicOcrPayload | null) => {
    ipcRenderer.send('mcp-ocr-response', payload);
  },

  onMcpVerifyOcrRequest: (callback: () => void) => {
    const handler = () => callback();
    ipcRenderer.on('mcp-verify-ocr-request', handler);
    return () => {
      ipcRenderer.removeListener('mcp-verify-ocr-request', handler);
    };
  },

  sendMcpVerifyOcrResponse: (payload: VerifyOcrPayload | null) => {
    ipcRenderer.send('mcp-verify-ocr-response', payload);
  },

  // MCP Server status notification
  onMcpServerReady: (callback: (info: { port: number }) => void) => {
    ipcRenderer.on('mcp-server-ready', (_event, info) => callback(info));
  },

  // Save capture (base64 or data URL) to Downloads folder
  saveCaptureToDownloads: (dataUrlOrBase64: string, hint: string) =>
    ipcRenderer.invoke('save-capture-to-downloads', {
      dataUrlOrBase64,
      hint,
    }),

  paddleOcrEnRecognize: (
    imageDataUrl: string,
    layoutHint?: 'mnemonic' | 'verify-options' | 'verify-number' | 'generic',
    expectedWordCount?: number
  ) =>
    ipcRenderer.invoke('paddleocr-en-recognize', {
      imageDataUrl,
      layoutHint,
      expectedWordCount,
    }) as Promise<PaddleOcrEnPayload>,

  // MCP Log: Receive log entries from main process
  onMcpLog: (
    callback: (log: {
      type: 'request' | 'response' | 'error' | 'info';
      action: string;
      detail: string;
    }) => void
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      log: { type: 'request' | 'response' | 'error' | 'info'; action: string; detail: string }
    ) => callback(log);
    ipcRenderer.on('mcp-log', handler);
    return () => {
      ipcRenderer.removeListener('mcp-log', handler);
    };
  },
});

// MCP Log entry type
interface McpLogPayload {
  type: 'request' | 'response' | 'error' | 'info';
  action: string;
  detail: string;
}

// Type definitions for the exposed API
declare global {
  interface Window {
    electronAPI: {
      getAppVersion: () => Promise<string>;
      getPlatform: () => Promise<string>;
      onMainProcessMessage: (callback: (message: string) => void) => void;
      sendMessage: (channel: string, data: unknown) => void;
      httpRequest: (url: string) => Promise<{ status: number; data: string }>;
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
}
