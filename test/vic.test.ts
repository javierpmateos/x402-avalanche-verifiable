import { describe, expect, it } from "vitest";
import { type Hex } from "viem";

import {
  REGISTRY_ABI,
  REGISTRY_BYTECODE,
  commitInvoice,
  invoiceForSale,
  invoiceHash,
  signInvoice,
  verifyInvoiceCommitment,
} from "../src/vic.js";
import {
  LOCAL_RPC,
  TOKEN_ABI,
  deployTestToken,
  facilitatorWallet,
  payerAccount,
  publicClient,
  sellerAccount,
  sellerWallet,
} from "./helpers/localChain.js";

/**
 * Pays `value` from the payer to the seller with transferWithAuthorization,
 * submitted by the facilitator, as an x402 settlement would.
 *
 * @param token - Token.
 * @param value - Amount.
 * @returns Settlement transaction hash.
 */
async function settle(token: Hex, value: bigint): Promise<Hex> {
  const nonce = ("0x" + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("hex")) as Hex;
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

describe.skipIf(!LOCAL_RPC)("ERC-8342 Mode B on a local chain", () => {
  it("commits an x402 sale's invoice against its settlement and verifies it", async () => {
    const token = await deployTestToken();
    const deploy = await sellerWallet.deployContract({ abi: REGISTRY_ABI, bytecode: REGISTRY_BYTECODE });
    const registry = (await publicClient.waitForTransactionReceipt({ hash: deploy })).contractAddress!;
    const tx = await settle(token, 10_000n);

    const invoice = invoiceForSale({
      invoiceId: "INV-0001",
      issuer: sellerAccount.address,
      recipient: payerAccount.address,
      token,
      amount: 10_000n,
      description: "GET https://api.example.com/reports/42",
      nonce: 1n,
      issuedAt: BigInt(Math.floor(Date.now() / 1000)),
    });

    // Off-chain digest equals the registrar's own.
    const onchain = await publicClient.readContract({
      address: registry,
      abi: REGISTRY_ABI,
      functionName: "hashInvoice",
      args: [invoice],
    });
    expect(onchain).toBe(invoiceHash(invoice, 43113, registry));

    const signature = await signInvoice(sellerAccount, invoice, 43113, registry);
    // Anyone can submit; the registrar checks the issuer signature.
    const commitTx = await commitInvoice(facilitatorWallet, registry, invoice, signature, tx, "https://api.example.com/invoices/INV-0001");
    await publicClient.waitForTransactionReceipt({ hash: commitTx });

    expect(await verifyInvoiceCommitment(publicClient, registry, invoice, signature)).toMatchObject({
      valid: true,
      paymentTxRef: tx,
    });

    // An invoice for a different amount was never committed.
    expect(
      (await verifyInvoiceCommitment(publicClient, registry, { ...invoice, paymentAmount: 9_999n }, signature)).valid,
    ).toBe(false);
  }, 60_000);

  it("rejects a committed invoice whose paymentTxRef paid something else", async () => {
    const token = await deployTestToken();
    const deploy = await sellerWallet.deployContract({ abi: REGISTRY_ABI, bytecode: REGISTRY_BYTECODE });
    const registry = (await publicClient.waitForTransactionReceipt({ hash: deploy })).contractAddress!;
    const tx = await settle(token, 5_000n); // paid 5000, invoice claims 10000

    const invoice = invoiceForSale({
      invoiceId: "INV-0002",
      issuer: sellerAccount.address,
      recipient: payerAccount.address,
      token,
      amount: 10_000n,
      description: "GET https://api.example.com/reports/43",
      nonce: 2n,
      issuedAt: BigInt(Math.floor(Date.now() / 1000)),
    });
    const signature = await signInvoice(sellerAccount, invoice, 43113, registry);
    await publicClient.waitForTransactionReceipt({
      hash: await commitInvoice(sellerWallet, registry, invoice, signature, tx, ""),
    });
    // The registrar accepted it (it does not check payments); the verifier must not.
    expect(await verifyInvoiceCommitment(publicClient, registry, invoice, signature)).toMatchObject({
      valid: false,
      reason: "paymentTxRef did not pay paymentAmount from recipient to issuer",
    });
  }, 60_000);
});
