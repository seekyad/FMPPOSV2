# FMP interaction contract

Scope: incremental security repair, September 2026. Existing visual context: DESIGN-SYSTEM.md; runtime tokens: packages/ui/src/tokens.css. Existing unmodified workflows still have the gaps tracked in audit/PRODUCTION-AUDIT.md.

Business sources: user-confirmed two-store scope in audit/PRODUCTION-AUDIT.md; server/src/auth.ts and server/src/store-scope.ts enforce current active staff and operational store ownership. Customers and store credit remain shared. Device approval is manager-only and scoped to the manager's store.

| Capability | Canonical owner | Contract |
|---|---|---|
| Buttons | packages/ui/src/Button.tsx | Existing FMP variants and touch sizes |
| Sensitive fields | packages/pos-client/src/SecretField.tsx | Masked initially, explicit reveal, label and associated help/error |
| Device pairing | packages/pos-client/src/PinScreen.tsx and DevicesSection.tsx | Manager or host operator issues a one-use 15-minute code; server derives store/kind from code |
| Credential settings | StoreSections.tsx PaymentsSection | Saved auth key never returned; blank replacement retains it; explicit disconnect clears it |
| Device revocation | DevicesSection.tsx | Inline named confirmation; current terminal revoked from another terminal or host operator |
| Feedback | Inline status/alert in touched forms | Preserve input on failures, disable duplicate submissions, announce errors |
| Native select/date | Existing native controls | OS-owned popup accepted for existing controls pending physical iPad validation; this pass adds neither |
| Data grids / modal | Existing DataTable / Modal | Audit gaps remain; no new implementation duplicates introduced here |

First-device/bootstrap operations run through a host-admin CLI, not an unauthenticated web administrator endpoint. Old sessions must sign in after the security migration. No automatic replay of money mutations on authentication failure. Browser/Safari validation remains an explicit verification item.

## Financial workflows

Checkout, refunds, repair cancellation and shared credit use pessimistic confirmation. The shared api.ts owns exact-checkout retry IDs and concurrent-dispatch suppression. No automatic provider-charge replay occurs. Changing a cart after an uncertain checkout requires reviewing recent transactions first. Completed sale amounts are immutable: the existing Refund action and a corrected sale replace repricing. Cancellation uses the existing Modal/Button owners, named native radio choices for deposit disposition, an associated reason label, inline errors and an in-flight guard. Inputs stay intact on failure. Store credit remains usable across both stores. Actual card settlement and full session/cart recovery remain unresolved release gates in audit/FINANCIAL-PASS.md.
