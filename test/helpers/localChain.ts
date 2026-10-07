/**
 * Local-chain helpers for tests: an anvil node started with
 * `anvil --chain-id 43113` (Fuji's chain id) and the test token from
 * contracts/test-token. Set LOCAL_RPC to enable these tests.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

export const LOCAL_RPC = process.env.LOCAL_RPC;

export const localFuji = defineChain({
  id: 43113,
  name: "local-fuji",
  nativeCurrency: { name: "AVAX", symbol: "AVAX", decimals: 18 },
  rpcUrls: { default: { http: [LOCAL_RPC ?? "http://127.0.0.1:8545"] } },
});

const artifacts = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../contracts/test-token/artifacts.json", import.meta.url)), "utf8"),
);
export const TOKEN_ABI = artifacts.TestUSDC.abi;
export const MULTICALL3_ADDRESS = "0xcA11bde05977b3631167028862bE2a173976CA11";

// Throwaway keys used only against the local node.
export const payerAccount = privateKeyToAccount(
  "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
);
export const facilitatorAccount = privateKeyToAccount(
  "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
);
export const sellerAccount = privateKeyToAccount(
  "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
);

export const publicClient = createPublicClient({ chain: localFuji, transport: http() }) as PublicClient;
export const facilitatorWallet = createWalletClient({
  account: facilitatorAccount,
  chain: localFuji,
  transport: http(),
});
export const sellerWallet = createWalletClient({ account: sellerAccount, chain: localFuji, transport: http() });

/**
 * Funds the test accounts, installs Multicall3 and deploys a fresh EIP-3009 token
 * with 1 USDC minted to the payer.
 *
 * @returns The token address.
 */
export async function deployTestToken(): Promise<Hex> {
  for (const a of [facilitatorAccount, sellerAccount]) {
    await publicClient.request({
      method: "anvil_setBalance" as never,
      params: [a.address, "0x56bc75e2d63100000"] as never,
    });
  }
  await publicClient.request({
    method: "anvil_setCode" as never,
    params: [MULTICALL3_ADDRESS, artifacts.MiniMulticall3.deployed] as never,
  });
  const hash = await facilitatorWallet.deployContract({
    abi: TOKEN_ABI,
    bytecode: artifacts.TestUSDC.bytecode as Hex,
  });
  const token = (await publicClient.waitForTransactionReceipt({ hash })).contractAddress!;
  await publicClient.waitForTransactionReceipt({
    hash: await facilitatorWallet.writeContract({
      address: token,
      abi: TOKEN_ABI,
      functionName: "mint",
      args: [payerAccount.address, 1_000_000n],
    }),
  });
  return token;
}
