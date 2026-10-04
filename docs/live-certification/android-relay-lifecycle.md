# Android Relay Lifecycle Intent

This branch owns one PREPRODUCTION certification intent:

- load Gecko + ChatGPT immediately when BKE Worker opens;
- make START / STOP control relay runtime only;
- make APPLY apply relay configuration independently of browser lifetime;
- prevent overlapping/stale reconnect callbacks;
- keep Android/relay ACK semantics aligned;
- reject identifiable protocol-invalid wakes explicitly;
- advance the PREPRODUCTION Durable Object routing generation once to supersede the currently stuck v1 wake ledger.

Certification owner graph: `android` + `relay`.

Production remains locked.
