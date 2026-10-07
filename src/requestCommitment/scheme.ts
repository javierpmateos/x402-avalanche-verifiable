/**
 * Client scheme for `exact` on EVM with `evm-request-commitment`, usable with
 * the published @x402/evm (which does not accept a caller-chosen nonce yet).
 *
 * When the 402 declares the extension, the EIP-3009 authorization is signed
 * with the nonce derived from the request; otherwise the stock scheme is used.
 * Only the `eip3009` transfer method is supported here.
 */
import type {
  PaymentPayloadContext,
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeNetworkClient,
} from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { getAddress, type Account, type Hex } from "viem";

import { formatNonce } from "./binding.js";
import {
  requestCommitmentPayloadExtension,
  resolveClientRequestCommitment,
  type RequestCommitmentClientOptions,
} from "./client.js";

type SigningAccount = Account & { signTypedData: NonNullable<Account["signTypedData"]> };

const AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

/** `exact` EVM client that binds payments to the request when asked to. */
export class RequestBoundExactEvmScheme implements SchemeNetworkClient {
  readonly scheme = "exact";
  private readonly fallback: ExactEvmScheme;

  /**
   * @param account - Payer key.
   * @param commitment - Request provider and optional salt source.
   */
  constructor(
    private readonly account: SigningAccount,
    private readonly commitment: RequestCommitmentClientOptions,
  ) {
    this.fallback = new ExactEvmScheme(account as never);
  }

  /**
   * @param x402Version - Protocol version.
   * @param req - Selected requirements.
   * @param context - Server-declared extensions.
   * @returns The payment payload.
   */
  async createPaymentPayload(
    x402Version: number,
    req: PaymentRequirements,
    context?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult> {
    const resolved = await resolveClientRequestCommitment(context?.extensions, this.commitment);
    if (!resolved) return this.fallback.createPaymentPayload(x402Version, req, context);

    const method = (req.extra?.assetTransferMethod as string | undefined) ?? "eip3009";
    if (method !== "eip3009") throw new Error(`request commitment demo supports eip3009 only, got ${method}`);
    const name = req.extra?.name as string | undefined;
    const version = req.extra?.version as string | undefined;
    if (!name || !version) throw new Error("EIP-712 domain name and version are required in extra");

    const chainId = Number(req.network.split(":")[1]);
    const authorization = {
      from: this.account.address,
      to: getAddress(req.payTo),
      value: req.amount,
      validAfter: "0",
      validBefore: String(Math.floor(Date.now() / 1000) + req.maxTimeoutSeconds),
      nonce: formatNonce(resolved.nonce, "eip3009") as Hex,
    };
    const signature = await this.account.signTypedData({
      domain: { name, version, chainId, verifyingContract: getAddress(req.asset) },
      types: AUTHORIZATION_TYPES,
      primaryType: "TransferWithAuthorization",
      message: {
        from: authorization.from,
        to: authorization.to,
        value: BigInt(authorization.value),
        validAfter: 0n,
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
    });
    return {
      x402Version,
      payload: { authorization, signature },
      extensions: requestCommitmentPayloadExtension(resolved),
    };
  }
}
