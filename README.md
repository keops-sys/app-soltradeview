./start.sh

# Setup
Move a .env file in the root of the project and add the following:

`mv .env.example .env`

pm2 link s6vupg2mr5gcavw 3ua3fp6vqgzmf1p


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


NEW_RELIC_AI_MONITORING_ENABLED=true NEW_RELIC_CUSTOM_INSIGHTS_EVENTS_MAX_SAMPLES_STORED=100k NEW_RELIC_SPAN_EVENTS_MAX_SAMPLES_STORED=10k NEW_RELIC_APP_NAME=soltradeview NEW_RELIC_LICENSE_KEY=04973d82d5b3753d2f011af75b78ed74FFFFNRAL node -r newrelic index.js