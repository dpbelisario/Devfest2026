# Warning delivery and Firebase setup

Workflow 2 now prepares a durable handoff to Cloud Run. It does not yet send phone
notifications: Firebase, a deployed ingestion API, and Android FCM integration are
not configured. The workflow is unpublished, its delivery switch is off, and the
unconfigured HTTP sender node is disabled.

## What the workflow implements

- Weather and disaster branches queue each newly processed source bulletin before
  updating the archive/current-state records used for deduplication. If queueing
  fails, the source is not marked processed and can be collected again.
- The `Evacuation-AR warning delivery outbox` table stores `deliveryKey`,
  `sourceUrl`, `publishedAt`, `payloadJson`, `deliveryStatus`, and `acknowledgedAt`.
  Normal reports enter `pending`; disaster training/test reports enter `excluded`
  and remain archived without entering the delivery query.
- A separate branch runs on both manual and scheduled triggers, including when
  the feeds have no new bulletins. When enabled, it reads the three oldest pending
  rows, processes one at a time, and POSTs to the configured endpoint. Each request
  has a three-second timeout, up to two attempts, and no redirects.
- Failed requests and invalid acknowledgements return to the loop without changing
  the pending row. Only a matching successful acknowledgement changes the status
  to `acknowledged`. This means backend acceptance, not FCM or phone delivery.
- Collection keeps official categories, areas, revisions, and cancellation
  semantics. A cancellation means unknown status, never an all-clear.

The handoff forwards source updates for ingestion. Meaningful-change detection,
recipient selection, notification expiry, and FCM delivery belong in the backend
and are not implemented by this workflow. In particular, `aichiMentioned` is not
an instruction to notify every user in Aichi.

## Required Cloud Run API contract — not implemented yet

Deploy an HTTPS endpoint, for example `POST /internal/warnings`, that validates an
ingestion credential before accepting requests. Public demo read endpoints do not
authorize this write operation. A simple initial option is an application-level
Bearer token stored in Secret Manager and an n8n credential. This is separate from
Cloud Run IAM authentication: a private IAM service additionally requires a valid
Google identity token. Never put the shared token in source, workflow parameters,
or exports.

The workflow sends `Idempotency-Key: <deliveryKey>` and this JSON body:

```json
{
  "schemaVersion": 1,
  "deliveryKey": "jma:<official source URL>",
  "sourceUrl": "<official source URL>",
  "publishedAt": "<source publication timestamp>",
  "bulletinType": "VPWW53",
  "purpose": "warning_ingestion",
  "bulletin": {}
}
```

`bulletin` contains the normalized official report and retained raw fields. The
supported types are `VPWW53`, `VXSE53`, `VTSE41`, and `VFVO50`. Validate the entire
request at runtime, including allowed official source URLs and consistent identity.
The `backendConnected` and `notificationsSent` fields inside archived bulletins
describe collection-time state; use separate backend delivery records thereafter.

Before returning success, persist the report and any notification work in durable
storage, such as Firestore. Deduplicate the delivery key transactionally. Repeated
requests must return the same acceptance without creating duplicate notification
jobs. Return HTTP 200 or 202 with:

```json
{
  "accepted": true,
  "deliveryKey": "jma:<same official source URL>"
}
```

Do not acknowledge merely because the request arrived. The backend must own retry
and expiry of accepted FCM work, independently of ingestion. Determine affected
users from the bulletin's area code system and their selected/current area; these
code systems differ between weather, tsunami, earthquake, and volcanic reports.
Compare relevant state before deciding to push. Preserve corrections and
cancellations; reject training/test reports from user notifications. Historical,
superseded, or stale reports may be archived without generating a push.

## Firebase and Android setup

1. Create a Firebase project, preferably using the same Google Cloud project as
   Cloud Run. Enable the Firebase Cloud Messaging API and grant the backend's
   runtime identity only the permissions needed to send messages. Use application
   default credentials on Cloud Run instead of a downloaded service-account key.
2. Implement Firebase Admin SDK sending in the backend and persistent notification
   jobs/status. Store device registrations or explicit area subscriptions. Do not
   treat an FCM send response as proof the user saw the warning.
3. Register the Android app in Firebase using its actual application ID. Add its
   Firebase client configuration and Messaging SDK, token registration/refresh,
   notification channels, Android 13+ notification permission, foreground handling,
   and a notification tap destination showing the source bulletin.
4. Implement token cleanup and subscription changes. The app must fetch current
   warnings on opening/resuming, even if no push arrived.

See [server sending](https://firebase.google.com/docs/cloud-messaging/send/admin-sdk)
and [Android setup](https://firebase.google.com/docs/cloud-messaging/android/client).

## Connect and verify

1. Keep `enabled: false` in **Cloud Run delivery configuration** while setting up.
2. Deploy and test the ingestion API with durable storage and notification expiry.
3. Create an n8n Custom Auth credential for **Send warning to Cloud Run**, using
   the template `{"headers":{"Authorization":"Bearer {{api_key}}"}}`. Enter the
   actual token only in the credential's secret field, matching the backend secret.
4. Set `endpointUrl` in the configuration node to the deployed HTTPS endpoint.
   The guard accepts a hostname and path without credentials, query, or fragment.
5. Review pending rows before enabling. They can contain historical recovery
   bulletins. Do not push them as new emergencies. Already archived source URLs
   are not automatically copied into the new outbox.
6. Enable the **Send warning to Cloud Run** node and set `enabled: true`, then
   manually test against a staging backend and test
   phone. Check valid acceptance, duplicate POSTs, HTTP failures, a wrong delivery
   key, and an empty feed with a pending row. Only valid acceptance should change
   a row to `acknowledged`; failures should leave it pending.
7. Publish only when automatic polling is wanted. An unpublished workflow does not
   retry automatically; further manual runs are needed. Scheduled polling every
   minute uses about 43,200 executions per 30 days.

Run sequentially: there is no cross-execution lock or exactly-once delivery.
If archiving fails after queueing, a later upsert can reset an acknowledged row to
pending. Backend idempotency is therefore mandatory. At most three queued rows
are attempted per run; repeated failures can delay later rows. Monitor the backlog
and storage limits, add retention, and split ingestion/delivery workers if volume
or latency requires it. The existing 55-second workflow timeout can interrupt a
busy run; unacknowledged rows stay pending. An earlier collection-branch failure
can also prevent the delivery branch from running in that execution.

Local checks (synthetic fixtures, no cloud writes or pushes):

```sh
node --test automation/n8n/tests/*.test.mjs
npx prettier --check automation/n8n/workflow-2.json docs/notifications.md
```
