import type { PublicClient } from "viem";
import { parseEventLogs } from "viem";

import {
  verifyAttestationSignature,
  checkSettlement,
} from "./attestation.js";

import {
  verifyInvoiceCommitment,
  type Invoice,
} from "./vic.js";

import {
  buildHttpBinding,
  requestDigest,
  deriveRequestNonce,
} from "./requestCommitment/binding.js";

const BIGINT_FIELDS = new Set([
  "issueDate",
  "dueDate",
  "paymentAmount",
  "fiatAmountMilliUnits",
  "fxRateScaled",
  "fxTimestamp",
  "nonce",
  "rateBps",
  "baseAmountMilliUnits",
  "taxAmountMilliUnits",
  "quantityScaled",
  "unitPriceMilliUnits",
  "lineTotalMilliUnits",
  "taxRefIndex",
]);

function reviveInvoiceBigInts(
  value: unknown,
  key?: string,
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) =>
      reviveInvoiceBigInts(item, key),
    );
  }

  if (
    value !== null &&
    typeof value === "object"
  ) {
    const result: Record<string, unknown> = {};

    for (const [childKey, childValue] of Object.entries(
      value as Record<string, unknown>,
    )) {
      result[childKey] =
        reviveInvoiceBigInts(
          childValue,
          childKey,
        );
    }

    return result;
  }

  if (
    typeof value === "string" &&
    key &&
    BIGINT_FIELDS.has(key) &&
    /^\d+$/.test(value)
  ) {
    return BigInt(value);
  }

  return value;
}

const authorizationUsedAbi = [
  {
    type: "event",
    name: "AuthorizationUsed",
    inputs: [
      {
        indexed: true,
        name: "authorizer",
        type: "address",
      },
      {
        indexed: true,
        name: "nonce",
        type: "bytes32",
      },
    ],
  },
] as const;

export interface VerifyPaidRequestInput {
  publicClient: PublicClient;
  registry: `0x${string}`;
  attestation: any;
  invoice: unknown;
  invoiceSignature: `0x${string}`;
  request: {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  headers: string[];
  salt: string;
  authorizedSigner?: `0x${string}`;
  expectedFacilitator: `0x${string}`;
  minConfirmations?: number;
}

export interface VerifyPaidRequestResult {
  valid: true;
  payer: `0x${string}`;
  payee: `0x${string}`;
  transaction: `0x${string}`;
  requestNonce: string;
}

export async function verifyPaidRequest(
  input: VerifyPaidRequestInput,
): Promise<VerifyPaidRequestResult> {
  /* 1. Attestation signature */
  const attestationResult =
    await verifyAttestationSignature(
      input.attestation,
      input.authorizedSigner,
    );

  if (!attestationResult.valid) {
    throw new Error(
      "invalid_attestation_signature",
    );
  }

  const payload = input.attestation.payload;

  if (
    payload.facilitator.toLowerCase() !==
    input.expectedFacilitator.toLowerCase()
  ) {
    throw new Error("unexpected_facilitator");
  }

  const payer =
    payload.payer as `0x${string}`;

  const payee =
    payload.payee as `0x${string}`;

  const transaction =
    payload.transaction as `0x${string}`;

  const amount = String(payload.amount);
  const asset = String(payload.asset).toLowerCase();

  /* 2. Settlement */
  const settlement = await checkSettlement(
    input.publicClient,
    input.attestation,
    input.minConfirmations,
  );

  if (settlement.outcome !== "MATCH") {
    throw new Error(
      settlement.outcome === "NOT_FOUND"
        ? "settlement_not_found"
        : "settlement_mismatch",
    );
  }

  /* 3. VIC invoice */
  const revivedInvoice = reviveInvoiceBigInts(
    input.invoice,
  );

  const invoice = revivedInvoice as Invoice;

  const invoiceResult =
    await verifyInvoiceCommitment(
      input.publicClient,
      input.registry,
      invoice,
      input.invoiceSignature,
    );

  if (!invoiceResult.valid) {
    throw new Error(
      "invalid_invoice_commitment",
    );
  }

  if (
    invoiceResult.paymentTxRef.toLowerCase() !==
    transaction.toLowerCase()
  ) {
    throw new Error(
      "invoice_payment_tx_mismatch",
    );
  }

  if (
    invoice.issuer.toLowerCase() !==
    payee.toLowerCase()
  ) {
    throw new Error(
      "invoice_issuer_mismatch",
    );
  }

  if (
    invoice.recipient.toLowerCase() !==
    payer.toLowerCase()
  ) {
    throw new Error(
      "invoice_recipient_mismatch",
    );
  }

  if (
    invoice.paymentAmount.toString() !==
    amount
  ) {
    throw new Error(
      "invoice_amount_mismatch",
    );
  }

  if (
    invoice.paymentToken.toLowerCase() !==
    asset
  ) {
    throw new Error(
      "invoice_token_mismatch",
    );
  }

  /* 4. Request nonce */
  if (
    !/^[0-9a-f]{64}$/.test(input.salt)
  ) {
    throw new Error(
      "invalid_request_commitment_salt",
    );
  }

  const normalizedHeaders =
    Object.fromEntries(
      Object.entries(input.request.headers).map(
        ([key, value]) => [
          key.toLowerCase(),
          value,
        ],
      ),
    );

  const binding = buildHttpBinding(
    {
      method: input.request.method,
      url: input.request.url,
      headers: normalizedHeaders,
    },
    input.headers,
  );

  const digest = requestDigest(binding);

  const expectedRequestNonce =
    deriveRequestNonce(
      digest,
      input.salt,
    );

  /* 5. AuthorizationUsed nonce */
  const receipt =
    await input.publicClient.getTransactionReceipt({
      hash: transaction,
    });

  const logs = parseEventLogs({
    abi: authorizationUsedAbi,
    logs: receipt.logs,
    eventName: "AuthorizationUsed",
  });

  const authorizationUsed = logs.find(
    (log) =>
      log.args.authorizer.toLowerCase() ===
      payer.toLowerCase(),
  );

  if (!authorizationUsed) {
    throw new Error(
      "authorization_used_event_not_found",
    );
  }

  const expectedNonceWithPrefix =
    `0x${expectedRequestNonce}`;

  if (
    authorizationUsed.args.nonce.toLowerCase() !==
    expectedNonceWithPrefix
  ) {
    throw new Error(
      "request_nonce_mismatch",
    );
  }

  return {
    valid: true,
    payer,
    payee,
    transaction,
    requestNonce: expectedRequestNonce,
  };
}
