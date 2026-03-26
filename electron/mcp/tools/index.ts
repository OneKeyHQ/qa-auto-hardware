/**
 * MCP Tools registration module.
 * Exports all tool schemas and executors for the MCP server.
 */

export { armConnectSchema, executeArmConnect } from './armConnect';
export type { ArmConnectInput, ArmConnectOutput } from './armConnect';

export { armDisconnectSchema, executeArmDisconnect } from './armDisconnect';
export type { ArmDisconnectInput, ArmDisconnectOutput } from './armDisconnect';

export { armMoveSchema, executeArmMove } from './armMove';
export type { ArmMoveInput, ArmMoveOutput } from './armMove';

export { armClickSchema, executeArmClick } from './armClick';
export type { ArmClickInput, ArmClickOutput } from './armClick';

export { captureFrameSchema, executeCaptureFrame } from './captureFrame';
export type { CaptureFrameInput, CaptureFrameOutput } from './captureFrame';

// New automation tools
export { executeSequenceSchema, executeExecuteSequence } from './executeSequence';
export type { ExecuteSequenceInput, ExecuteSequenceOutput } from './executeSequence';

export { confirmActionSchema, executeConfirmAction } from './confirmAction';
export type { ConfirmActionInput, ConfirmActionOutput } from './confirmAction';

export { confirmActionSequenceSchema, executeConfirmActionSequence } from './confirmActionSequence';
export type {
  ConfirmActionSequenceInput,
  ConfirmActionSequenceOutput,
} from './confirmActionSequence';

export { executeAutomationPresetSchema, executeAutomationPreset } from './executeAutomationPreset';
export type {
  ExecuteAutomationPresetInput,
  ExecuteAutomationPresetOutput,
} from './executeAutomationPreset';

export { inputPinSchema, executeInputPin } from './inputPin';
export type { InputPinInput, InputPinOutput } from './inputPin';

export { stopSequenceSchema, executeStopSequence } from './stopSequence';
export type { StopSequenceInput, StopSequenceOutput } from './stopSequence';

// Mnemonic tools
export { mnemonicStoreSchema, executeMnemonicStore } from './mnemonicStore';
export type { MnemonicStoreInput, MnemonicStoreOutput } from './mnemonicStore';

export { mnemonicVerifySchema, executeMnemonicVerify } from './mnemonicVerify';
export type { MnemonicVerifyInput, MnemonicVerifyOutput } from './mnemonicVerify';
