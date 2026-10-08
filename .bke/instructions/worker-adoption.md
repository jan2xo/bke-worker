# BKE Worker Consumer Adoption

This repository is the first proving adopter of the shared BKE Autonomous Engineering consumer contract, not a special-case implementation.

During migration, `BKE-WORKER-CANONICAL-PROJECT-EXECUTION-INSTRUCTIONS.md` remains the Worker-specific operating contract. Shared Autonomous Engineering adds cross-repository GitHub truth, exact-head evidence, ownership, human-auth, certification-graph, capsule, and evidence-escalation semantics.

Worker consumes the public Autonomous Engineering runtime at the exact immutable SHA declared in `.bke/autonomous.json`. Repository-specific executable adapters remain under the `repo.*` namespace and execute from the Worker repository root.

Do not delete or weaken existing Worker certification, dispatcher, browser-authentication, production, signing, security, or human-authorization boundaries merely because they are not yet modeled by the shared layer.

Adoption is successful only when the consumer exact head and pinned Autonomous Engineering revision are bound into one execution identity and the declared Worker `repo.*` checks produce compact exact-head evidence.
