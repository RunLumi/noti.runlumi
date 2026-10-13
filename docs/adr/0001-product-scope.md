# ADR 0001: Notification routing, not general automation

Status: Proposed

Decision: Noti is a standalone notification routing product in the Lumi ecosystem. It will support multiple sources, destinations, formats and tenants, but will not attempt arbitrary workflows or bidirectional sync in V1.

Why: A focused promise makes onboarding, reliability, trust and distribution easier. Broad automation platforms have more integrations but require far more complexity.

Consequences: Connector adapters and normalized events must be extensible; source-to-destination routing and formatting must be first-class; unsupported operations must be visible instead of silently ignored.

Revisit when: Repeated paying customers need conditional multi-step actions beyond notifications.
