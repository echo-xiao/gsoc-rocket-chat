# Rocket.Chat Codebase Q&A

> Session recorded on 2026-03-18

---

## Q1: based on https://github.com/RocketChat/Rocket.Chat How do push notifications work?

## How Push Notifications Work in Rocket.Chat

### Architecture

The system is event-driven with two delivery paths: **direct APNs/FCM** (self-hosted) or **via Rocket.Chat Cloud gateway** (registered servers).

---

### End-to-End Flow

**1. Message Sent**
`sendMessage.ts` → `afterSaveMessage` callbacks fire → `sendNotificationsOnMessage.ts` iterates every room subscriber.

**2. Per-User Eligibility Check (`mobile.js` → `shouldNotifyMobile()`)**
Push fires when ALL of:
- `Push_enable` setting is on
- User preference is not "nothing"
- User is NOT currently online/active

AND ANY of:
- Direct message room
- User is `@mentioned`
- Message matches a highlight keyword
- User preference is "all messages"
- Direct thread reply to the user

**3. Queue (`NotificationQueue.ts`)**
Eligible notifications are persisted to MongoDB's `NotificationQueue`. Delivery delay:
- **Online users**: 120-second delay (batches to avoid noise)
- **Away/Offline**: immediate

A worker polls every **2 seconds**, processing up to 100 items per cycle.

**4. Payload Construction (`PushNotification.ts`)**
Builds the platform payload:
- **Privacy/E2EE mode** (`Push_request_content_from_server`): sends only `messageId` + `roomId`; the mobile app fetches content itself
- **Standard mode**: includes full `title`, `text`, sender, room name
- Android adds `style: "inbox"` + favicon URL; iOS adds interactive `category` for inline reply

**5. Token Lookup & Routing (`push.ts` → `PushClass`)**
Queries `PushToken` collection for user's registered tokens, then decides path:

```
Self-hosted (no Cloud)          Cloud-registered
──────────────────────          ────────────────
sendNotificationNative()        sendNotificationGateway()
  ├─ APNs via @parse/node-apn     └─ POST to gateway /push/apn|gcm/send
  └─ FCM v1 API (OAuth2/JWT)            (Rocket.Chat Cloud relays to APNs/FCM)
```

Gateway path uses exponential backoff retry (1→2→4→8→16 min, max 5 attempts). HTTP 406 = remove token; HTTP 422/401 = abort.

---

### Token Registration

Mobile clients call Meteor method `raix:push-update` → `PushService.registerPushToken()` stores in `PushToken` collection. Tokens are cleaned up when login sessions expire.

---

### Key Files

| File | Role |
|---|---|
| `app/lib/server/lib/sendNotificationsOnMessage.ts` | Orchestrator, per-user condition evaluation |
| `app/lib/server/functions/notifications/mobile.js` | `shouldNotifyMobile()` logic |
| `app/notification-queue/server/NotificationQueue.ts` | Async queue with delay |
| `app/push-notifications/server/lib/PushNotification.ts` | Payload builder |
| `app/push/server/push.ts` | Gateway vs. native routing |
| `app/push/server/apn.ts` | Direct Apple APNs delivery |
| `app/push/server/fcm.ts` | Direct Firebase FCM v1 delivery |

---

## Q2: Where is the logic for message permission validation located?

### Message Permission Validation — Key Locations

**Primary permission gate:**
`apps/meteor/app/authorization/server/functions/canSendMessage.ts`
- `canSendMessageAsync(rid, user)` — fetches room, calls `validateRoomMessagePermissionsAsync`
- `validateRoomMessagePermissionsAsync(room, user)` — the core validation

**Entry point (Meteor DDP method):**
`apps/meteor/app/lib/server/methods/sendMessage.ts` → `executeSendMessage()`

**Structural/impersonation checks:**
`apps/meteor/app/lib/server/functions/sendMessage.ts` → `validateMessage()`

---

### Call Chain

```
Meteor.methods sendMessage()
  → executeSendMessage()
    → canSendMessageAsync()                ← primary authorization gate
        → validateRoomMessagePermissionsAsync()
    → sendMessage()
        → validateMessage()                ← structural + impersonation
```

---

### What Each Layer Validates

**`executeSendMessage()` (methods layer)**
- User authenticated, has username
- Thread params valid, threads not disabled
- Message timestamp within 60s of server
- Message size ≤ `Message_MaxAllowedSize`
- E2E encrypted rooms require `e2e` message type
- Rate limit: 5 msg/s (unless `send-many-messages` permission)

**`validateRoomMessagePermissionsAsync()` (auth layer)**
- Room exists → `error-invalid-room`
- Room not archived → `room_is_archived`
- User is a room member → `error-not-allowed` (delegates to `canAccessRoomAsync`)
- DM not blocked → `room_is_blocked`
- Read-only room: user needs `post-readonly` permission or be in `room.unmuted` list
- User not in `room.muted` array → `You_have_been_muted`

**`validateMessage()` (functions layer)**
- No `alias`/`avatar` impersonation without `message-impersonate` permission
- No `javascript:` protocol URLs in attachments (XSS prevention)
- Valid attachment structure

---

### Authorization Module Structure

```
apps/meteor/app/authorization/server/functions/
├── canSendMessage.ts       ← message send permission
├── canAccessRoom.ts        ← room membership (delegates to @rocket.chat/core-services)
└── hasPermission.ts        ← generic role/permission checks
```

The thin wrappers in `app/authorization/server/` delegate to `@rocket.chat/core-services`'s `Authorization` service for the actual permission resolution.

---

## Q3: What is the storage workflow for file uploads?

## File Upload Storage Workflow

### High-Level Flow

```
Client (XHR multipart) → POST /v1/rooms.media/:rid
  → Busboy parses → temp file on disk
  → Validate + image processing (Sharp)
  → write() to storage backend
  → return fileId to client

Client → POST /v1/rooms.mediaConfirm/:rid/:fileId
  → build message attachment
  → mark file permanent
  → post chat message
```

The two-step design (upload → confirm) allows encrypted rooms to attach E2E metadata before the message appears.

---

### Stage 1 — Client Upload

**`client/lib/chats/flows/uploadFiles.ts`** validates file count and checks if the room requires E2EE. For encrypted rooms, files are encrypted via `e2eRoom.encryptFile()` before sending.

**`client/lib/chats/uploads.ts`** (`UploadsStore`) sends a single `multipart/form-data` XHR to `POST /v1/rooms.media/:rid`. **Not chunked** — one request per file, with real-time progress tracking.

---

### Stage 2 — Server Receives & Temp-Stores

**`app/api/server/v1/rooms.ts`** validates room access, then delegates to:

**`app/api/server/lib/MultipartUploadHandler.ts`** (uses **Busboy**) which:
- Validates MIME type against allowlist and `FileUpload_MediaTypeBlackList`
- Enforces `FileUpload_MaxFileSize` (default 100 MB)
- Streams file to a **temp file on disk** (`$TMPDIR/ufs/`)
- Returns `{ tempFilePath, filename, mimetype, size }`

---

### Stage 3 — Validation, Processing & Backend Write

**`app/file-upload/server/lib/FileUpload.ts`** orchestrates:

1. **`_validateFile()`** — runs store filter (size, MIME, extension, custom `onCheck`)
2. **`uploadsOnValidate()`** (images only, via **Sharp**):
   - Extracts dimensions/format metadata
   - Rotates by EXIF orientation if `FileUpload_RotateImages` is on
   - Strips EXIF if configured
   - Creates thumbnails (`fit: 'inside'`)
   - Converts SVG → PNG for thumbnails
3. **`ufsComplete()`** (`server/ufs/ufs-methods.ts`) — reads temp file, calls `store.write()` which pipes through the backend's `getWriteStream()`
4. Temp file is deleted after successful write

No virus scanning is present in the codebase.

---

### Stage 4 — Confirm & Post Message

Client calls `POST /v1/rooms.mediaConfirm/:rid/:fileId`.

**`app/file-upload/server/methods/sendFileMessage.ts`**:
- Verifies file ownership (`userId` + `roomId` match)
- `parseFileIntoMessageAttachments()` routes by type:
  - **Image**: generates preview + thumbnail, captures dimensions
  - **Audio/Video**: embeds media URL
  - **Other**: extracts extension + basic metadata
- Posts the chat message
- `Uploads.confirmTemporaryFile()` marks file permanent in DB

---

### Storage Backends

Controlled by `FileUpload_Storage_Type`. All implement the same `Store` interface (`server/ufs/ufs-store.ts`): `create`, `delete`, `getReadStream`, `getWriteStream`, `getRedirectURL`.

| Backend | Setting | Key File |
|---|---|---|
| MongoDB GridFS (default) | `GridFS` | `server/ufs/ufs-gridfs.ts` |
| Local Filesystem | `FileSystem` | `server/ufs/ufs-local.ts` |
| Amazon S3 | `AmazonS3` | `app/file-upload/ufs/AmazonS3/server.ts` |
| Google Cloud Storage | `GoogleCloudStorage` | `app/file-upload/ufs/GoogleStorage/server.ts` |
| WebDAV | `Webdav` | `app/file-upload/ufs/Webdav/server.ts` |

**S3**: uses `@aws-sdk/client-s3` + `@aws-sdk/lib-storage` multipart upload; presigned URLs expire at `FileUpload_S3_URLExpiryTimeSpan` (default 120s). Can proxy instead of redirect.

**GridFS**: uses `GridFSBucket` with `chunkSize` = 1024×255 bytes. Collections: `rocketchat_uploads`, `rocketchat_avatars`, `rocketchat_userDataFiles`.

---

### File Serving

**`app/file-upload/server/lib/requests.ts`** handles `GET /FileUpload/[fileId]/[filename]`:

Access control checks (in order):
1. JWT token validation
2. Room coordinator check
3. Cookie auth (`rc_uid` + `rc_token`)
4. Room membership check
5. General room access check

Then either redirects to a presigned URL (S3/GCS) or proxies the stream from the backend. Supports HTTP 206 range requests and ETag/304 conditional responses.

---

## Q4: How are the keys managed for end-to-end (E2E) encryption?

## E2E Encryption Key Management

### Algorithms

| Purpose | Algorithm | Details |
|---|---|---|
| User keypair | RSA-OAEP | 2048-bit, SHA-256 |
| Room session key | AES-GCM | 256-bit |
| Private key protection (v2) | AES-GCM + PBKDF2 | 256-bit, 100k iterations |
| Private key protection (v1 legacy) | AES-CBC + PBKDF2 | 128-bit, 1k iterations |
| File encryption | AES-CTR | 256-bit, per-file key |
| Session key wrapping | RSA-OAEP | sender encrypts AES key with recipient's RSA public key |

All operations use the **Web Crypto API** (`crypto.subtle`). No ECDH — key agreement is done purely via RSA-OAEP wrapping.

---

### User Keypair Lifecycle

**Generation** (`client/lib/e2ee/rocketchat.e2e.ts` → `createAndLoadKeys()`)
1. Generate RSA-OAEP-2048 keypair via `client/lib/e2ee/crypto/rsa.ts`
2. Generate a 12-word random passphrase via CSPRNG (`helper.ts` → `generatePassphrase()`)
3. Encrypt private key JWK with passphrase using `Keychain.encryptKey()` (`keychain.ts`):
   - PBKDF2(SHA-256, 100k iterations) over passphrase → AES-GCM-256 key
   - Random salt: `"v2:{userId}:{uuid}"`, random 12-byte IV
   - Output: `{ iv, ciphertext, salt, iterations }` (v2 format)
4. Upload public key (plaintext JWK) + encrypted private key to server via `POST /v1/e2e.setUserPublicAndPrivateKeys`

**Storage**

| Data | Where | Format |
|---|---|---|
| RSA public key | Server `Users.e2e.public_key` + localStorage | JWK plaintext |
| RSA private key | Server `Users.e2e.private_key` | AES-GCM encrypted JWK |
| RSA private key (runtime) | Client memory only | `CryptoKey` object |
| E2EE passphrase | localStorage `e2e.randomPassword` | Plaintext, cleared after user saves it |

The server **never sees the plaintext private key**. Encryption happens client-side before upload.

---

### Room Session Key Generation & Distribution

**Creation** (`client/lib/e2ee/rocketchat.e2e.room.ts` → `createGroupKey()`)
1. Generate AES-GCM-256 key + UUID `keyID`
2. Register `keyID` on server via `e2e.setRoomKeyID`
3. RSA-OAEP encrypt the AES key JWK with each member's public key
4. Encoded as `{keyID}{base64(RSA-ciphertext)}` via `PrefixedBase64` (`prefixed.ts`)
5. Store per-user in `Subscriptions.E2EKey`

**Distribution to new/existing members** runs on a **10-second polling loop** (`initiateKeyDistribution()`):
1. Query `GET /v1/e2e.fetchUsersWaitingForGroupKey`
2. Encrypt AES session key with each waiting user's RSA public key
3. Post to `POST /v1/e2e.provideUsersSuggestedGroupKeys` → stored in `Subscriptions.E2ESuggestedKey` (not applied yet)
4. Recipient client decrypts suggested key with own private key:
   - Success → `POST /v1/e2e.acceptSuggestedGroupKey` → server moves to `Subscriptions.E2EKey`
   - Failure → `POST /v1/e2e.rejectSuggestedGroupKey` → server re-queues user

The suggested-key pattern ensures **no key is applied without client-side validation**.

---

### Message Wire Format

Two versions coexist:

- **v1** (`rc.v1.aes-sha2`): `{ algorithm, ciphertext: kid[12] + base64(iv[16] + data) }`
- **v2** (`rc.v2.aes-sha2`): `{ algorithm, kid, iv, ciphertext }` as separate Base64 fields

The `kid` (key ID) in each message enables decryption of messages encrypted with **old rotated keys** (kept in `Subscriptions.oldRoomKeys[]`, capped at 10).

File uploads use a **per-file AES-CTR-256 key** (not the session key); the file key is stored alongside the message.

---

### Key Rotation

**Room key rotation** (`rocketchat.e2e.room.ts` → `resetRoomKey()` + `app/e2e/server/functions/resetRoomKey.ts`):
1. Client generates new AES key + keyID, posts to `POST /v1/e2e.resetRoomKey`
2. Server archives old key to `Subscriptions.oldRoomKeys[]` for all members
3. Clears all `Subscriptions.E2EKey` except the requester's
4. Queues all other members into `usersWaitingForE2EKeys`
5. Other clients detect keyID mismatch → transition to `WAITING_KEYS` state → receive new key via the distribution loop

**User key reset** (`server/lib/resetUserE2EKey.ts` → `resetUserE2EEncriptionKey()`):
- Force-logs out all sessions, clears `Users.e2e`, resets all subscription E2E keys
- User **permanently loses access to all prior encrypted messages** — no recovery path
- Self-reset requires 2FA (`resetOwnE2EKey` method)

---

### State Machines

**Global** (`E2EEState.ts`):
```
NOT_STARTED → LOADING_KEYS → READY
                            → SAVE_PASSWORD  (new keypair, passphrase not saved)
                            → ENTER_PASSWORD (returning user, need passphrase)
                            → ERROR / DISABLED
```

**Per-room** (`E2ERoomState.ts`):
```
NOT_STARTED → ESTABLISHING → CREATING_KEYS → READY
                           → WAITING_KEYS  → READY
                           → ERROR / DISABLED
```

---

### Key Files

| File | Role |
|---|---|
| `client/lib/e2ee/rocketchat.e2e.ts` | Global `E2E` singleton: lifecycle, persistence, distribution loop |
| `client/lib/e2ee/rocketchat.e2e.room.ts` | Per-room: key creation, message encrypt/decrypt, rotation |
| `client/lib/e2ee/keychain.ts` | Password-based private key encrypt/decrypt (v1/v2) |
| `client/lib/e2ee/crypto/rsa.ts` | RSA-OAEP keypair generate, import, export, wrap/unwrap |
| `client/lib/e2ee/crypto/aes.ts` | AES-GCM session key generate, import, export, encrypt/decrypt |
| `client/lib/e2ee/crypto/pbkdf2.ts` | PBKDF2 key derivation |
| `client/lib/e2ee/content.ts` | Wire-format parsing for v1/v2 encrypted messages |
| `client/lib/e2ee/prefixed.ts` | `PrefixedBase64` codec: `keyID + base64(RSA-ciphertext)` |
| `app/e2e/server/functions/resetRoomKey.ts` | Server-side room key rotation |
| `app/e2e/server/functions/provideUsersSuggestedGroupKeys.ts` | Write suggested keys to subscriptions |
| `server/lib/resetUserE2EKey.ts` | Full user E2E key reset with forced logout |

---

## Q5: What is the complete call chain for sendMessage?

## Complete `sendMessage` Call Chain

### Client Side

```
User presses Enter
  └─ chat.flows.sendMessage(text, opts)
       [client/lib/chats/flows/sendMessage.ts]
       ├─ chat.data.isSubscribedToRoom() → joinRoom() if needed
       ├─ chat.data.composeMessage()
       └─ process(chat, message)
            ├─ processSetReaction()          → sdk.call('setReaction')  [short-circuit]
            ├─ processTooLongMessage()       → chat.flows.uploadFiles() [short-circuit]
            ├─ processSlashCommand()         → sdk.call('slashCommand') [short-circuit]
            ├─ processMessageUploads()       → sdk.rest.post('/rooms.upload/:rid')
            ├─ onClientBeforeSendMessage()   → async transform chain (E2E encrypt, etc.)
            ├─ processMessageEditing()       → sdk.call('updateMessage') [if editing]
            └─ sdk.call('sendMessage', message, previewUrls)  ← DDP over WebSocket
```

---

### Server Entry (two paths, same core)

```
DDP:  Meteor.methods({ sendMessage })   [app/lib/server/methods/sendMessage.ts]
REST: POST /api/v1/chat.sendMessage     [app/api/server/v1/chat.ts]
  ├─ check() / Match validation
  ├─ Meteor.userAsync() auth check
  ├─ MessageTypes.isSystemMessage() guard
  ├─ applyAirGappedRestrictionsValidation()
  ├─ RateLimiter: 5 msg/s (unless 'send-many-messages' permission)
  └─ executeSendMessage(user, message, { previewUrls })
```

---

### `executeSendMessage` → `canSendMessageAsync` → `sendMessage`

```
executeSendMessage()           [methods/sendMessage.ts]
  ├─ tshow/tmid param validation
  ├─ Timestamp drift check (±60s hard limit)
  ├─ Message_MaxAllowedSize check
  ├─ Users.findOneById(uid)
  ├─ Messages.findOneById(tmid)  [thread parent → resolves rid]
  ├─ canSendMessageAsync(rid, user)    [authorization/canSendMessage.ts]
  │    └─ validateRoomMessagePermissionsAsync()
  │         ├─ Rooms.findOneById(rid) — room must exist
  │         ├─ room.archived check
  │         ├─ canAccessRoomAsync()   — membership check
  │         ├─ Subscriptions lookup  — blocked/blocker check
  │         ├─ hasPermissionAsync('post-readonly')
  │         └─ room.muted[] check
  ├─ E2E policy check (encrypted room + unencrypted message → deny)
  ├─ metrics.messagesSent.inc()
  └─ sendMessage(user, message, room, opts)   [functions/sendMessage.ts]
       ├─ validateMessage()
       │    ├─ check() structural validation
       │    ├─ hasPermissionAsync('message-impersonate')  [alias/avatar guard]
       │    ├─ validateBodyAttachments()  [no javascript: URLs]
       │    └─ validateCustomMessageFields()
       ├─ prepareMessageObject()  [sets ts, u, rid]
       ├─ message.unread = true  [if read receipts enabled]
       │
       ├─ Apps.triggerEvent(IPreMessageSentPrevent)  → abort if true
       ├─ Apps.triggerEvent(IPreMessageSentExtend)
       ├─ Apps.triggerEvent(IPreMessageSentModify)
       ├─ re-validateMessage()  [post-app-modification]
       │
       ├─ Message.beforeSave()  [URL parsing, OEmbed, link previews]
       ├─ Messages.insertOne(message)  /  Messages.updateOne() [upsert]
       │
       ├─ Apps.triggerEvent(IPostMessageSent)
       ├─ afterSaveMessage(message, room, user)   [lib/afterSaveMessage.ts]
       │    ├─ callbacks.run('afterSaveMessage', ...)  [priority-ordered chain]
       │    │    ├─ sendNotificationsOnMessage  ← see below
       │    │    ├─ thread reply tracking
       │    │    ├─ federation relay
       │    │    ├─ omnichannel hooks
       │    │    └─ integration webhooks
       │    ├─ Rooms.updateFromUpdater()  [persist room metadata changes]
       │    └─ Message.afterSave()       [core-services post-save hook]
       └─ notifyOnRoomChangedById(rid)   [trigger client room list refresh]
```

---

### Notification Dispatch Chain

```
sendAllNotifications(message, room)    [lib/sendNotificationsOnMessage.ts]
  └─ sendMessageNotifications()
       ├─ getMentions()                [lib/notifyUsersOnMessage.ts]
       │    └─ callbacks.run('beforeGetMentions', ...)
       ├─ callbacks.run('beforeSendMessageNotifications', msg)
       ├─ Subscriptions.col.aggregate([$match, $lookup users, $project])
       └─ sendNotification()  [per matching subscriber]
            ├─ parseMessageTextPerUser()
            ├─ messageContainsHighlight()
            ├─ shouldNotifyDesktop() → notifyDesktopUser()
            │    └─ api.broadcast('notify.desktop', uid, payload)  → WebSocket
            ├─ shouldNotifyMobile() → getPushData()                [notifications/mobile.ts]
            ├─ shouldNotifyEmail()  → getEmailData()               [notifications/email.ts]
            └─ Notification.scheduleItem()   [NotificationQueue.ts]
                 └─ worker loop (every 2s, up to 100 items/cycle)
                      ├─ 'push'  → PushNotification.send() → APNs/FCM
                      └─ 'email' → sendEmailFromData()     → SMTP
```

---

### Key Files

| Layer | File |
|---|---|
| Client flow | `client/lib/chats/flows/sendMessage.ts` |
| DDP method + executeSendMessage | `app/lib/server/methods/sendMessage.ts` |
| REST route | `app/api/server/v1/chat.ts` |
| Core sendMessage | `app/lib/server/functions/sendMessage.ts` |
| Permission gate | `app/authorization/server/functions/canSendMessage.ts` |
| afterSaveMessage runner | `app/lib/server/lib/afterSaveMessage.ts` |
| Notification dispatch | `app/lib/server/lib/sendNotificationsOnMessage.ts` |
| Notification queue worker | `app/notification-queue/server/NotificationQueue.ts` |

---

## Q6: How are Livechat requests routed to the server-side?

## Livechat Request Routing

### Widget Communication Architecture

The Livechat widget is a **Preact SPA** served inside an `<iframe>`. It uses three communication layers:

```
Host page  ←─ postMessage ─→  Widget iframe  ←─ DDP/WebSocket + REST ─→  Rocket.Chat server
[widget.ts]                   [parentCall.ts]   [api.ts: LivechatClientImpl]
```

- **DDP**: real-time subscriptions (messages, agent status, queue position)
- **REST**: lifecycle actions (visitor registration, room creation, closing)
- **postMessage**: events surfaced to the embedding site (`chat-started`, `assign-agent`, `queue-position-change`, etc.)

---

### Session Initiation: Visitor Click → Assigned Agent

```
1. GET /api/v1/livechat/config?token=<t>      [api/v1/config.ts]
   └─ Returns settings, departments, triggers, open room info

2. POST /api/v1/livechat/visitor               [api/v1/visitor.ts]
   └─ registerGuest() → upsert ILivechatVisitor (token, name, email, dept, custom fields)

3. GET /api/v1/livechat/room?token=<t>         [api/v1/room.ts]
   └─ createRoom(visitor, roomInfo, agent)      [lib/rooms.ts]
        ├─ checkDefaultAgentOnNewRoom()         ← hookable override point
        ├─ getRequiredDepartment()              ← forces dept if Livechat_Require_Department
        └─ QueueManager.requestRoom(...)        [lib/QueueManager.ts]
```

---

### `QueueManager.requestRoom` Pipeline

```
QueueManager.requestRoom()
  ├─ beforeDelegateAgent()         ← assigns bot if Livechat_assign_new_conversation_to_bot
  ├─ getDepartment()               ← recurses through fallbackForwardDepartment chain
  ├─ Livechat_accept_chats_with_no_agents check
  ├─ prepareLivechatRoom()         ← sets priorityWeight, SLA, estimatedWaitTime, contactId
  ├─ Apps.triggerEvent(IPreLivechatRoomCreatePrevent)  ← apps can abort
  ├─ startConversation()           ← MongoDB transaction: creates Room + LivechatInquiry atomically
  ├─ onNewRoom()                   ← updates visitor.lastChat, fires CRM webhook
  ├─ processNewInquiry(inquiry, room, defaultAgent)
  │    ├─ getInquiryStatus() determines: READY | QUEUED | VERIFYING
  │    │    ├─ READY   → if bot agent OR (autoAssignAgent AND waiting queue off)
  │    │    ├─ QUEUED  → if waiting queue on, or Manual_Selection, or no agent found
  │    │    └─ VERIFYING → if contact verification required
  │    ├─ READY   → RoutingManager.delegateInquiry(inquiry, agent)  [assign immediately]
  │    └─ QUEUED  → afterInquiryQueued + afterRoomQueued hooks, dispatchInquiryQueued
  └─ dispatchInquiryPosition()     ← notifies visitor of queue position
```

---

### RoutingManager (`lib/RoutingManager.ts`)

The strategy registry and core assignment orchestrator:

```
RoutingManager.delegateInquiry(inquiry, agent?)
  ├─ getNextAgent(department)       ← delegates to active strategy if no agent provided
  ├─ conditionalLockAgent(agentId)  ← MongoDB atomic mutex (when waiting queue enabled)
  └─ takeInquiry(inquiry, agent, room)
       ├─ LivechatInquiry.takeInquiry()  ← MongoDB update with lockedAt check
       ├─ livechat.checkAgentBeforeTakeInquiry callback
       ├─ assignAgent(inquiry, agent)
       │    ├─ Creates Subscription
       │    ├─ Updates room.servedBy
       │    ├─ Saves 'command/connected' + 'uj' system messages
       │    └─ dispatchAgentDelegated() → notifies widget via DDP
       └─ Apps.triggerEvent(IPostLivechatAgentAssigned)
```

---

### Routing Strategies

| Strategy | Edition | Algorithm | Queue Visible to Agents? |
|---|---|---|---|
| `Auto_Selection` | CE | Fewest open chats | No |
| `Manual_Selection` | CE | None — agents claim manually | Yes |
| `External` | CE | HTTP call to external URL (10 parallel requests) | No |
| `Load_Balancing` | EE | Fewest open chats, excludes over-limit agents | No |
| `Load_Rotation` | EE | Round-robin by oldest last-routed timestamp | No |

All implement `getNextAgent(department?, ignoreAgentId?): Promise<SelectedAgent | null>`.

Active strategy is read from the `Livechat_Routing_Method` setting at runtime.

---

### Department & Agent Selection Details

- **Department fallback**: `getDepartment()` checks if any agents are online in the department; if not, follows `department.fallbackForwardDepartment` recursively (EE: `beforeRoutingChat` hook handles this)
- **Bot priority**: if no human agent and `Livechat_assign_new_conversation_to_bot` is on → `getNextBotForDepartment()` or `getNextBotAgent()`; bots skip the queue entirely via `allowAgentSkipQueue`
- **Agent lock** (`conditionalLockAgent.ts`): `Users.acquireAgentLock(agentId, lockTime)` is an atomic MongoDB op preventing two concurrent requests from double-assigning the same agent

---

### Queue Mechanism

The queue is the **`LivechatInquiry` MongoDB collection** (statuses: `ready`, `queued`, `taken`, `verifying`).

- Sort order: `priorityWeight` + `ts` (configurable via `getInquirySortMechanismSetting()`)
- Queue position is calculated via `LivechatInquiry.getCurrentSortedQueueAsync()` and pushed to the visitor in real-time
- Re-queuing (`requeueInquiry`): triggered on agent unassign or room re-open → calls `beforeRouteChat` hook → `delegateAgent()` → `dispatchInquiryQueued()`
- Agent claims from queue: `takeInquiry()` in `lib/takeInquiry.ts` → validates MAC limits and contact channel block → `RoutingManager.takeInquiry(..., { clientAction: true })`

---

### Extension Hooks

| Hook | CE behavior | EE patch |
|---|---|---|
| `beforeRouteChat` | passthrough | dept fallback + waiting queue enrollment |
| `beforeDelegateAgent` | bot agent check | — |
| `checkDefaultAgentOnNewRoom` | passthrough | — |
| `livechat.checkAgentBeforeTakeInquiry` | passthrough | enforces simultaneous chat limits |
| `livechat.applySimultaneousChatRestrictions` | passthrough | filters over-limit agents from selection |

---

### Key Files

| File | Role |
|---|---|
| `packages/livechat/src/api.ts` | Widget DDP/REST client |
| `packages/livechat/src/widget.ts` | Host-page embed + postMessage API |
| `app/livechat/server/api/v1/room.ts` | `GET /livechat/room` — routing entry point |
| `app/livechat/server/lib/QueueManager.ts` | Room/inquiry lifecycle orchestration |
| `app/livechat/server/lib/RoutingManager.ts` | Strategy registry, `takeInquiry`, `assignAgent` |
| `app/livechat/server/lib/routing/AutoSelection.ts` | CE least-open-chats strategy |
| `app/livechat/server/lib/routing/ManualSelection.ts` | CE manual queue strategy |
| `app/livechat/server/lib/routing/External.ts` | CE external HTTP strategy |
| `app/livechat/server/lib/conditionalLockAgent.ts` | MongoDB atomic agent mutex |
| `app/livechat/server/lib/hooks.ts` | Patchable extension points |
| `ee/app/livechat-enterprise/server/lib/routing/LoadBalancing.ts` | EE load balancing |
| `ee/app/livechat-enterprise/server/lib/routing/LoadRotation.ts` | EE round-robin |
| `ee/app/livechat-enterprise/server/hooks/beforeRoutingChat.ts` | EE dept fallback + waiting queue |

---

## Q7: How are new endpoints registered in the REST API?

## REST API Endpoint Registration

### HTTP Framework

Rocket.Chat uses **Hono** (not Express or Iron Router) mounted onto Meteor's `WebApp.rawConnectHandlers`. The `@rocket.chat/http-router` package wraps Hono and bridges it to the API context.

```typescript
// api.ts — startup
WebApp.rawConnectHandlers.use(
    API.api
        .use(remoteAddressMiddleware)
        .use(cors(settings))
        .use(loggerMiddleware(logger))
        .use(metricsMiddleware({...}))
        .use(tracerSpanMiddleware)
        .use(API.v1.router)     // mounts at /api/v1
        .use(API.default.router) // mounts at /api
        .router
);
```

---

### API Singletons and Versioning

```typescript
// api.ts
export const API = {
    v1:      createApi({ version: 'v1', useDefaultAuth: true }),  // → /api/v1/*
    default: createApi({}),                                        // → /api/*
};
```

Versioning is purely path-prefix based. `useDefaultAuth: true` auto-registers `/login` and `/logout`.

---

### Registering an Endpoint

**Two styles coexist:**

**Legacy (`addRoute`)** — used by most existing files:
```typescript
// apps/meteor/app/api/server/v1/channels.ts
API.v1.addRoute('channels.addAll',
    { authRequired: true, validateParams: isChannelsAddAllProps },
    {
        async post() {
            const { roomId } = this.bodyParams;
            return API.v1.success(await addAllUserToRoom(roomId));
        }
    }
);
```

**Modern typed** — explicit AJV validators for query/body/response:
```typescript
API.v1.get('rooms.info', {
    authRequired: true,
    query: isRoomsInfoQueryParams,          // AJV ValidateFunction
    response: { 200: isRoomsInfoResponse }, // typed response schema
}, async function() {
    const { roomId } = this.queryParams;    // fully typed
    ...
});
```

New endpoint files must be imported in `apps/meteor/app/api/server/index.ts` to be loaded at startup.

---

### `addRoute` Internal Pipeline

For each `(route, HTTP method)` pair registered, `addRoute`:

1. Normalizes `permissionsRequired` via `checkPermissions(options)`
2. Registers a rate limiter rule if applicable (`addRateLimiterRuleForRoutes()`)
3. Wraps the action in `_internalRouteActionHandler` which at request time:
   - Enforces rate limit → 429 if exceeded
   - Runs AJV `validateParams` → throws `invalid-params` on failure
   - Runs `processTwoFactor()` if `twoFactorRequired: true`
   - Wraps in `createMeteorInvocation()` if `applyMeteorContext: true`
   - Calls `originalAction.apply(this)`
4. Registers on Hono router: `this.router[method](path, auth, permissions, license, wrappedAction)`

---

### Full Per-Request Middleware Stack

```
remoteAddressMiddleware   → c.vars.remoteAddress
cors()                    → CORS headers / preflight
loggerMiddleware()        → HTTP request/response logging
metricsMiddleware()       → Prometheus timer
tracerSpanMiddleware      → OpenTelemetry span + X-Trace-Id header
─── per-route ───────────────────────────────────────────────────
authenticationMiddleware  → looks up x-auth-token + x-user-id → c.set('user', user)
permissionsMiddleware     → checks permissionsRequired → 403 if denied
license()                 → checks options.license modules → 403 if not licensed
_internalRouteActionHandler
    ├─ enforceRateLimit()
    ├─ validateParams (AJV)
    ├─ processTwoFactor()
    └─ action.apply(this)
```

---

### Request Context (`this` inside a handler)

| Property | Source |
|---|---|
| `this.userId` / `this.user` | Set by auth middleware from `x-user-id` + `x-auth-token` headers |
| `this.bodyParams` | Parsed request body |
| `this.queryParams` | URL query string params |
| `this.urlParams` | Hono path params (e.g. `:rid`) |
| `this.requestIp` | Set by `remoteAddressMiddleware` |
| `this.connection` | Synthetic DDP-like connection object |
| `this.parseJsonQuery()` | Parses `sort`, `fields`, `query` from query string |

`this.user` / `this.userId` are only non-optional at the TypeScript level when `authRequired: true`.

---

### Options Reference

| Option | Type | Effect |
|---|---|---|
| `authRequired` | `boolean` | 401 if no authenticated user |
| `authOrAnonRequired` | `boolean` | Allows anonymous if `Accounts_AllowAnonymousRead` is on |
| `permissionsRequired` | `string[]` or per-method map | Enforced by `permissionsMiddleware` → 403 |
| `validateParams` | AJV `ValidateFunction` | Validates body (POST) or query (GET) |
| `rateLimiterOptions` | `{ numRequestsAllowed, intervalTimeInMS }` or `false` | Per-route rate limit override |
| `twoFactorRequired` | `boolean` | Requires valid 2FA code in `x-2fa-code` header |
| `license` | `LicenseModule[]` | Requires specific EE license modules |
| `applyMeteorContext` | `boolean` | Wraps action in a Meteor DDP invocation context |
| `deprecation` | `{ version, alternatives }` | Logs deprecation warning; hard-errors if past removal version |

---

### Key Files

| File | Role |
|---|---|
| `app/api/server/api.ts` | Creates `API.v1`/`API.default` singletons, calls `startRestAPI()` |
| `app/api/server/ApiClass.ts` | `APIClass`: `addRoute()`, `_internalRouteActionHandler()`, rate limiting |
| `app/api/server/router.ts` | `RocketChatAPIRouter`: Hono bridge, builds `ActionThis` context |
| `app/api/server/definition.ts` | `Options`, `ActionThis`, `TypedOptions` TypeScript types |
| `app/api/server/ajv.ts` | AJV instance with core-typings component schemas |
| `app/api/server/middlewares/authenticationHono.ts` | Token lookup → `c.set('user', user)` |
| `app/api/server/middlewares/permissions.ts` | `permissionsRequired` enforcement |
| `app/api/server/index.ts` | Imports all v1 endpoint files at startup |

---

## Q8: How are federation messages sent across different servers?

## Federation Message Sending

### Protocol

Rocket.Chat uses the **Matrix Server-to-Server (S2S) federation protocol** — it acts as its own Matrix homeserver (no separate Synapse). The `@rocket.chat/federation-sdk` npm package (v0.4.1) serves as the protocol engine. This is an **Enterprise Edition** feature requiring a `federation` license module.

---

### Architecture Overview

```
Rocket.Chat Server A                          Rocket.Chat Server B
─────────────────────                         ─────────────────────
afterSaveMessage hook                         PUT /_matrix/federation/v1/send/{txnId}
  → FederationMatrix.sendMessage()              → isAuthenticatedMiddleware (Ed25519 verify)
      → federationSDK.sendMessage()               → federationSDK.processIncomingTransaction()
          → signs PDU (Ed25519)                       → eventEmitterService.emit()
          → PUT /_matrix/federation/v1/send/…             → events/message.ts
                                                              → Message.saveMessageFromFederation()
```

There is no separate bridge process — Matrix routes are mounted directly into Meteor's Express stack:
```typescript
WebApp.rawConnectHandlers.use(routes.matrix.router).use(routes.wellKnown.router);
```

---

### Outbound Message Flow (Server A)

**1. Hook fires** (`ee/server/hooks/federation/index.ts`)

`afterSaveMessage` callback calls `FederationActions.shouldPerformFederationAction(room)`:
- Returns `true` only if `room.federated === true` AND `room.federation.version === 1`
- Skips if `message.federation?.eventId` already set (loop prevention — message came from Matrix)

**2. `FederationMatrix.sendMessage(message, room, user)`** (`ee/packages/federation-matrix/src/FederationMatrix.ts`)
- Resolves sender Matrix ID: `@username:serverDomain` (local) or `user.federation.mui` (remote)
- Converts message to Matrix format via `toExternalMessageFormat()` — handles `@mention` → HTML pills, markdown
- For file messages: generates `mxc://` URI via `MatrixMediaService.prepareLocalFileForMatrix()`
- Calls `federationSDK.sendMessage(roomId, rawBody, htmlBody, userId, replyTo?)`
- Stores returned Matrix `eventId` back: `Messages.setFederationEventIdById(message._id, eventId)`

**3. `federationSDK.sendMessage()`** (inside `@rocket.chat/federation-sdk`)
- Builds a PDU (`m.room.message` event) with `room_id`, `sender`, `origin_server_ts`, `prev_events`, `auth_events`, `depth`
- **Signs** the PDU with Ed25519 using the server's signing key
- Enqueues in a **priority queue** for transaction batching
- Sends `PUT /_matrix/federation/v1/send/{txnId}` to all remote homeservers with room members

---

### Inbound Event Processing (Server B)

**1. Request received**: `PUT /_matrix/federation/v1/send/{txnId}` (`src/api/_matrix/transactions.ts`)

**2. Auth middleware** (`src/api/middlewares/isAuthenticated.ts`):
- Verifies `Authorization: X-Matrix ...` header Ed25519 signature
- Fetches remote server's public key from `GET /_matrix/key/v2/server` on the remote
- Stores verified server name in Hono context

**3. Access control**: domain allow-list check + `federationSDK.canAccessResource()`

**4. `federationSDK.processIncomingTransaction(body)`**:
- Validates + deduplicates by `txnId` (MongoDB-backed)
- Stores PDUs in EventStore
- Emits typed events on `federationSDK.eventEmitterService`

**5. Event handlers dispatch**:

| Matrix Event Type | Handler File | RC Action |
|---|---|---|
| `m.room.message` | `src/events/message.ts` | `Message.saveMessageFromFederation()` |
| `m.room.member` | `src/events/member.ts` | invite/join/leave processing |
| `m.reaction` | `src/events/reaction.ts` | `Message.reactToMessage()` |
| `m.room.name/topic` | `src/events/room.ts` | Room metadata update |
| `m.typing` / `m.presence` / `m.receipt` | `src/events/edu.ts` | Typing indicators, presence, read receipts |

Each handler upserts remote users via `createOrUpdateFederatedUser()` if not yet known locally.

---

### Identity and Room Format

**Users**: `@localpart:serverdomain` — e.g., `@alice:chat.example.com`
- Local users: `@username:serverName` (constructed dynamically)
- Remote users stored with `user.federated = true`, `user.federation.mui` = full Matrix ID, role `federated-external`
- Helper: `getUsernameServername(mxid, serverName)` → `(username, domain, isLocal)`

**Rooms**: `!<opaque-id>:<server-domain>` — e.g., `!abc123:chat.example.com`
- Stored as `room.federation.mrid` in MongoDB
- All inbound event lookups: `Rooms.findOne({ 'federation.mrid': event.room_id })`

---

### Server Authentication (Ed25519 Signing)

- On startup, `generateFederationKeys()` creates an Ed25519 keypair stored in settings (`Federation_Service_Matrix_Signing_Key/Algorithm/Version`)
- **Key publication**: `GET /_matrix/key/v2/server` returns signed key document (refreshed every 60 min by default)
- **Outbound**: every PDU and HTTP request is signed before sending
- **Inbound**: `federationSDK.verifyRequestSignature()` fetches and caches remote server's public key, verifies the `X-Matrix` authorization header

---

### Queue, Retry, and Loop Prevention

**Queue**: Priority queue (`priorityqueue`) inside the SDK batches outbound transactions. Inbound concurrency overload returns HTTP 429 `M_UNKNOWN: Too many concurrent transactions`.

**Loop prevention** (multiple layers):
- `afterSaveMessage`: skip if `message.federation?.eventId` is set
- `afterReadMessages`: skip if `isUserNativeFederated(user)` (receipt already came from Matrix)
- `beforeAddUserToRoom`: skip re-propagating invites from Matrix users
- `FederationActions.shouldPerformFederationAction(room)`: gates every outbound action

---

### Key Files

| File | Role |
|---|---|
| `ee/packages/federation-matrix/src/FederationMatrix.ts` | All outbound Matrix operations |
| `ee/packages/federation-matrix/src/api/routes.ts` | Registers all `/_matrix/*` and `/.well-known/*` HTTP routes |
| `ee/packages/federation-matrix/src/api/_matrix/transactions.ts` | Inbound PDU/EDU handler |
| `ee/packages/federation-matrix/src/api/middlewares/isAuthenticated.ts` | Ed25519 signature verification |
| `ee/packages/federation-matrix/src/events/message.ts` | Inbound message → RC message |
| `ee/packages/federation-matrix/src/helpers/message.parsers.ts` | Matrix ↔ RC message format conversion |
| `ee/packages/federation-matrix/src/services/MatrixMediaService.ts` | `mxc://` URI management |
| `ee/server/hooks/federation/index.ts` | 15 RC event callbacks → outbound federation calls |
| `apps/meteor/server/services/federation/Settings.ts` | All `Federation_Matrix_*` admin settings |

---

