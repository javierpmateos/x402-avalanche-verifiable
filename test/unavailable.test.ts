import { describe, expect, it } from "vitest";
import { createPublicClient, custom, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";

import { checkSettlement, signAttestation } from "../src/attestation.js";
import { invoiceForSale, signInvoice, verifyInvoiceCommitment } from "../src/vic.js";

// Throwaway keys for offline signing; never funded, never used on a network.
const facilitator = privateKeyToAccount(`0x${"11".repeat(32)}`);
const seller = privateKeyToAccount(`0x${"22".repeat(32)}`);
const payer = privateKeyToAccount(`0x${"33".repeat(32)}`);
const TOKEN = "0x5425890298aed601595a70AB815c96711a31Bc65" as Hex;
const REGISTRY = "0xa8C5b7D5B413297343ca6CeCe3931F9770D7A2FD" as Hex;
const TX = `0x${"ab".repeat(32)}` as Hex;

/**
 * A client on Fuji whose RPC answers eth_chainId and fails every other call
 * named in `failing`, the way an unreachable or erroring node would.
 *
 * @param failing - Methods that throw.
 * @param receipt - Result for eth_getTransactionReceipt when it does not fail.
 * @returns The client.
 */
function client(failing: string[], receipt: unknown = null): PublicClient {
  return createPublicClient({
    transport: custom(
      {
        async request({ method }: { method: string }) {
          if (failing.includes(method)) throw new Error(`upstream timeout on ${method}`);
          if (method === "eth_chainId") return "0xa869"; // 43113
          if (method === "eth_getTransactionReceipt") return receipt;
          if (method === "eth_blockNumber") return "0x10";
          if (method === "eth_call") return `0x${"00".repeat(96)}`;
          throw new Error(`unexpected ${method}`);
        },
      },
      { retryCount: 0 },
    ),
  }) as PublicClient;
}

/**
 * A signed attestation for TX on Fuji.
 *
 * @returns The attestation.
 */
function attestation() {
  return signAttestation(facilitator, {
    version: 1,
    network: "eip155:43113",
    transaction: TX,
    payer: payer.address,
    payee: seller.address,
    asset: TOKEN,
    amount: "10000",
    facilitator: facilitator.address,
    facilitatorFee: "0",
    observedAt: "1700000000",
  });
}

describe("§6.3 UNAVAILABLE: a lookup that cannot complete is not a finding", () => {
  it("reports a failing chainId or receipt lookup as UNAVAILABLE, never NOT_FOUND", async () => {
    const a = await attestation();
    for (const method of ["eth_chainId", "eth_getTransactionReceipt"]) {
      const result = await checkSettlement(client([method]), a);
      expect(result.outcome, method).toBe("UNAVAILABLE");
    }
  });

  it("still reports a receipt the node does not have as NOT_FOUND", async () => {
    const result = await checkSettlement(client([]), await attestation());
    expect(result).toEqual({ outcome: "NOT_FOUND", detail: "no receipt for transaction" });
  });

  it("reports a client on another network as UNAVAILABLE", async () => {
    const a = await signAttestation(facilitator, { ...(await attestation()).payload, network: "eip155:43114" });
    expect((await checkSettlement(client([]), a)).outcome).toBe("UNAVAILABLE");
  });
});

describe("ERC-8342 invoice check: a failed chain read is not an invalid invoice", () => {
  /**
   * An invoice for TX, signed by the seller.
   *
   * @returns The invoice and its signature.
   */
  async function signed() {
    const invoice = invoiceForSale({
      invoiceId: "INV-1",
      issuer: seller.address,
      recipient: payer.address,
      token: TOKEN,
      amount: 10_000n,
      description: "GET https://seller.example/api/data",
      nonce: 1n,
      issuedAt: 1_700_000_000n,
    });
    return { invoice, signature: await signInvoice(seller, invoice, 43113, REGISTRY) };
  }

  it("marks a failing registry read as unavailable", async () => {
    const { invoice, signature } = await signed();
    const result = await verifyInvoiceCommitment(client(["eth_call"]), REGISTRY, invoice, signature);
    expect(result).toMatchObject({ valid: false, unavailable: true });
  });

  it("marks a failing chainId read as unavailable", async () => {
    const { invoice, signature } = await signed();
    const result = await verifyInvoiceCommitment(client(["eth_chainId"]), REGISTRY, invoice, signature);
    expect(result).toMatchObject({ valid: false, unavailable: true });
  });

  it("keeps an uncommitted invoice a real failure, not unavailable", async () => {
    const { invoice, signature } = await signed();
    const result = await verifyInvoiceCommitment(client([]), REGISTRY, invoice, signature);
    expect(result).toEqual({ valid: false, reason: "invoice is not committed" });
  });
});
