// SPDX-License-Identifier: MIT
pragma solidity ^0.8.27;

import "@openzeppelin/contracts/token/ERC1155/ERC1155.sol";
import "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Supply.sol";
import "@openzeppelin/contracts/token/ERC1155/extensions/ERC1155Pausable.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/metatx/ERC2771Context.sol";
import "@openzeppelin/contracts/utils/Context.sol";

/**
 * @title  OpaliteDppSoulbound
 * @notice Soulbound (ERC-1155 intransferível) do Passaporte Digital de Produto (DPP).
 *         Cada deploy = UM passaporte (TOKEN_ID = 1). É atestação, não ativo
 *         financeiro: não-transferível e sem valor.
 *
 *         DIVERGÊNCIA DELIBERADA vs uma versão anterior deste contrato:
 *         `revoke` ancora um `uint8 reasonCode` NUMÉRICO (nunca texto livre, que
 *         seria imutável on-chain e poderia carregar PII). O motivo humano fica
 *         off-chain, no log de auditoria. Este contrato é a fonte de verdade
 *         da ABI que o backend consome.
 *
 *         MODELO DE DEPLOY (EIP-1167): este contrato NÃO é deployado por
 *         passaporte. A factory deploya UMA implementação e cria um *minimal
 *         proxy* por passaporte, inicializado via `initialize`. Cada clone tem
 *         storage próprio e delega execução a esta implementação. Custo medido:
 *         2.333.023 → ~45.000 de gás por passaporte.
 *
 *         Consequência: o estado do passaporte precisa morar em STORAGE (clones
 *         não executam construtor). `contentHash` deixou de ser `immutable` por
 *         isso — segue write-once (só `initialize` escreve, não há setter), mas a
 *         imutabilidade agora é garantida pela ausência de setter, não pelo
 *         compilador. `_trustedForwarder` do ERC2771Context permanece `immutable`
 *         na implementação e é compartilhado por todos os clones (é o mesmo
 *         forwarder da plataforma), o que é o comportamento desejado.
 *
 * Roles:
 *   - DEFAULT_ADMIN_ROLE: plataforma (operator) — governança das roles.
 *   - ISSUER_ROLE:        emissor (wallet custodial da org) + plataforma — mint.
 *   - OPERATOR_ROLE:      plataforma — revoke/pause/burn forçado.
 */
contract OpaliteDppSoulbound is ERC1155, ERC1155Supply, ERC1155Pausable, AccessControl, ERC2771Context {
    // ─── Roles ──────────────────────────────────────────────────────────────
    bytes32 public constant ISSUER_ROLE = keccak256("ISSUER_ROLE");
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");

    // ─── Token ID fixo por contrato (single-token soulbound) ────────────────
    uint256 public constant TOKEN_ID = 1;

    // ─── Metadados imutáveis ────────────────────────────────────────────────
    string public assetId;
    string public name;
    string public symbol;
    string public subtype;
    uint256 public maxSupply;
    string public linkedAssetId;
    uint256 public expiresAt; // 0 = sem expiração

    // ─── Âncora de conteúdo (WS-4) ──────────────────────────────────────────
    // contentHash = keccak256(canonicalBytes(recortePUBLIC)) — snapshot imutável
    // do conteúdo público (JCS/RFC 8785), fixado no deploy. merkleRoot = raiz dos
    // eventos (recorte público), REGRAVÁVEL em lote pelo operador. Nunca PII/cru.
    // Write-once: escrito só por `initialize`, sem setter em lugar nenhum.
    // Não pode ser `immutable` porque clones EIP-1167 não executam construtor.
    bytes32 public contentHash;
    bytes32 public merkleRoot;      // 0 = sem eventos ancorados
    uint64  public contentVersion;  // incrementa a cada reanchor bem-sucedido

    // ─── Eventos ────────────────────────────────────────────────────────────
    event ProofMinted(address indexed to, uint256 amount, address indexed minter);
    event ProofBurned(address indexed from, uint256 amount, address indexed burner);
    // reasonCode numérico (DPP V2). O motivo humano fica off-chain.
    event ProofRevoked(address indexed from, uint256 amount, uint8 reasonCode);
    event LinkedAssetUpdated(string oldAssetId, string newAssetId);
    event ContentReanchored(bytes32 indexed oldRoot, bytes32 indexed newRoot, uint64 version, uint256 count);

    // ─── Erros ──────────────────────────────────────────────────────────────
    error TransferBlocked();
    error ExceedsMaxSupply(uint256 requested, uint256 available);
    error ZeroAmount();
    error NotAuthorizedToBurn();
    error ProofExpired();
    error InvalidTokenId();
    error EmptyMerkleRoot();
    error AlreadyInitialized();
    error OnlyFactory();
    error UnchangedMerkleRoot();

    /// @notice Factory que deployou esta implementação — única autorizada a
    /// inicializar clones. `immutable` vive no bytecode da implementação, então
    /// todo clone lê o mesmo valor através do delegatecall.
    address public immutable factory;

    /// @dev Guarda de inicialização. Na implementação já nasce `true` (o
    /// construtor a trava); em cada clone nasce `false` porque o storage é novo.
    bool private _initialized;

    /// @param _trustedForwarder Forwarder ERC-2771 da plataforma, compartilhado
    ///        por todos os clones (fica no bytecode da implementação).
    constructor(address _trustedForwarder) ERC1155("") ERC2771Context(_trustedForwarder) {
        factory = msg.sender;
        _initialized = true; // a própria implementação nunca é inicializável
    }

    /// @notice Inicializa um clone. Chamada pela factory no mesmo tx do `clone`,
    ///         portanto não há janela para front-run. Idempotência garantida
    ///         pelo guard: uma segunda chamada reverte.
    function initialize(
        string memory _assetId,
        string memory _name,
        string memory _symbol,
        string memory _subtype,
        uint256 _maxSupply,
        string memory _metadataURI,
        address _issuer,
        address _operator,
        string memory _linkedAssetId,
        uint256 _expiresAt,
        bytes32 _contentHash
    ) external {
        if (msg.sender != factory) revert OnlyFactory();
        if (_initialized) revert AlreadyInitialized();
        _initialized = true;

        require(_maxSupply > 0, "DppSoulbound: maxSupply must be > 0");
        require(_issuer != address(0), "DppSoulbound: invalid issuer");
        require(_operator != address(0), "DppSoulbound: invalid operator");

        _setURI(_metadataURI);

        assetId = _assetId;
        name = _name;
        symbol = _symbol;
        subtype = _subtype;
        maxSupply = _maxSupply;
        linkedAssetId = _linkedAssetId;
        expiresAt = _expiresAt;
        contentHash = _contentHash; // write-once — snapshot público (0 se flag OFF)

        _grantRole(DEFAULT_ADMIN_ROLE, _operator);
        _grantRole(OPERATOR_ROLE, _operator);
        // Issuer (org) E plataforma (operator) podem mintar: enquanto a assinatura
        // for do signer da plataforma (pré-KMS-por-org), a plataforma minta; com
        // KMS-por-org a própria wallet da org assina. Ambos seguros (custodial).
        _grantRole(ISSUER_ROLE, _issuer);
        _grantRole(ISSUER_ROLE, _operator);
    }

    // ─── Mint ───────────────────────────────────────────────────────────────
    // Assinatura casada com a ABI do backend: mint(to, tokenId, amount, data).
    // tokenId é exigido == TOKEN_ID (single-token). `data` repassado ao _mint.
    function mint(
        address to,
        uint256 tokenId,
        uint256 amount,
        bytes calldata data
    ) external onlyRole(ISSUER_ROLE) {
        if (tokenId != TOKEN_ID) revert InvalidTokenId();
        if (amount == 0) revert ZeroAmount();
        if (expiresAt > 0 && block.timestamp > expiresAt) revert ProofExpired();

        uint256 available = maxSupply - totalSupply(TOKEN_ID);
        if (amount > available) revert ExceedsMaxSupply(amount, available);

        _mint(to, TOKEN_ID, amount, data);
        emit ProofMinted(to, amount, msg.sender);
    }

    // ─── Burn ───────────────────────────────────────────────────────────────
    function burn(address from, uint256 amount) external {
        if (amount == 0) revert ZeroAmount();

        bool isOperator = hasRole(OPERATOR_ROLE, msg.sender);
        bool isSelf = from == msg.sender;
        bool isApproved = isApprovedForAll(from, msg.sender);
        if (!isSelf && !isApproved && !isOperator) revert NotAuthorizedToBurn();

        _burn(from, TOKEN_ID, amount);
        emit ProofBurned(from, amount, msg.sender);
    }

    // ─── Revoke (DPP V2: reasonCode numérico, sem PII on-chain) ─────────────
    function revoke(
        address from,
        uint256 amount,
        uint8 reasonCode
    ) external onlyRole(OPERATOR_ROLE) {
        if (amount == 0) revert ZeroAmount();
        _burn(from, TOKEN_ID, amount);
        emit ProofRevoked(from, amount, reasonCode);
    }

    // ─── Reanchor (WS-4): regrava a raiz Merkle dos eventos em lote ─────────
    // 1 tx por lote (não por evento). `count` = nº de folhas para auditoria off-chain.
    // Rejeita raiz zero e raiz igual (no-op) para não incrementar versão à toa.
    function setMerkleRoot(bytes32 newRoot, uint256 count) external onlyRole(OPERATOR_ROLE) {
        if (newRoot == bytes32(0)) revert EmptyMerkleRoot();
        if (newRoot == merkleRoot) revert UnchangedMerkleRoot();
        bytes32 old = merkleRoot;
        merkleRoot = newRoot;
        contentVersion += 1;
        emit ContentReanchored(old, newRoot, contentVersion, count);
    }

    // ─── Pause ──────────────────────────────────────────────────────────────
    function pause() external onlyRole(OPERATOR_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(OPERATOR_ROLE) {
        _unpause();
    }

    // ─── Linked asset / URI ─────────────────────────────────────────────────
    function setLinkedAsset(string calldata newLinkedAssetId) external onlyRole(OPERATOR_ROLE) {
        string memory old = linkedAssetId;
        linkedAssetId = newLinkedAssetId;
        emit LinkedAssetUpdated(old, newLinkedAssetId);
    }

    function uri(uint256) public view override returns (string memory) {
        return super.uri(TOKEN_ID);
    }

    function setURI(string memory newURI) external onlyRole(OPERATOR_ROLE) {
        _setURI(newURI);
    }

    function isExpired() external view returns (bool) {
        return expiresAt > 0 && block.timestamp > expiresAt;
    }

    // ─── Soulbound: bloqueia transferências (permite mint/burn) ─────────────
    function _update(
        address from,
        address to,
        uint256[] memory ids,
        uint256[] memory values
    ) internal override(ERC1155, ERC1155Supply, ERC1155Pausable) {
        if (from != address(0) && to != address(0)) revert TransferBlocked();
        super._update(from, to, ids, values);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC1155, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }

    // ─── Meta-tx (ERC-2771): resolve _msgSender/_msgData via trusted forwarder ──
    // Quando o mint vem pelo Forwarder confiável, _msgSender() é a ORG (que
    // assinou o ForwardRequest off-chain) — é o que o onlyRole(ISSUER_ROLE) valida.
    // O gás é pago por quem CHAMA o forwarder (relayer da plataforma).

    function _msgSender()
        internal
        view
        override(Context, ERC2771Context)
        returns (address)
    {
        return ERC2771Context._msgSender();
    }

    function _msgData()
        internal
        view
        override(Context, ERC2771Context)
        returns (bytes calldata)
    {
        return ERC2771Context._msgData();
    }

    function _contextSuffixLength()
        internal
        view
        override(Context, ERC2771Context)
        returns (uint256)
    {
        return ERC2771Context._contextSuffixLength();
    }
}
