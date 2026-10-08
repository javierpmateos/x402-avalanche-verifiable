# x402-avalanche-verifiable

Verifiable agent payments on Avalanche. Three independent pieces, each signed by a different party, that together let anyone check what an agent paid for, who settled it and which invoice backs it:

| Link | Question it answers | Signed by | Where it lives |
|---|---|---|---|
| **Request binding** (`evm-request-commitment`) | Was this payment made for *this* HTTP request? | Payer (EIP-3009 authorization) | The authorization nonce |
| **Settlement attestation** (`facilitator-attestation`) | Who settled it, for how much, to whom? | Facilitator | `SettleResponse.extensions` |
| **Invoice commitment** (ERC-8342, Mode B) | Which fiscal document does this payment satisfy? | Seller (invoice issuer) | `InvoiceCommitmentRegistry` on-chain |

All three are bound to the same settlement transaction on Avalanche.

## Status

| Component | State |
|---|---|
| Request binding: binding, digest, nonce derivation, resource-server check | Done, tested |
| Request binding: client scheme for the published `@x402/evm` (EIP-3009) | Done, typechecked |
| Facilitator attestation: sign, verify, settlement check (§6.3) | Done, tested, cross-checked with `eth_account` |
| Attesting facilitator HTTP service (`/verify`, `/settle`, `/supported`) | Done, typechecked |
| ERC-8342 Mode B: build, sign, commit, verify | Done, tested against the registrar bytecode |
| Seller API, paying agent and end-to-end receipt verifier | Done, run on Fuji |

## Run it on Fuji

Live run: settlement [`0xc480ee94…14c2`](https://testnet.snowtrace.io/tx/0xc480ee94a64c704ace02adb64efb7661bfce07409391cbd4a386bc86b7ae14c2), receipt in [`examples/fuji-receipt.json`](examples/fuji-receipt.json).

Three wallets: facilitator and seller need a little Fuji AVAX for gas (C-Chain), the agent needs Fuji USDC.

```bash
npx tsx src/run-facilitator.ts      # terminal 1, port 4021
npx tsx src/seller.ts               # terminal 2, port 3000
npx tsx src/agent.ts                # terminal 3, pays GET /api/data, writes receipt.json
npx tsx src/verify-receipt.ts receipt.json
```

The verifier checks the attestation signature, the settlement on-chain (`MATCH`), the ERC-8342 invoice commitment and that the authorization nonce was derived from this exact request. It then replays the same receipt against a different request and a different facilitator; both are rejected:

```
[VALID]    receipt as issued
[REJECTED] same payment, different request: request_nonce_mismatch
[REJECTED] same payment, different expected facilitator: unexpected_facilitator
```

## How each link works

**Request binding.** The server publishes a digest of the request in the 402 (`requestDigest`). The client recomputes it from its own request and derives the EIP-3009 nonce as `SHA-256(tag ‖ requestDigest ‖ salt)`, disclosing only the salt. Before calling the facilitator, the server recomputes the digest from the request it is about to serve and checks that it leads to the signed nonce. A payment made for one resource is rejected on another. The nonce on-chain is indistinguishable from a random one. Spec: [`evm_request_commitment.md`](https://github.com/javierpmateos/x402/blob/feat/evm-request-commitment/specs/extensions/evm_request_commitment.md).

**Settlement attestation.** After settling, the facilitator signs an EIP-712 `SettlementAttestation` (network, transaction, payer, payee, asset, amount, facilitator, fee, observedAt). It *attributes* a settlement; it does not prove one. Consumers run the settlement check, which has three distinct outcomes: `MATCH`, `MISMATCH`, `NOT_FOUND`. Spec: x402 PR [#2339](https://github.com/x402-foundation/x402/pull/2339), revision 2.

**Invoice commitment.** The seller (x402 `payTo`) issues an ERC-8342 invoice to the payer and commits it to the registrar with `paymentTxRef` = the settlement transaction hash. The registrar checks the issuer signature; whether that transaction actually paid the invoice is checked by the verifier (ERC-8342 §5), and the tests cover the case where it did not. Spec and registrar: [verifiable-invoice-commitment](https://github.com/javierpmateos/verifiable-invoice-commitment).

## Deployments

| Contract | Network | Address |
|---|---|---|
| `InvoiceCommitmentRegistry` (ERC-8342) | Avalanche Fuji (43113) | [`0xa8C5b7D5B413297343ca6CeCe3931F9770D7A2FD`](https://testnet.snowtrace.io/address/0xa8C5b7D5B413297343ca6CeCe3931F9770D7A2FD#code) (verified) |

Same CREATE2 address as on Sepolia, Base Sepolia and Arbitrum Sepolia.

Test USDC on Fuji: `0x5425890298aed601595a70AB815c96711a31Bc65` ([Circle faucet](https://faucet.circle.com/)).

## Layout

```
src/
  attestation.ts           facilitator-attestation: types, sign, verify, settlement check
  facilitator.ts           attesting facilitator (reference EVM facilitator + attestation)
  vic.ts                   ERC-8342 Mode B: invoice, sign, commit, verify
  requestCommitment/       evm-request-commitment (from javierpmateos/x402, feat/evm-request-commitment)
    binding.ts             http:1 binding, request digest, nonce derivation
    client.ts              client-side resolution (recompute, refuse on mismatch)
    server.ts              resource-server extension (enrichDeclaration + onBeforeVerify)
    scheme.ts              exact EVM client scheme with the derived nonce
contracts/
  vic-registry.json        registrar ABI and bytecode (solc 0.8.26, viaIR, OZ 5.6.1)
  test-token/              minimal EIP-3009 token and Multicall3 subset for local tests
test/
  vectors/                 facilitator-attestation test vector
```

## Tests

```bash
npm install
npm test
```

Unit tests run anywhere. The local-chain tests (settlement check and ERC-8342) need an anvil node with Fuji's chain id:

```bash
anvil --chain-id 43113 &
LOCAL_RPC=http://127.0.0.1:8545 npm test
```

## Related work

- `scheme_exact_lnbtc.md` (x402): the same `http:1` request binding, anchored in the BOLT11 `description_hash`.
- `cardano-request-commitment` ([#3449](https://github.com/x402-foundation/x402/issues/3449)): the same binding, anchored in signed Cardano transaction metadata.

## License

MIT
