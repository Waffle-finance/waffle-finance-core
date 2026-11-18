# Frontend Troubleshooting

## Wallet network switch rejected or unsupported

When the app needs your wallet on a different network (for example after
toggling Testnet/Mainnet), it asks the connected wallet to switch.

**What to expect:**

- **MetaMask (Ethereum):** the app sends a `wallet_switchEthereumChain`
  request. Approve it in MetaMask to switch. If the network is unknown to
  MetaMask (error 4902), the app follows up with a
  `wallet_addEthereumChain` request instead.
- **If you reject the request (error 4001):** the app stays on its current
  network. You will see a "Network change cancelled" notice — a rejection
  is *not* a successful connection, and the app does not pretend it is.
- **If the switch fails for any other reason:** you will see a "Network
  switch failed" notice asking you to switch the wallet network manually
  (in the wallet extension) and then try the toggle again.
- **Freighter (Stellar) cannot be switched programmatically:** there is no
  automatic switch. Open the Freighter extension and change its network
  yourself, then the app re-detects it (it polls every few seconds).

**Manual recovery:**

1. Open the wallet extension and switch it to the network the app shows
   (Testnet: Sepolia / Stellar Testnet; Mainnet: Ethereum / Stellar Mainnet).
2. If the yellow "wallet network does not match" banner is shown
   (`NetworkMismatchBanner`, driven by `useNetworkMode().hasAnyMismatch`
   / the `network_mismatch` wallet error code), use its
   **"Switch wallet to …"** button to retry the guided switch, or
   **"Switch app to wallet"** to move the app to the wallet's network.
3. The app never asks for your seed phrase or private keys. Anyone who
   does is not us — decline and report it.
