import "@nomicfoundation/hardhat-toolbox";
import dotenv from "dotenv";

dotenv.config();

// DPP on-chain contracts.
//
// Networks:
//   fuji — Avalanche testnet, chainId 43113, gas token AVAX (faucet)
//
// These contracts are EVM and chain-agnostic; Fuji is where they are deployed
// today. The production chain has not been decided.

import type { HardhatUserConfig } from "hardhat/config";

/** Lê a 1ª chave definida dentre as env vars dadas. Sem chave = rede só-leitura. */
const accounts = (...envVars: string[]): string[] => {
  const key = envVars.map((v) => process.env[v]).find(Boolean);
  return key ? [key] : [];
};

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.27",
    settings: {
      evmVersion: "prague",
      optimizer: { enabled: true, runs: 200 },
      // viaIR: o construtor do Soulbound (12 args + herança ERC1155/ERC2771)
      // estoura o stack no code-gen legado ("Stack too deep"). O pipeline IR
      // resolve. Necessário desde o WS-4 (+bytes32 contentHash no construtor).
      viaIR: true,
    },
  },
  paths: {
    sources: "./src",
    scripts: "./scripts",
    tests: "./test",
    cache: "./.cache",
    artifacts: "./artifacts",
  },
  // Verificação de código-fonte. Fuji vai pelo Routescan (API compatível com a
  // do Etherscan), que aceita a chave pública "verifyContract" — não exige conta.
  // Sourcify como segundo canal, independente de explorer.
  etherscan: {
    apiKey: {
      fuji: process.env.SNOWTRACE_API_KEY || "verifyContract",
    },
    customChains: [
      {
        network: "fuji",
        chainId: 43113,
        urls: {
          apiURL: "https://api.routescan.io/v2/network/testnet/evm/43113/etherscan",
          browserURL: "https://testnet.snowtrace.io",
        },
      },
    ],
  },
  // Sourcify desligado: a API v1 entrou em brownout permanente (jul/2026) e o
  // hardhat-verify ainda não fala a v2. Routescan acima é o canal ativo.
  sourcify: {
    enabled: false,
  },
  networks: {
    hardhat: {},
    // Avalanche testnet. Faucet: https://core.app/tools/testnet-faucet (AVAX de teste).
    fuji: {
      url:
        process.env.BLOCKCHAIN_AVALANCHE_FUJI_RPC_URL ||
        "https://api.avax-test.network/ext/bc/C/rpc",
      chainId: 43113,
      accounts: accounts("DEPLOYER_PRIVATE_KEY_FUJI", "DEPLOYER_PRIVATE_KEY"),
    },
  },
};

export default config;
