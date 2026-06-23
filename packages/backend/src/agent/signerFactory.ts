import type { AgentSigner } from '../types/agent';
import { DevSigner } from './devSigner';
import { logger } from '../utils/logger';

let instance: AgentSigner | null = null;

export function getSigner(): AgentSigner {
  if (instance) return instance;

  const mode = process.env.SIGNER_MODE ?? 'dev';

  if (mode === 'dev') {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('DevSigner cannot be used in production. Set SIGNER_MODE=kms and configure KMS.');
    }
    logger.warn('Using DevSigner — for development only. Never use in production.');
    instance = new DevSigner();
    return instance;
  }

  if (mode === 'kms') {
    // KMS signer stub — implement with AWS KMS, GCP KMS, or MPC provider
    throw new Error('KMS signer not yet implemented. Implement ProductionKmsSigner and register it here.');
  }

  throw new Error(`Unknown SIGNER_MODE: ${mode}`);
}
