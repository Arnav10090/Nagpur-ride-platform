# Decisions Needed from the Owner

This file tracks decisions that only the product owner / business can make.
Engineering proceeds with **reversible defaults** (marked below) until answered.

---

## 1. Service Boundary (Nagpur Polygon)
- **Question:** What is the approved Nagpur service-area polygon and operating hours?
- **Why it matters:** Determines where rides can be requested and where drivers are eligible.
- **Options:** (a) Use a surveyed polygon of target areas, (b) Start with a simple rectangle/radius.
- **Default used:** Bounding box 20.95–21.25°N, 78.95–79.25°E (placeholder, stored in `ServiceZone` row).
- **Blocks:** Real pilot launch, zone-based pricing, accurate eligibility checks.
- **Built meanwhile:** `ServiceZone` table with PostGIS polygon column (placeholder rectangle).

## 2. Vehicle Categories & Driver Documents
- **Question:** Which vehicle categories for the pilot? What is the exact driver document list?
- **Options:** (a) AUTO only, (b) AUTO + CAB, (c) AUTO + BIKE_TAXI.
- **Default used:** AUTO only. Documents: registration, licence (placeholder list).
- **Blocks:** Driver onboarding flow, document upload, verification UI.
- **Built meanwhile:** `Vehicle` and `DriverDocument` tables with placeholder category/doc-type enums.

## 3. Pricing (Rates, Cancellation, Fees)
- **Question:** Real fare rates (base/per-km/per-min), minimum fare, cancellation policy and fee amounts, waiting charges, night/peak rules, GST handling.
- **Why it matters:** Auto fares may be regulated in Nagpur — need to check.
- **Default used:** base ₹30, ₹12/km, ₹1.50/min, min ₹50, cancel fee ₹20 (after driver arrival or 3 min post-assignment). GST OFF. All stored in `PricingRule` rows.
- **Blocks:** Real fare calculation, tax invoices, regulatory compliance.

## 4. Payment Provider & Credentials
- **Question:** Which UPI payment provider? Do you have sandbox credentials?
- **Options:** Razorpay, PhonePe, Cashfree, Juspay, Paytm.
- **Default used:** `PaymentProvider` interface with FAKE provider. Production start-up refuses to run.
- **Blocks:** Real UPI payments, settlement, reconciliation against real reports.
- **Built meanwhile:** Adapter interface ready; second adapter slot for a real gateway.

## 5. Commission / Business Model
- **Question:** Commission rate, or subscription/SaaS model? Cash-settlement cadence?
- **Options:** (a) 15% commission (standard), (b) Lower/zero commission + subscription, (c) Hybrid.
- **Default used:** 15% commission (1500 bps), stored in `PricingRule`. Daily cash settlement assumed.
- **Blocks:** Driver economics, payout model, cash reconciliation policy.

## 6. Payout Model
- **Question:** Payout schedule, minimum threshold, bank/UPI payout provider?
- **Default used:** Weekly payouts, ₹100 minimum, behind a `PayoutProvider` interface with a fake.
- **Blocks:** Driver earnings screens, actual money movement.

## 7. SMS/OTP Provider
- **Question:** Which SMS/OTP provider? DLT registration status?
- **Options:** MSG91, Twilio, Gupshup, Kaleyra.
- **Default used:** Dev OTP sender (logs code to console). Production refuses to start.
- **Blocks:** Real user authentication.

## 8. Maps Provider
- **Question:** Which maps provider? API key? Cost budget per trip?
- **Options:** Google Maps, Mappls (MapMyIndia), HERE, Ola Maps.
- **Default used:** Straight-line × 1.3 distance estimate. No geocoding/autocomplete.
- **Blocks:** Real ETA, routing, address search, map display.

## 9. Product Name / Brand / Bundle IDs
- **Question:** Product name, app-store accounts, bundle identifiers?
- **Default used:** `com.example.nagpurrides.*` (placeholder).
- **Blocks:** App store submission, EAS builds.

## 10. Languages at Launch
- **Question:** Hindi and Marathi required at launch?
- **Default used:** English only. Strings not externalised yet.
- **Blocks:** Localisation work, string externalisation.

## 11. Safety Scope for Pilot
- **Question:** Which safety features are required for the pilot?
- **Options:** (a) SOS + trip PIN (minimum), (b) + share-trip + call masking (moderate), (c) Full suite.
- **Default used:** Building all behind feature flags; SOS + trip PIN as minimum.
- **Blocks:** Safety incident process, emergency contacts integration.

## 12. Support Channels
- **Question:** In-app only, phone, WhatsApp? Support hours?
- **Default used:** In-app support tickets linked to trips.
- **Blocks:** Support staffing, channel integrations.

## 13. Hosting / Cloud / Region
- **Question:** Which cloud provider and region for staging/production?
- **Options:** AWS Mumbai, GCP Mumbai, Azure Central India, DigitalOcean.
- **Default used:** Docker Compose for local/staging. Cloud-agnostic Dockerfiles.
- **Blocks:** Production deployment, managed Postgres, CDN.

## 14. Suspension Policy Mid-Trip
- **Question:** What happens if a driver is suspended while on an active trip?
- **Default used:** Suspension signs them out + takes offline but does NOT end the active trip. Policy undecided.

## 15. Staff PII Access
- **Question:** Which staff roles may see full phone numbers? Extra approval needed?
- **Default used:** OPS_ADMIN and SUPER_ADMIN see full phones; SUPPORT and FINANCE see masked.

## 16. Rider Verification Level
- **Question:** OTP only, or additional verification (name, photo)?
- **Default used:** Phone OTP only. Fraud policy undefined.
