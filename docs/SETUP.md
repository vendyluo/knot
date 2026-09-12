# Setup and verification

This runbook takes Knot from an empty Cloudflare account and a test LINE Official Account to a verified personal and group installation.

Use a dedicated test OA first. Don't begin with a company or production account, and never paste LINE credentials into an issue, chat, README, or Git commit.

## 1. Prepare Cloudflare

You need a Cloudflare account with access to:

- Workers
- D1
- R2

R2 has a free usage allowance, but Cloudflare may still ask you to enable R2 or configure a payment method before creating a bucket.

Install dependencies and authenticate Wrangler:

```sh
npm install
npx wrangler login
```

Confirm the local project before creating remote resources:

```sh
npm test
npm run typecheck
npx wrangler deploy --dry-run
```

## 2. Prepare a LINE Official Account

In [LINE Official Account Manager](https://manager.line.biz/):

1. Create a test Official Account.
2. Enable the Messaging API for that account.
3. Open its channel in LINE Developers Console.
4. Copy the **Channel secret**.
5. Issue and copy a **Channel access token**. A long-lived token is sufficient for the first test.
6. Enable **Use webhook**.
7. Disable default automatic responses if they would duplicate Knot's replies.

You don't need to enable group access yet. Prove the personal-chat path first.

## 3. Create Cloudflare resources

Create D1:

```sh
npx wrangler d1 create knot
```

Copy the returned database ID into `wrangler.jsonc` as the value of:

```text
d1_databases[0].database_id
```

Apply the schema:

```sh
npx wrangler d1 migrations apply knot --remote
```

Create R2 and add a lifecycle rule that expires only the `temp/` prefix after one day:

```sh
npx wrangler r2 bucket create knot
npx wrangler r2 bucket lifecycle add knot expire-temp temp/ --expire-days 1
```

Permanent objects use the `permanent/` prefix and aren't covered by this rule.

## 4. Store credentials and deploy

Store both values as encrypted Worker secrets:

```sh
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
```

Wrangler prompts for each value. The values must not be added to `wrangler.jsonc` or `.dev.vars` for a remote deployment.

Deploy:

```sh
npm run deploy
```

Record the resulting URL, for example:

```text
https://knot-line-memory.example.workers.dev
```

Open its root path. A healthy Worker returns:

```json
{"name":"Knot","status":"ok"}
```

## 5. Connect LINE

In LINE Developers Console, set the webhook URL to:

```text
https://knot-line-memory.example.workers.dev/webhook
```

Replace the example hostname with the deployed Worker URL, then:

1. Verify the webhook URL. Verification must succeed.
2. Confirm **Use webhook** is enabled.
3. Enable webhook redelivery.
4. Add the test OA as a LINE friend.

### If LINE replies that the account can't respond individually

The default message beginning with 「感謝您的訊息！很抱歉，本帳號無法個別回覆」comes from LINE OA, not Knot. It means LINE's default **Auto-reply messages** setting is still enabled.

Open LINE Official Account Manager, select the account, then go to **設定 → 回應設定**:

- set **回應模式** to **聊天機器人**, not manual **聊天**;
- keep **Webhook** enabled;
- disable **自動回應訊息**;
- optionally disable **加入好友的歡迎訊息** while testing, so every visible response has one clear source.

Don't switch to manual **聊天** merely to remove the default reply. Depending on the OA Manager configuration, that can disable the Messaging API webhook path entirely.

You can also use **Edit** beside **Auto-reply messages** in the channel's Messaging API tab to open the corresponding OA Manager setting. Ordinary messages are intentionally silent in Knot; only `@memo` commands receive a Knot reply.

## 6. Acceptance test: personal text

### Ordinary chat stays temporary

Send the OA an ordinary message:

```text
這是一則普通聊天，不應永久保存
```

Expected behavior:

- The Bot stays silent.
- R2 contains a new object under `temp/events/user_.../`.
- D1 contains a temporary `snapshots` row.
- D1 doesn't contain a new `notes` row.

Check D1 from the command line:

```sh
npx wrangler d1 execute knot --remote \
  --command "SELECT COUNT(*) AS snapshots FROM snapshots; SELECT COUNT(*) AS notes FROM notes;"
```

### Explicit text becomes permanent

Send:

```text
@memo 文字 這是一則測試記事
```

Expected reply:

```text
Knot shows a green “已永久保存” Flex card for 文字記事 #<id>.
```

The card includes quick actions for recent notes and help. Tapping either action sends the corresponding deterministic `@memo` command; it doesn't invoke AI or Push API.

Expected storage:

- D1 contains one new `notes` row and one `note_items` row.
- R2 contains `permanent/.../<id>/0/event.json`.
- The command was answered through Reply API rather than Push API.

Inspect the saved data:

```sh
npx wrangler d1 execute knot --remote --command \
  "SELECT n.id, n.kind, i.text FROM notes n JOIN note_items i ON i.note_id = n.id ORDER BY n.id DESC LIMIT 5;"
```

## 7. Acceptance test: media

1. Send the OA a disposable test image.
2. Wait a few seconds for its R2 snapshot.
3. Use LINE's Reply action on that image.
4. Send `@memo 測試圖片` as the reply. The description is optional; plain `@memo` still works.

Expected reply:

```text
Knot shows a green “已永久保存” Flex card titled `測試圖片` and identifies it as 圖片記事 #<id>.
```

Expected storage:

- The short-lived media exists under `temp/media/...`.
- A permanent copy exists under `permanent/.../<id>/0/content`.
- D1 contains an `attachments` row for the permanent object.

If Knot reports that the attachment snapshot is still being created, wait a moment and send `@memo` again. It won't report success until the attachment can be retained permanently.

Check attachment metadata:

```sh
npx wrangler d1 execute knot --remote --command \
  "SELECT i.note_id, i.kind, a.r2_key, a.content_type, a.file_name FROM attachments a JOIN note_items i ON i.id = a.note_item_id ORDER BY a.id DESC LIMIT 5;"
```

## 8. Acceptance test: list and delete

Send:

```text
@memo 列表
```

The two saved notes should appear in a compact Flex card. The media row should use `測試圖片` as its title and say `圖片記事 #<id>` below it, rather than the generic `媒體`. Delete the media note using the ID returned earlier:

First retrieve it:

```text
@memo 取出 <id>
```

Expected behavior:

- Text is displayed directly in the Flex card.
- Media appears as a download button with a signed URL.
- The download responds with the original content type and file name.
- The URL stops working after 15 minutes and doesn't expose the R2 bucket publicly.

Then delete the media note:

```text
@memo 刪除 <id>
```

Expected behavior:

- Knot confirms deletion.
- The note, its items, and attachment metadata disappear from D1.
- Its objects under `permanent/.../<id>/` disappear from R2.
- Temporary snapshots remain subject to the one-day lifecycle rule.

## 9. Verify the free-message assumption

Open the test OA's message-usage view before and after running the interactive tests.

The commands above arrive through webhooks and Knot answers with Messaging API Reply API. According to LINE's pricing rules, Reply API messages aren't counted toward the plan's monthly message allowance. The counted usage should therefore remain unchanged.

Record this separately from API request or reply-delivery statistics: Knot does send replies, but those replies shouldn't consume the free plan's 200 counted messages.

If counted usage increases, stop before broader testing and verify that:

- no default OA broadcast or campaign was triggered;
- no custom fork replaced Reply API with Push API;
- the usage view and comparison period are correct.

Official references:

- [Messaging API pricing](https://developers.line.biz/en/docs/messaging-api/pricing/)
- [How message counts are calculated](https://developers.line.biz/en/tips/2026/05/28/how-to-count-messages/)
- [Taiwan LINE OA pricing](https://tw.linebiz.com/column/LINEOA-2026-Price-Plan/)

## 10. Acceptance test: group isolation

Only proceed after personal-chat tests pass.

1. In LINE Developers Console, enable **Allow bot to join group chats**.
2. Invite the test OA into a disposable LINE group.
3. Send a normal message and save it by replying `@memo`.
4. Run `@memo 列表` in the group.
5. Run `@memo 列表` in the personal OA chat.

Expected behavior:

- The group can see only notes whose workspace is its `groupId`.
- The personal chat can see only notes whose workspace is its `userId`.
- A note ID from one workspace can't be deleted from the other.
- Group command replies still use Reply API and don't consume counted-message allowance.

LINE permits only one Official Account in a group at a time. Use a group without another OA.

If Knot leaves immediately after being invited, the channel's **Allow bot to join group chats** setting is still disabled, or the group already contains another Official Account. This setting is on the channel's **Messaging API** tab in LINE Developers Console and doesn't require redeploying Knot.

## Completion evidence

The v0.1 deployment is proven when all of these are true:

- [ ] Unit tests, typecheck, and Wrangler dry run pass.
- [ ] Worker health endpoint returns `status: ok`.
- [ ] LINE webhook verification succeeds.
- [ ] Ordinary text creates only a temporary snapshot.
- [ ] Explicit text creates a permanent note.
- [ ] A quoted image creates a permanent R2 attachment.
- [ ] Save, help, and recent-note Flex cards render correctly in the LINE mobile app.
- [ ] `@memo 取出 <id>` displays text and downloads the original media through a signed link.
- [ ] An expired or modified download URL returns HTTP 403.
- [ ] List and delete commands operate on the correct workspace.
- [ ] Personal and group notes remain isolated.
- [ ] Interactive Reply API tests don't increase counted-message usage.
- [ ] The R2 `temp/` lifecycle rule exists and excludes `permanent/`.

Don't enable reminders, delayed notifications, or digests as part of this proof. Those features require Push API and have a different cost model.

## 11. Optional reminders

This is a separate opt-in test after the memory workflow passes. Use a disposable OA and synthetic content. Remote migration, deployment, and live Push require the resource owner's approval; none of the commands below imply that they have already been run.

### Local verification (no live LINE requests)

```sh
npm ci
npm test
npm run typecheck
npx wrangler deploy --dry-run
```

Reminder integration tests use disposable Miniflare D1/R2 and mock LINE requests. They apply all migrations and exercise redelivery, overlapping ticks, cancellation, Push failures, and recovery after a result-write failure. They do not prove mobile rendering, delivery, real Cron timing, or billing.

If changing bindings, regenerate the small configuration types:

```sh
npx wrangler types src/worker-bindings.d.ts --env-interface WorkerBindings --include-runtime=false --strict-vars=false
```

### Enable only on the intended deployment

1. Confirm `wrangler.jsonc` points to the owner's intended D1 and R2 resources, not the repository's example installation.
2. Apply `0003_reminders.sql` with the other migrations **before deploying this version**, even when reminders remain disabled. The scheduled handler performs reminder maintenance while sending is off:

   ```sh
   npx wrangler d1 migrations apply knot --remote
   ```

3. Check the OA plan and remaining monthly message allowance in OA Manager. Push counts by recipients: a group notification may consume several messages. API alternatives are `GET /v2/bot/message/quota` and `GET /v2/bot/message/quota/consumption`; never put the access token into public examples or logs.
4. Set `vars.NOTIFY_ENABLED` to the **string** `"true"` in the intended config. Keep the single `"* * * * *"` Cron expression. Then deploy with the owner's authorization. Do not create one Cron per reminder.
5. Allow time for Cron configuration propagation (up to 15 minutes). In a private test chat, send `@notify 3分鐘後 測試提醒`; check the exact Taipei time, destination, and cancel button on the receipt.
6. Verify one reminder reaches the original chat, another cancelled reminder does not, and a group reminder cannot be listed/cancelled from private chat. In the group, test cancellation by a different member. Insert ordinary messages before tapping an old card.
7. Inspect long reminder text, failed/expired cards, and the paginated list in LINE on a phone. Test reminders do consume Push allowance; record that separately from free Reply interactions.

### Choose rule or AI time parsing

The repository defaults to `NOTIFY_TIME_PARSER="rule"`. No model runs in this mode. The included `ai` binding alone does not invoke inference. To opt in, keep the `AI` binding and change only `vars.NOTIFY_TIME_PARSER` to the string `"ai"` in the intended Wrangler config, then deploy with the owner's authorization. `NOTIFY_ENABLED` separately controls creation and Push. Missing or unrecognized parser values behave as `rule`.

AI mode still uses deterministic rules for supported formats. Known invalid rule dates, past times, excessive lengths/horizons and management commands are not rescued by AI. Unsupported syntax can invoke `@cf/meta/llama-3.3-70b-instruct-fp8-fast` once, with an 8-second timeout and no automatic inference retry. Existing reminders are looked up before inference. Concurrent first deliveries can still cause more than one inference call, but the unique message ID permits only one reminder.

Try synthetic input such as `@notify 後天早上九點 合成測試事項`. The model is instructed to reject ambiguous or recurring requests; validated output creates a single reminder immediately. The initial receipt says `AI 解讀，請核對時間與事項`. There is no second confirmation step. Check the result and cancel/reset mistakes. Structural validation cannot prove semantic accuracy or guarantee the model follows its ambiguity instructions. For predictable behavior, use the explicit rule formats even in AI mode.

Privacy/cost boundaries:

- Cloudflare receives the entire explicit command argument (including the task) and original event time expressed in Taipei. No history, media, user ID or group ID is included. Do not use this mode for content you do not want sent to model inference; inform your chat participants before enabling it. See [Workers AI data usage](https://developers.cloudflare.com/workers-ai/platform/data-usage/).
- No model-generated task text, destination or SQL is executed. The original suffix after the interpreted time is saved and existing date/length checks run again. Inputs over 600 Unicode characters are rejected before inference; the extracted task remains limited to 500.
- Missing binding, malformed output, provider failure or timeout creates no reminder and asks for an explicit format. Model output and provider errors are not logged.
- Inference may incur [Workers AI charges](https://developers.cloudflare.com/workers-ai/platform/pricing/), independently of LINE Push. AI bindings use remote inference even during `wrangler dev`; opt-in local testing may be billable. The chat limit is not an AI spending cap.
- Switch back to `rule` and deploy to stop future inference; existing reminders keep their stored due times and normal Push behavior. Requests already in progress may finish.

Automated tests mock the binding; they check routing and validation, not real-model interpretation quality. Before adopting AI mode, test synthetic midnight/year-boundary, ambiguous, failure and cancellation cases against the live model and LINE on a phone. Do not use real private messages as public demonstrations.

### Operational limits and failure handling

- 500 Unicode characters, at most 365 days ahead, 100 pending/sending reminders per workspace. Parsing uses the original LINE event timestamp; new commands arriving over one hour late are rejected. Redelivery of an existing message returns its receipt instead of recreating it.
- A tick processes at most 10 reminders, claiming each atomically with a 120-second lease. Each request has a 10-second timeout. A transient failure waits 60, 120, 240, 480, then 900 seconds between attempts, with at most six total attempts and no new attempt later than one hour after the due time.
- Only network failures and HTTP 5xx are automatically retried. HTTP 4xx, including 429, stops automatic sending: inspect credentials, destination, rate limits, and monthly quota. Don't blindly recreate a reminder with an unconfirmed outcome.
- The first request's retry key and payload are persisted and reused, including after process interruption. `accepted` means LINE accepted the request, not delivery or reading. `unknown` means an attempt may have been accepted but Knot cannot confirm it; it won't issue a new key automatically.
- Cancel only succeeds while pending. Once claimed, even between retries, cancellation cannot be guaranteed; the bot says so. Already cancelled reminders stay cancelled on repeated commands.
- Terminal rows, including text and destination, are removed after 30 days in batches of at most 100 per tick. Temporary command snapshots still follow the existing lifecycle; backups and LINE chat history are separate copies.
- Set `NOTIFY_ENABLED` back to `"false"` and deploy to stop new creation/sending on that version. In-flight sends and rollout overlap may still complete. Lists/cancellation and Cron expiry/cleanup remain available. Reenabling can send pending work still within the one-hour window. Removing the Cron also stops automatic expiry and cleanup.
- This is a trusted self-hosted tool, not an abuse-resistant public notification gateway. The per-chat cap is not a global budget or rate limit. Don't enable unrestricted reminders on the shared public test OA.

For diagnosis, query only IDs, status, counts and error categories first; avoid dumping private text or destinations:

```sh
npx wrangler d1 execute knot --remote --command \
  "SELECT status, COUNT(*) AS count FROM reminders GROUP BY status; SELECT id, status, attempts, last_error FROM reminders WHERE status IN ('failed', 'unknown', 'expired') ORDER BY id DESC LIMIT 20;"
```

Use `npx wrangler tail` during a test, or configured Workers Logs. Reminder logs contain internal reminder IDs and error categories (`http_401`, `http_429`, `network_timeout`, etc.), not raw LINE responses or reminder content. If even list queries fail, investigate the migration/binding and D1 availability rather than assuming no reminder was created.
