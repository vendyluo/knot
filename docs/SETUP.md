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
