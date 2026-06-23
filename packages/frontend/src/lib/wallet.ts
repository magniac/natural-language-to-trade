import { ethers } from 'ethers';

export type WalletState =
  | { status: 'disconnected' }
  | { status: 'connecting' }
  | { status: 'connected'; address: string; provider: ethers.BrowserProvider };

export async function connectWallet(): Promise<{ address: string; provider: ethers.BrowserProvider }> {
  if (!window.ethereum) throw new Error('No wallet found. Install MetaMask or another Web3 wallet.');
  const provider = new ethers.BrowserProvider(window.ethereum as ethers.Eip1193Provider);
  const accounts = await provider.send('eth_requestAccounts', []);
  const address = ethers.getAddress(accounts[0]);
  return { address, provider };
}

export async function signPolicyEIP712(
  provider: ethers.BrowserProvider,
  policy: {
    version: string;
    userWallet: string;
    agentWallet: string;
    sessionKey: string;
    createdAt: number;
    expiresAt: number;
    revocationNonce: string;
    policyHash: string;
  }
): Promise<string> {
  const signer = await provider.getSigner();
  const domain = { name: 'PolymarketAgentPolicy', version: '1' };
  const types = {
    AgentPolicy: [
      { name: 'version', type: 'string' },
      { name: 'userWallet', type: 'address' },
      { name: 'agentWallet', type: 'address' },
      { name: 'sessionKey', type: 'address' },
      { name: 'createdAt', type: 'uint256' },
      { name: 'expiresAt', type: 'uint256' },
      { name: 'revocationNonce', type: 'string' },
      { name: 'policyHash', type: 'bytes32' },
    ],
  };
  return signer.signTypedData(domain, types, policy);
}

// Augment window type for ethereum
declare global {
  interface Window {
    ethereum?: unknown;
  }
}
