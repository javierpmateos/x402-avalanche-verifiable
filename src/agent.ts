import {
  decodePaymentResponseHeader,
  wrapFetchWithPayment,
  x402Client,
} from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";

import {
  EVM_REQUEST_COMMITMENT,
  RequestBoundExactEvmScheme,
} from "./requestCommitment/index.js";

const AGENT_PRIVATE_KEY =
  process.env.AGENT_PRIVATE_KEY as `0x${string}`;

if (!AGENT_PRIVATE_KEY) {
  throw new Error("AGENT_PRIVATE_KEY is required");
}

const REQUEST_URL =
  "http://127.0.0.1:3000/api/data";

const SELLER_ORIGIN =
  "http://127.0.0.1:3000";

const USDC_FUJI =
  "0x5425890298aed601595a70AB815c96711a31Bc65";

const NETWORK =
  "eip155:43113";

const INVOICE_WAIT_MS = Number(
  process.env.INVOICE_WAIT_MS ?? 5000,
);

const account = privateKeyToAccount(
  AGENT_PRIVATE_KEY,
);

const request = () => ({
  method: "GET",
  url: REQUEST_URL,
  headers: {},
});

let paymentSalt: string | undefined;

const client = new x402Client()
  .setSpendControls({
    allowedAssets: [
      {
        asset: USDC_FUJI,
        network: NETWORK,
        maxAmountPerPayment: "10000",
      },
    ],
  })
  .register(
    NETWORK,
    new RequestBoundExactEvmScheme(
      account,
      { request },
    ),
  )
  .onAfterPaymentCreation(async (ctx) => {
    const extension =
      ctx.paymentPayload.extensions?.[
        EVM_REQUEST_COMMITMENT
      ];

    const salt = (extension as { info?: { salt?: unknown } } | undefined)?.info?.salt;

    if (
      typeof salt !== "string" ||
      !/^[0-9a-f]{64}$/.test(salt)
    ) {
      throw new Error(
        "invalid_request_commitment_salt",
      );
    }

    paymentSalt = salt;

    console.log(
      `Request commitment salt: ${salt}`,
    );
  });

const paidFetch = wrapFetchWithPayment(
  fetch,
  client,
);

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) =>
    setTimeout(resolve, ms),
  );
}

async function main(): Promise<void> {
  console.log(
    `Agent address: ${account.address}`,
  );
  console.log(
    `Request: GET ${REQUEST_URL}`,
  );

  // The request-bound scheme must see exactly the same method,
  // URL and headers as the actual paid request.
  const response = await paidFetch(
    REQUEST_URL,
    {
      method: "GET",
      headers: {},
    },
  );

  if (!response.ok) {
    const header = response.headers.get("PAYMENT-REQUIRED");
    const reason = header
      ? JSON.parse(Buffer.from(header, "base64").toString("utf8")).error
      : (() => {
          const pr = response.headers.get("PAYMENT-RESPONSE");
          if (!pr) return "(no PAYMENT-REQUIRED or PAYMENT-RESPONSE header)";
          const d = JSON.parse(Buffer.from(pr, "base64").toString("utf8"));
          return `settlement failed: ${d.errorReason ?? ""} ${d.errorMessage ?? ""}`;
        })();
    throw new Error(`Paid request failed: HTTP ${response.status}: ${reason}`);
  }

  if (!paymentSalt) {
    throw new Error(
      "payment_salt_not_captured",
    );
  }

  const paymentResponseHeader =
    response.headers.get("PAYMENT-RESPONSE");

  if (!paymentResponseHeader) {
    throw new Error(
      "missing_PAYMENT_RESPONSE_header",
    );
  }

  const paymentResponse =
    decodePaymentResponseHeader(
      paymentResponseHeader,
    );

  const attestation = (
    paymentResponse.extensions?.["facilitator-attestation"] as
      | { info?: { attestation?: unknown } }
      | undefined
  )?.info?.attestation;

  const transaction =
    paymentResponse.transaction;

  if (!attestation) {
    throw new Error(
      "missing_facilitator_attestation",
    );
  }

  if (
    typeof transaction !== "string" ||
    !/^0x[0-9a-fA-F]+$/.test(transaction)
  ) {
    throw new Error(
      "missing_payment_transaction",
    );
  }

  console.log(
    `Settlement transaction: ${transaction}`,
  );

  console.log(
    `Waiting ${INVOICE_WAIT_MS} ms for invoice commit...`,
  );

  await sleep(INVOICE_WAIT_MS);

  const invoiceUrl =
    `${SELLER_ORIGIN}/invoices/${transaction}`;

  const invoiceResponse =
    await fetch(invoiceUrl);

  if (!invoiceResponse.ok) {
    const body = await invoiceResponse.text();
    throw new Error(
      `Invoice fetch failed: HTTP ${invoiceResponse.status}: ${body}`,
    );
  }

  const invoiceDocument =
    (await invoiceResponse.json()) as {
      invoice?: unknown;
      signature?: unknown;
    };

  if (!invoiceDocument.invoice) {
    throw new Error(
      "invoice_missing_from_response",
    );
  }

  if (
    typeof invoiceDocument.signature !== "string" ||
    !invoiceDocument.signature.startsWith("0x")
  ) {
    throw new Error(
      "invoice_signature_missing_from_response",
    );
  }

  const receipt = {
    request: {
      method: "GET",
      url: REQUEST_URL,
      headers: {},
    },
    salt: paymentSalt,
    attestation,
    transaction,
    invoice: invoiceDocument.invoice,
    signature: invoiceDocument.signature,
  };

  await import("node:fs/promises").then(
    ({ writeFile }) =>
      writeFile(
        "receipt.json",
        JSON.stringify(receipt, null, 2),
        "utf8",
      ),
  );

  console.log("Receipt written to receipt.json");
  console.log(
    JSON.stringify(
      {
        agent: account.address,
        transaction,
        invoiceUrl,
        receipt: "receipt.json",
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error("Agent failed:", error);
  process.exitCode = 1;
});
