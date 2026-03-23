import { app } from 'electron';
import { ChildProcessWithoutNullStreams, execFile, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { promisify } from 'util';

export interface PaddleOcrEnRequest {
  imageDataUrl: string;
  layoutHint?: 'mnemonic' | 'verify-options' | 'verify-number' | 'generic';
  expectedWordCount?: number;
}

export interface PaddleOcrEnResult {
  text: string;
  confidence: number;
  backend: 'en_PP-OCRv5_mobile_rec';
  elapsedMs: number;
}

export interface PaddleOcrEnHealthStatus {
  ready: boolean;
  pythonBin: string;
  pythonVersion?: string;
  scriptPath?: string;
  missingDependencies: string[];
  missingModels: string[];
  message: string;
  checkedAt: string;
}

const execFileAsync = promisify(execFile);
const HEALTH_CACHE_TTL_MS = 30 * 1000;
const REQUIRED_PYTHON_MODULES = [
  'paddleocr',
  'paddle',
  'cv2',
  'PIL',
  'yaml',
  'huggingface_hub',
] as const;
const REQUIRED_MODEL_CONFIGS = [
  {
    name: 'en_PP-OCRv5_mobile_rec',
    envKeys: ['QA_AUTO_HW_OCR_MODEL_DIR', 'QA_AUTO_HW_EN_OCR_MODEL_DIR'],
  },
  {
    name: 'PP-OCRv5_mobile_rec',
    envKeys: ['QA_AUTO_HW_OCR_MULTI_REC_MODEL_DIR'],
  },
  {
    name: 'PP-OCRv5_mobile_det',
    envKeys: ['QA_AUTO_HW_OCR_DET_MODEL_DIR'],
  },
] as const;
const REQUIRED_MODEL_FILES = ['inference.json', 'inference.pdiparams', 'inference.yml'] as const;

let cachedHealthStatus: { expiresAt: number; value: PaddleOcrEnHealthStatus } | null = null;

function resolvePythonBin(): string {
  if (process.env.QA_AUTO_HW_PYTHON_BIN) {
    return process.env.QA_AUTO_HW_PYTHON_BIN;
  }
  // In dev mode, prefer the project-local venv created by scripts/setup_ocr.sh
  const venvCandidates = [
    path.join(app.getAppPath(), 'scripts', '.venv', 'bin', 'python'),
    path.join(process.cwd(), 'scripts', '.venv', 'bin', 'python'),
    path.join(__dirname, '..', 'scripts', '.venv', 'bin', 'python'),
  ];
  for (const candidate of venvCandidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return 'python3';
}

function resolveInferScriptPath(): string {
  const candidates = [
    path.join(app.getAppPath(), 'scripts', 'paddleocr_en_infer.py'),
    path.join(process.cwd(), 'scripts', 'paddleocr_en_infer.py'),
    path.join(__dirname, '..', 'scripts', 'paddleocr_en_infer.py'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    `paddleocr_en_infer.py not found. Checked: ${candidates.join(', ')}`
  );
}

function resolveProjectRootCandidates(): string[] {
  return [
    app.getAppPath(),
    process.cwd(),
    path.join(__dirname, '..'),
  ];
}

function resolveModelDir(
  defaultName: string,
  envKeys: readonly string[]
): string | null {
  for (const envKey of envKeys) {
    const value = (process.env[envKey] || '').trim();
    if (value) {
      const resolved = path.resolve(value);
      return fs.existsSync(resolved) ? resolved : null;
    }
  }

  for (const root of resolveProjectRootCandidates()) {
    const candidate = path.join(root, 'models', 'paddle_ocr', defaultName);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

async function probePythonEnvironment(
  pythonBin: string
): Promise<{ pythonVersion?: string; missingDependencies: string[]; error?: string }> {
  const env = { ...process.env };
  delete env.HTTP_PROXY;
  delete env.HTTPS_PROXY;
  delete env.ALL_PROXY;
  delete env.http_proxy;
  delete env.https_proxy;
  delete env.all_proxy;

  const command = [
    'import importlib.util, json, sys',
    `modules = ${JSON.stringify(REQUIRED_PYTHON_MODULES)}`,
    'missing = [name for name in modules if importlib.util.find_spec(name) is None]',
    "print(json.dumps({'pythonVersion': sys.version.split()[0], 'missingDependencies': missing}))",
  ].join('; ');

  try {
    const { stdout } = await execFileAsync(pythonBin, ['-c', command], {
      env,
      timeout: 15 * 1000,
      maxBuffer: 256 * 1024,
    });
    const parsed = JSON.parse(stdout.trim()) as {
      pythonVersion?: string;
      missingDependencies?: string[];
    };
    return {
      pythonVersion: parsed.pythonVersion,
      missingDependencies: Array.isArray(parsed.missingDependencies)
        ? parsed.missingDependencies
        : [],
    };
  } catch (error) {
    return {
      missingDependencies: [...REQUIRED_PYTHON_MODULES],
      error: error instanceof Error ? error.message : 'Unknown python probe error',
    };
  }
}

function collectMissingModels(): string[] {
  const missingModels: string[] = [];

  for (const config of REQUIRED_MODEL_CONFIGS) {
    const modelDir = resolveModelDir(config.name, config.envKeys);
    if (!modelDir) {
      missingModels.push(`${config.name}: directory not found`);
      continue;
    }

    for (const fileName of REQUIRED_MODEL_FILES) {
      const filePath = path.join(modelDir, fileName);
      if (!fs.existsSync(filePath)) {
        missingModels.push(`${config.name}: missing ${fileName}`);
      }
    }
  }

  return missingModels;
}

export async function getPaddleOcrEnHealth(
  forceRefresh = false
): Promise<PaddleOcrEnHealthStatus> {
  if (!forceRefresh && cachedHealthStatus && cachedHealthStatus.expiresAt > Date.now()) {
    return cachedHealthStatus.value;
  }

  const pythonBin = resolvePythonBin();
  let scriptPath: string | undefined;
  let message = 'OCR ready';

  try {
    scriptPath = resolveInferScriptPath();
  } catch (error) {
    message = error instanceof Error ? error.message : 'paddleocr_en_infer.py not found';
  }

  const pythonProbe = await probePythonEnvironment(pythonBin);
  const missingDependencies = [...pythonProbe.missingDependencies];
  const missingModels = collectMissingModels();

  if (pythonProbe.error) {
    message = pythonProbe.error;
  } else if (missingDependencies.length > 0) {
    message = `Python dependencies missing: ${missingDependencies.join(', ')}`;
  } else if (missingModels.length > 0) {
    message = `OCR models missing: ${missingModels.join(', ')}`;
  } else if (!scriptPath) {
    message = 'OCR infer script not found';
  }

  const value: PaddleOcrEnHealthStatus = {
    ready: Boolean(scriptPath) && missingDependencies.length === 0 && missingModels.length === 0,
    pythonBin,
    pythonVersion: pythonProbe.pythonVersion,
    scriptPath,
    missingDependencies,
    missingModels,
    message,
    checkedAt: new Date().toISOString(),
  };

  cachedHealthStatus = {
    value,
    expiresAt: Date.now() + HEALTH_CACHE_TTL_MS,
  };

  return value;
}

export async function runPaddleOcrEn(
  request: PaddleOcrEnRequest
): Promise<PaddleOcrEnResult> {
  return daemon.send(request);
}

interface PendingRequest {
  resolve: (value: PaddleOcrEnResult) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class PaddleOcrEnDaemon {
  private child: ChildProcessWithoutNullStreams | null = null;
  private startPromise: Promise<void> | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private stdoutBuffer = '';
  private stderrBuffer = '';

  async send(request: PaddleOcrEnRequest): Promise<PaddleOcrEnResult> {
    await this.ensureStarted();

    if (!this.child) {
      throw new Error('PP-OCRv5 rec daemon is not running');
    }

    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('PP-OCRv5 rec request timed out after 2 minutes'));
      }, 2 * 60 * 1000);

      this.pending.set(id, { resolve, reject, timer });
      const line = JSON.stringify({ id, ...request });
      this.child?.stdin.write(`${line}\n`);
    });
  }

  stop(): void {
    if (this.child) {
      this.child.kill('SIGTERM');
      this.child = null;
    }
    this.startPromise = null;
    this.stdoutBuffer = '';
    this.rejectAllPending(new Error('PP-OCRv5 rec daemon stopped'));
  }

  private async ensureStarted(): Promise<void> {
    if (this.child) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    const pythonBin = resolvePythonBin();
    const scriptPath = resolveInferScriptPath();

    this.startPromise = new Promise((resolve, reject) => {
      const env = { ...process.env };
      env.PYTHONUNBUFFERED = '1';
      env.QA_AUTO_HW_OCR_MAX_IMAGE_SIDE = env.QA_AUTO_HW_OCR_MAX_IMAGE_SIDE || '1280';
      env.QA_AUTO_HW_OCR_CPU_THREADS = env.QA_AUTO_HW_OCR_CPU_THREADS || '4';
      env.PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK =
        env.PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK || 'True';
      env.MPLCONFIGDIR = env.MPLCONFIGDIR || '/tmp/matplotlib-qa-auto-hw';

      // Avoid inheriting dead local proxy settings from shell/IDE.
      delete env.HTTP_PROXY;
      delete env.HTTPS_PROXY;
      delete env.ALL_PROXY;
      delete env.http_proxy;
      delete env.https_proxy;
      delete env.all_proxy;

      const child = spawn(pythonBin, [scriptPath, '--server'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });
      this.child = child;
      this.stderrBuffer = '';
      this.stdoutBuffer = '';

      const bootTimeout = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('Timed out while starting PP-OCRv5 rec daemon'));
      }, 45 * 1000);

      child.stdout.on('data', (chunk: Buffer) => {
        this.stdoutBuffer += chunk.toString();
        this.consumeStdoutLines({
          onReady: () => {
            clearTimeout(bootTimeout);
            resolve();
          },
        });
      });

      child.stderr.on('data', (chunk: Buffer) => {
        const text = chunk.toString();
        this.stderrBuffer += text;
        if (this.stderrBuffer.length > 8 * 1024) {
          this.stderrBuffer = this.stderrBuffer.slice(-8 * 1024);
        }
      });

      child.on('error', (err) => {
        clearTimeout(bootTimeout);
        this.child = null;
        reject(new Error(`Failed to start PP-OCRv5 rec daemon: ${err.message}`));
      });

      child.on('close', (code) => {
        clearTimeout(bootTimeout);
        this.child = null;
        this.startPromise = null;
        const reason = `PP-OCRv5 rec daemon exited with code ${code}. stderr: ${this.stderrBuffer.trim() || '(empty)'}`;
        this.rejectAllPending(new Error(reason));
      });
    }).finally(() => {
      this.startPromise = null;
    });

    return this.startPromise;
  }

  private consumeStdoutLines(options?: { onReady?: () => void }): void {
    let idx: number;
    while ((idx = this.stdoutBuffer.indexOf('\n')) >= 0) {
      const line = this.stdoutBuffer.slice(0, idx).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(idx + 1);
      if (!line) continue;

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }

      if (parsed.type === 'ready') {
        options?.onReady?.();
        continue;
      }

      const id = typeof parsed.id === 'number' ? parsed.id : null;
      if (!id) continue;

      const pending = this.pending.get(id);
      if (!pending) continue;
      this.pending.delete(id);
      clearTimeout(pending.timer);

      if (parsed.ok === false) {
        const errorText =
          typeof parsed.error === 'string'
            ? parsed.error
            : 'Unknown PP-OCRv5 rec daemon error';
        pending.reject(new Error(errorText));
        continue;
      }

      pending.resolve({
        text: typeof parsed.text === 'string' ? parsed.text : '',
        confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0,
        backend: 'en_PP-OCRv5_mobile_rec',
        elapsedMs: typeof parsed.elapsedMs === 'number' ? parsed.elapsedMs : 0,
      });
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

const daemon = new PaddleOcrEnDaemon();

export function stopPaddleOcrEnDaemon(): void {
  daemon.stop();
}
