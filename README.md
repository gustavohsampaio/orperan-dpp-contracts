# Opalite DPP — on-chain product passport contracts

Every physical lot gets its own contract: an issuer-signed content hash, a one-way
lifecycle, and Merkle-anchored batches of events as the lot moves. The payload stays
off-chain — only a 32-byte hash and the issuer's authority reach the ledger.

Built by [Opalite](https://opalitetrust.com) for Brazil's agro-export economy, where the
EU Deforestation Regulation starts requiring proof of origin on 30 December 2026.

These contracts are **EVM and chain-agnostic**. Avalanche Fuji is where they run today.

---

## Deployed on Avalanche Fuji

chainId `43113` · all three source-verified on Snowtrace

| Contract | Address |
|---|---|
| `OpaliteDppSoulboundFactory` | [`0x8f8EEC686823b16A665d7F919A9a374FA5FdDe03`](https://testnet.snowtrace.io/address/0x8f8EEC686823b16A665d7F919A9a374FA5FdDe03#code) |
| `OpaliteDppSoulbound` (implementation) | [`0xF21C7bA4c03237e02bd3466A2c21E791CD2Dc361`](https://testnet.snowtrace.io/address/0xF21C7bA4c03237e02bd3466A2c21E791CD2Dc361#code) |
| `OpaliteDppForwarder` (ERC-2771) | [`0x731b23577ebf80587cd6742afCD2AB801B471d10`](https://testnet.snowtrace.io/address/0x731b23577ebf80587cd6742afCD2AB801B471d10#code) |
| Sample passport (a clone) | [`0x079B8f0f8AC57e811fF4383E4A6Eb9B032cAf859`](https://testnet.snowtrace.io/address/0x079B8f0f8AC57e811fF4383E4A6Eb9B032cAf859) |

---

## One passport used to cost 2.3M gas. Now it costs 451k.

Each passport was a full contract deployment — 9,551 bytes of code, paid again on every
lot. It is now an [EIP-1167](https://eips.ethereum.org/EIPS/eip-1167) minimal proxy over a
single implementation deployed once by the factory.

| | before | after |
|---|---:|---:|
| `deploySoulbound` | 2,333,023 | **451,253** |
| full cycle incl. `mint` | 2,440,030 | **558,475** |

Measured on Fuji, not in a local EVM.

**Confirm it yourself.** A minimal proxy is 45 bytes — that is the whole tell:

```bash
curl -s -X POST https://api.avax-test.network/ext/bc/C/rpc \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_getCode",
           "params":["0x079B8f0f8AC57e811fF4383E4A6Eb9B032cAf859","latest"]}'
# → 45 bytes (the passport, a proxy)
# → 12,126 bytes for the implementation it delegates to
```

Why it matters: at 2.3M gas the economics only close for bulk shipments — the traders who
already have compliance departments. At 451k, a smallholder's single lot can carry its own
passport.

---

## The contracts

**`OpaliteDppSoulbound`** — a non-transferable ERC-1155 (one token id per contract). Roles
split platform from issuer: the organization mints, the platform operates (revoke, pause,
re-anchor). `revoke` records a **numeric** reason code, never free text — an immutable
string on-chain could carry personal data. Transfers between wallets revert; only mint and
burn are possible.

**`OpaliteDppSoulboundFactory`** — clones the implementation per passport and initializes it
in the same transaction. `initialize` is callable only by the factory (`factory` is
`immutable`, so it lives in the implementation bytecode and every clone reads the same
value) and is guarded against a second call.

**`OpaliteDppForwarder`** — ERC-2771 forwarder. The organization signs a mint off-chain and
the platform relayer pays the gas, so the organization never has to hold a gas balance.

---

## Build and test

Prerequisites: Node >= 20.

```bash
npm install
npm run compile      # solc 0.8.27, evmVersion prague, viaIR
npm test             # 19 tests
npm run verify-abis  # asserts the ABI surface our backend consumes is intact
```

The suite covers the full role matrix, the soulbound transfer block, supply limits,
content re-anchoring, and four ERC-2771 meta-transaction cases — including that a request
signed by a non-issuer is rejected at the meta-sender, not just at `msg.sender`.

Deploy your own instance:

```bash
cp .env.example .env      # DEPLOYER_PRIVATE_KEY, funded on Fuji
npm run deploy:fuji
```

---

## Scope and honest caveats

- **Testnet only.** Nothing here is on Avalanche mainnet.
- **Unaudited.** No third-party security audit has been performed.
- **`contentHash` is write-once, not `immutable`.** Clones do not run a constructor, so it
  is set in `initialize` and never written again. There is no setter — but the guarantee is
  the absence of one, not a compiler check.
- **Production runs off-chain content seals today**; the on-chain layer is in gated rollout.
  This repository is the on-chain half, not a description of what is live.
- Contract comments are in Portuguese; the team is in Goiânia, Brazil.

## License

[Apache-2.0](LICENSE).
