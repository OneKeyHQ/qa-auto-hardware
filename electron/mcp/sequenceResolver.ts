import fs from 'fs';
import path from 'path';
import {
  generateSlip39ShareSteps,
  generateWordSteps,
  getPageAction,
  getSequence,
  pickRandomShares,
  type AutoSequence,
  type AutoStep,
  type MnemonicSource,
  type PageAction,
} from './sequences';

interface MnemonicsData {
  bip39: Record<string, string>;
  slip39: Record<string, string>;
}

function loadMnemonics(): MnemonicsData {
  const candidates = [
    path.join(process.cwd(), 'mnemonics.local.json'),
    path.join(__dirname, '..', '..', 'mnemonics.local.json'),
  ];

  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(raw) as MnemonicsData;
      } catch (err) {
        console.error(`[mnemonics] Failed to parse ${filePath}:`, err);
      }
    }
  }

  console.warn(
    '[mnemonics] mnemonics.local.json not found. Import-wallet sequences will use placeholder words.\n' +
    '  Copy mnemonics.example.json → mnemonics.local.json and fill in your test mnemonics.'
  );
  return { bip39: {}, slip39: {} };
}

const MNEMONICS = loadMnemonics();

function getMnemonicWords(section: 'bip39' | 'slip39', key: string): string[] {
  const phrase = MNEMONICS[section]?.[key] ?? '';
  return phrase ? phrase.split(' ') : [];
}

function resolveMnemonicSource(source: MnemonicSource): AutoStep[] {
  const shares = source.keys.map((key) => getMnemonicWords(source.section, key));

  switch (source.mode) {
    case 'single':
      return generateWordSteps(shares[0] ?? []);
    case 'shares-all':
      return generateSlip39ShareSteps(shares);
    case 'shares-random':
      return generateSlip39ShareSteps(pickRandomShares(shares, source.pickCount ?? 1));
    default:
      return [];
  }
}

export function resolvePageActionSteps(action: PageAction): AutoStep[] {
  if (action.mnemonicSource) {
    return resolveMnemonicSource(action.mnemonicSource);
  }
  if (action.buildSteps) {
    return action.buildSteps();
  }
  return action.steps;
}

export function resolveSequenceSteps(sequence: AutoSequence): AutoStep[] {
  const steps: AutoStep[] = [];

  for (const actionId of sequence.actions) {
    const action = getPageAction(actionId);
    if (!action) {
      console.warn(`[sequence-resolver] Unknown page action ID: ${actionId}`);
      continue;
    }
    steps.push(...resolvePageActionSteps(action));
  }

  return steps;
}

export function resolveSequenceStepsById(sequenceId: string): AutoStep[] {
  const sequence = getSequence(sequenceId);
  if (!sequence) {
    throw new Error(`Unknown sequence ID: ${sequenceId}`);
  }
  return resolveSequenceSteps(sequence);
}
