# Rocket.Chat Codebase — Agent Constitution

## Tools

Three tools only. All other file/shell tools are disabled.

| Tool | When to use |
|------|-------------|
| `search(query, layer?, question?)` | Find entry point by symbol or keyword |
| `graph(symbol, direction, depth?, edgeTypes?, question?)` | Traverse dependency edges from a known symbol |
| `implement(symbol, filename)` | Read full source of one specific symbol — use sparingly, max 3 calls per question |

**`implement` is expensive. Call it only at layer boundaries or to confirm a specific detail. Never call it before `graph` unless the question is Locate or Pattern type.**

---

## Navigation Rules

**Default flow for any architectural question:**
```
search → graph(down) → implement only at boundaries
```

**Pick direction:**
- `graph(down)` — what does X invoke? (trace a flow forward)
- `graph(up)` — what calls X? (find callers, assess impact)

**Pick layer to suppress noise:**
- Add `layer='client'` for UI questions
- Add `layer='server'` for backend questions
- Omit for cross-layer questions

**Edge types to filter when tracing specific patterns:**
- Event chains: `edgeTypes=['event_emit','event_listen']`
- Component tree: `edgeTypes=['jsx']`
- Full routing: `edgeTypes=['call','event_listen','pubsub_subscribe']`

**If `search` or `graph` returns nothing:** the symbol may be dynamically registered — check the Dynamic Patterns section below before retrying.

---

## Question Type → Entry Strategy

| Type | Strategy |
|------|----------|
| Architecture / Call chain | Check Architecture section for entry point → `search(entry)` → `graph(down)` |
| Locate | `search(keyword)` → `implement` top result |
| Pattern | `search` existing instance → `implement` — skip `graph` |
| Routing | Check Architecture section → `search(dispatcher)` → `graph(down, edgeTypes=[...])` |
| Impact | `search(target)` → `graph(up)` → `implement` top callers |

---

## Architecture

### Client Message Sending
```
RoomBody → ComposerContainer → ComposerMessage → MessageBox
                                                    ↓ onSend
                                             chat.flows.sendMessage()
                                                    ↓
                                             sdk.call('sendMessage')  ← DDP boundary
```
Entry: `search('MessageBox', layer='client')` → `graph(down)`

Cross DDP boundary: `sdk.call('sendMessage')` → virtual node `'sendMessage'` → server handler (see Dynamic Patterns §A)

---

### Server Message Sending
```
Meteor.methods({ sendMessage })   ← DDP entry (virtual node 'sendMessage')
        ↓
executeSendMessage                ← permission check
        ↓
sendMessage → Messages.insertOne  ← DB write
        ↓
afterSaveMessage callbacks        ← event_emit (see Dynamic Patterns §B)
```
Entry: `search('executeSendMessage', layer='server')` → `graph(down)`

---

### Push Notifications
```
afterSaveMessage  →  sendMessageNotifications  →  sendNotification (per user)
                                                          ↓
                                               shouldNotifyMobile/Desktop/Email
                                                          ↓
                                                  NotificationQueue → PushNotification → APN / FCM
```
Entry: `search('sendNotificationsOnMessage')` → `graph(down)`

---

### REST API
```
ApiClass → authenticationMiddleware → permissionsMiddleware → rate limiter → Route Handler
```
Entry: `search('ApiClass')` or search the specific route path → `graph(down)`

---

### DDP Subscription / Real-time Sync
```
Meteor.subscribe('X')  →  Meteor.publish('X', fn)  →  StreamerCentral  →  DDP push to client
                                                              ↓
                                                    Streamer Client → React re-render
```
Entry: `search('StreamerCentral')` → `graph(down)`

---

### Apps Engine
```
AppManager → AppListenerManager → executeListener()
                                        ↓
                              Bridge layer (adapts core ↔ App)
                                        ↓
                              App hook return value applied to core flow
```
Entry: `search('AppListenerManager')` → `graph(down)`

---

### Authentication
```
Meteor.loginWithPassword/LDAP/OAuth
        ↓
Accounts.registerLoginHandler  →  credential validation  →  { id, token }
        ↓ (subsequent requests)
x-auth-token header  →  authenticationMiddleware  →  Users.findOneByIdAndLoginToken
```
Entry: `search('registerLoginHandler')` → `graph(down)`

---

### Webhook Routing
```
POST /hooks/:integrationId/:token  →  authenticatedRoute  →  executeIntegrationRest  →  processWebhookMessage
```
Entry: `search('executeIntegrationRest')` → `graph(down)`

---

## Dynamic Patterns

These patterns are **not visible via import edges**. The graph connects them via virtual nodes — but only if the dispatch target is a string literal in source.

### A. DDP Method Dispatch
```
sdk.call('sendMessage')              →  virtual node 'sendMessage'
Meteor.methods({ sendMessage: fn })  →  virtual node 'sendMessage'  →  fn
```
`graph('sendMessage', up)` shows the client caller. `graph('sendMessage', down)` shows the server handler.

### B. Callbacks Event System
```
callbacks.run('afterSaveMessage')          →  virtual node 'afterSaveMessage'
callbacks.add('afterSaveMessage', handler) →  virtual node 'afterSaveMessage'  →  handler
```
Use `graph('afterSaveMessage', down, edgeTypes=['event_listen'])` to find all registered handlers.

### C. Meteor Pub/Sub
```
Meteor.subscribe('roomMessages')   →  virtual node 'roomMessages'
Meteor.publish('roomMessages', fn) →  virtual node 'roomMessages'  →  fn
```

### D. core-services Bus
Services do NOT call each other directly — they go through a broker.
```
ServiceName.method(args)   →  proxify('ServiceName')  →  LocalBroker  →  ServiceClass instance
```
If you can't find a service implementation via `graph`, search for the `ServiceClass` with `name = 'ServiceName'`.

### E. Message Rendering (data pipeline, not a call chain)
```
message.msg → parse() → Root AST → <Markup /> → <GazzodownText /> → <MessageContentBody />
```
`graph` cannot traverse this. Use `implement` on each step directly.

### F. Blaze → React (legacy portals)
Some pages use HTML/Blaze templates. React mounts into them via `createPortal`. If you find a `.html` template, look for the React counterpart in a nearby `portals/` or `views/` directory.

### G. Fuselage components
`<Box>`, `<Button>`, `<TextInput>` etc. are from `@rocket.chat/fuselage`. Do NOT traverse into Fuselage for business logic questions.

### H. Message Composer
The composer uses a native textarea + ComposerAPI, **not Slate.js**. Do not search for Slate.
```
MessageBox → ComposerAPI (setText/insertText) → onSend({ value }) → chat.flows.sendMessage()
```

---

## Subsystem Entry Points

| Subsystem | Entry Symbol | File |
|-----------|-------------|------|
| Authorization | `hasPermission` | `apps/meteor/app/authorization/server/functions/hasPermission.ts` |
| Slash commands | `slashCommands` | `apps/meteor/app/utils/server/slashCommand.ts` |
| File upload | `uploadFiles` | `apps/meteor/client/lib/chats/flows/uploadFiles.ts` |
| E2E encryption | `Rocketchate2e` | `apps/meteor/client/lib/e2ee/rocketchat.e2e.ts` |
| Livechat widget | `api` | `packages/livechat/src/api.ts` |
| Livechat routing | `RoutingManager` | `apps/meteor/app/livechat/server/lib/RoutingManager.ts` |
| Federation | `FederationMatrix` | `ee/packages/federation-matrix/src/FederationMatrix.ts` |
| Room service | `RoomService` | `apps/meteor/server/services/room/service.ts` |
| Messages model | `MessagesRaw` | `packages/models/src/models/Messages.ts` |

---

## Source Roots

| Root | Contents |
|------|----------|
| `apps/meteor/client/` | React UI, hooks, client-side flows |
| `apps/meteor/server/` | Server services, startup, lib |
| `apps/meteor/app/` | Meteor methods, REST API, legacy server code |
| `packages/` | Shared packages (models, core-services, ui-kit…) |
| `apps/meteor/ee/` and `ee/packages/` | Enterprise features |
