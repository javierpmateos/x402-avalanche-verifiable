import { describe, expect, it } from "vitest";
import { getAddress, type Hex } from "viem";

import { checkSettlement, signAttestation, type SettlementAttestationPayload } from "../src/attestation.js";
import {
  LOCAL_RPC,
  TOKEN_ABI,
  deployTestToken,
  facilitatorAccount,
  facilitatorWallet,
  payerAccount,
  publicClient,
  sellerAccount,
} from "./helpers/localChain.js";

/**
 * Settles a transferWithAuthorization from the payer to the seller.
 *
 * @param token - Token address.
 * @param value - Amount.
 * @returns The transaction hash.
 */
async function settle(token: Hex, value: bigint): Promise<Hex> {
  const nonce = ("0x" + crypto.getRandomValues(new Uint8Array(32)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "")) as Hex;
  const validBefore = BigInt(Math.floor(Date.now() / 1000) + 600);
  const signature = await payerAccount.signTypedData({
    domain: { name: "USDC", version: "2", chainId: 43113, verifyingContract: token },
    types: {
      TransferWithAuthorization: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "validAfter", type: "uint256" },
        { name: "validBefore", type: "uint256" },
        { name: "nonce", type: "bytes32" },
      ],
    },
    primaryType: "TransferWithAuthorization",
    message: { from: payerAccount.address, to: sellerAccount.address, value, validAfter: 0n, validBefore, nonce },
  });
  const hash = await facilitatorWallet.writeContract({
    address: token,
    abi: TOKEN_ABI,
    functionName: "transferWithAuthorization",
    args: [payerAccount.address, sellerAccount.address, value, 0n, validBefore, nonce, signature],
  });
  await publicClient.waitForTransactionReceipt({ hash });
  return hash;
}

describe.skipIf(!LOCAL_RPC)("§6.3 settlement check on a local chain", () => {
  it("MATCH, MISMATCH and NOT_FOUND stay distinct", async () => {
    const token = await deployTestToken();
    const tx = await settle(token, 10_000n);
    const base: SettlementAttestationPayload = {
      version: 1,
      network: "eip155:43113",
      transaction: tx,
      payer: payerAccount.address,
      payee: sellerAccount.address,
      asset: getAddress(token),
      amount: "10000",
      facilitator: facilitatorAccount.address,
      facilitatorFee: "0",
      observedAt: String(Math.floor(Date.now() / 1000)),
    };
    const sign = (p: Partial<SettlementAttestationPayload>) =>
      signAttestation(facilitatorAccount, { ...base, ...p });

    expect(await checkSettlement(publicClient, await sign({}))).toEqual({ outcome: "MATCH" });
    expect((await checkSettlement(publicClient, await sign({ amount: "9999" }))).outcome).toBe("MISMATCH");
    // The facilitator named as payer: a party to the transaction, but not the debited account.
    expect(
      (await checkSettlement(publicClient, await sign({ payer: facilitatorAccount.address }))).outcome,
    ).toBe("MISMATCH");
    expect(
      (await checkSettlement(publicClient, await sign({ transaction: "0x" + "00".repeat(32) }))).outcome,
    ).toBe("NOT_FOUND");
    expect(
      (await checkSettlement(publicClient, await sign({ network: "eip155:43114" }))).outcome,
    ).toBe("NOT_FOUND");
    expect(
      (await checkSettlement(publicClient, await sign({}), 1000)).outcome,
    ).toBe("NOT_FOUND");
  }, 60_000);
});
