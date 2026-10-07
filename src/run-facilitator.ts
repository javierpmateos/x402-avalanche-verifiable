import {
  createPublicClient,
  createWalletClient,
  http,
} from "viem";
import { avalancheFuji } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

import { createFacilitatorApp } from "./facilitator.js";

const PORT = Number(
  process.env.FACILITATOR_PORT ?? 4021,
);

const FUJI_RPC_URL =
  process.env.FUJI_RPC_URL ??
  "https://api.avax-test.network/ext/bc/C/rpc";

const account = privateKeyToAccount(
  process.env.FACILITATOR_PRIVATE_KEY as `0x${string}`,
);

const publicClient = createPublicClient({
  chain: avalancheFuji,
  transport: http(FUJI_RPC_URL),
});

const walletClient = createWalletClient({
  account,
  chain: avalancheFuji,
  transport: http(FUJI_RPC_URL),
});

const app = createFacilitatorApp({
  network: "eip155:43113",
  publicClient,
  walletClient,
  attestationKey: account,
});

app.listen(PORT, () => {
  console.log(
    `Facilitator listening on http://127.0.0.1:${PORT}`,
  );

  console.log(
    `Facilitator / attestation address: ${account.address}`,
  );
});
