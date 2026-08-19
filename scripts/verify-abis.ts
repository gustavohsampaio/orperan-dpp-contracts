/* Valida que os contratos compilados expõem EXATAMENTE as funções/eventos que a
 * ABI do dpp-api consome (src/blockchain/abis/*.ts). Roda após `compile`.
 *   pnpm verify-abis
 * Falha (exit 1) se alguma assinatura esperada não existir no contrato real. */
import hre from "hardhat";
import { ethers } from "ethers";

const { artifacts } = hre;

// Assinaturas canônicas que o dpp-api espera (= soulbound.abi.ts / factory.abi.ts).
const EXPECTED = {
  OpaliteDppSoulboundFactory: {
    functions: ["deploySoulbound(string,string,string,string,uint256,string,address,string,uint256,bytes32)"],
    events: ["SoulboundDeployed(address,string)"],
  },
  OpaliteDppSoulbound: {
    functions: [
      "mint(address,uint256,uint256,bytes)",
      "revoke(address,uint256,uint8)",
      "balanceOf(address,uint256)",
      "setMerkleRoot(bytes32,uint256)",
      "contentHash()",
      "merkleRoot()",
      "contentVersion()",
    ],
    events: [
      "ProofRevoked(address,uint256,uint8)",
      "TransferSingle(address,address,address,uint256,uint256)",
      "ContentReanchored(bytes32,bytes32,uint64,uint256)",
    ],
  },
} as const;

async function main() {
  let failures = 0;

  for (const [contractName, spec] of Object.entries(EXPECTED)) {
    const art = await artifacts.readArtifact(contractName);
    const iface = new ethers.Interface(art.abi);
    console.log(`\n── ${contractName} ──`);

    for (const sig of spec.functions) {
      try {
        const f = iface.getFunction(sig);
        console.log(`  ✅ fn  ${sig}  selector=${f!.selector}`);
      } catch {
        console.log(`  ❌ fn  ${sig}  AUSENTE`);
        failures++;
      }
    }
    for (const sig of spec.events) {
      try {
        const e = iface.getEvent(sig);
        console.log(`  ✅ ev  ${sig}  topic=${e!.topicHash.slice(0, 18)}…`);
      } catch {
        console.log(`  ❌ ev  ${sig}  AUSENTE`);
        failures++;
      }
    }
  }

  console.log(
    failures === 0
      ? "\n✅ ABIs do dpp-api casam 100% com os contratos compilados."
      : `\n❌ ${failures} assinatura(s) divergente(s) — ajustar contrato ou ABI.`,
  );
  if (failures > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
