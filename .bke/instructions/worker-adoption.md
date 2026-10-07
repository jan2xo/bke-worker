# BKE Worker Consumer Adoption

This repository is the first proving adopter of the shared BKE Autonomous Engineering consumer contract, not a special-case implementation.

During migration, `BKE-WORKER-CANONICAL-PROJECT-EXECUTION-INSTRUCTIONS.md` remains the Worker-specific operating contract. Shared Autonomous Engineering adds cross-repository GitHub truth, exact-head evidence, ownership, human-auth, certification-graph, capsule, evidence-escalation, and GitHub App trust-bridge semantics.

Worker does not directly download the private Autonomous Engineering repository from PR-controlled CI. The BKE GitHub App/control plane performs trusted resolution of the pinned private source. The sanitized `repo.*` plan is then executed without the private source credential or checkout.

Do not delete or weaken existing Worker certification, dispatcher, browser-authentication, production, signing, security, or human-authorization boundaries merely because they are not yet modeled by the shared layer.

Adoption is successful only when the consumer exact head and pinned Autonomous Engineering revision are bound into one execution identity and the declared Worker `repo.*` checks produce compact exact-head evidence through the control plane.
