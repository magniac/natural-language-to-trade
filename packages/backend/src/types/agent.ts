export type AgentWalletStatus = 'active' | 'paused' | 'disabled' | 'archived';
export type SignerProvider = 'dev' | 'kms';

export interface AgentWallet {
  id: string;
  userId: string;
  address: string;
  signerProvider: SignerProvider;
  kmsKeyId: string | null;
  status: AgentWalletStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentSigner {
  getAddress(agentWalletId: string): Promise<string>;
  signMessage(agentWalletId: string, message: Uint8Array | string): Promise<string>;
  signTypedData(agentWalletId: string, typedData: unknown): Promise<string>;
}

export interface CLOBCredentials {
  id: string;
  agentWalletId: string;
  encryptedApiKey: string;
  encryptedSecret: string;
  encryptedPassphrase: string;
  status: 'active' | 'rotated' | 'deleted';
  createdAt: Date;
  rotatedAt: Date | null;
}
