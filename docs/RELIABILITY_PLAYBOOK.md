# Reliability playbook

These rules capture failure modes that are easy to reproduce when connecting MCP Events to a long-lived ChatGPT Work conversation.

## Preserve one identity per logical event

- Keep the Standard Webhooks `webhook-id` stable for every retry of the same event.
- Keep the body `eventId` and `data.event_id` equal to that same value.
- Bind the reply idempotency key to the event: `reply:<eventId>`.
- Do not create a new event identity just to bypass receiver deduplication. If an old deployment used incompatible identities, treat recovery as a separate, explicitly authorized operation.

## Avoid retry amplification in a slow conversation

- `TRANSPORT_EVENT_RETRY_DELAYS_MS` controls managed event delivery attempts. The default `0,5000,15000` keeps bounded retries for transient callback failures.
- If the event host accepts callbacks but a long-running conversation regularly takes longer than the acknowledgement timeout to call the reply tool, repeated delivery can add duplicate work to the same queue. In that environment, set `TRANSPORT_EVENT_RETRY_DELAYS_MS=0` to make one delivery attempt, and choose an acknowledgement timeout that covers the expected run time.
- Single delivery trades duplicate-work pressure for less automatic recovery from a genuinely lost callback. Keep the delivery watchdog and operational monitoring enabled, and verify callback acceptance, write receipt, and client receipt as separate stages.
- This setting reduces one source of queue amplification. It does not guarantee platform latency or prevent work already queued by the event host from competing with a new message.

## Separate content from operations

- User content may wake the conversational task.
- Outage, recovery, and health notifications should be sent through a backend-owned, authenticated, idempotent notification path.
- Operational alerts must not be converted into user content or injected into the agent's conversation merely to obtain delivery.

## Cut over conversations fail-closed

- Create the replacement task before disabling the old task when the platform supports a safe overlap-free handoff.
- Verify the exact conversation, event names, channel arguments, enabled state, model, reasoning level, and subscription count.
- Never replay retained pending or stalled records as part of a routine cutover.
- Keep a concise handoff package with current behavior, unresolved work, and the last few verbatim exchanges. Do not assume a new conversation inherits old context.

## Verify in layers

Record these as separate observations:

1. The event was accepted by the transport.
2. The callback was accepted by the event host.
3. The reply tool produced a successful write receipt.
4. The user observed the message in the client.

Passing an earlier layer does not prove a later one.
