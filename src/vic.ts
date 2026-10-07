/**
 * ERC-8342 Verifiable Invoice Commitment, post-payment binding (Mode B):
 * the payment settles first, then the issuer commits the signed invoice with
 * `paymentTxRef` = the settlement transaction hash.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  getAddress,
  hashTypedData,
  parseEventLogs,
  recoverTypedDataAddress,
  type Account,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";

const artifact = JSON.parse(
  readFileSync(fileURLToPath(new URL("../contracts/vic-registry.json", import.meta.url)), "utf8"),
);
export const REGISTRY_ABI = artifact.abi;
export const REGISTRY_BYTECODE = artifact.bytecode as Hex;

/** CREATE2 address of the canonical registrar (same on every EVM chain it is deployed to). */
export const CANONICAL_REGISTRY = "0xa8C5b7D5B413297343ca6CeCe3931F9770D7A2FD";

export interface TaxIdentity { scheme: string; id: string }
export interface TaxEntry {
  taxType: string; taxScheme: string; rateBps: bigint;
  baseAmountMilliUnits: bigint; taxAmountMilliUnits: bigint;
}
export interface LineItem {
  description: string; quantityScaled: bigint; unit: string;
  unitPriceMilliUnits: bigint; lineTotalMilliUnits: bigint; taxRefIndex: bigint;
}
/** Mirrors InvoiceCommitmentTypes.Invoice. */
export interface Invoice {
  invoiceId: string; issueDate: bigint; dueDate: bigint; paymentTerms: string; purchaseOrderRef: string;
  issuer: Hex; issuerTaxId: TaxIdentity; recipient: Hex; recipientTaxId: TaxIdentity;
  paymentToken: Hex; paymentAmount: bigint; fiatCurrency: string; fiatAmountMilliUnits: bigint;
  fxRateScaled: bigint; fxOracle: Hex; fxTimestamp: bigint;
  taxes: TaxEntry[]; lineItems: LineItem[]; jurisdiction: string; regulatoryData: Hex; nonce: bigint;
}

/** Byte-identical to the type strings in InvoiceHasher.sol. */
export const INVOICE_TYPES = {
  TaxIdentity: [
    { name: "scheme", type: "string" },
    { name: "id", type: "string" },
  ],
  TaxEntry: [
    { name: "taxType", type: "string" },
    { name: "taxScheme", type: "string" },
    { name: "rateBps", type: "uint256" },
    { name: "baseAmountMilliUnits", type: "uint256" },
    { name: "taxAmountMilliUnits", type: "uint256" },
  ],
  LineItem: [
    { name: "description", type: "string" },
    { name: "quantityScaled", type: "uint256" },
    { name: "unit", type: "string" },
    { name: "unitPriceMilliUnits", type: "uint256" },
    { name: "lineTotalMilliUnits", type: "uint256" },
    { name: "taxRefIndex", type: "uint256" },
  ],
  Invoice: [
    { name: "invoiceId", type: "string" },
    { name: "issueDate", type: "uint256" },
    { name: "dueDate", type: "uint256" },
    { name: "paymentTerms", type: "string" },
    { name: "purchaseOrderRef", type: "string" },
    { name: "issuer", type: "address" },
    { name: "issuerTaxId", type: "TaxIdentity" },
    { name: "recipient", type: "address" },
    { name: "recipientTaxId", type: "TaxIdentity" },
    { name: "paymentToken", type: "address" },
    { name: "paymentAmount", type: "uint256" },
    { name: "fiatCurrency", type: "string" },
    { name: "fiatAmountMilliUnits", type: "uint256" },
    { name: "fxRateScaled", type: "uint256" },
    { name: "fxOracle", type: "address" },
    { name: "fxTimestamp", type: "uint256" },
    { name: "taxes", type: "TaxEntry[]" },
    { name: "lineItems", type: "LineItem[]" },
    { name: "jurisdiction", type: "string" },
    { name: "regulatoryData", type: "bytes" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

/**
 * EIP-712 domain of a registrar deployment.
 *
 * @param chainId - Chain of the registrar.
 * @param registry - Registrar address.
 * @returns The domain.
 */
export function invoiceDomain(chainId: number, registry: Hex) {
  return { name: "VerifiableInvoiceCommitment", version: "1", chainId, verifyingContract: registry } as const;
}

/**
 * The invoice digest the registrar stores (`invoiceHash`).
 *
 * @param invoice - Invoice.
 * @param chainId - Chain of the registrar.
 * @param registry - Registrar address.
 * @returns The EIP-712 digest.
 */
export function invoiceHash(invoice: Invoice, chainId: number, registry: Hex): Hex {
  return hashTypedData({
    domain: invoiceDomain(chainId, registry),
    types: INVOICE_TYPES,
    primaryType: "Invoice",
    message: invoice,
  });
}

/**
 * Signs an invoice as its issuer.
 *
 * @param issuer - Issuer key; must be `invoice.issuer`.
 * @param invoice - Invoice.
 * @param chainId - Chain of the registrar.
 * @param registry - Registrar address.
 * @returns The issuer signature.
 */
export async function signInvoice(
  issuer: Account & { signTypedData: NonNullable<Account["signTypedData"]> },
  invoice: Invoice,
  chainId: number,
  registry: Hex,
): Promise<Hex> {
  if (getAddress(issuer.address) !== getAddress(invoice.issuer)) {
    throw new Error("signer is not the invoice issuer");
  }
  return issuer.signTypedData({
    domain: invoiceDomain(chainId, registry),
    types: INVOICE_TYPES,
    primaryType: "Invoice",
    message: invoice,
  });
}

/**
 * Commits a signed invoice in Mode B (post-payment binding), off-chain payload.
 *
 * @param wallet - Any wallet; the registrar checks the issuer signature, not the sender.
 * @param registry - Registrar address.
 * @param invoice - Invoice.
 * @param signature - Issuer signature.
 * @param paymentTxRef - Settlement transaction hash.
 * @param uri - Where the full invoice document can be fetched.
 * @returns The commit transaction hash.
 */
export async function commitInvoice(
  wallet: WalletClient & { account: Account },
  registry: Hex,
  invoice: Invoice,
  signature: Hex,
  paymentTxRef: Hex,
  uri: string,
): Promise<Hex> {
  return wallet.writeContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: "commitInvoice",
    args: [invoice, paymentTxRef, 0, uri, "0x", signature],
    account: wallet.account,
    chain: wallet.chain,
  });
}

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

/** Outcome of verifying an invoice commitment. */
export type InvoiceCheck =
  | { valid: true; invoiceHash: Hex; paymentTxRef: Hex }
  | { valid: false; reason: string };

/**
 * Verification per ERC-8342 §5 for Mode B: recompute the digest, check the
 * issuer signature and the stored commitment, and check that `paymentTxRef`
 * transferred `paymentAmount` of `paymentToken` from `recipient` to `issuer`
 * (the registrar does not enforce this; verifiers must).
 *
 * @param client - Public client on the registrar's chain.
 * @param registry - Registrar address.
 * @param invoice - The invoice document.
 * @param signature - Issuer signature.
 * @returns Whether the commitment holds.
 */
export async function verifyInvoiceCommitment(
  client: PublicClient,
  registry: Hex,
  invoice: Invoice,
  signature: Hex,
): Promise<InvoiceCheck> {
  if (invoice.lineItems.length > 0) {
    const lines = invoice.lineItems.reduce((s, l) => s + l.lineTotalMilliUnits, 0n);
    const taxes = invoice.taxes.reduce((s, t) => s + t.taxAmountMilliUnits, 0n);
    if (lines + taxes !== invoice.fiatAmountMilliUnits) {
      return { valid: false, reason: "line items and taxes do not add up to fiatAmountMilliUnits" };
    }
  }
  const chainId = await client.getChainId();
  const digest = invoiceHash(invoice, chainId, registry);
  const signer = await recoverTypedDataAddress({
    domain: invoiceDomain(chainId, registry),
    types: INVOICE_TYPES,
    primaryType: "Invoice",
    message: invoice,
    signature,
  });
  if (getAddress(signer) !== getAddress(invoice.issuer)) return { valid: false, reason: "issuer signature does not verify" };

  const [issuer, recipient, paymentTxRef] = (await client.readContract({
    address: registry,
    abi: REGISTRY_ABI,
    functionName: "getCommitment",
    args: [digest],
  })) as [Hex, Hex, Hex];
  if (getAddress(issuer) === "0x0000000000000000000000000000000000000000") {
    return { valid: false, reason: "invoice is not committed" };
  }
  if (getAddress(issuer) !== getAddress(invoice.issuer) || getAddress(recipient) !== getAddress(invoice.recipient)) {
    return { valid: false, reason: "stored commitment does not match the invoice parties" };
  }

  let receipt;
  try {
    receipt = await client.getTransactionReceipt({ hash: paymentTxRef });
  } catch {
    return { valid: false, reason: "paymentTxRef is not a known transaction" };
  }
  if (receipt.status !== "success") return { valid: false, reason: "payment transaction reverted" };
  const paid = parseEventLogs({ abi: TRANSFER_ABI, logs: receipt.logs }).some(
    l =>
      getAddress(l.address) === getAddress(invoice.paymentToken) &&
      getAddress(l.args.from) === getAddress(invoice.recipient) &&
      getAddress(l.args.to) === getAddress(invoice.issuer) &&
      l.args.value === invoice.paymentAmount,
  );
  if (!paid) return { valid: false, reason: "paymentTxRef did not pay paymentAmount from recipient to issuer" };
  return { valid: true, invoiceHash: digest, paymentTxRef };
}

/**
 * A minimal invoice for one x402 sale: the seller (payTo) issues it, the payer
 * receives it, one line item for the purchased resource.
 *
 * @param sale - Sale facts.
 * @param sale.invoiceId - Seller's invoice number.
 * @param sale.issuer - Seller address (x402 payTo); must also be the signing key.
 * @param sale.recipient - Payer address.
 * @param sale.token - Token address.
 * @param sale.amount - Amount in the token's smallest unit.
 * @param sale.description - What was sold (e.g. "GET https://api.example.com/reports/42").
 * @param sale.nonce - Issuer-unique nonce.
 * @param sale.issuedAt - Unix seconds.
 * @returns The invoice.
 */
export function invoiceForSale(sale: {
  invoiceId: string; issuer: Hex; recipient: Hex; token: Hex; amount: bigint;
  description: string; nonce: bigint; issuedAt: bigint;
}): Invoice {
  // USDC has 6 decimals; milli-units are 1/1000 of a currency unit.
  const milli = sale.amount / 1000n;
  return {
    invoiceId: sale.invoiceId,
    issueDate: sale.issuedAt,
    dueDate: sale.issuedAt,
    paymentTerms: "paid via x402",
    purchaseOrderRef: "",
    issuer: getAddress(sale.issuer),
    issuerTaxId: { scheme: "", id: "" },
    recipient: getAddress(sale.recipient),
    recipientTaxId: { scheme: "", id: "" },
    paymentToken: getAddress(sale.token),
    paymentAmount: sale.amount,
    fiatCurrency: "USD",
    fiatAmountMilliUnits: milli,
    fxRateScaled: 0n,
    fxOracle: "0x0000000000000000000000000000000000000000",
    fxTimestamp: 0n,
    taxes: [],
    lineItems: [
      {
        description: sale.description,
        quantityScaled: 1_000n, // quantity x 10^3
        unit: "request",
        unitPriceMilliUnits: milli,
        lineTotalMilliUnits: milli,
        taxRefIndex: 0n,
      },
    ],
    jurisdiction: "",
    regulatoryData: "0x",
    nonce: sale.nonce,
  };
}
