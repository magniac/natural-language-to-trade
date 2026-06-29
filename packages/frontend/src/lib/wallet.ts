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

/**
 * A FRESH BrowserProvider bound to the current injected wallet. The app trades on multiple chains
 * (Polygon for Polymarket, Arbitrum for Hyperliquid); a long-lived cached provider throws
 * `network changed (NETWORK_ERROR)` when MetaMask switches chains under it. Always build a fresh
 * provider for each on-chain operation so it reflects the current network.
 */
export function freshProvider(): ethers.BrowserProvider {
  if (!window.ethereum) throw new Error('No wallet found. Install MetaMask or another Web3 wallet.');
  return new ethers.BrowserProvider(window.ethereum as ethers.Eip1193Provider);
}

/** Switch the injected wallet to the given chain (hex id, e.g. '0x89' Polygon, '0xa4b1' Arbitrum)
 *  and return a fresh provider already on that chain. */
export async function providerForChain(chainIdHex: string): Promise<ethers.BrowserProvider> {
  const eth = window.ethereum as ethers.Eip1193Provider | undefined;
  if (!eth) throw new Error('No wallet found. Install MetaMask or another Web3 wallet.');
  await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: chainIdHex }] });
  return new ethers.BrowserProvider(eth);
}

export async function signPolicyEIP712(
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
  // Fresh signer — the policy signature (EIP-712 over name/version only) is chain-agnostic, but a
  // cached provider left on another chain (e.g. after a Hyperliquid/Arbitrum action) would throw.
  const signer = await freshProvider().getSigner();
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
