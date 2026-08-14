// GENERATED FROM assets/gtm-default.yaml. Do not hand-edit: edit the YAML, then regenerate.
//
// Contract C12. The policy text is inlined because `readFileSync` of a relative asset does not
// survive eve's bundler, and `send_email.ts` calls `buildDeps()` at module scope, so the failure
// hit at compile time rather than runtime. `assets/gtm-default.yaml` stays the human-authored
// source of truth; `tests/policy-bundling.test.ts` asserts the two are byte-identical.

export const GTM_DEFAULT_YAML: string = `\
version: "0.1.0"
defaults:
  path: deny
stakes:
  - id: draft-for-review
    match:
      actionKind: draft_email
    path: auto
  - id: reply-existing-thread
    match:
      actionKind: send_email
      audience: known
    path: auto
  - id: cold-email-hiring-manager
    match:
      actionKind: send_email
      audience: cold
    path: human
protectedAudiences:
  - "*@*.gov"
  - "press@*"
caps:
  perPrincipalDaily:
    send_email: 10
`;
