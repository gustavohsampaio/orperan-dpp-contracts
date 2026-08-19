// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/proxy/Clones.sol";
import "./OpaliteDppSoulbound.sol";

/**
 * @title  OpaliteDppSoulboundFactory
 * @notice Um passaporte por chamada, criado como *minimal proxy* EIP-1167
 *         (`Clones.clone`) sobre uma única implementação deployada no construtor
 *         desta factory. Antes cada passaporte era um `new OpaliteDppSoulbound`
 *         completo: 2.333.023 de gás, ~9,5 KB de code deposit por passaporte.
 *         Com o proxy, ~45.000 — o mesmo passaporte por ~2% do custo.
 *
 *         A assinatura externa e o evento NÃO mudaram: o dpp-api não precisa de
 *         alteração alguma.
 *         A assinatura e o evento casam EXATAMENTE a ABI do dpp-api
 *         (`src/blockchain/abis/factory.abi.ts`):
 *           deploySoulbound(string,string,string,string,uint256,string,address,string,uint256,bytes32) -> address
 *           event SoulboundDeployed(address indexed contractAddress, string assetId)
 *
 *         O `owner` da factory (signer da plataforma) é passado como `operator`
 *         do Soulbound → detém OPERATOR_ROLE (revoke/pause) e ISSUER_ROLE (mint
 *         custodial). O `issuerWallet` (wallet da org) também recebe ISSUER_ROLE.
 */
contract OpaliteDppSoulboundFactory is Ownable {
    /// @notice assetId (passportId) → endereço do Soulbound deployado.
    mapping(string => address) public soulboundOf;
    address[] public deployed;

    /// @notice Forwarder ERC-2771 confiável (meta-tx do mint: a org assina
    /// off-chain, o relayer da plataforma paga o gás). Fica no bytecode da
    /// implementação, então vale para todos os clones.
    address public immutable trustedForwarder;

    /// @notice Implementação clonada por `deploySoulbound`. Deployada uma única
    /// vez, aqui no construtor, e travada contra inicialização.
    address public immutable implementation;

    event SoulboundDeployed(address indexed contractAddress, string assetId);

    error AlreadyDeployed(string assetId);

    constructor(address _trustedForwarder) Ownable(msg.sender) {
        trustedForwarder = _trustedForwarder;
        // `msg.sender` dentro do construtor do Soulbound é esta factory, que
        // vira o único endereço autorizado a chamar `initialize` nos clones.
        implementation = address(new OpaliteDppSoulbound(_trustedForwarder));
    }

    function deploySoulbound(
        string memory assetId,
        string memory name,
        string memory symbol,
        string memory subtype,
        uint256 totalSupply,
        string memory metadataURI,
        address issuerWallet,
        string memory linkedAssetId,
        uint256 expiresAt,
        bytes32 contentHash
    ) external onlyOwner returns (address) {
        if (soulboundOf[assetId] != address(0)) revert AlreadyDeployed(assetId);

        // Clone + initialize no MESMO tx: não há janela para outro chamador
        // inicializar o proxy antes de nós.
        address contractAddress = Clones.clone(implementation);
        OpaliteDppSoulbound(contractAddress).initialize(
            assetId,
            name,
            symbol,
            subtype,
            totalSupply,
            metadataURI,
            issuerWallet,
            owner(), // operator = plataforma (OPERATOR_ROLE + ISSUER_ROLE)
            linkedAssetId,
            expiresAt,
            contentHash
        );
        soulboundOf[assetId] = contractAddress;
        deployed.push(contractAddress);

        emit SoulboundDeployed(contractAddress, assetId);
        return contractAddress;
    }

    function deployedCount() external view returns (uint256) {
        return deployed.length;
    }
}
