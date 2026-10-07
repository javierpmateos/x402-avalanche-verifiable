/**
 * x402 facilitator for Avalanche that settles `exact` EVM payments and attaches
 * a facilitator-attestation to every successful settlement.
 */
import express from "express";
import { x402Facilitator } from "@x402/core/facilitator";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";
import { ExactEvmScheme as ExactEvmFacilitatorScheme } from "@x402/evm/exact/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { getAddress, type Account, type PublicClient, type WalletClient } from "viem";

import { FACILITATOR_ATTESTATION, evmExactFundingAccount, signAttestation } from "./attestation.js";

type SigningAccount = Account & { signTypedData: NonNullable<Account["signTypedData"]> };

export interface FacilitatorOptions {
  /** CAIP-2 network, e.g. eip155:43113. */
  network: `${string}:${string}`;
  publicClient: PublicClient;
  /** Wallet that submits settlements and pays gas. */
  walletClient: WalletClient & { account: Account };
  /** Key that signs attestations. Its address is the `facilitator` field. */
  attestationKey: SigningAccount;
  /** Fee the facilitator reports, in the asset's smallest unit. */
  feeOf?: (requirements: PaymentRequirements) => string;
}

/**
 * Settles through the reference EVM facilitator and attests the result.
 *
 * @param opts - Facilitator configuration.
 * @returns The facilitator and an attesting settle function.
 */
export function createAttestingFacilitator(opts: FacilitatorOptions) {
  const { publicClient, walletClient } = opts;
  const signer = toFacilitatorEvmSigner({
    address: walletClient.account.address,
    readContract: args => publicClient.readContract({ ...args, args: args.args || [] } as never),
    verifyTypedData: args => publicClient.verifyTypedData(args as never),
    writeContract: args =>
      walletClient.writeContract({ ...args, args: args.args || [], chain: walletClient.chain } as never),
    sendTransaction: args => walletClient.sendTransaction({ ...args, chain: walletClient.chain } as never),
    waitForTransactionReceipt: args => publicClient.waitForTransactionReceipt(args),
    getCode: args => publicClient.getCode(args),
  });
  const facilitator = new x402Facilitator().register(opts.network, new ExactEvmFacilitatorScheme(signer));

  /**
   * Settles and, on success, attaches the attestation. The payer is the
   * debited account from the authorization (spec §4.3); if it cannot be
   * determined, no attestation is emitted (§8).
   *
   * @param payload - Payment payload.
   * @param requirements - Accepted requirements.
   * @returns The settle response.
   */
  async function settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const result = await facilitator.settle(payload, requirements);
    if (!result.success) return result;
    const payer = evmExactFundingAccount(payload.payload);
    if (!payer) return result;
    try {
      const attestation = await signAttestation(opts.attestationKey, {
        version: 1,
        network: result.network,
        transaction: result.transaction.toLowerCase(),
        payer,
        payee: getAddress(requirements.payTo),
        asset: getAddress(requirements.asset),
        amount: requirements.amount,
        facilitator: opts.attestationKey.address,
        facilitatorFee: opts.feeOf?.(requirements) ?? "0",
        observedAt: String(Math.floor(Date.now() / 1000)),
      });
      return {
        ...result,
        extensions: { ...result.extensions, [FACILITATOR_ATTESTATION]: { info: { attestation } } },
      };
    } catch (error) {
      // An attestation failure never fails the settlement (§8).
      console.error("[facilitator] attestation failed:", (error as Error).message);
      return result;
    }
  }

  return { facilitator, settle };
}

/**
 * HTTP facilitator API (`/verify`, `/settle`, `/supported`) compatible with
 * `HTTPFacilitatorClient`.
 *
 * @param opts - Facilitator configuration.
 * @returns An Express app.
 */
export function createFacilitatorApp(opts: FacilitatorOptions) {
  const { facilitator, settle } = createAttestingFacilitator(opts);
  const app = express();
  app.use(express.json({ limit: "256kb" }));

  app.get("/supported", (_req, res) => {
    res.json(facilitator.getSupported());
  });
  app.post("/verify", async (req, res) => {
    try {
      const { paymentPayload, paymentRequirements } = req.body ?? {};
      res.json(await facilitator.verify(paymentPayload, paymentRequirements));
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });
  app.post("/settle", async (req, res) => {
    try {
      const { paymentPayload, paymentRequirements } = req.body ?? {};
      res.json(await settle(paymentPayload, paymentRequirements));
    } catch (error) {
      res.status(400).json({ error: (error as Error).message });
    }
  });
  return app;
}
