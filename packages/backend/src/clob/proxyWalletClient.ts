import { ethers } from 'ethers';
import {
  RelayClient,
  RelayerTxType,
  deriveProxyWallet,
  deriveSafe,
} from '@polymarket/builder-relayer-client';
import { getContractConfig } from '@polymarket/builder-relayer-client/dist/config';
import { BuilderConfig } from '@polymarket/builder-signing-sdk';
import { createWalletClient, http, type Hex } from 'viem';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { polygon } from 'viem/chains';

const POLYGON_CHAIN_ID = 137;
const DEFAULT_RELAYER_URL = 'https://relayer-v2.polymarket.com/';
const PUSD_TRANSFER_INTERFACE = new ethers.Interface([
  'function transfer(address to, uint256 amount) returns (bool)',
]);
const PUSD_APPROVE_INTERFACE = new ethers.Interface([
  'function approve(address spender, uint256 amount) returns (bool)',
]);
const CTF_SET_APPROVAL_INTERFACE = new ethers.Interface([
  'function setApprovalForAll(address operator, bool approved)',
]);

export interface RelayerApiCreds {
  apiKey: string;
  apiKeyAddress: string;
}

/** Build a RelayClient for the given signer account and relayer authorization. */
function makeRelayClient(
  account: PrivateKeyAccount,
  relayerCreds: RelayerApiCreds | null | undefined,
  txType: RelayerTxType,
): RelayClient {
  const rpcUrl = process.env.POLYGON_RPC_URL ?? 'https://polygon-bor-rpc.publicnode.com';
  const walletClient = createWalletClient({ account, chain: polygon, transport: http(rpcUrl) });
  return new RelayClient(
    process.env.POLYMARKET_RELAYER_URL ?? DEFAULT_RELAYER_URL,
    POLYGON_CHAIN_ID,
    // The relayer package can resolve a second compatible viem minor in this workspace.
    // Both implement WalletClient; avoid leaking their nominal type mismatch here.
    walletClient as never,
    getRelayerAuthorization(relayerCreds),
    txType,
  );
}

export interface ProvisionResult {
  depositWalletAddress: string;
  created: boolean;
  transactionHash: string | null;
}

/**
 * Provision the agent's Polymarket deposit wallet *through the relayer* so it is
 * registered to the relayer API key. This is what makes autonomous withdrawals work:
 * a deposit wallet only accepts relayer-submitted batches if it was created via the
 * relayer (WALLET-CREATE) under the same API key — being deployed on-chain is not enough.
 */
export async function provisionDepositWallet(
  privateKey: string,
  relayerCreds: RelayerApiCreds | null | undefined,
): Promise<ProvisionResult> {
  const account = privateKeyToAccount(privateKey as Hex);
  const relayer = makeRelayClient(account, relayerCreds, RelayerTxType.PROXY);

  // Canonical (UUPS/beacon-aware) deposit wallet address for this signer.
  const depositWalletAddress = await relayer.deriveDepositWalletAddress();

  if (await relayer.getDeployed(depositWalletAddress, 'WALLET')) {
    return { depositWalletAddress, created: false, transactionHash: null };
  }

  const deployment = await relayer.deployDepositWallet();
  const deployed = await deployment.wait();
  if (!deployed?.transactionHash) {
    throw new Error('Polymarket relayer did not create the deposit wallet');
  }
  return { depositWalletAddress, created: true, transactionHash: deployed.transactionHash };
}

export interface ApproveResult {
  transactionHash: string;
  depositWalletAddress: string;
}

/**
 * Authorize the deposit wallet to trade, executed *by the deposit wallet* through the relayer
 * (gasless), in a single batch:
 *  - ERC-20 `approve` of the collateral (pUSD) to each operator — needed to BUY (exchange pulls collateral).
 *  - ERC-1155 `setApprovalForAll` on the ConditionalTokens to each operator — needed to SELL (exchange moves outcome tokens).
 */
export async function authorizeDepositWalletForTrading({
  privateKey,
  relayerCreds,
  collateral,
  conditionalTokens,
  operators,
}: {
  privateKey: string;
  relayerCreds?: RelayerApiCreds | null;
  collateral: string;
  conditionalTokens: string;
  operators: string[];
}): Promise<ApproveResult> {
  const account = privateKeyToAccount(privateKey as Hex);
  const relayer = makeRelayClient(account, relayerCreds, RelayerTxType.PROXY);
  const depositWalletAddress = await relayer.deriveDepositWalletAddress();

  if (!(await relayer.getDeployed(depositWalletAddress, 'WALLET'))) {
    throw new Error('Deposit wallet is not provisioned yet — provision it first.');
  }

  const calls = [
    // BUY: collateral allowance to each operator
    ...operators.map((operator) => ({
      target: collateral,
      data: PUSD_APPROVE_INTERFACE.encodeFunctionData('approve', [operator, ethers.MaxUint256]),
      value: '0',
    })),
    // SELL: outcome-token (ERC-1155) operator approval to each operator
    ...operators.map((operator) => ({
      target: conditionalTokens,
      data: CTF_SET_APPROVAL_INTERFACE.encodeFunctionData('setApprovalForAll', [operator, true]),
      value: '0',
    })),
  ];

  const response = await relayer.executeDepositWalletBatch(
    calls,
    depositWalletAddress,
    String(Math.floor(Date.now() / 1000) + 600),
  );
  const result = await response.wait();
  if (!result?.transactionHash) {
    throw new Error('Polymarket relayer did not confirm the authorization');
  }
  return { transactionHash: result.transactionHash, depositWalletAddress };
}

interface WithdrawProxyPusdParams {
  privateKey: string;
  proxyWalletAddress: string;
  recipient: string;
  tokenAddress: string;
  amount: bigint;
  /** Per-agent relayer authorization. Falls back to env vars when omitted. */
  relayerCreds?: RelayerApiCreds | null;
}

export interface ProxyWithdrawalResult {
  transactionHash: string;
  proxyWalletAddress: string;
  walletType: 'deposit' | 'proxy' | 'safe';
}

function getRelayerAuthorization(relayerCreds?: RelayerApiCreds | null): BuilderConfig {
  const key = process.env.POLY_BUILDER_API_KEY;
  const secret = process.env.POLY_BUILDER_SECRET;
  const passphrase = process.env.POLY_BUILDER_PASSPHRASE;
  // Per-agent creds take precedence over env vars.
  const relayerApiKey = relayerCreds?.apiKey ?? process.env.RELAYER_API_KEY;
  const relayerApiKeyAddress = relayerCreds?.apiKeyAddress ?? process.env.RELAYER_API_KEY_ADDRESS;

  if (relayerApiKey || relayerApiKeyAddress) {
    if (!relayerApiKey || !relayerApiKeyAddress) {
      throw new Error('Set both RELAYER_API_KEY and RELAYER_API_KEY_ADDRESS');
    }
    if (!ethers.isAddress(relayerApiKeyAddress)) {
      throw new Error('RELAYER_API_KEY_ADDRESS must be a valid address');
    }

    // RelayClient only needs this two-method authorization contract. Relayer API
    // keys use static headers rather than Builder HMAC headers.
    return {
      isValid: () => true,
      generateBuilderHeaders: async () => ({
        RELAYER_API_KEY: relayerApiKey,
        RELAYER_API_KEY_ADDRESS: relayerApiKeyAddress,
      }),
    } as unknown as BuilderConfig;
  }

  if (key || secret || passphrase) {
    if (!key || !secret || !passphrase) {
      throw new Error(
        'Builder attribution is partially configured; set all three POLY_BUILDER credentials',
      );
    }
    return new BuilderConfig({
      localBuilderCreds: { key, secret, passphrase },
    });
  }

  throw new Error(
    'Polymarket requires relayer authorization: configure RELAYER_API_KEY and RELAYER_API_KEY_ADDRESS, or all three POLY_BUILDER credentials',
  );
}

export async function withdrawPusdFromProxy({
  privateKey,
  proxyWalletAddress,
  recipient,
  tokenAddress,
  amount,
  relayerCreds,
}: WithdrawProxyPusdParams): Promise<ProxyWithdrawalResult> {
  const account = privateKeyToAccount(privateKey as Hex);
  const relayerContracts = getContractConfig(POLYGON_CHAIN_ID);
  const expectedProxy = deriveProxyWallet(account.address, relayerContracts.ProxyContracts.ProxyFactory);
  const expectedSafe = deriveSafe(account.address, relayerContracts.SafeContracts.SafeFactory);

  // The deposit wallet is resolved via the relayer's own canonical (UUPS/beacon-aware)
  // derivation — the same address provisioning registered — rather than a static derive.
  const detectClient = makeRelayClient(account, relayerCreds, RelayerTxType.PROXY);
  const expectedDeposit = await detectClient.deriveDepositWalletAddress();

  const storedWallet = proxyWalletAddress.toLowerCase();
  const walletType = storedWallet === expectedDeposit.toLowerCase()
    ? 'deposit'
    : storedWallet === expectedProxy.toLowerCase()
      ? 'proxy'
      : storedWallet === expectedSafe.toLowerCase()
        ? 'safe'
        : null;

  if (!walletType) {
    throw new Error('Stored Polymarket wallet is not controlled by the agent signer');
  }

  const relayer = walletType === 'safe'
    ? makeRelayClient(account, relayerCreds, RelayerTxType.SAFE)
    : detectClient;

  const transferData = PUSD_TRANSFER_INTERFACE.encodeFunctionData('transfer', [recipient, amount]);
  const transfer = { to: tokenAddress, data: transferData, value: '0' };

  if (walletType === 'deposit' && !(await relayer.getDeployed(proxyWalletAddress, 'WALLET'))) {
    const deployment = await relayer.deployDepositWallet();
    const deployed = await deployment.wait();
    if (!deployed?.transactionHash) {
      throw new Error('Polymarket relayer did not deploy the deposit wallet');
    }
  } else if (walletType === 'safe' && !(await relayer.getDeployed(proxyWalletAddress))) {
    const deployment = await relayer.deploy();
    const deployed = await deployment.wait();
    if (!deployed?.transactionHash) {
      throw new Error('Polymarket relayer did not deploy the Safe wallet');
    }
  }

  const response = walletType === 'deposit'
    ? await relayer.executeDepositWalletBatch(
      [{ target: transfer.to, data: transfer.data, value: transfer.value }],
      proxyWalletAddress,
      String(Math.floor(Date.now() / 1000) + 600),
    )
    : await relayer.execute([transfer], 'Withdraw pUSD to the connected wallet');
  const result = await response.wait();

  if (!result?.transactionHash) {
    throw new Error('Polymarket relayer did not confirm the proxy withdrawal');
  }

  return {
    transactionHash: result.transactionHash,
    proxyWalletAddress,
    walletType,
  };
}
