/* Deploy do Forwarder + Factory do DPP. Uso:
 *   npm run deploy:fuji    (Avalanche testnet, chainId 43113)
 * A chave vem de DEPLOYER_PRIVATE_KEY_<REDE> ou, na falta, DEPLOYER_PRIVATE_KEY.
 * Saída: os nomes exatos das envs a colar no .env do backend, por rede.
 *
 * A factory deploya a implementação do Soulbound no próprio construtor e passa
 * a clonar por EIP-1167 — por isso ela custa mais e cada passaporte custa ~79%
 * menos (ver historico.md).
 */
import hre from "hardhat";

const { ethers, network } = hre;

async function main() {
  const [deployer] = await ethers.getSigners();
  const bal = await ethers.provider.getBalance(deployer.address);
  console.log(`Rede:     ${network.name}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Saldo:    ${ethers.formatEther(bal)} (gas token)`);

  // 1) Forwarder ERC-2771 (relayer/meta-tx do mint por-org)
  const Forwarder = await ethers.getContractFactory("OpaliteDppForwarder");
  const forwarder = await Forwarder.deploy();
  await forwarder.waitForDeployment();
  const forwarderAddr = await forwarder.getAddress();
  console.log(`\n✅ OpaliteDppForwarder: ${forwarderAddr}`);

  // 2) Factory (recebe o forwarder, que repassa a cada Soulbound)
  const Factory = await ethers.getContractFactory("OpaliteDppSoulboundFactory");
  const factory = await Factory.deploy(forwarderAddr);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log(`✅ OpaliteDppSoulboundFactory: ${factoryAddr}`);

  // Prefixo das envs por rede, casando com o registry de redes do backend
  // (src/blockchain/networks.ts).
  const ENV_PREFIX: Record<string, string> = {
    fuji: "AVALANCHE_FUJI",
  };
  const prefix = ENV_PREFIX[network.name];

  const implAddr = await factory.implementation();
  console.log(`   └─ implementação clonada: ${implAddr}`);

  if (prefix) {
    console.log("\nCole no .env do backend:");
    console.log(`   FORWARDER_${prefix}_ADDRESS=${forwarderAddr}`);
    console.log(`   FACTORY_${prefix}_ADDRESS=${factoryAddr}`);
  } else {
    console.log(`\n⚠️  Rede "${network.name}" sem prefixo de env mapeado neste script.`);
    console.log(`   forwarder=${forwarderAddr}  factory=${factoryAddr}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
