/**
 * facilitator-attestation (x402 extension draft, revision 2, PR #2339).
 *
 * A facilitator-signed statement attributing a settlement to a payer, payee,
 * asset and amount. It does not by itself establish that the settlement
 * happened: consumers run the settlement check (`checkSettlement`) or hold
 * independent evidence (spec §2.1).
 */
import {
  getAddress,
  isAddress,
  parseEventLogs,
  recoverTypedDataAddress,
  type Account,
  type Hex,
  type PublicClient,
} from "viem";

export const FACILITATOR_ATTESTATION = "facilitator-attestation";

/** §3.2: shared with offer-and-receipt receipts; chainId fixed to 1. */
export const ATTESTATION_DOMAIN = { name: "x402 receipt", version: "1", chainId: 1n } as const;

/** §4.6: normative EIP-712 types. Never sent on the wire. */
export const ATTESTATION_TYPES = {
  SettlementAttestation: [
    { name: "version", type: "uint256" },
    { name: "network", type: "string" },
    { name: "transaction", type: "string" },
    { name: "payer", type: "string" },
    { name: "payee", type: "string" },
    { name: "asset", type: "string" },
    { name: "amount", type: "uint256" },
    { name: "facilitator", type: "string" },
    { name: "facilitatorFee", type: "uint256" },
    { name: "observedAt", type: "uint256" },
  ],
} as const;

/** §4.1: JSON payload. uint256 fields other than `version` are decimal strings. */
export interface SettlementAttestationPayload {
  version: 1;
  network: string;
  transaction: string;
  payer: string;
  payee: string;
  asset: string;
  amount: string;
  facilitator: string;
  facilitatorFee: string;
  observedAt: string;
}

/** §3.1 */
export interface SettlementAttestation {
  format: "eip712";
  payload: SettlementAttestationPayload;
  signature: Hex;
}

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const CAIP2 = /^[-a-z0-9]{3,8}:[-_a-zA-Z0-9]{1,32}$/;
const TX_HASH = /^0x[0-9a-f]{64}$/;

/**
 * Typed-data message for a payload.
 *
 * @param p - Attestation payload.
 * @returns The EIP-712 message with uint256 fields as bigint.
 */
function message(p: SettlementAttestationPayload) {
  return {
    version: BigInt(p.version),
    network: p.network,
    transaction: p.transaction,
    payer: p.payer,
    payee: p.payee,
    asset: p.asset,
    amount: BigInt(p.amount),
    facilitator: p.facilitator,
    facilitatorFee: BigInt(p.facilitatorFee),
    observedAt: BigInt(p.observedAt),
  };
}

/**
 * Field validation, §6.1. EVM networks additionally require checksummed
 * addresses and a lowercase 0x-prefixed 32-byte transaction hash (§4.5).
 *
 * @param a - Candidate attestation.
 * @returns The list of problems; empty when valid.
 */
export function validateAttestation(a: unknown): string[] {
  const errors: string[] = [];
  const att = a as Partial<SettlementAttestation> | null;
  if (!att || typeof att !== "object") return ["attestation is not an object"];
  if (att.format !== "eip712") errors.push("format must be eip712");
  if (typeof att.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(att.signature)) {
    errors.push("signature must be 0x-prefixed 65-byte hex");
  }
  const p = att.payload as Partial<SettlementAttestationPayload> | undefined;
  if (!p || typeof p !== "object") return [...errors, "payload missing"];
  if (p.version !== 1) errors.push("version must be 1");
  if (typeof p.network !== "string" || !CAIP2.test(p.network)) errors.push("network is not CAIP-2");
  for (const f of ["transaction", "payer", "payee", "asset", "facilitator"] as const) {
    if (typeof p[f] !== "string" || p[f]!.length === 0) errors.push(`${f} must be a non-empty string`);
  }
  for (const f of ["amount", "facilitatorFee"] as const) {
    if (typeof p[f] !== "string" || !DECIMAL.test(p[f]!)) errors.push(`${f} must be a decimal string`);
  }
  if (typeof p.observedAt !== "string" || !DECIMAL.test(p.observedAt) || p.observedAt === "0") {
    errors.push("observedAt must be a positive decimal string");
  }
  if (typeof p.network === "string" && p.network.startsWith("eip155:")) {
    if (typeof p.transaction === "string" && !TX_HASH.test(p.transaction)) {
      errors.push("transaction must be a lowercase 0x-prefixed 32-byte hash on EVM");
    }
    for (const f of ["payer", "payee", "asset"] as const) {
      const v = p[f];
      if (typeof v === "string" && (!isAddress(v, { strict: false }) || getAddress(v) !== v)) {
        errors.push(`${f} must be an EIP-55 address on EVM`);
      }
    }
  }
  return errors;
}

/**
 * Signs an attestation (facilitator side, §8).
 *
 * @param account - The facilitator's attestation key.
 * @param payload - Payload; `facilitator` should be this key's address.
 * @returns The signed attestation.
 * @throws When the payload fails §6.1 validation.
 */
export async function signAttestation(
  account: Account & { signTypedData: NonNullable<Account["signTypedData"]> },
  payload: SettlementAttestationPayload,
): Promise<SettlementAttestation> {
  const problems = validateAttestation({ format: "eip712", payload, signature: `0x${"00".repeat(65)}` });
  if (problems.length > 0) throw new Error(`invalid attestation payload: ${problems.join("; ")}`);
  const signature = await account.signTypedData({
    domain: ATTESTATION_DOMAIN,
    types: ATTESTATION_TYPES,
    primaryType: "SettlementAttestation",
    message: message(payload),
  });
  return { format: "eip712", payload, signature };
}

/** Result of signature verification (§6.2). */
export type SignatureCheck =
  | { valid: true; signer: Hex }
  | { valid: false; reason: string; signer?: Hex };

/**
 * Signature verification, §6.2. When `facilitator` is a URL or DID the caller
 * must pass the key it resolved out of band as `authorizedSigner`.
 *
 * @param a - Attestation.
 * @param authorizedSigner - Key resolved for a URL/DID facilitator.
 * @returns Whether the signature is valid and by whom.
 */
export async function verifyAttestationSignature(
  a: SettlementAttestation,
  authorizedSigner?: string,
): Promise<SignatureCheck> {
  const problems = validateAttestation(a);
  if (problems.length > 0) return { valid: false, reason: problems.join("; ") };
  const signer = await recoverTypedDataAddress({
    domain: ATTESTATION_DOMAIN,
    types: ATTESTATION_TYPES,
    primaryType: "SettlementAttestation",
    message: message(a.payload),
    signature: a.signature,
  });
  const expected = isAddress(a.payload.facilitator, { strict: false })
    ? a.payload.facilitator
    : authorizedSigner;
  if (!expected) {
    return { valid: false, reason: "facilitator is not an address and no authorized key was given", signer };
  }
  if (signer.toLowerCase() !== expected.toLowerCase()) {
    return { valid: false, reason: "signer is not the facilitator's key", signer };
  }
  return { valid: true, signer };
}

/** §6.3: three outcomes, kept distinct. */
export type SettlementOutcome =
  | { outcome: "NOT_FOUND"; detail: string }
  | { outcome: "MATCH" }
  | { outcome: "MISMATCH"; detail: string };

const TRANSFER_ABI = [
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;

/**
 * Settlement check for EVM ERC-20 settlements, §6.3: looks up the transaction
 * and compares the asset's Transfer events with the attested payer, payee and
 * amount. `payer` is compared with the debited account, never with "any party".
 *
 * @param client - Public client for the attested network.
 * @param a - Attestation (already signature-checked).
 * @param minConfirmations - Depth the consumer requires.
 * @returns NOT_FOUND, MATCH or MISMATCH.
 */
export async function checkSettlement(
  client: PublicClient,
  a: SettlementAttestation,
  minConfirmations = 1,
): Promise<SettlementOutcome> {
  const p = a.payload;
  const chainId = await client.getChainId();
  if (p.network !== `eip155:${chainId}`) {
    return { outcome: "NOT_FOUND", detail: `client is on eip155:${chainId}, attestation names ${p.network}` };
  }
  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: p.transaction as Hex });
  } catch {
    return { outcome: "NOT_FOUND", detail: "no receipt for transaction" };
  }
  const head = await client.getBlockNumber({ cacheTime: 0 });
  if (head - receipt.blockNumber + 1n < BigInt(minConfirmations)) {
    return { outcome: "NOT_FOUND", detail: "not yet at the required depth" };
  }
  if (receipt.status !== "success") return { outcome: "MISMATCH", detail: "transaction reverted" };
  const transfers = parseEventLogs({ abi: TRANSFER_ABI, logs: receipt.logs }).filter(
    l => l.address.toLowerCase() === p.asset.toLowerCase(),
  );
  const hit = transfers.find(
    l =>
      l.args.from.toLowerCase() === p.payer.toLowerCase() &&
      l.args.to.toLowerCase() === p.payee.toLowerCase() &&
      l.args.value === BigInt(p.amount),
  );
  if (hit) return { outcome: "MATCH" };
  return {
    outcome: "MISMATCH",
    detail:
      transfers.length === 0
        ? "transaction has no transfer of the attested asset"
        : "no transfer of the attested asset matches payer, payee and amount",
  };
}

/**
 * The account debited in an EVM `exact` payment (§4.3): the authorization's
 * `from` for EIP-3009 and Permit2. Never `SettlementResponse.payer` blindly.
 *
 * @param payload - The scheme payload of the PaymentPayload.
 * @returns The funding account, or undefined when the method is unknown.
 */
export function evmExactFundingAccount(payload: unknown): string | undefined {
  const p = payload as {
    authorization?: { from?: string };
    permit2Authorization?: { from?: string };
  };
  const from = p?.authorization?.from ?? p?.permit2Authorization?.from;
  return typeof from === "string" && isAddress(from, { strict: false }) ? getAddress(from) : undefined;
}
