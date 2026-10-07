import express from "express";
import {
  HTTPFacilitatorClient,
  x402ResourceServer,
  type RoutesConfig,
} from "@x402/core/server";
import { paymentMiddleware } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";

import { createWalletClient, http } from "viem";
import { avalancheFuji } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

import {
  EVM_REQUEST_COMMITMENT,
  createRequestCommitmentServerExtension,
  declareRequestCommitmentExtension,
} from "./requestCommitment/index.js";

import {
  invoiceForSale,
  signInvoice,
  commitInvoice,
} from "./vic.js";

const app = express();

const PORT = Number(process.env.SELLER_PORT ?? 3000);

const PUBLIC_ORIGIN =
  process.env.PUBLIC_ORIGIN ??
  "http://127.0.0.1:3000";

const FACILITATOR_URL =
  process.env.FACILITATOR_URL ??
  "http://127.0.0.1:4021";

const SELLER_PRIVATE_KEY =
  process.env.SELLER_PRIVATE_KEY as `0x${string}`;

const FUJI_RPC_URL =
  process.env.FUJI_RPC_URL ??
  "https://api.avax-test.network/ext/bc/C/rpc";

const SELLER_ACCOUNT =
  privateKeyToAccount(SELLER_PRIVATE_KEY);

const PAY_TO = SELLER_ACCOUNT.address;

const REGISTRY =
  "0xa8C5b7D5B413297343ca6CeCe3931F9770D7A2FD" as `0x${string}`;

const USDC_FUJI =
  "0x5425890298aed601595a70AB815c96711a31Bc65" as `0x${string}`;

const CHAIN_ID = 43113;

const walletClient = createWalletClient({
  account: SELLER_ACCOUNT,
  chain: avalancheFuji,
  transport: http(FUJI_RPC_URL),
});

/**
 * Demo-only monotonic VIC invoice nonce.
 * Persist this counter in production so a restart cannot reuse a nonce.
 */
let invoiceNonce = 0n;

function nextInvoiceNonce(): bigint {
  invoiceNonce += 1n;
  return invoiceNonce;
}

type StoredInvoice = {
  invoice: ReturnType<typeof invoiceForSale>;
  signature: `0x${string}`;
};

/**
 * Off-chain invoice store for the demo.
 * On-chain the registry stores only the invoice hash, so the verifier
 * needs the complete document and signature from this route.
 */
const invoiceStore = new Map<string, StoredInvoice>();

function stringifyBigInts(value: unknown): string {
  return JSON.stringify(value, (_key, child) =>
    typeof child === "bigint" ? child.toString() : child,
  );
}

const resourceServer =
  new x402ResourceServer(
    new HTTPFacilitatorClient({
      url: FACILITATOR_URL,
    }),
  )
    .register(
      "eip155:43113",
      new ExactEvmScheme(),
    )
    .registerExtension(
      createRequestCommitmentServerExtension({
        publicOrigin: PUBLIC_ORIGIN,
      }),
    )
    .onAfterSettle(
      async ({
        paymentPayload,
        requirements,
        result,
      }) => {
        if (!result.success) {
          return;
        }

        try {
          const authorization =
            paymentPayload.payload?.authorization;

          if (
            !authorization ||
            typeof authorization !== "object" ||
            !("from" in authorization)
          ) {
            throw new Error("settlement_missing_payer");
          }

          const recipient =
            String(authorization.from) as `0x${string}`;

          const invoice = invoiceForSale({
            invoiceId: crypto.randomUUID(),
            issuer: PAY_TO,
            recipient,
            token: requirements.asset as `0x${string}`,
            amount: BigInt(requirements.amount),
            description: `Sale of ${PUBLIC_ORIGIN}/api/data`,
            nonce: nextInvoiceNonce(),
            issuedAt: BigInt(Math.floor(Date.now() / 1000)),
          });

          const signature = await signInvoice(
            SELLER_ACCOUNT,
            invoice,
            CHAIN_ID,
            REGISTRY,
          );

          const invoiceUri =
            `${PUBLIC_ORIGIN}/invoices/${result.transaction}`;

          await commitInvoice(
            walletClient,
            REGISTRY,
            invoice,
            signature,
            result.transaction as `0x${string}`,
            invoiceUri,
          );

          invoiceStore.set(
            result.transaction.toLowerCase(),
            {
              invoice,
              signature,
            },
          );

          console.log("VIC invoice committed", {
            invoiceId: invoice.invoiceId,
            paymentTxRef: result.transaction,
            uri: invoiceUri,
            issuer: invoice.issuer,
            recipient: invoice.recipient,
            nonce: invoice.nonce.toString(),
          });
        } catch (error) {
          // Settlement has already completed; don't throw from this hook.
          console.error("VIC invoice commit failed:", error);
        }
      },
    );

const routes: RoutesConfig = {
  "GET /api/data": {
    accepts: {
      scheme: "exact",
      network: "eip155:43113",
      payTo: PAY_TO,
      price: {
        amount: "10000",
        asset: USDC_FUJI,
      },
      extra: {
        name: "USD Coin",
        version: "2",
      },
    },
    description: "Paid Fuji demo endpoint",
    extensions: {
      [EVM_REQUEST_COMMITMENT]:
        declareRequestCommitmentExtension({
          required: true,
          headers: [],
        }),
    },
  },
};

app.use(
  paymentMiddleware(
    routes,
    resourceServer,
  ),
);

app.get(
  "/api/data",
  (_req, res) => {
    res.json({
      ok: true,
      message: "Paid request accepted",
    });
  },
);

/**
 * Free invoice retrieval endpoint.
 * The verifier needs the complete off-chain document and its signature;
 * the registry contains only the committed hash.
 */
app.get(
  "/invoices/:tx",
  (req, res) => {
    const stored = invoiceStore.get(
      req.params.tx.toLowerCase(),
    );

    if (!stored) {
      res.status(404).json({
        error: "invoice_not_found",
      });
      return;
    }

    res
      .type("application/json")
      .send(
        stringifyBigInts({
          invoice: stored.invoice,
          signature: stored.signature,
        }),
      );
  },
);

app.listen(PORT, () => {
  console.log(`Seller API: ${PUBLIC_ORIGIN}`);
  console.log(`Facilitator: ${FACILITATOR_URL}`);
  console.log(`payTo: ${PAY_TO}`);
  console.log(`USDC Fuji: ${USDC_FUJI}`);
});
