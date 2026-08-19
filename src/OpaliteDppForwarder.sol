// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/metatx/ERC2771Forwarder.sol";

/**
 * @title  OpaliteDppForwarder
 * @notice Trusted forwarder ERC-2771 (wrapper do contrato AUDITADO da OZ) para o
 *         mint custodial-por-org sem fricção de gás:
 *           - a ORG assina um ForwardRequest (EIP-712) com a chave KMS dela;
 *           - o RELAYER da plataforma chama execute(request) e PAGA o gás;
 *           - o Soulbound (ERC2771Context) enxerga _msgSender() == ORG.
 *         A org nunca segura/recebe USDC → fora do escopo PSAV.
 *
 *         Proteções herdadas da OZ: verificação da assinatura EIP-712, nonce
 *         por-remetente (anti-replay) e deadline. O nome do domínio EIP-712 é
 *         "OpaliteDppForwarder" (usado off-chain pra montar a assinatura).
 */
contract OpaliteDppForwarder is ERC2771Forwarder {
    constructor() ERC2771Forwarder("OpaliteDppForwarder") {}
}
