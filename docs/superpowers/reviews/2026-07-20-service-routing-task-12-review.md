# Task 12 review: dedicated VUSA public profile

Review type: read-only static contract review

Reviewed working-tree inputs:

- `src/service-catalog.ts`
- `src/service-catalog-compiler.ts`
- `src/service-catalog-activation.ts`
- `src/service-catalog-active-projection.ts`
- `src/service-catalog-policy-render.ts`
- `tests/service-catalog-compiler.test.ts`
- `tests/service-catalog-activation.test.ts`
- `tests/service-catalog-active-projection.test.ts`
- `tests/service-catalog-policy-render.test.ts`

## Verdict

Task 12 is **not ready to activate**. The compiler, lowerer, and renderer agree
on the explicit VUSA-profile behavior, but the durable projection validator
rejects the profile that the lowerer emits. A VUSA both-scope singleton therefore
cannot be persisted and subsequently rendered by the runtime path.

## Confirmed behavior

- The only dedicated public profile representable by the catalog model is the
  literal `"vusa"` (`ServiceTargetCapability.dedicatedPublicDnsProfile`).
- A singleton `workIn: "both"` pool can use that profile: the LAN rule binds to
  its declared LAN balancer, while the external rule becomes
  `public-edge-profile` with `profileId: "vusa"` even while VPN2 is active.
- `workIn: "external"` pools remain deferred before profile selection, so the
  dedicated VUSA profile does not bypass the external-only safety gate.
- An inactive public target without the explicit profile remains deferred.
- The SmartDNS renderer chooses `proxy*` versus `vusaProxy*` from the explicit
  `profileId`, not from `targetId`.

## Blocking finding

### P1: durable projection rejects the profile emitted by activation

`lowerActivationReadyCatalog()` projects a ready public-edge-profile as
`{ kind: "proxy", targetId, profileId: "vusa" }` for the external scope.
`validateActiveServiceCatalogProjection()` instead accepts an external proxy
with exactly `kind` and `targetId`; `profileId` is an unexpected field. Thus
`saveActiveServiceCatalogProjection(lowerActivationReadyCatalog(compiled))`
throws for the Task 12 VUSA route. If a profile-less external proxy is saved,
the renderer rejects it because external proxies require `profileId`.

Required regression coverage: lower a both-scope VUSA singleton, save/load the
projection, then render it and assert its domain appears in
`vusaProxyDomains` or `vusaProxySuffixes`.

## Integration gap (not fixed in this review)

The known server mapper omission remains an integration gap: runtime mapping
must consume the persisted/compiled profile when producing the SmartDNS policy.
It was intentionally not inspected or changed in this task-limited review.

## Verification boundary

No tests were executed and no runtime, deployment, service, or live-access
operation was performed. This verdict is based on the named source and focused
test files above.
