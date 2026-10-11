# Deploying the All Star Players store API

**Nothing in this document has been run.** The container this was built in has
no access to your AWS account and no network route to Square at all — both
`connect.squareup.com` and `connect.squareupsandbox.com` are blocked by its
egress policy. So the code is finished and tested against doubles, and every
step that touches your real account is yours to run.

Work the sandbox column first, prove a real test payment end to end, then do
the production column. The two are separate secrets, separate functions and
separate tables; nothing is shared.

---

## 0. What you must supply

The storefront will not invent any of these. A fulfillment method that is not
configured is **unavailable**, not free.

| # | Setting | Where it goes | What happens without it |
| --- | --- | --- | --- |
| 1 | **Production Square access token** | secret `SQUARE_ACCESS_TOKEN` | nothing works |
| 2 | **Production location ID** — the real shop, see §3 | secret `SQUARE_LOCATION_ID` | nothing works |
| 3 | **Webhook signature key** | secret `SQUARE_WEBHOOK_SIGNATURE_KEY` | order status still works by polling; webhooks are refused |
| 4 | **Shipping rates and zones** | env `SHIPPING_RATES` | shipping is not offered at all |
| 5 | **Pickup on/off + shop address** | env `PICKUP_ENABLED`, `PICKUP_ADDRESS` | pickup is not offered at all |
| 6 | **Pickup policy wording** | env `PICKUP_POLICY` | falls back to "we will contact you when it is ready" |
| 7 | **Do your Square tax rules cover online orders?** | checked by you in Square | see §8 — this one needs your eyes |
| 8 | **Sell items Square is not counting?** | env `SELL_UNTRACKED_VARIATIONS` | off: untracked items are listed as "availability unknown" and cannot be bought |

Decide #7 and #8 before you take a real payment.

---

## 1. Build the package

The function is several modules plus the AWS SDK, so it ships as a zip rather
than a console paste.

```bash
cd backend
npm install           # once
npm test              # 78 checks, all against doubles — see the report
npm run package       # produces backend/function.zip
```

## 2. Create the DynamoDB table

One table, on-demand, with a TTL attribute so nothing accumulates cost. Do
this twice — once per environment.

```bash
for ENV in sandbox production; do
aws dynamodb create-table \
  --table-name "all-star-players-store-$ENV" \
  --attribute-definitions AttributeName=pk,AttributeType=S AttributeName=sk,AttributeType=S \
  --key-schema AttributeName=pk,KeyType=HASH AttributeName=sk,KeyType=RANGE \
  --billing-mode PAY_PER_REQUEST \
  --region us-east-1
aws dynamodb update-time-to-live \
  --table-name "all-star-players-store-$ENV" \
  --time-to-live-specification "Enabled=true,AttributeName=ttl" \
  --region us-east-1
done
```

Every row carries a `ttl`: the catalog cache expires in minutes, idempotency
records in 48 hours, webhook de-duplication keys in 7 days, stock holds in 15
minutes, and order records after `ORDER_RETENTION_DAYS` (90 by default).

## 3. Find the real production location ID

**Do not assume the sandbox location `LPDXRBQ28WHB6` means anything in
production.** It does not. Ask Square:

```bash
curl -s https://connect.squareup.com/v2/locations \
  -H "Authorization: Bearer $SQUARE_PRODUCTION_TOKEN" \
  -H "Square-Version: 2026-09-16" \
| python3 -m json.tool
```

Pick the one whose `address` is 96-03 37th Ave and whose `status` is `ACTIVE`.
That `id` is what goes in the secret. Getting this wrong means selling stock
the shop does not have.

## 4. Create the secrets

```bash
# production
aws secretsmanager create-secret \
  --name all-star-players/square/production \
  --region us-east-1 \
  --secret-string '{
    "SQUARE_ACCESS_TOKEN": "EAAAl...PRODUCTION...",
    "SQUARE_APPLICATION_ID": "sq0idp-...",
    "SQUARE_LOCATION_ID": "L...THE REAL ONE FROM STEP 3...",
    "SQUARE_ENVIRONMENT": "production",
    "SQUARE_WEBHOOK_SIGNATURE_KEY": "...from the webhook subscription...",
    "ADMIN_REFRESH_KEY": "...any long random string you choose..."
  }'
```

Do the same with `all-star-players/square/sandbox` and
`"SQUARE_ENVIRONMENT": "sandbox"`.

The function refuses to start if `SQUARE_ENVIRONMENT` is anything but
`sandbox` or `production`, and refuses outright if the secret says production
but the token looks like a sandbox one. A sandbox token cannot reach the
production host: the base URL is derived from the environment, not configured
separately.

## 5. Create the Lambda functions

Two functions, same zip, different environment variables.

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

aws lambda create-function \
  --function-name all-star-players-store-production \
  --runtime nodejs24.x --handler index.handler \
  --role "arn:aws:iam::${ACCOUNT_ID}:role/all-star-players-store-production-role" \
  --zip-file fileb://function.zip \
  --timeout 25 --memory-size 512 \
  --region us-east-1
```

**Timeout 25 seconds, not the 3-second default.** A cold catalog fetch walks
several pages of Square's catalog and several inventory batches.

Then the configuration. This is the part you will come back and edit:

```bash
aws lambda update-function-configuration \
  --function-name all-star-players-store-production \
  --region us-east-1 \
  --environment 'Variables={
    SECRET_ID=all-star-players/square/production,
    TABLE_NAME=all-star-players-store-production,
    ALLOWED_ORIGINS=https://bellmorewebdesign.github.io,
    RETURN_URL=https://bellmorewebdesign.github.io/AllStarPlayers/order.html,
    WEBHOOK_NOTIFICATION_URL=https://REPLACE.execute-api.us-east-1.amazonaws.com/default/webhooks/square,

    PICKUP_ENABLED=true,
    PICKUP_ADDRESS=96-03 37th Ave\, Queens\, NY 11368,

    SHIPPING_ENABLED=true,
    SHIPPING_RATES=[{"id":"ny"\,"label":"New York"\,"amount":800\,"currency":"USD"\,"countries":["US"]\,"states":["NY"\,"NJ"\,"CT"]\,"freeOver":15000}\,{"id":"us"\,"label":"United States"\,"amount":1400\,"currency":"USD"\,"countries":["US"]\,"states":[]}],

    CATALOG_TTL_SECONDS=600,
    SELL_UNTRACKED_VARIATIONS=false,
    STOCK_HOLDS_ENABLED=true,
    STOCK_HOLD_SECONDS=900,
    APPLY_CATALOG_TAXES=true,
    STORE_NAME=All Star Players,
    STORE_PHONE=+17185051038
  }'
```

Commas inside the JSON need escaping on the CLI; the console is easier for
`SHIPPING_RATES`. Paste it there as plain JSON.

### Every setting

| Variable | Default | What it does |
| --- | --- | --- |
| `SECRET_ID` | *(required)* | which Secrets Manager secret to read |
| `TABLE_NAME` | *(required)* | the DynamoDB table |
| `ALLOWED_ORIGINS` | the GitHub Pages origin | comma-separated, for the fallback CORS headers |
| `RETURN_URL` | the order page on GitHub Pages | where Square sends the buyer back |
| `WEBHOOK_NOTIFICATION_URL` | *(none)* | must match the URL registered in Square **exactly**, or every signature fails |
| `PICKUP_ENABLED` / `PICKUP_ADDRESS` / `PICKUP_POLICY` | off | pickup is offered only with both of the first two |
| `SHIPPING_ENABLED` / `SHIPPING_RATES` | off | shipping is offered only with a valid rates array |
| `SELL_UNTRACKED_VARIATIONS` | `false` | whether items Square is not counting can be bought |
| `STOCK_HOLDS_ENABLED` / `STOCK_HOLD_SECONDS` | on / 900 | the soft hold, see §9 |
| `CATALOG_TTL_SECONDS` | 600 | how stale browsing may be; checkout always revalidates |
| `APPLY_CATALOG_TAXES` | `true` | attach the shop's own Square tax rules to the order |
| `SQUARE_ASK_FOR_SHIPPING_ADDRESS` | `false` | see §7 |
| `ORDER_RETENTION_DAYS` | 90 | how long order rows live |
| `MAX_CART_LINES` / `MAX_LINE_QUANTITY` | 40 / 20 | ceilings |

## 6. IAM: the narrowest policy that works

The function reads one secret and uses one table. Nothing else.

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "Logs",
      "Effect": "Allow",
      "Action": ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
      "Resource": "arn:aws:logs:us-east-1:ACCOUNT_ID:log-group:/aws/lambda/all-star-players-store-production:*"
    },
    {
      "Sid": "ReadOneSecret",
      "Effect": "Allow",
      "Action": ["secretsmanager:GetSecretValue"],
      "Resource": "arn:aws:secretsmanager:us-east-1:ACCOUNT_ID:secret:all-star-players/square/production-*"
    },
    {
      "Sid": "OneTable",
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem",
        "dynamodb:DeleteItem", "dynamodb:Query", "dynamodb:BatchWriteItem"
      ],
      "Resource": "arn:aws:dynamodb:us-east-1:ACCOUNT_ID:table/all-star-players-store-production"
    }
  ]
}
```

No `dynamodb:Scan`, no `secretsmanager:*`, no wildcard resources. The sandbox
role is the same with `sandbox` substituted.

## 7. API Gateway: routes, CORS and the stage prefix

Reuse the existing HTTP API `n9ecaydkv4` for sandbox if you like; make a
second API for production so the two cannot be confused.

**The route keys do not include the stage.** `GET /catalog` is what answers
`https://.../default/catalog`. The function strips the stage prefix itself, so
it works on a named stage or on `$default`.

```bash
API=n9ecaydkv4
FN=arn:aws:lambda:us-east-1:ACCOUNT_ID:function:all-star-players-store-sandbox

INT=$(aws apigatewayv2 create-integration --api-id $API --region us-east-1 \
  --integration-type AWS_PROXY --payload-format-version 2.0 \
  --integration-uri "$FN" --query IntegrationId --output text)

for ROUTE in "GET /config" "GET /catalog" "POST /catalog/refresh" \
             "POST /cart/validate" "POST /checkout" "GET /order" \
             "POST /webhooks/square"; do
  aws apigatewayv2 create-route --api-id $API --region us-east-1 \
    --route-key "$ROUTE" --target "integrations/$INT"
done

aws lambda add-permission \
  --function-name all-star-players-store-sandbox \
  --statement-id apigw-store --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:us-east-1:ACCOUNT_ID:$API/*/*/*" \
  --region us-east-1
```

Delete the old `GET /products` and `POST /checkout` single-item routes once
the new ones answer, or leave `/products` as a dead end — nothing calls it.

CORS, on the API itself:

```bash
aws apigatewayv2 update-api --api-id $API --region us-east-1 \
  --cors-configuration AllowOrigins=https://bellmorewebdesign.github.io,\
AllowMethods=GET,AllowMethods=POST,AllowMethods=OPTIONS,\
AllowHeaders=content-type,MaxAge=600
```

The origin is the bare host with **no repository path** — a browser never
sends one. Check it:

```bash
curl -i -H 'Origin: https://bellmorewebdesign.github.io' \
  https://$API.execute-api.us-east-1.amazonaws.com/default/config
```

You want an `access-control-allow-origin` line back.

### Hosted checkout and the shipping address — verify this in sandbox

The order carries a `SHIPMENT` fulfillment with the recipient and address this
service validated, and `ask_for_shipping_address` is **off**, so there is one
source of truth for where the parcel goes.

**Check in sandbox** that the address appears on the order in the Square
dashboard after a test payment. If it does not come through, set
`SQUARE_ASK_FOR_SHIPPING_ADDRESS=true` and Square's own page will collect it
instead. This is flagged rather than assumed because Square's hosted checkout
behaviour around pre-set fulfillments is the one part of this that could not be
verified against the live API or the current documentation from here.

Square's hosted page does **not** let the buyer choose pickup versus shipping.
That choice is made on our cart page and baked into the order, which is why
the two produce different orders and different idempotency keys.

## 8. Tax — the one you must check yourself

`APPLY_CATALOG_TAXES=true` makes the order name the shop's own Square `TAX`
objects, taken from each item's `tax_ids`, and Square computes the amount. **No
rate is hardcoded anywhere in this code**, and there is no destination-based
tax calculation.

What to check before going live:

1. In Square → Settings → Taxes, confirm the tax that should apply to online
   orders exists, is enabled, and is attached to the items you sell.
2. Take one sandbox payment and compare the tax on the Square order with what
   an in-store sale of the same item charges.
3. If your items have no tax attached in Square, the order will carry no tax.
   That is Square's configuration, not a bug here — fix it in Square.

If you need destination-based sales tax for shipped orders, that is not built
and would need Square's tax settings extended or a tax service added. Say so
and it can be scoped.

## 9. Overselling — what is and is not protected

Plainly: **a stock check is not a reservation, and this does not guarantee
stock.**

What is implemented: a soft hold. When a checkout is created, the quantities
go into DynamoDB for `STOCK_HOLD_SECONDS` (15 minutes). While that hold lives,
*this website* subtracts it from what it offers other shoppers, so two
browsers cannot both be promised the last unit.

What that does not cover:

- **An in-store sale.** The shop sells the same rail to whoever is standing
  there. Square has no API to reserve catalog stock for a hosted checkout, so
  nothing here can stop that.
- **A hold expiring** before the customer finishes paying on Square's page.
- **Square's own inventory** is decremented when the payment completes, not
  when the link is made.

If a sale goes through for stock that is gone, Square takes the payment and
staff deal with it as a refund or a backorder — the same as any shop. If that
is not acceptable, the next step up is Square's inventory adjustment API to
move stock into a held state at checkout and move it back on expiry, which is
a real piece of work and needs its own reconciliation. Not built; not claimed.

Inventory is never adjusted by this code. Square decrements catalog stock
itself when an order with catalog line items is paid, so touching it here
would take the same units off the shelf twice.

## 10. Webhooks

In Square → Developer → Webhooks → Subscriptions, add a subscription to
`https://<your api>/default/webhooks/square` for at least:

- `payment.created`, `payment.updated`
- `order.updated`

Copy the **signature key** into the secret as `SQUARE_WEBHOOK_SIGNATURE_KEY`,
and put the exact same notification URL into `WEBHOOK_NOTIFICATION_URL`. The
signature is an HMAC over that URL plus the body, so one character of
difference fails every delivery.

The endpoint verifies the signature in constant time, de-duplicates on
`event_id`, ignores orders this website did not create, and never lets a late
"pending" event walk a paid order backwards.

Webhooks are an optimisation, not a dependency: the return page also asks
Square directly, so order status is correct even before a webhook lands.

## 11. The front end

The static site is unchanged in how it deploys — GitHub Pages, no build step.
The only thing to set is the API base, at the top of `js/store-api.js`:

```js
var API_BASE = window.ASP_API_BASE ||
  'https://n9ecaydkv4.execute-api.us-east-1.amazonaws.com/default';
```

Point it at the production API when you cut over.

---

## Sandbox checks, in order

Do all of these in sandbox before touching production.

1. `GET /config` returns the fulfillment methods you configured, and no ids or
   tokens.
2. `GET /catalog` returns products, and `?cursor=` walks to the end.
3. The shop page lists the sandbox catalog with real photos where Square has
   them.
4. Add two different variations of one item; they stay separate lines.
5. Check out with pickup. Pay with the sandbox test card `4111 1111 1111 1111`,
   any future expiry, CVV `111`, ZIP `94103`.
6. **In the Square sandbox dashboard:** the order appears under the right
   location, with the right lines, the pickup fulfillment, and the customer's
   contact details on it.
7. Check out with shipping. Confirm the shipping charge is on the order as a
   service charge and **the address came through** (§7).
8. Confirm tax on the order matches what you expect (§8).
9. Let the webhook fire; the order page should go from "checking" to
   "Payment confirmed" without a reload.
10. Cancel a payment instead of paying; the order page says cancelled and the
    cart is still there.
11. Press Pay twice quickly: one order, not two.
12. Confirm inventory went down by the right amount in Square, once.

## Going live

1. Repeat §2, §4, §5, §6, §7 with `production`.
2. Point `js/store-api.js` at the production API and push.
3. Buy one cheap real item yourself, with a real card. Refund it in Square.
4. Watch CloudWatch for the first day.

## Costs

Everything is serverless and on-demand. The catalog is cached in DynamoDB and
in Lambda memory, so a busy day costs a handful of Square API calls rather than
one per visitor. At this shop's volume expect the AWS bill to be cents a month;
the Secrets Manager secret (about $0.40/month each) is the largest fixed line.
