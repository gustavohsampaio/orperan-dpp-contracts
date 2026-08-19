import { expect } from "chai";
import hre from "hardhat";

const { ethers } = hre;

const TOKEN_ID = 1n;
// contentHash de teste (bytes32) — snapshot público JCS fixado no deploy (WS-4).
const CONTENT_HASH = "0x" + "ab".repeat(32);

async function deployFixture() {
  const [platform, orgIssuer, holder, stranger] = await ethers.getSigners();

  // Forwarder ERC-2771 (relayer/meta-tx)
  const Forwarder = await ethers.getContractFactory("OpaliteDppForwarder", platform);
  const forwarder = await Forwarder.deploy();
  await forwarder.waitForDeployment();
  const forwarderAddr = await forwarder.getAddress();

  const Factory = await ethers.getContractFactory("OpaliteDppSoulboundFactory", platform);
  const factory = await Factory.deploy(forwarderAddr);
  await factory.waitForDeployment();

  const assetId = "passport-001";
  const tx = await factory.deploySoulbound(
    assetId,
    "Lote Café 2026",
    "ATTEST",
    "ATTESTATION",
    1n, // totalSupply (soulbound = 1)
    "http://localhost:8889/api/verify/qr-001/metadata",
    orgIssuer.address, // issuerWallet (wallet custodial da org)
    "", // linkedAssetId
    0n, // expiresAt (sem expiração)
    CONTENT_HASH, // contentHash (WS-4)
  );
  await tx.wait();

  const soulboundAddr = await factory.soulboundOf(assetId);
  const soulbound = await ethers.getContractAt("OpaliteDppSoulbound", soulboundAddr, platform);

  return { factory, forwarder, forwarderAddr, soulbound, soulboundAddr, assetId, platform, orgIssuer, holder, stranger };
}

// Monta + assina (EIP-712) um ForwardRequest e devolve o struct p/ forwarder.execute.
async function signForwardRequest(
  forwarder: any,
  forwarderAddr: string,
  signer: any,
  to: string,
  data: string,
  gas = 600000n,
) {
  const { chainId } = await ethers.provider.getNetwork();
  const nonce: bigint = await forwarder.nonces(signer.address);
  const deadline = 4102444800n; // 2100-01-01 (futuro distante p/ teste)
  const domain = { name: "OpaliteDppForwarder", version: "1", chainId, verifyingContract: forwarderAddr };
  const types = {
    ForwardRequest: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "gas", type: "uint256" },
      { name: "nonce", type: "uint256" },
      { name: "deadline", type: "uint48" },
      { name: "data", type: "bytes" },
    ],
  };
  const message = { from: signer.address, to, value: 0n, gas, nonce, deadline, data };
  const signature = await signer.signTypedData(domain, types, message);
  return { from: signer.address, to, value: 0n, gas, deadline, data, signature };
}

describe("OpaliteDppSoulboundFactory", () => {
  it("deploya um Soulbound e registra assetId → address + evento", async () => {
    const { factory, soulboundAddr, assetId } = await deployFixture();
    expect(soulboundAddr).to.properAddress;
    expect(await factory.soulboundOf(assetId)).to.equal(soulboundAddr);
    expect(await factory.deployedCount()).to.equal(1n);
  });

  it("rejeita deploy duplicado do mesmo assetId", async () => {
    const { factory } = await deployFixture();
    await expect(
      factory.deploySoulbound("passport-001", "x", "X", "ATTESTATION", 1n, "uri", ethers.ZeroAddress, "", 0n, ethers.ZeroHash),
    ).to.be.reverted; // issuer zero OU AlreadyDeployed — ambos revertem
  });

  it("deploySoulbound é onlyOwner", async () => {
    const { factory, stranger } = await deployFixture();
    await expect(
      factory.connect(stranger).deploySoulbound("p2", "x", "X", "ATTESTATION", 1n, "uri", stranger.address, "", 0n, ethers.ZeroHash),
    ).to.be.reverted;
  });
});

describe("OpaliteDppSoulbound — âncora de conteúdo (WS-4)", () => {
  it("contentHash() é o valor imutável passado no deploy", async () => {
    const { soulbound } = await deployFixture();
    expect(await soulbound.contentHash()).to.equal(CONTENT_HASH);
    expect(await soulbound.merkleRoot()).to.equal(ethers.ZeroHash); // sem eventos
    expect(await soulbound.contentVersion()).to.equal(0n);
  });

  it("setMerkleRoot (OPERATOR) grava raiz, incrementa versão e emite ContentReanchored", async () => {
    const { soulbound } = await deployFixture();
    const root = "0x" + "cd".repeat(32);
    await expect(soulbound.setMerkleRoot(root, 5n))
      .to.emit(soulbound, "ContentReanchored")
      .withArgs(ethers.ZeroHash, root, 1n, 5n);
    expect(await soulbound.merkleRoot()).to.equal(root);
    expect(await soulbound.contentVersion()).to.equal(1n);
  });

  it("setMerkleRoot rejeita raiz zero (EmptyMerkleRoot) e raiz repetida (UnchangedMerkleRoot)", async () => {
    const { soulbound } = await deployFixture();
    await expect(soulbound.setMerkleRoot(ethers.ZeroHash, 0n)).to.be.revertedWithCustomError(
      soulbound,
      "EmptyMerkleRoot",
    );
    const root = "0x" + "cd".repeat(32);
    await soulbound.setMerkleRoot(root, 5n);
    await expect(soulbound.setMerkleRoot(root, 5n)).to.be.revertedWithCustomError(
      soulbound,
      "UnchangedMerkleRoot",
    );
  });

  it("setMerkleRoot é OPERATOR-only (estranho não regrava)", async () => {
    const { soulbound, stranger } = await deployFixture();
    const root = "0x" + "cd".repeat(32);
    await expect(soulbound.connect(stranger).setMerkleRoot(root, 1n)).to.be.reverted;
  });
});

describe("OpaliteDppSoulbound", () => {
  it("metadados imutáveis + uri", async () => {
    const { soulbound } = await deployFixture();
    expect(await soulbound.assetId()).to.equal("passport-001");
    expect(await soulbound.subtype()).to.equal("ATTESTATION");
    expect(await soulbound.maxSupply()).to.equal(1n);
    expect(await soulbound.uri(TOKEN_ID)).to.equal("http://localhost:8889/api/verify/qr-001/metadata");
  });

  it("mint(to, tokenId, amount, data) pela plataforma (ISSUER) credita o holder", async () => {
    const { soulbound, holder } = await deployFixture();
    await expect(soulbound.mint(holder.address, TOKEN_ID, 1n, "0x")).to.emit(soulbound, "ProofMinted");
    expect(await soulbound.balanceOf(holder.address, TOKEN_ID)).to.equal(1n);
  });

  it("a wallet da org (issuer) também pode mintar", async () => {
    const { soulbound, orgIssuer, holder } = await deployFixture();
    await soulbound.connect(orgIssuer).mint(holder.address, TOKEN_ID, 1n, "0x");
    expect(await soulbound.balanceOf(holder.address, TOKEN_ID)).to.equal(1n);
  });

  it("mint com tokenId != 1 reverte InvalidTokenId", async () => {
    const { soulbound, holder } = await deployFixture();
    await expect(soulbound.mint(holder.address, 2n, 1n, "0x")).to.be.revertedWithCustomError(
      soulbound,
      "InvalidTokenId",
    );
  });

  it("mint acima do maxSupply reverte ExceedsMaxSupply", async () => {
    const { soulbound, holder } = await deployFixture();
    await expect(soulbound.mint(holder.address, TOKEN_ID, 2n, "0x")).to.be.revertedWithCustomError(
      soulbound,
      "ExceedsMaxSupply",
    );
  });

  it("é SOULBOUND: transferência entre wallets reverte", async () => {
    const { soulbound, holder, stranger } = await deployFixture();
    await soulbound.mint(holder.address, TOKEN_ID, 1n, "0x");
    await expect(
      soulbound.connect(holder).safeTransferFrom(holder.address, stranger.address, TOKEN_ID, 1n, "0x"),
    ).to.be.revertedWithCustomError(soulbound, "TransferBlocked");
  });

  it("revoke(from, amount, uint8 reasonCode) pela plataforma (OPERATOR) queima + emite reasonCode numérico", async () => {
    const { soulbound, holder } = await deployFixture();
    await soulbound.mint(holder.address, TOKEN_ID, 1n, "0x");
    await expect(soulbound.revoke(holder.address, 1n, 1)) // 1 = FRAUD
      .to.emit(soulbound, "ProofRevoked")
      .withArgs(holder.address, 1n, 1);
    expect(await soulbound.balanceOf(holder.address, TOKEN_ID)).to.equal(0n);
  });

  it("revoke é OPERATOR-only (estranho não revoga)", async () => {
    const { soulbound, holder, stranger } = await deployFixture();
    await soulbound.mint(holder.address, TOKEN_ID, 1n, "0x");
    await expect(soulbound.connect(stranger).revoke(holder.address, 1n, 1)).to.be.reverted;
  });
});

describe("Mint via meta-tx (ERC-2771 — org assina, relayer paga)", () => {
  it("forwarder confiável está setado no soulbound", async () => {
    const { soulbound, forwarderAddr } = await deployFixture();
    expect(await soulbound.isTrustedForwarder(forwarderAddr)).to.equal(true);
  });

  it("org assina o ForwardRequest e o RELAYER (stranger) submete + paga → mint creditado, org gasta 0", async () => {
    const { soulbound, soulboundAddr, forwarder, forwarderAddr, orgIssuer, holder, stranger } =
      await deployFixture();

    // calldata do mint(to, tokenId, amount, data)
    const data = soulbound.interface.encodeFunctionData("mint", [holder.address, TOKEN_ID, 1n, "0x"]);
    // a ORG (issuer) assina o pedido — NÃO envia tx
    const req = await signForwardRequest(forwarder, forwarderAddr, orgIssuer, soulboundAddr, data);

    const orgEthBefore = await ethers.provider.getBalance(orgIssuer.address);
    // o RELAYER (stranger, ≠ issuer) submete e paga o gás
    await expect(forwarder.connect(stranger).execute(req)).to.not.be.reverted;
    const orgEthAfter = await ethers.provider.getBalance(orgIssuer.address);

    expect(await soulbound.balanceOf(holder.address, TOKEN_ID)).to.equal(1n);
    expect(orgEthAfter).to.equal(orgEthBefore); // org não gastou gás
  });

  it("pedido assinado por NÃO-issuer (stranger) → execute reverte (role checado no meta-sender)", async () => {
    const { soulbound, soulboundAddr, forwarder, forwarderAddr, holder, stranger, platform } =
      await deployFixture();
    const data = soulbound.interface.encodeFunctionData("mint", [holder.address, TOKEN_ID, 1n, "0x"]);
    // stranger NÃO tem ISSUER_ROLE; assina o próprio pedido
    const req = await signForwardRequest(forwarder, forwarderAddr, stranger, soulboundAddr, data);
    await expect(forwarder.connect(platform).execute(req)).to.be.reverted;
    expect(await soulbound.balanceOf(holder.address, TOKEN_ID)).to.equal(0n);
  });

  it("assinatura adulterada (nonce errado) → forwarder rejeita", async () => {
    const { soulbound, soulboundAddr, forwarder, forwarderAddr, orgIssuer, holder, stranger } =
      await deployFixture();
    const data = soulbound.interface.encodeFunctionData("mint", [holder.address, TOKEN_ID, 1n, "0x"]);
    const req = await signForwardRequest(forwarder, forwarderAddr, orgIssuer, soulboundAddr, data);
    await forwarder.connect(stranger).execute(req); // consome o nonce 0
    // replay do MESMO request (nonce já usado) → reverte
    await expect(forwarder.connect(stranger).execute(req)).to.be.reverted;
  });
});
