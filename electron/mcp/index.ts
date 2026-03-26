/**
 * QA Auto Hardware MCP Server.
 * Provides mechanical arm control and camera capture via MCP protocol.
 * Supports both Streamable HTTP and legacy SSE transports.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import express, { Request, Response } from 'express';
import { Server } from 'http';
import { randomUUID } from 'crypto';

import { getPaddleOcrEnHealth } from '../paddleOcrEn';
import {
  armConnectSchema,
  executeArmConnect,
  armDisconnectSchema,
  executeArmDisconnect,
  armMoveSchema,
  executeArmMove,
  armClickSchema,
  executeArmClick,
  captureFrameSchema,
  executeCaptureFrame,
  // New automation tools
  executeSequenceSchema,
  executeExecuteSequence,
  confirmActionSchema,
  executeConfirmAction,
  confirmActionSequenceSchema,
  executeConfirmActionSequence,
  executeAutomationPresetSchema,
  executeAutomationPreset,
  inputPinSchema,
  executeInputPin,
  stopSequenceSchema,
  executeStopSequence,
  // Mnemonic tools
  mnemonicStoreSchema,
  executeMnemonicStore,
  mnemonicVerifySchema,
  executeMnemonicVerify,
} from './tools';
import { ARM_STATUS_URI, getArmStatusResource } from './resources';
import { getAllSequenceIds } from './sequences';
import { sendMcpLog } from './state';

/** MCP Server configuration */
const MCP_CONFIG = {
  name: 'qa-auto-hardware',
  version: '1.0.0',
  port: 3847,
} as const;

/** HTTP request function type (injected from main process) */
type HttpRequestFn = (url: string) => Promise<string>;

/**
 * QA Auto Hardware MCP Server class.
 * Manages MCP server lifecycle and tool/resource registration.
 */
export class QAAutoHardwareMcpServer {
  private httpServer: Server | null = null;
  private httpRequest: HttpRequestFn;
  
  // Transport storage for session management
  private streamableTransports: Map<string, StreamableHTTPServerTransport> = new Map();
  private sseTransports: Map<string, SSEServerTransport> = new Map();

  constructor(httpRequest: HttpRequestFn) {
    this.httpRequest = httpRequest;
  }

  /**
   * Creates a new MCP server instance with tools and resources registered.
   */
  private createMcpServer(): McpServer {
    const mcpServer = new McpServer({
      name: MCP_CONFIG.name,
      version: MCP_CONFIG.version,
    });

    this.registerTools(mcpServer);
    this.registerResources(mcpServer);

    return mcpServer;
  }

  /**
   * Registers all MCP tools.
   */
  private registerTools(mcpServer: McpServer): void {
    // arm-connect: Connect to mechanical arm
    mcpServer.registerTool(
      'arm-connect',
      {
        description: 'Connect to the mechanical arm controller via COM port. Returns a handle for subsequent operations.',
        inputSchema: armConnectSchema,
      },
      async (args) => {
        sendMcpLog({ type: 'request', action: 'arm-connect', detail: JSON.stringify(args) });
        const result = await executeArmConnect(args, this.httpRequest);
        sendMcpLog({
          type: result.success ? 'response' : 'error',
          action: 'arm-connect',
          detail: result.message,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }
    );

    // arm-disconnect: Disconnect from mechanical arm
    mcpServer.registerTool(
      'arm-disconnect',
      {
        description: 'Disconnect from the mechanical arm controller. Resets position to origin before closing.',
        inputSchema: armDisconnectSchema,
      },
      async (args) => {
        sendMcpLog({ type: 'request', action: 'arm-disconnect', detail: 'Disconnecting...' });
        const result = await executeArmDisconnect(args, this.httpRequest);
        sendMcpLog({
          type: result.success ? 'response' : 'error',
          action: 'arm-disconnect',
          detail: result.message,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }
    );

    // arm-move: Move arm to position
    mcpServer.registerTool(
      'arm-move',
      {
        description: 'Move the mechanical arm to a specified X,Y position in millimeters. Optionally returns a camera frame after moving.',
        inputSchema: armMoveSchema,
      },
      async (args) => {
        sendMcpLog({ type: 'request', action: 'arm-move', detail: `X${args.x} Y${args.y}` });
        const { output, frame } = await executeArmMove(args, this.httpRequest);
        sendMcpLog({
          type: output.success ? 'response' : 'error',
          action: 'arm-move',
          detail: output.message,
        });
        const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
          {
            type: 'text' as const,
            text: JSON.stringify(output, null, 2),
          },
        ];

        if (frame) {
          content.push({
            type: 'image' as const,
            data: frame,
            mimeType: 'image/jpeg',
          });
        }

        return { content };
      }
    );

    // arm-click: Perform click at current position
    mcpServer.registerTool(
      'arm-click',
      {
        description: 'Perform a click operation at the current position. Lowers stylus, waits briefly, then raises it. Optionally returns a camera frame.',
        inputSchema: armClickSchema,
      },
      async (args) => {
        sendMcpLog({ type: 'request', action: 'arm-click', detail: `depth=${args.depth || 12}` });
        const { output, frame } = await executeArmClick(args, this.httpRequest);
        sendMcpLog({
          type: output.success ? 'response' : 'error',
          action: 'arm-click',
          detail: output.message,
        });
        const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
          {
            type: 'text' as const,
            text: JSON.stringify(output, null, 2),
          },
        ];

        if (frame) {
          content.push({
            type: 'image' as const,
            data: frame,
            mimeType: 'image/jpeg',
          });
        }

        return { content };
      }
    );

    // capture-frame: Capture camera frame
    mcpServer.registerTool(
      'capture-frame',
      {
        description: 'Capture the current camera frame. Returns a JPEG image showing the current view.',
        inputSchema: captureFrameSchema,
      },
      async (args) => {
        sendMcpLog({ type: 'request', action: 'capture-frame', detail: 'Capturing...' });
        const { output, frame } = await executeCaptureFrame(args);
        sendMcpLog({
          type: output.success ? 'response' : 'error',
          action: 'capture-frame',
          detail: output.message,
        });
        const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
          {
            type: 'text' as const,
            text: JSON.stringify(output, null, 2),
          },
        ];

        if (frame) {
          content.push({
            type: 'image' as const,
            data: frame,
            mimeType: 'image/jpeg',
          });
        }

        return { content };
      }
    );

    // ========================================================================
    // Automation Tools
    // ========================================================================

    // execute-sequence: Execute a predefined auto operation sequence
    mcpServer.registerTool(
      'execute-sequence',
      {
        description: 'Execute a predefined auto operation sequence (e.g., reset-wallet, one-normal-24). Use this to automate device setup and mnemonic recovery.',
        inputSchema: executeSequenceSchema,
      },
      async (args) => {
        sendMcpLog({ type: 'request', action: 'execute-sequence', detail: `Sequence: ${args.sequenceId}` });
        const { output, frame } = await executeExecuteSequence(args, this.httpRequest);
        sendMcpLog({
          type: output.success ? 'response' : 'error',
          action: 'execute-sequence',
          detail: output.message,
        });
        const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
          {
            type: 'text' as const,
            text: JSON.stringify(output, null, 2),
          },
        ];

        if (frame) {
          content.push({
            type: 'image' as const,
            data: frame,
            mimeType: 'image/jpeg',
          });
        }

        return { content };
      }
    );

    // confirm-action: Click confirm or cancel button
    mcpServer.registerTool(
      'confirm-action',
      {
        description: 'Click the confirm or cancel button on the device. Use "confirm" to approve an action, "cancel" to reject.',
        inputSchema: confirmActionSchema,
      },
      async (args) => {
        sendMcpLog({ type: 'request', action: 'confirm-action', detail: `Action: ${args.action}` });
        const { output, frame } = await executeConfirmAction(args, this.httpRequest);
        sendMcpLog({
          type: output.success ? 'response' : 'error',
          action: 'confirm-action',
          detail: output.message,
        });
        const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
          {
            type: 'text' as const,
            text: JSON.stringify(output, null, 2),
          },
        ];

        if (frame) {
          content.push({
            type: 'image' as const,
            data: frame,
            mimeType: 'image/jpeg',
          });
        }

        return { content };
      }
    );

    mcpServer.registerTool(
      'confirm-action-sequence',
      {
        description: 'Execute an ordered sequence of device actions such as confirm and slide-to-confirm on the PhonePilot side.',
        inputSchema: confirmActionSequenceSchema,
      },
      async (args) => {
        sendMcpLog({
          type: 'request',
          action: 'confirm-action-sequence',
          detail: `Steps: ${args.steps.join(' -> ')}`,
        });
        const { output, frame } = await executeConfirmActionSequence(args, this.httpRequest);
        sendMcpLog({
          type: output.success ? 'response' : 'error',
          action: 'confirm-action-sequence',
          detail: output.message,
        });
        const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
          {
            type: 'text' as const,
            text: JSON.stringify(output, null, 2),
          },
        ];

        if (frame) {
          content.push({
            type: 'image' as const,
            data: frame,
            mimeType: 'image/jpeg',
          });
        }

        return { content };
      }
    );

    mcpServer.registerTool(
      'execute-automation-preset',
      {
        description: 'Resolve and execute a shared automation preset for security-check, chain-method-batch, or device-settings directly on the PhonePilot side.',
        inputSchema: executeAutomationPresetSchema,
      },
      async (args) => {
        sendMcpLog({
          type: 'request',
          action: 'execute-automation-preset',
          detail: `${args.suite}/${args.presetId}`,
        });
        const { output, frame } = await executeAutomationPreset(args, this.httpRequest);
        sendMcpLog({
          type: output.success ? 'response' : 'error',
          action: 'execute-automation-preset',
          detail: output.message,
        });
        const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
          {
            type: 'text' as const,
            text: JSON.stringify(output, null, 2),
          },
        ];

        if (frame) {
          content.push({
            type: 'image' as const,
            data: frame,
            mimeType: 'image/jpeg',
          });
        }

        return { content };
      }
    );

    // input-pin: Input PIN code on device
    mcpServer.registerTool(
      'input-pin',
      {
        description: 'Input a PIN code on the device using the number pad. Optionally confirms after entering.',
        inputSchema: inputPinSchema,
      },
      async (args) => {
        sendMcpLog({ type: 'request', action: 'input-pin', detail: `PIN length: ${args.pin.length}` });
        const { output, frame } = await executeInputPin(args, this.httpRequest);
        sendMcpLog({
          type: output.success ? 'response' : 'error',
          action: 'input-pin',
          detail: output.message,
        });
        const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [
          {
            type: 'text' as const,
            text: JSON.stringify(output, null, 2),
          },
        ];

        if (frame) {
          content.push({
            type: 'image' as const,
            data: frame,
            mimeType: 'image/jpeg',
          });
        }

        return { content };
      }
    );

    // stop-sequence: Stop the currently running sequence
    mcpServer.registerTool(
      'stop-sequence',
      {
        description: 'Stops the currently running sequence execution. The sequence will stop at the next step.',
        inputSchema: stopSequenceSchema,
      },
      async (args) => {
        sendMcpLog({ type: 'request', action: 'stop-sequence', detail: 'Stopping sequence...' });
        const output = await executeStopSequence(args);
        sendMcpLog({
          type: output.success ? 'response' : 'error',
          action: 'stop-sequence',
          detail: output.message,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(output, null, 2),
            },
          ],
        };
      }
    );

    // ========================================================================
    // Mnemonic Tools
    // ========================================================================

    // mnemonic-store: Store/retrieve mnemonic words
    mcpServer.registerTool(
      'mnemonic-store',
      {
        description: 'Store, retrieve, or clear mnemonic words. Use after OCR recognition to save seed phrase for later verification.',
        inputSchema: mnemonicStoreSchema,
      },
      async (args) => {
        sendMcpLog({ type: 'request', action: 'mnemonic-store', detail: `action=${args.action}` });
        const output = await executeMnemonicStore(args);
        sendMcpLog({
          type: output.success ? 'response' : 'error',
          action: 'mnemonic-store',
          detail: output.message,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(output, null, 2),
            },
          ],
        };
      }
    );

    // mnemonic-verify: Find correct word option for verification
    mcpServer.registerTool(
      'mnemonic-verify',
      {
        description: 'Find the correct word to click during mnemonic verification. Given a word index (e.g., "Word #5") and OCR results from the verification screen, returns the position of the correct option to click.',
        inputSchema: mnemonicVerifySchema,
      },
      async (args) => {
        sendMcpLog({ type: 'request', action: 'mnemonic-verify', detail: `wordIndex=${args.wordIndex}` });
        const output = await executeMnemonicVerify(args);
        sendMcpLog({
          type: output.success ? 'response' : 'error',
          action: 'mnemonic-verify',
          detail: output.message,
        });
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(output, null, 2),
            },
          ],
        };
      }
    );

  }

  /**
   * Registers all MCP resources.
   */
  private registerResources(mcpServer: McpServer): void {
    mcpServer.registerResource(
      'arm-status',
      ARM_STATUS_URI,
      {
        description: 'Current mechanical arm connection status and position',
        mimeType: 'application/json',
      },
      async () => {
        const status = getArmStatusResource();
        return {
          contents: [
            {
              uri: ARM_STATUS_URI,
              mimeType: 'application/json',
              text: JSON.stringify(status, null, 2),
            },
          ],
        };
      }
    );
  }

  /**
   * Starts the MCP server with HTTP transport.
   * Supports both Streamable HTTP and legacy SSE transports.
   */
  async start(): Promise<number> {
    const app = express();
    app.use(express.json());

    // CORS headers for all requests
    app.use((_req: Request, res: Response, next) => {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, mcp-session-id');
      res.setHeader('Access-Control-Expose-Headers', 'mcp-session-id');

      if (_req.method === 'OPTIONS') {
        res.sendStatus(200);
        return;
      }

      next();
    });

    // Streamable HTTP endpoint - handles POST, GET, DELETE
    app.post('/mcp', async (req: Request, res: Response) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport = sessionId ? this.streamableTransports.get(sessionId) : undefined;

      if (transport) {
        // Reuse existing transport for this session
        await transport.handleRequest(req, res, req.body);
        return;
      }

      // Create new transport for new session
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          sendMcpLog({ type: 'info', action: 'session', detail: `Streamable HTTP connected: ${newSessionId.slice(0, 8)}...` });
          this.streamableTransports.set(newSessionId, transport!);
        },
      });

      // Clean up on close
      transport.onclose = () => {
        if (sessionId) {
          this.streamableTransports.delete(sessionId);
          sendMcpLog({ type: 'info', action: 'session', detail: `Streamable HTTP disconnected: ${sessionId.slice(0, 8)}...` });
        }
      };

      // Create new MCP server for this session and connect
      const mcpServer = this.createMcpServer();
      await mcpServer.connect(transport);

      // Handle the request
      await transport.handleRequest(req, res, req.body);
    });

    app.get('/mcp', async (req: Request, res: Response) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      
      if (!sessionId || !this.streamableTransports.has(sessionId)) {
        res.status(400).json({ error: 'Invalid or missing session ID' });
        return;
      }

      const transport = this.streamableTransports.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
    });

    app.delete('/mcp', async (req: Request, res: Response) => {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (!sessionId || !this.streamableTransports.has(sessionId)) {
        res.status(400).json({ error: 'Invalid or missing session ID' });
        return;
      }

      const transport = this.streamableTransports.get(sessionId)!;
      await transport.handleRequest(req, res, req.body);
      this.streamableTransports.delete(sessionId);
    });

    // Legacy SSE endpoint
    app.get('/sse', async (_req: Request, res: Response) => {
      const transport = new SSEServerTransport('/message', res);

      // Create new MCP server for this session and connect
      // Note: connect() automatically calls start(), so we don't call it manually
      const mcpServer = this.createMcpServer();
      await mcpServer.connect(transport);

      // Store transport using its internal sessionId (available after connect/start)
      const sessionId = transport.sessionId;
      this.sseTransports.set(sessionId, transport);
      sendMcpLog({ type: 'info', action: 'session', detail: `SSE connected: ${sessionId.slice(0, 8)}...` });

      res.on('close', () => {
        this.sseTransports.delete(sessionId);
        sendMcpLog({ type: 'info', action: 'session', detail: `SSE disconnected: ${sessionId.slice(0, 8)}...` });
      });
    });

    // Legacy SSE message endpoint
    app.post('/message', async (req: Request, res: Response) => {
      const sessionId = req.query.sessionId as string;
      
      if (!sessionId) {
        res.status(400).json({ error: 'Missing sessionId parameter' });
        return;
      }

      const transport = this.sseTransports.get(sessionId);

      if (!transport) {
        sendMcpLog({ type: 'error', action: 'session', detail: `SSE session not found: ${sessionId.slice(0, 8)}...` });
        res.status(404).json({ error: 'Session not found' });
        return;
      }

      // Pass req.body explicitly to avoid "stream is not readable" error
      // (Express body parser already consumed the stream)
      await transport.handlePostMessage(req, res, req.body);
    });

    // Health check endpoint
    app.get('/health', async (_req: Request, res: Response) => {
      const ocr = await getPaddleOcrEnHealth();
      res.json({
        status: 'ok',
        server: MCP_CONFIG.name,
        version: MCP_CONFIG.version,
        mcpReady: true,
        ocrReady: ocr.ready,
        message: ocr.message,
        ocr,
        sequenceIds: getAllSequenceIds(),
        activeSessions: {
          streamable: this.streamableTransports.size,
          sse: this.sseTransports.size,
        },
      });
    });

    return new Promise((resolve) => {
      this.httpServer = app.listen(MCP_CONFIG.port, () => {
        console.log(`QA Auto Hardware MCP Server running on http://localhost:${MCP_CONFIG.port}`);
        console.log('  - Streamable HTTP: POST/GET/DELETE /mcp');
        console.log('  - Legacy SSE: GET /sse, POST /message');
        console.log('  - Health check: GET /health');
        resolve(MCP_CONFIG.port);
      });
    });
  }

  /**
   * Stops the MCP server.
   */
  stop(): void {
    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
      this.streamableTransports.clear();
      this.sseTransports.clear();
      console.log('QA Auto Hardware MCP Server stopped');
    }
  }

  /**
   * Gets the server port.
   */
  getPort(): number {
    return MCP_CONFIG.port;
  }
}
