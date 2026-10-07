import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

import {
  evmExactFundingAccount,
  signAttestation,
  validateAttestation,
  verifyAttestationSignature,
  type SettlementAttestationPayload,
} from "../src/attestation.js";

// Public test key (anvil/hardhat account #0). Never use for real funds.
const facilitator = privateKeyToAccount(
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
);

export const VECTOR_PAYLOAD: SettlementAttestationPayload = {
  version: 1,
  network: "eip155:43113",
  transaction: "0x" + "ab".repeat(32),
  payer: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
  payee: "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  asset: "0x5425890298aed601595a70AB815c96711a31Bc65",
  amount: "10000",
  facilitator: facilitator.address,
  facilitatorFee: "0",
  observedAt: "1700000000",
};

describe("facilitator-attestation", () => {
  it("signs and verifies; the signer is the facilitator", async () => {
    const a = await signAttestation(facilitator, VECTOR_PAYLOAD);
    expect(a.format).toBe("eip712");
    expect(await verifyAttestationSignature(a)).toEqual({ valid: true, signer: facilitator.address });
  });

  it("is deterministic (RFC 6979) so the vector is reproducible", async () => {
    const a = await signAttestation(facilitator, VECTOR_PAYLOAD);
    const b = await signAttestation(facilitator, VECTOR_PAYLOAD);
    expect(a.signature).toBe(b.signature);
  });

  it("rejects any change to a signed field", async () => {
    const a = await signAttestation(facilitator, VECTOR_PAYLOAD);
    for (const [k, v] of Object.entries({
      network: "eip155:43114",
      amount: "10001",
      payer: "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
      facilitatorFee: "1",
      transaction: "0x" + "cd".repeat(32),
    })) {
      const tampered = { ...a, payload: { ...a.payload, [k]: v } };
      const r = await verifyAttestationSignature(tampered);
      expect(r.valid, k).toBe(false);
    }
  });

  it("rejects a signature by a key other than the named facilitator", async () => {
    const other = privateKeyToAccount(
      "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a7412f4603b6b78690d",
    );
    const a = await signAttestation(other, VECTOR_PAYLOAD);
    const r = await verifyAttestationSignature(a);
    expect(r).toMatchObject({ valid: false, reason: "signer is not the facilitator's key" });
  });

  it("requires an out-of-band key when the facilitator is a URL", async () => {
    const a = await signAttestation(facilitator, { ...VECTOR_PAYLOAD, facilitator: "https://f.example" });
    expect((await verifyAttestationSignature(a)).valid).toBe(false);
    expect((await verifyAttestationSignature(a, facilitator.address)).valid).toBe(true);
  });

  it("validates fields per §6.1 and §4.5 before signing or verifying", async () => {
    const bad = [
      { amount: "01" },
      { amount: "-1" },
      { observedAt: "0" },
      { network: "avalanche" },
      { transaction: "0x" + "AB".repeat(32) },
      { payer: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" }, // not EIP-55
      { version: 2 },
    ];
    for (const patch of bad) {
      await expect(
        signAttestation(facilitator, { ...VECTOR_PAYLOAD, ...patch } as SettlementAttestationPayload),
        JSON.stringify(patch),
      ).rejects.toThrow(/invalid attestation payload/);
    }
    expect(validateAttestation({ format: "jws" })).toContain("format must be eip712");
  });

  it("takes the payer from the authorization, not from the settle response", () => {
    expect(
      evmExactFundingAccount({ authorization: { from: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8" } }),
    ).toBe("0x70997970C51812dc3A010C7d01b50e0d17dc79C8");
    expect(evmExactFundingAccount({ permit2Authorization: { from: VECTOR_PAYLOAD.payee } })).toBe(
      VECTOR_PAYLOAD.payee,
    );
    expect(evmExactFundingAccount({ transaction: "base64" })).toBeUndefined();
  });
});
