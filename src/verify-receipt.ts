import { readFileSync } from "node:fs";
import { createPublicClient, http, type PublicClient } from "viem";
import { avalancheFuji } from "viem/chains";
import { verifyPaidRequest } from "./verifier.js";
import { CANONICAL_REGISTRY } from "./vic.js";

const FACILITATOR: `0x${string}` = "0x8078f2c50d52292F319e1923752839BD12AA4225";
const file = process.argv[2] ?? "receipt.json";
const r = JSON.parse(readFileSync(file, "utf8"));

const publicClient = createPublicClient({
  chain: avalancheFuji,
  transport: http("https://api.avax-test.network/ext/bc/C/rpc"),
}) as PublicClient;

const base = {
  publicClient,
  registry: CANONICAL_REGISTRY as `0x${string}`,
  attestation: r.attestation,
  invoice: r.invoice,
  invoiceSignature: r.signature as `0x${string}`,
  request: {
    method: r.request.method,
    url: r.request.url,
    headers: r.request.headers ?? {},
  },
  headers: [] as string[],
  salt: r.salt as string,
  expectedFacilitator: FACILITATOR,
  minConfirmations: 1,
};

async function attempt(label: string, input: typeof base) {
  try {
    const res = await verifyPaidRequest(input);
    console.log(`[VALID]    ${label}`);
    return res;
  } catch (e) {
    console.log(`[REJECTED] ${label}: ${(e as Error).message}`);
    return undefined;
  }
}

console.log(`Verifying ${file} (tx ${r.transaction})\n`);
const ok = await attempt("receipt as issued", base);
if (ok) {
  console.log(`  payer        ${ok.payer}`);
  console.log(`  payee        ${ok.payee}`);
  console.log(`  transaction  ${ok.transaction}`);
  console.log(`  requestNonce ${ok.requestNonce}`);
  console.log(`  snowtrace    https://testnet.snowtrace.io/tx/${ok.transaction}\n`);
}

// Tamper checks: the same payment must not verify for another request or facilitator.
await attempt("same payment, different request", {
  ...base,
  request: { ...base.request, url: base.request.url.replace("/api/data", "/api/other") },
});
await attempt("same payment, different expected facilitator", {
  ...base,
  expectedFacilitator: "0x000000000000000000000000000000000000dEaD",
});
