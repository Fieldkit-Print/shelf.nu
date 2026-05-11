# Fieldkit Customer-Tenancy + Request Flow

**Status:** Approved (decisions captured 2026-05-11). Not yet implemented.
**Owner:** Carson
**Prereq:** Customer-tenancy schema (Customer model, `Asset.carbonCustomerId`, `User.carbonCustomerId`, `CustomerContactPermission`) must be migrated to prod before anything below ships.

---

## Goals

Two problems, intertwined:

- **(A) Customer-only data visibility.** A CUSTOMER role user must see only assets/bookings/kits tied to their Carbon customer (plus Fieldkit-owned rentable inventory). Today, helpers exist for asset routes only; bookings/kits/calendar/QR-scan/command-palette/dashboard leak across customers.
- **(B) Approval flow for customer requests.** Customer team member submits a request → optional customer-internal approver → Fieldkit staff confirms → booking is created and shipped. Approval routing is per-customer configurable.

---

## Decisions made

| Question | Decision |
|---|---|
| Kit ownership model | **Kit mirrors Asset.** Each `Kit` gets `carbonCustomerId` (null = Fieldkit-owned) and `rentable` (boolean). A CUSTOMER sees kits where `carbonCustomerId = theirs` OR `(carbonCustomerId IS NULL AND rentable = true)`. Internal-only Fieldkit kits (`carbonCustomerId IS NULL AND rentable = false`) are hidden from CUSTOMER. |
| Approval routing | **Per-customer configurable.** `Customer.requiresInternalApproval` boolean. When true, request goes `DRAFT → PENDING_INTERNAL → PENDING_FIELDKIT → APPROVED`. When false, it goes `DRAFT → PENDING_FIELDKIT → APPROVED`. |
| Data model for requests | **New `BookingRequest` entity.** Cleaner state machine than overloading `Booking.status`. Booking is created at the moment of final Fieldkit approval. Easier to merge upstream Shelf changes to Booking. |

---

## Part A — Audit findings (severity + remediation)

### Critical (data exposure with action)

| Surface | Files | Leak | Fix |
|---|---|---|---|
| Kits | `/kits._index.tsx`, `/kits.$kitId.*.tsx`, `modules/kit/service.server.ts` | `getPaginatedAndFilterableKits`, `getKit` filter only by `organizationId`. A CUSTOMER sees and edits every kit. | Schema: add `Kit.carbonCustomerId` + `Kit.rentable`. Add `buildCustomerKitScope(perm)` helper: `{ OR: [{ carbonCustomerId: perm.carbonCustomerId }, { carbonCustomerId: null, rentable: true }] }`. Wire into `getPaginatedAndFilterableKits` and `getKit`. Block assigning a foreign-customer asset to a customer-owned kit at the action layer (mismatched `carbonCustomerId`). |
| Bookings | `/bookings._index.tsx`, `/bookings.$bookingId.*.tsx`, `modules/booking/service.server.ts` | `getBookings`, `getBooking` apply only custodian filtering for self-service. Bookings can reference other customers' assets through the linked-asset list. | Add `customerScope` param to `getBookings` and `getBooking`. AND-merge into `assets.some({ carbonCustomerId in visible-set })`. Block linking foreign assets at the action layer (`manage-assets.tsx`, `manage-kits.tsx`). |
| QR scanner | `/api+/get-scanned-item.$qrId.ts` | A CUSTOMER scans any QR → resolves to any asset. | After resolving asset, check `asset.carbonCustomerId` against `perm.carbonCustomerId` (or rentable Fieldkit pool). Return the same "unknown QR" error shape on mismatch — no information disclosure. |

### High (data visibility, limited action)

| Surface | Files | Leak | Fix |
|---|---|---|---|
| Calendar | `/calendar.tsx`, `getBookingsForCalendar` in booking service | All org bookings shown on grid. | Pass `customerScope` to `getBookingsForCalendar`. Same scope as bookings index. |
| Command palette | `/api+/command-palette.search.ts` | Searches kits/locations/bookings/audits org-wide. | Per-entity scoping. CUSTOMER role: no locations/audits/team results. Kit results scoped via kit helper. Asset/booking results scoped via existing helpers. |

### Medium

| Surface | Files | Leak | Fix |
|---|---|---|---|
| Home dashboard | `/home.tsx` | Aggregates computed org-wide. | Per-widget: add `carbonCustomerId` to aggregates, or hide widget for CUSTOMER role. |
| Booking notes | (implicit via booking routes) | Inherits booking visibility. | Implicitly fixed when bookings are scoped; add explicit guard in note loaders/actions for defense in depth. |

### Open questions (lower priority but worth resolving)

- Team-member autocomplete on scanner forms — should CUSTOMER see Fieldkit staff names? **Default proposal: no.**
- Customer-side approver assignment UI — for `requiresInternalApproval = true` customers, which Fieldkit-staff page sets `CustomerContactPermission.canApproveBookings`?

---

## Part B — Data model

### Schema additions

```prisma
model Customer {
  // … existing fields …

  /// When true, customer requests require approval from a CustomerContact
  /// flagged with canApproveBookings before reaching Fieldkit staff.
  requiresInternalApproval Boolean @default(false)

  bookingRequests BookingRequest[]
}

model CustomerContactPermission {
  // … existing fields …

  /// When true, this contact can approve BookingRequests submitted by other
  /// contacts at the same Carbon customer. Meaningful only when
  /// Customer.requiresInternalApproval = true.
  canApproveBookings Boolean @default(false)
}

model BookingRequest {
  id                  String                @id @default(cuid())
  carbonCustomerId    String
  organizationId      String

  requesterId         String
  requester           User                  @relation("BookingRequestRequester", fields: [requesterId], references: [id])

  status              BookingRequestStatus
  rejectionReason     String?

  // Approval trail
  internalApproverId  String?
  internalApprover    User?                 @relation("BookingRequestInternalApprover", fields: [internalApproverId], references: [id])
  internalApprovedAt  DateTime?

  fieldkitApproverId  String?
  fieldkitApprover    User?                 @relation("BookingRequestFieldkitApprover", fields: [fieldkitApproverId], references: [id])
  fieldkitApprovedAt  DateTime?

  // Request payload (mirrors fields chosen at submit time)
  proposedFrom        DateTime
  proposedTo          DateTime
  shippingAddress     String?
  notes               String?

  assets              Asset[]               @relation("BookingRequestAssets")

  // Set when status transitions to APPROVED
  bookingId           String?               @unique
  booking             Booking?              @relation(fields: [bookingId], references: [id])

  createdAt           DateTime              @default(now())
  updatedAt           DateTime              @updatedAt

  @@index([carbonCustomerId, status])
  @@index([organizationId, status])
}

enum BookingRequestStatus {
  DRAFT
  PENDING_INTERNAL
  PENDING_FIELDKIT
  APPROVED
  REJECTED
  CANCELLED
}
```

### State machine

```
                          requires             requires
                          internal?            internal?
                            no                   yes

  DRAFT  ── submit ──►  PENDING_FIELDKIT      PENDING_INTERNAL
                            │                      │
                            │                      ├─ internal reject ──► REJECTED
                            │                      └─ internal approve ──► PENDING_FIELDKIT
                            │
                            ├─ FK reject ──► REJECTED
                            └─ FK approve ──► APPROVED  (Booking row created in same tx)

  Any non-terminal state: requester can CANCEL ──► CANCELLED
```

### Routes

| Path | Audience | Notes |
|---|---|---|
| `/requests` | CUSTOMER | List requests for own customer (mine + same customer if `canApproveBookings`). Filtered by status tabs. |
| `/requests/new` | CUSTOMER | Composer. Asset picker scoped to customer's owned + rentable pool. Date range, shipping address, notes. |
| `/requests/$id` | CUSTOMER + Fieldkit staff | Detail page. Approve/reject buttons gated by viewer role + `canApproveBookings` + current status. |
| `/admin/requests` | Fieldkit staff | Queue filtered to `status = PENDING_FIELDKIT`. Approve/reject inline. |
| `api+/requests.$id.approve` | CUSTOMER (internal) + Fieldkit | Action endpoint. Transitions state, fires notifications. On final approve, creates Booking + links it back to the request in a single tx. |
| `api+/requests.$id.reject` | CUSTOMER (internal) + Fieldkit | Sets status REJECTED, records reason. |
| `api+/requests.$id.cancel` | Requester only | Allowed from any non-terminal state. |

### Notifications

| Event | Recipients | Template |
|---|---|---|
| Request submitted, `requiresInternalApproval = true` | Each CustomerContact with `canApproveBookings = true` at the same customer | New transactional template; reuse `LogoForEmail` and `styles.button`. |
| Request submitted, `requiresInternalApproval = false` | Fieldkit ops email (`SUPPORT_EMAIL` env or new `OPS_EMAIL` env) | Same template, different recipient. |
| Internal approved | Fieldkit ops email | Status-change template. |
| Fieldkit approved | Requester + internal approver (if any) | Confirmation template — includes booking link. |
| Rejected (either stage) | Requester + internal approver (if FK rejected after internal approval) | Rejection template with reason. |

All emails use the existing `sendEmail` infra; no Stripe templates needed; primary color stays Fieldkit green.

### Activity events

Each state transition emits a `recordEvent` (consistent with `.claude/rules/use-record-event.md` and `.claude/rules/record-event-payload-shapes.md`):
- `BOOKING_REQUEST_SUBMITTED`
- `BOOKING_REQUEST_INTERNAL_APPROVED` / `_REJECTED`
- `BOOKING_REQUEST_FIELDKIT_APPROVED` / `_REJECTED`
- `BOOKING_REQUEST_CANCELLED`

---

## PR sequencing

| PR | Scope | Blocks |
|---|---|---|
| **0** | Apply pending Customer-tenancy schema migration to prod | Everything |
| **4a** | Tenancy fixes — critical (kit + booking scope + QR guard) | 4b, 5+ |
| **4b** | Tenancy fixes — high (calendar + command palette + home dashboard) | — |
| **5** | Schema: `BookingRequest`, `Customer.requiresInternalApproval`, `CustomerContactPermission.canApproveBookings` | 6+ |
| **6** | Customer-side request composer + list + detail routes | 7 |
| **7** | Approver UI (internal + Fieldkit-staff variants) | 8 |
| **8** | Notifications + activity-event records for audit trail | — |

Each PR gets a behavior-driven Vitest covering at minimum: a CUSTOMER user from customer A cannot see customer B's data through the affected surface.

---

## Out of scope (for this round)

- Per-asset approval (every line item separately approved). Approval is per-request.
- Recurring requests / scheduled rentals.
- Self-serve customer admin (CUSTOMER role managing their own contact list). Fieldkit staff manages `canApproveBookings` flags for now.
- Payment / invoicing on request approval — handled in Carbon, not Fieldkit/Shelf.
