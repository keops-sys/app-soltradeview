
Create a .env file in the root of the project and add the following:
```
PRIVATE_KEY=5xqp2sY7SVD...tRoiMz7JNarG6zKhRvdaHx8hiPS
PORT=80

```




acme.sh --issue --standalone -d soltradeview.com


[Thu Nov  7 14:11:44 UTC 2024] Your cert is in: /root/.acme.sh/soltradeview.com_ecc/soltradeview.com.cer
[Thu Nov  7 14:11:44 UTC 2024] Your cert key is in: /root/.acme.sh/soltradeview.com_ecc/soltradeview.com.key
[Thu Nov  7 14:11:44 UTC 2024] The intermediate CA cert is in: /root/.acme.sh/soltradeview.com_ecc/ca.cer
[Thu Nov  7 14:11:44 UTC 2024] And the full-chain cert is in: /root/.acme.sh/soltradeview.com_ecc/fullchain.cer