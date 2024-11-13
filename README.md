./start.sh

# Setup
Move a .env file in the root of the project and add the following:

`mv .env.example .env`


# Start
```
./start.sh
```
# SSL Certificate Generation
```
./get-certificates.sh
```

## Docs Jupiter trtansactions

https://station.jup.ag/docs/apis/landing-transactions

# Certificate Locations
The certificates will be generated in:
- Private Key: /root/.acme.sh/soltradeview.com_ecc/soltradeview.com.key
- Full Chain: /root/.acme.sh/soltradeview.com_ecc/fullchain.cer
- CA Cert: /root/.acme.sh/soltradeview.com_ecc/ca.cer


# RPC Nodes Providers
https://www.alchemy.com/list-of/rpc-node-providers-on-solana