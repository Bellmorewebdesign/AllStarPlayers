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
| 1 | **Production Square access token**, with ORDERS_READ and ORDERS_WRITE | secret `SQUARE_ACCESS_TOKEN` | nothing works; without ORDERS_WRITE, abandoned links cannot be cancelled |
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
npm test              # 158 checks, all against doubles — see the report
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

`SQUARE_ENVIRONMENT` is validated strictly: anything but exactly `sandbox` or
`production` and the function refuses to start. **That one field is what picks
the host**, so a sandbox credential cannot quietly reach
`connect.squareup.com` — it is sent to whichever host the environment names,
and Square decides whether it is valid there.

Nothing inspects what the token *looks like*. An earlier build guessed the
environment from the token's prefix and refused anything starting `EAAAl` in a
production secret; production tokens start `EAAA` too, so it rejected a real
credential and blocked a deployment. Square's authentication response is the
only authority on whether a token works against a host.

Every value is trimmed on the way in, so a newline picked up from a console
paste does not turn a good token into a mysterious 401.

**If a request comes back `SQUARE_AUTH_FAILED`**, Square would not accept the
credential for the host that environment names. The CloudWatch line
`square_auth_failed` gives the host and Square's own error code; the token is
never logged. Check, in order: that the token belongs to the environment the
secret names, that it has not been revoked in the Square dashboard, and that
it carries the permissions in §0 (`ORDERS_READ`, `ORDERS_WRITE`). It is never
retried, because retrying a refused credential cannot help.

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
| `INFLIGHT_RECOVERY_MS` | 15000 | how long a half-finished checkout or webhook is left alone before another request takes it over |
| `CLEANUP_GRACE_SECONDS` | 180 | how long after a hold lapses before cleanup goes near the link |
| `CLEANUP_MAX_ATTEMPTS` | 12 | tries at cancelling one link before it is flagged for a person |
| `CLEANUP_BATCH_SIZE` | 25 | jobs per sweep run |
| `CLEANUP_FORCE_CANCEL_ORDER` | `false` | fallback that cancels the order directly if deleting the link does not — **unverified, see §9b** |
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

The cleanup sweep (§9a) needs nothing extra: it finds its work with a Query
against a known partition key, which is why there is still no Scan here. On
the Square side it needs the token to carry **ORDERS_READ and ORDERS_WRITE**,
which deleting a payment link requires.

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
             "POST /webhooks/square" "POST /admin/sweep" \
             "GET /admin/stuck" "POST /admin/holds/release"; do
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

## 8a. What happens at the moment of checkout

Browsing is cached. **Buying is not.** `POST /checkout` ignores the cache
entirely and asks Square, every single time, about exactly the variations in
that cart:

1. `POST /v2/catalog/batch-retrieve` for the cart's variations, with their
   items, taxes, options and images. That is where the price comes from.
2. A second `batch-retrieve` only if a tax, option or image was not included
   the first time.
3. `POST /v2/inventory/counts/batch-retrieve` for whichever of them Square is
   counting.

If any of those fails, the checkout returns **503 `AVAILABILITY_UNVERIFIED`**
and no payment link is made. It never falls back to the cached catalog, and
never to the stale copy served during a Square outage. A shop window may be a
minute out of date; an order may not.

So a checkout costs two or three Square calls. Browsing costs none, because
the catalog is cached. At this shop's volume that is nowhere near Square's
rate limits, but it is the thing to look at first if you ever see 429s.

## 9. Overselling — what is and is not protected

Plainly: **a stock check is not a reservation.** What follows is exactly how
far it goes.

**Two shoppers at once.** Every hold on a variation lives in one DynamoDB row,
and taking a hold is a single conditional write against that row's version.
Two Lambdas racing for the last unit cannot both read "one available" and both
write a hold: the loser's write is rejected, it re-reads, and it sees the
winner. A cart is held all-or-nothing.

**An abandoned checkout.** This used to be the hole. A Square payment link
does not expire, so freeing the stock when the hold's clock ran out meant
offering a unit that somebody could still buy from a tab opened yesterday.

So the hold no longer lapses on a timer. It keeps holding until the order
behind it has been **confirmed** cancelled or **confirmed** paid — see §9a for
how that is done and §9b for what to verify in sandbox.

The cost of that is honest and worth knowing: an abandoned cart keeps its
stock off the website for `STOCK_HOLD_SECONDS` + `CLEANUP_GRACE_SECONDS` +
however long until the next sweep. With the defaults and a five-minute
schedule that is about twenty minutes. Shorten `STOCK_HOLD_SECONDS` if that is
too long for a busy line, but not below the time it takes somebody to find
their card.

**An in-store sale — still not protected, and cannot be.** The shop sells the
same rail to whoever is standing in front of it, and Square offers no way to
reserve catalog stock for a hosted checkout. If the last one goes over the
counter while a web customer is paying, Square takes the payment and staff
deal with it as a refund or a backorder, exactly as any shop would. Nothing
here changes that, and nothing here claims to.

The supported way to close that last gap is Square's inventory adjustment API:
move stock into a held state when the checkout is created and move it back
when the hold is released, with a scheduled reconciliation for whatever falls
through. That is a real piece of work with its own failure modes. It is not
built, and the site does not imply it is.

Inventory is never adjusted by this code. Square decrements catalog stock
itself when an order with catalog line items is paid, so touching it here
would take the same units off the shelf twice.

## 9a. The cleanup sweep

`lib/cleanup.mjs`, run on a schedule. For each checkout whose hold has lapsed:

1. **Ask Square what the order is doing.**
2. **Paid?** Square has taken the stock down itself — free our hold, done.
   **Already cancelled?** Free the hold, done.
3. **A tender on a live order?** Money is moving through it right now. Leave
   it completely alone and look again shortly.
4. **Still live?** `DELETE /v2/online-checkout/payment-links/{id}`, then **ask
   Square again**.
5. **Confirmed cancelled or paid on that second read?** Free the hold.
   **Anything else?** The hold stays and the job comes back later.

Step 5 is the important one, and it is not paranoia. Square's reference says
deleting a link sets its order to CANCELED and returns `cancelled_order_id`.
There are unresolved reports on Square's own developer forums of that not
happening — a 200 with no `cancelled_order_id`, the order still live, and a
customer paying hours later. Trusting the delete would put the hole straight
back, so the delete is treated as a request and the re-read as the answer.

A job that will not settle is retried on a backoff and then flagged
`stuck: true` with a `cleanup_stuck_needs_a_person` log line. **Its stock stays
held, and there is no timer that will ever let go of it.** See §9c.

### Wiring the schedule

EventBridge invokes the function directly with a plain object, so the sweep has
no public route and no internet-facing surface:

```bash
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
FN=all-star-players-store-production

aws events put-rule --name "${FN}-sweep" --region us-east-1 \
  --schedule-expression "rate(5 minutes)" --state ENABLED

aws lambda add-permission --function-name "$FN" --region us-east-1 \
  --statement-id events-sweep --action lambda:InvokeFunction \
  --principal events.amazonaws.com \
  --source-arn "arn:aws:events:us-east-1:${ACCOUNT_ID}:rule/${FN}-sweep"

aws events put-targets --rule "${FN}-sweep" --region us-east-1 \
  --targets "Id=1,Arn=arn:aws:lambda:us-east-1:${ACCOUNT_ID}:function:${FN},Input='{\"task\":\"sweep-abandoned-checkouts\"}'"
```

Repeat with `sandbox` in place of `production`.

To run it by hand while setting up, or during the sandbox checks:

```bash
curl -s -X POST -H "x-admin-key: $ADMIN_REFRESH_KEY" \
  https://$API.execute-api.us-east-1.amazonaws.com/default/admin/sweep
```

Watch for `cleanup_sweep` (a per-run tally), `cleanup_link_would_not_die` (a
delete that did not cancel) and `cleanup_stuck_needs_a_person` in CloudWatch.
A metric filter on the last two is worth setting up before launch.

## 9b. What to verify about DeletePaymentLink — in sandbox, before launch

This is the part that could not be checked from here: Square is unreachable
from the environment this was built in, so **none of the following has been
run against a real Square account.** It is all mocked in
`backend/test/cleanup.test.mjs`, including the failure modes.

Do these in sandbox:

1. Create a checkout, do not pay, make the hold lapse (set
   `STOCK_HOLD_SECONDS=60` temporarily), run the sweep by hand.
2. Check the delete response in the logs: does it carry `cancelled_order_id`?
3. In the Square sandbox dashboard, is the order **CANCELED**?
4. Open the old checkout URL. Does Square refuse it?
5. Is the stock available on the website again?

If 2–4 do not behave — the forum reports say they sometimes do not — then set
`CLEANUP_FORCE_CANCEL_ORDER=true`, which makes cleanup also try
`PUT /v2/orders/{id}` with `state: CANCELED` before re-reading. That fallback
is **off by default and unverified**; the re-read still decides, so turning it
on cannot cause a bad release either way. If neither works, the stock stays
held and the job is flagged, which is the safe failure.

## 9c. Stock is never freed on a timer — and what that means for you

There is **no maximum age at which a hold gives up**. Not seven days, not
seven months. There is no environment variable that re-arms one, the hold row
carries no DynamoDB TTL while it holds anything, and the cleanup job that
tracks it carries no TTL at all.

The reasoning is short: age is not evidence. A Square payment link that nobody
has managed to cancel is still payable on its thousandth day. Dropping the
hold would put a unit back on the website that the link can still buy, which
is the exact thing this whole mechanism exists to prevent. An automatic
release would also be *silent* — no log, no order, no way to find out
afterwards why the shop oversold.

So the failure mode is deliberately the visible one: a unit sits off the
website until a person deals with it.

**Finding them.** Either the `cleanup_stuck_needs_a_person` log line, or:

```bash
curl -s -H "x-admin-key: $ADMIN_REFRESH_KEY" \
  https://$API.execute-api.us-east-1.amazonaws.com/default/admin/stuck | python3 -m json.tool
```

Each entry names the attempt, the order, the payment link, the variations
being held, how many times cleanup has tried, and the last error.

**Resolving one.** Open that order in the Square dashboard and look.

- If it is *paid*, there is nothing to do: the next sweep will see that and
  free the hold by itself.
- If it is *cancelled*, likewise.
- If it is still live, try to delete the link from the Square dashboard by
  hand, then run `POST /admin/sweep`.
- Only when you have looked and are satisfied the order can never be paid:

```bash
curl -s -X POST -H "x-admin-key: $ADMIN_REFRESH_KEY" \
  -H 'content-type: application/json' \
  -d '{"attemptId":"<from the stuck listing>","confirm":"I-CHECKED-SQUARE"}' \
  https://$API.execute-api.us-east-1.amazonaws.com/default/admin/holds/release
```

That is the only route in the whole service that frees stock without Square
having confirmed anything, which is why it needs the key, the exact
confirmation phrase, and why it writes a `hold_released_by_hand` line naming
the order and the link. It is an audit trail, not a convenience.

**Set up an alarm before launch.** A CloudWatch metric filter on
`cleanup_stuck_needs_a_person` is the difference between noticing this the day
it happens and noticing it when a customer asks why a size is missing.

## 10. Webhooks

In Square → Developer → Webhooks → Subscriptions, add a subscription to
`https://<your api>/default/webhooks/square` for at least:

- `payment.created`, `payment.updated`
- `order.updated`

Copy the **signature key** into the secret as `SQUARE_WEBHOOK_SIGNATURE_KEY`,
and put the exact same notification URL into `WEBHOOK_NOTIFICATION_URL`. The
signature is an HMAC over that URL plus the body, so one character of
difference fails every delivery.

The endpoint verifies the signature in constant time, ignores orders this
website did not create, and never lets a late "pending" event walk a paid
order backwards.

On de-duplication, the distinction that matters: an event is skipped only once
it has been **finished**, not merely seen. A delivery that claimed an event and
then failed hands the claim straight back and answers 500, so Square's retry
does the work properly rather than being waved through as a duplicate. A
delivery abandoned by a killed container is taken over after
`INFLIGHT_RECOVERY_MS`.

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
13. **Stock moved under a shopper.** Put the last unit of something in a cart,
    then sell that unit in the Square dashboard, then press Pay. You should
    get the cart back for review and no payment link — not a successful
    checkout.
14. **Two shoppers, one unit.** Open the same last item in two browsers and
    press Pay in both as close together as you can. Exactly one should reach
    Square; the other should be told it has gone.
15. **Changed details.** Check out, come back, change only the apartment
    number, and check out again: two different Square orders. Then retry an
    unchanged checkout: the same link, no second order.
16. **Square unreachable.** Temporarily put a wrong token in the sandbox
    secret and press Pay: you want `AVAILABILITY_UNVERIFIED` and no order.
    Put the token back.
17. **Buy Now on something already in the cart.** The saved cart must still
    have it afterwards.
18. **A redelivered webhook.** Replay one from the Square dashboard; the order
    must not change twice and the response must be a 200.
19. **An abandoned checkout.** The five steps in §9b. This is the one to do
    most carefully, because it is the only part of the system whose Square
    behaviour is reported to be unreliable.
20. **Stock is not freed early.** Start a checkout, let the hold lapse, and
    before running the sweep check that the item still reads as unavailable
    on the website. Freeing it at that point would be the bug.
21. **A stale checkout page.** Leave Square's checkout open in one tab, run
    the sweep, then try to pay from that tab. Square should refuse it. Then
    check out again from the cart: a new link, which does work.
22. **The schedule.** Confirm the EventBridge rule is firing and
    `cleanup_sweep` appears in CloudWatch every five minutes.
23. **A hold that cannot be settled.** Create a checkout, delete its payment
    link by hand in the Square dashboard *without* cancelling the order if you
    can, or set a deliberately wrong token so cleanup keeps failing. Run the
    sweep until the job is flagged, then confirm with `GET /admin/stuck` that
    it is listed and that **the item is still unavailable on the website**.
    Freeing it on its own would be the bug.
24. **Resolving one by hand.** From that same stuck job, run
    `POST /admin/holds/release` without `confirm` (it must refuse), then with
    it (the stock comes back), and check the `hold_released_by_hand` line is
    in CloudWatch.

## Going live

1. Repeat §2, §4, §5, §6, §7 with `production`.
2. Point `js/store-api.js` at the production API and push.
3. Buy one cheap real item yourself, with a real card. Refund it in Square.
4. Watch CloudWatch for the first day.

## Costs

Everything is serverless and on-demand. The catalog is cached in DynamoDB and
in Lambda memory, so browsing costs no Square calls at all; only a checkout
does, and then two or three of them (§8a).

The cleanup sweep adds one scheduled invocation every five minutes — about
8,600 a month, which is inside the Lambda free tier and costs a few cents
beyond it. A run with nothing to do is one DynamoDB Query and no Square calls
at all. At this shop's volume expect the AWS bill to be cents a month;
the Secrets Manager secret (about $0.40/month each) is the largest fixed line.
