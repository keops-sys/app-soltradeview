./start.sh

https://soltradeview.com/
https://soltradeview.com/
https://soltradeview.com/
https://soltradeview.com/
https://soltradeview.com/
Create a .env file in the root of the project and add the following:

# SSL Certificate Generation
acme.sh --issue --standalone -d soltradeview.com -d www.soltradeview.com

# Certificate Locations
The certificates will be generated in:
- Private Key: /root/.acme.sh/soltradeview.com_ecc/soltradeview.com.key
- Full Chain: /root/.acme.sh/soltradeview.com_ecc/fullchain.cer
- CA Cert: /root/.acme.sh/soltradeview.com_ecc/ca.cer