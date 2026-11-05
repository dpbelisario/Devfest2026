# Evacuation-AR workflows

[n8n instance](https://minhc613.app.n8n.cloud)

| Workflow                                                                                   | What it does                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Workflow 1](https://minhc613.app.n8n.cloud/workflow/6tZRkFszCUvEA32S) · `workflow-1.json` | Downloads and validates Nagoya's official evacuation destination data, saving a new snapshot when it changes. Configured to check hourly.                                                                                                                          |
| [Workflow 2](https://minhc613.app.n8n.cloud/workflow/iaxxDBAjTsiAXCV9) · `workflow-2.json` | Checks JMA's Aichi weather feed and nationwide earthquake/volcano feed. Saves supported earthquake, tsunami and volcanic bulletins with their affected areas, while skipping previously saved data. Configured to check every minute with hourly history recovery. |

Both workflows are unpublished. Workflow 2 now queues warning handoffs in a
persistent outbox and includes an authenticated Cloud Run delivery branch with
retries and matching acknowledgements. Delivery is disabled until the backend URL
and credential are configured. Firebase sending and Android reception still need
implementation; see [notification setup](../../docs/notifications.md).

The connection between the workflows is still pending. Existing archived bulletins
are not automatically backfilled into the outbox. Run the workflow tests locally:

```sh
node --test automation/n8n/tests/*.test.mjs
```
