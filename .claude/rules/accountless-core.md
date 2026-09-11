---
paths:
  - "src/pairing/**"
  - "src/channel/**"
  - "src/connection/**"
  - "src/demo/**"
  - "src/devsupport/**"
  - "src/notifications/**"
  - "src/navigation/**"
  - "app/+native-intent.ts"
---
# Rule: pairing, transport, and capability code stay accountless

The project is open-core (see `docs/architecture.md` and the desktop repo's
`docs/research/mobile-companion-app.md` section 10): the E2E pairing, transport, and capability
layer is accountless and open source, and must work identically self-hosted or on a paid,
Kangentic-operated relay. A Kangentic account/entitlement check belongs only on the hosted
relay's admission logic, deciding whether a device may use *that* relay and at what plan limit.
It must never leak into the crypto or pairing model, or the free/self-host path silently
degrades and the load-bearing separation the business model depends on breaks.

## The rule

- No file under `src/pairing/`, `src/channel/`, `src/connection/`, `src/demo/`,
  `src/devsupport/`, `src/notifications/`, or `src/navigation/` - nor `app/+native-intent.ts`,
  the deep-link router that feeds the demo pairing - may import from any account, billing, or
  entitlement module.
- No code path in these directories may require a Kangentic account or signup to function.
- The relay address is a user-configurable setting; self-hosting is a first-class, equally
  supported path, never a degraded one.
- Plan limits, quotas, and hosted-relay reliability are concerns of the relay's own admission
  layer, not of this app's crypto or transport code.

## Enforcement (self-maintaining)

- **Review (live now):** the `crypto-pairing-auditor` agent checks for account/entitlement
  imports in these directories during `/code-review`.
- **Test (planned):** once an account module exists, an import-edge test (dependency-cruiser or
  a vitest module-graph scan) asserting no edge from these directories into it.

## Scope

`src/pairing/**`, `src/channel/**`, `src/connection/**` (the lifecycle composer over pairing +
channel + stores), `src/demo/**` (the reviewer/demo pairing, which composes pairing + the
loopback peer and so inherits the same discipline), `src/devsupport/**` (the loopback transport,
stub peer classes, and wire fixtures shared by tests, the mock desktop, and now the shipped
demo), `src/notifications/**`, `src/navigation/**` (it performs the navigation those directories
publish, so it sits on the same pairing and notification paths), and `app/+native-intent.ts` (the
deep-link router: it is pairing-adjacent, input-driven code that lives outside `src/`, so it is
named here explicitly rather than caught by a directory glob). Settings UI that merely
lets a user type in a hosted-account token (if that ever exists) lives outside these
directories.
