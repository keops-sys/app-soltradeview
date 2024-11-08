./start.sh

# Setup
Create a .env file in the root of the project and add the following:

```
# Solana Configuration
SOLANA_RPC_ENDPOINT=https://api.mainnet-beta.solana.com
SOLANA_RPC_ENDPOINT=https://thrilling-red-tree.solana-mainnet.quiknode.pro/392c7c4a3140c4fcef39f1be375947284e2f799c
SOLANA_RPC_ENDPOINT=https://solana-api.instantnodes.io/token-p7mcZBiFVLTnQpv5s6ISa3zVSu8lUVTa
SOLANA_RPC_ENDPOINT=https://mainnet.helius-rpc.com/?api-key=292afef7-e149-4010-862b-f611beb385fc
SOLANA_RPC_ENDPOINT=https://solana.drpc.org

PRIVATE_KEY=

# PostHog Configuration
POSTHOG_API_KEY=
POSTHOG_HOST=https://eu.i.posthog.com

# Environment
NODE_ENV=production

# Trading Configuration
MIN_SOL_BALANCE=0.1
SLIPPAGE_BPS=300
PRIORITY_FEE=11000000
PORT=80
```

# Start
```
./start.sh
```
# SSL Certificate Generation
```
./get-certificates.sh
```

# Certificate Locations
The certificates will be generated in:
- Private Key: /root/.acme.sh/soltradeview.com_ecc/soltradeview.com.key
- Full Chain: /root/.acme.sh/soltradeview.com_ecc/fullchain.cer
- CA Cert: /root/.acme.sh/soltradeview.com_ecc/ca.cer


# RPC Nodes Providers
https://www.alchemy.com/list-of/rpc-node-providers-on-solana