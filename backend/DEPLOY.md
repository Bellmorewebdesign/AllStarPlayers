# Deploying the Square sandbox backend

## Shipping-address update (2026-10-04)

The existing product route, checkout route and GitHub Pages CORS were verified working
on October 4, 2026. For this update, deploy the new `backend/index.mjs` using Step 1;
you do not need to recreate routes, permissions or CORS that already work.
Updating GitHub alone does **not** deploy Lambda.

Checkout now sends `ask_for_shipping_address: true` to Square. This collects an
address on the hosted checkout; it does not buy a UPS/USPS/FedEx label, calculate
carrier rates, restrict shipping destinations or promise a delivery date. No
shipping fee is configured pending the client's decision. Keep this sandbox-only
until shipping areas, rates, taxes and fulfillment are agreed and implemented.

After deploying, start a new checkout attempt (reload the shop page) so it uses a
new idempotency key and creates a link with the new options. Existing payment links
are not changed by deploying this file. Check the preview as described in Step 5.

The remaining steps document initial setup and troubleshooting. AWS deployment is
manual; repository changes do not mean that the running Lambda has been updated.

**What already exists** (confirmed working before these changes):

| Thing | Value |
| --- | --- |
| Region | `us-east-1` |
| Lambda | `all-star-players-square-api-sandbox`, Node.js 24, `index.mjs` |
| HTTP API | `n9ecaydkv4`, stage `default`, auto-deploy on |
| Secret | `all-star-players/square/sandbox` (Lambda env var `SECRET_ID` points at it) |
| Sandbox location | `LPDXRBQ28WHB6` |
| Live route | `GET https://n9ecaydkv4.execute-api.us-east-1.amazonaws.com/default/products` |

**Already verified:** `GET /products` returns the test product, `POST /checkout`
creates a sandbox payment link, and responses allow the GitHub Pages origin.

---

## Step 1 — put the new code on the Lambda

`backend/index.mjs` in this repository is the complete replacement. It keeps
`GET /products` and `POST /checkout` working and enables shipping-address collection.

**Console:** Lambda → `all-star-players-square-api-sandbox` → **Code** tab →
open `index.mjs` → select all → paste the new file over it → **Deploy**.

**CLI:**

```bash
cd backend
zip function.zip index.mjs
aws lambda update-function-code \
  --function-name all-star-players-square-api-sandbox \
  --zip-file fileb://function.zip \
  --region us-east-1
```

Then give it room to talk to Square. The Lambda default timeout is **3
seconds**, which is not enough for creating a payment link:

```bash
aws lambda update-function-configuration \
  --function-name all-star-players-square-api-sandbox \
  --timeout 15 --region us-east-1
```

**Check it:**

```bash
curl -s https://n9ecaydkv4.execute-api.us-east-1.amazonaws.com/default/products
```

You should get the same JSON as before — `"Sandbox Test Sneaker"`, price
`10000`. If you instead get a 502 or a `SERVER_ERROR`, open CloudWatch Logs for
the function and look at the newest log stream.

> **If the log says `Cannot find module '@aws-sdk/client-secrets-manager'`**
> the runtime is not shipping the AWS SDK and you need to bundle it:
>
> ```bash
> cd backend
> npm init -y
> npm install @aws-sdk/client-secrets-manager
> zip -r function.zip index.mjs node_modules package.json
> aws lambda update-function-code \
>   --function-name all-star-players-square-api-sandbox \
>   --zip-file fileb://function.zip --region us-east-1
> ```

## Step 2 — add the POST /checkout route

The route key does **not** include the stage. `POST /checkout` is what answers
`https://.../default/checkout`.

**Console:** API Gateway → APIs → the API with ID `n9ecaydkv4` → **Routes** →
**Create** → Method `POST`, path `/checkout` → **Create**. Then click the new
route → **Attach integration** → pick the *existing* Lambda integration (the
one `GET /products` already uses) → **Attach integration**.

**CLI:**

```bash
# 1. find the integration GET /products already uses
aws apigatewayv2 get-routes --api-id n9ecaydkv4 --region us-east-1 \
  --query 'Items[].{route:RouteKey,target:Target}' --output table
# -> target looks like  integrations/abc1234

# 2. create the route against that same integration
aws apigatewayv2 create-route --api-id n9ecaydkv4 --region us-east-1 \
  --route-key 'POST /checkout' \
  --target integrations/abc1234          # <- paste the id from step 1
```

Auto-deploy is on for the `default` stage, so there is nothing to publish.

## Step 3 — let API Gateway invoke the Lambda for the new route

A route created in the console usually adds this for you. A route created with
the CLI never does. Look at the function's resource policy first:

```bash
aws lambda get-policy \
  --function-name all-star-players-square-api-sandbox \
  --region us-east-1 --query Policy --output text | python3 -m json.tool
```

Read the `SourceArn` values. If one of them ends in `n9ecaydkv4/*/*/*` or
`n9ecaydkv4/*`, you are already covered and can skip to step 4. If they are all
specific to `GET/products`, add one:

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
aws lambda add-permission \
  --function-name all-star-players-square-api-sandbox \
  --statement-id apigw-post-checkout \
  --action lambda:InvokeFunction \
  --principal apigateway.amazonaws.com \
  --source-arn "arn:aws:execute-api:us-east-1:${ACCOUNT_ID}:n9ecaydkv4/*/POST/checkout" \
  --region us-east-1
```

(`ResourceConflictException` means the statement id is already there — fine.)

**Check it:** this should now come back **400**, not 404. A 400 is the right
answer: the route is live, the Lambda ran, and it refused an empty body.

```bash
curl -i -X POST -H 'content-type: application/json' -d '{}' \
  https://n9ecaydkv4.execute-api.us-east-1.amazonaws.com/default/checkout
```

A 500 with `"CONFIG_ERROR"` means the route works but the secret is wrong —
the message names the key at fault.

## Step 4 — turn on CORS for the website's origin

CORS is already configured for GitHub Pages. If rebuilding the API, configure it
here so browser requests can read the responses. The origin is the **bare host**, with no repository
path on the end — a browser never sends one.

**Console:** API Gateway → `n9ecaydkv4` → **CORS** → **Configure**:

| Field | Value |
| --- | --- |
| Access-Control-Allow-Origin | `https://bellmorewebdesign.github.io` |
| Access-Control-Allow-Methods | `GET`, `POST`, `OPTIONS` |
| Access-Control-Allow-Headers | `content-type` |
| Access-Control-Max-Age | `600` |

**CLI:**

```bash
aws apigatewayv2 update-api --api-id n9ecaydkv4 --region us-east-1 \
  --cors-configuration '{"AllowOrigins":["https://bellmorewebdesign.github.io"],"AllowMethods":["GET","POST","OPTIONS"],"AllowHeaders":["content-type"],"MaxAge":300}'
```

**Check it.** Both of these must print an
`access-control-allow-origin: https://bellmorewebdesign.github.io` line:

```bash
# the preflight the browser sends before the POST
curl -i -X OPTIONS \
  -H 'Origin: https://bellmorewebdesign.github.io' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: content-type' \
  https://n9ecaydkv4.execute-api.us-east-1.amazonaws.com/default/checkout

# and the real request
curl -i -H 'Origin: https://bellmorewebdesign.github.io' \
  https://n9ecaydkv4.execute-api.us-east-1.amazonaws.com/default/products
```

`index.mjs` also sets these headers itself, as a safety net for the case where
the API-level configuration is missing. When both are present API Gateway's
configuration is the one that takes effect.

## Step 5 — check the shipping checkout preview

```bash
curl -s -X POST -H 'content-type: application/json' \
  -d '{"variationId":"T2APLGR5UFWGFELNUHGVNVI2","quantity":1,"idempotencyKey":"asp-shipping-preview-0001"}' \
  https://n9ecaydkv4.execute-api.us-east-1.amazonaws.com/default/checkout
```

You want:

```json
{"success":true,"environment":"sandbox",
 "checkoutUrl":"https://sandbox.square.link/u/XXXXXXXX",
 "orderId":"...","paymentLinkId":"..."}
```

Open that URL and choose the checkout preview if Square first shows a testing
panel. Verify the correct item, $100 price and shipping-address fields. The
preview's card fields and Pay button are disabled: this is expected, not a Lambda
failure. Do not claim a completed payment or look for a successful transaction
based only on creating a link. Use a fresh idempotency key after changing checkout
options, but reuse the same key when retrying an unchanged request.

Square references:
- [CheckoutOptions: ask_for_shipping_address](https://developer.squareup.com/reference/square/objects/CheckoutOptions)
- [Square support: disabled payment fields in sandbox hosted checkout](https://developer.squareup.com/forums/t/issue-with-credit-card-fields-and-pay-button-disabled-in-square-checkout-api-in-sandbox-enviornment/21045)

Finally, load the real site at
`https://bellmorewebdesign.github.io/AllStarPlayers/shop.html`, scroll to the
test block and press **Preview Shipping Checkout**. It should take you to Square.
If the block says "Could not reach the product service", open the browser
console — a CORS message there means step 4 did not take.

---

## What the endpoints do

### `GET /products`

Unchanged. Lists the sandbox catalog. Prices are in the smallest currency unit
(`10000` is $100.00); the browser formats them.

### `POST /checkout`

```json
{ "variationId": "T2APLGR5UFWGFELNUHGVNVI2", "quantity": 1, "idempotencyKey": "asp-…" }
```

The function refuses anything else — any other variation is
`VARIATION_NOT_ALLOWED`, any quantity but 1 is `QUANTITY_NOT_ALLOWED`, and both
are rejected before Square is called. **No price is ever read from the request
body.** The line item names the catalog variation and Square prices it from its
own catalog, so a tampered-with browser cannot change the total.

It then calls `POST https://connect.squareupsandbox.com/v2/online-checkout/payment-links`
with `Square-Version: 2026-09-16` and:

```json
{
  "idempotency_key": "<yours, passed straight through>",
  "order": {
    "location_id": "<SQUARE_LOCATION_ID from the secret>",
    "line_items": [{ "catalog_object_id": "T2APLGR5UFWGFELNUHGVNVI2", "quantity": "1" }]
  },
  "checkout_options": { "allow_tipping": false, "ask_for_shipping_address": true }
}
```

No `redirect_url` is sent, so Square hosts the confirmation page as well.

Back to the browser goes `{ success, environment, checkoutUrl, orderId,
paymentLinkId }` — never the token, never the raw Square response.

### Safety rails

- `SQUARE_ENVIRONMENT` in the secret must read `sandbox`. Anything else and
  every request fails with `CONFIG_ERROR` before Square is contacted. This is
  deliberate: it cannot be pointed at production by accident.
- The access token is read from Secrets Manager, cached in memory for the life
  of the container, and never logged or returned.
- Square's own error objects are passed back (they carry no credentials) so a
  failure is debuggable; everything else becomes a flat `SERVER_ERROR`.

### Configuration knobs (Lambda environment variables, all optional)

| Variable | Default | What it does |
| --- | --- | --- |
| `SECRET_ID` | *(required, already set)* | which Secrets Manager secret to read |
| `ALLOWED_VARIATION_ID` | `T2APLGR5UFWGFELNUHGVNVI2` | the only variation that may be sold |
| `ALLOWED_ORIGINS` | the GitHub Pages origin + localhost | comma-separated, for the fallback CORS headers |
| `SQUARE_VERSION` | `2026-09-16` | the `Square-Version` header |

## Going past the test

Before this is ever more than a test, at minimum: a webhook or an
`RetrieveOrder` call to confirm payment server-side rather than trusting the
redirect, real stock and shipping, and a second look at the "only one variation,
only quantity 1" rails, which exist precisely because this is a test.
