# Knot

> LINE cuts. You keep what matters.

Knot is an open-source, self-hosted memory layer for LINE. Add your own LINE Official Account as a personal notebook, invite it into a group, or use both. Your data goes from your LINE OA to your Cloudflare account—there is no Knot SaaS in the middle.

This repository deliberately provides code and a small, deterministic interaction model rather than a hosted product. Fork it, change the commands, add a UI, or connect AI later if you actually need it.

## What it does

```text
Personal chat                    Group chat
User ↔ your LINE OA              Members ↔ your LINE OA
        │                                │
        └──────── webhook ───────────────┘
                         │
                  Cloudflare Worker
                    ├─ D1 metadata
                    └─ R2
                       ├─ temp/*       24-hour snapshots
                       └─ permanent/*  explicitly saved notes
```

Every incoming message is first snapshotted under `temp/` in your R2 bucket. Images, videos, audio, and files are downloaded from LINE while they are still available. R2 lifecycle rules delete temporary objects after one day.

Knot only copies content into `permanent/` when somebody explicitly saves it. **It is not a permanent chat logger.** D1's temporary index contains identifiers and object locations, not the text of unsaved conversations, and is pruned opportunistically after expiry.

## Commands

Commands are intentionally explicit and contain no AI classification:

| Command | Result |
| --- | --- |
| Reply to a message with `@memo [描述]` | Save that text, image, video, audio, or file with an optional description |
| `@memo 文字 <內容>` | Save new text directly |
| `@memo 對話 [則數]` | Save the latest messages in this chat; defaults to 10, maximum 50 |
| `@memo 列表` | List the 10 most recent notes in this chat |
| `@memo 取出 <記事編號>` | Show saved text and create 15-minute media download links |
| `@memo 刪除 <記事編號>` | Delete a note and its permanent R2 objects |
| `@memo 說明` | Show command help |

`#memo` can be used in place of `@memo`. English aliases are also available: `text`, `chat`, `conversation`, `list`, `get`, `retrieve`, `delete`, and `help`.

Personal chats and groups use the same code. Their data stays separated by LINE's source identity (`userId`, `groupId`, or legacy `roomId`). A note created in one chat can't be listed or deleted from another.

Knot stays silent during ordinary conversation, especially in groups. When somebody explicitly uses a command, it responds with compact LINE Flex cards that distinguish text, images, videos, audio, files, and conversations. Success cards offer quick actions for recent notes and help; destructive deletion still requires typing the note ID.

Descriptions are intentionally lightweight. Reply to media with `@memo 北海道飯店候選`, and that description becomes the note's title. Recent-note previews prefer the description, then saved text, the original file name, and finally the media type. Descriptions are limited to 200 characters.

Retrieval doesn't make the R2 bucket public. Each attachment button contains an HMAC-signed URL bound to one attachment and expires after 15 minutes. Treat the URL as temporarily shareable: anyone who receives it before expiry can download that attachment.

### Why snapshot first?

LINE doesn't guarantee how long user-sent media remains available through the Get content API. Waiting until somebody replies `@memo` can produce `410 Gone`. Knot therefore takes a short-lived R2 snapshot immediately, giving people time to decide what is worth keeping without permanently mirroring the chat.

If a very large media file is still being copied when `@memo` is sent, the event snapshot can be saved before its attachment is ready. Retry the command after the media snapshot finishes.

## LINE OA cost model (Taiwan)

As of September 11, 2026, Taiwan's free/light-use LINE OA plan costs NT$0 and includes 200 counted messages per month. It can't purchase additional messages. The important distinction is that **Messaging API replies don't count toward this allowance**.

Not counted toward the monthly message allowance:

- Messaging API Reply API
- incoming webhooks and downloading user-sent content
- OA one-to-one chat, greeting messages, and automatic responses

Counted toward the allowance:

- Push API
- multicast, broadcast, and narrowcast messages

Knot replies directly to each command using the webhook's `replyToken`, so normal personal and group interactions don't consume the 200-message allowance. Reply tokens are single-use and should be used within one minute; one reply request can contain up to five message objects.

Scheduled reminders, delayed completion notifications, and digests don't have a reply token and therefore require Push API. A push to one person counts as one message; a push to a group is counted by the number of recipients. Keep the free 200 messages for these optional proactive features.

Each self-hosted installation uses its owner's OA plan and allowance. Users don't share a central Knot quota.

Official references:

- [Taiwan LINE OA pricing and November 2026 changes](https://tw.linebiz.com/column/LINEOA-2026-Price-Plan/)
- [Messaging API pricing and counted sending methods](https://developers.line.biz/en/docs/messaging-api/pricing/)
- [Reply token rules](https://developers.line.biz/en/reference/messaging-api/#send-reply-message)
- [Receiving messages and retrieving media](https://developers.line.biz/en/docs/messaging-api/receiving-messages/)

## Deploy to Cloudflare

Prerequisites:

- a Cloudflare account
- a LINE Official Account with a Messaging API channel
- Node.js 22 or newer

Install dependencies and log in:

```sh
npm install
npx wrangler login
```

Create D1 and set the returned ID as `d1_databases[0].database_id` in `wrangler.jsonc`:

```sh
npx wrangler d1 create knot
npx wrangler d1 migrations apply knot --remote
```

Create R2 and configure automatic deletion for the `temp/` prefix:

```sh
npx wrangler r2 bucket create knot
npx wrangler r2 bucket lifecycle add knot expire-temp temp/ --expire-days 1
```

Store your LINE credentials as Worker secrets:

```sh
npx wrangler secret put LINE_CHANNEL_SECRET
npx wrangler secret put LINE_CHANNEL_ACCESS_TOKEN
```

Deploy:

```sh
npm run deploy
```

In LINE Developers Console:

1. Set the webhook URL to `https://<your-worker>.workers.dev/webhook`.
2. Enable **Use webhook** and webhook redelivery.
3. Disable LINE's default auto-response if it would duplicate Knot's replies.
4. To use groups, enable **Allow bot to join group chats**. LINE permits only one Official Account in a group at a time.

Add the OA as a friend for a private notebook, or invite it to a group for shared notes.

For a complete first-deployment checklist and acceptance test, follow [Setup and verification](docs/SETUP.md). It starts with a test OA, verifies temporary versus permanent storage, and checks that Reply API interactions don't consume the OA's counted-message allowance.

## Local development

Create local resources and secrets without committing credentials:

```sh
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply knot --local
npm run dev
```

LINE needs a public HTTPS webhook URL, so use your preferred tunnel when testing real webhook delivery.

Run deterministic checks:

```sh
npm test
npm run typecheck
```

## Storage model

- `snapshots`: temporary D1 lookup index for message IDs and R2 keys
- `notes`: one explicitly saved unit in a personal or group workspace
- `note_items`: one or more source messages inside a note
- `attachments`: permanent R2 objects belonging to note items
- `temp/events/*`: raw short-lived webhook event snapshots
- `temp/media/*`: short-lived copies of LINE media
- `permanent/*`: snapshots and media retained by explicit save commands

R2 lifecycle removes the objects. Knot also deletes expired D1 snapshot rows opportunistically whenever a webhook succeeds. At higher volume, add a Cloudflare Cron Trigger that calls the same cleanup operation in batches.

## Intentional v0.1 boundaries

Knot currently has no hosted UI, login system, reminders, proactive push messages, OCR, transcription, semantic search, or AI. The core stays useful without any model provider or additional infrastructure.

Natural extensions include:

- a read-only Worker/LIFF interface for browsing and searching notes
- deterministic tags such as `@memo 文字 --tag travel ...`
- reminder commands backed by Cron Triggers and the owner's push allowance
- OCR or embeddings as optional adapters, not core dependencies
- configurable snapshot retention and upload-size policies

Before expanding automatic capture, preserve the central promise: unsaved chat is temporary, and permanent retention is explicit.

## Product priority

Knot prioritizes capabilities that LINE has actually removed or announced it will remove, rather than replacing every existing Note feature:

1. **Durable video and media notes:** LINE webhooks expose new image, video, audio, and file messages, so Knot can snapshot and retain these reliably.
2. **Knot-native polls and date picking:** a future deterministic interaction can use LINE postbacks and datetime pickers. It would replace the removed workflow, not import native LINE polls.
3. **Manual rescue:** users can forward or screenshot old poll, date-selection, and VOOM content before deletion and save it through Knot.

The Messaging API doesn't expose native Note history, polls, date-selection posts, or VOOM posts to bots. Automatic migration of those existing items is therefore intentionally not promised.
