📄 PRD — Food Delivery & Ordering Platform
1. Product Overview
   Product Name
   QuickBite
   Vision
   Build a scalable, multi-region food ordering and delivery platform connecting customers, restaurants, delivery agents, and admins, with strong consistency for money and orders, and clear operational ownership.

2. User Types & Roles
   2.1 End User (Customer)
   Browse restaurants


View menus


Place orders


Choose payment method (Online / Cash on Delivery)


Track order & delivery status


View order history



2.2 Restaurant (RBAC REQUIRED)
Roles inside a restaurant
1️⃣ Restaurant Owner
Permissions
Manage restaurant profile


Manage menu & pricing


View all orders


View financial balance


View payout history


Assign / revoke staff roles


2️⃣ Restaurant Manager
Permissions
Manage menu


Accept / reject orders


Update order status


View orders & basic analytics


3️⃣ Restaurant Staff
Permissions
View incoming orders


Update preparation status only


RBAC is enforced per restaurant, not globally.

2.3 Delivery Agent
Accept or reject delivery tasks


Pick up orders from restaurants


Update delivery status:


Assigned


Picked up


Delivered


View delivery history


View earnings (read-only) — an agent earns a flat 80% of the delivery fee on every order they deliver; the platform keeps the remaining 20%



2.4 Admin
Manage restaurants


Manage delivery agents


View all orders


Monitor payments


Record restaurant payouts




3. Order Lifecycle (End-to-End)
   Customer places order


Payment decision:


Online payment → payment authorization required


Cash on Delivery (COD) → no pre-payment


Order sent to restaurant


Restaurant accepts or rejects


Order prepared


Delivery agent assigned


Order picked up


Order delivered


Financial settlement recorded



4. Delivery Assignment
   Assignment Model
   Broadcast accept/reject (no automatic single-agent assignment)


Ready-for-delivery orders are offered simultaneously to up to 5 candidate agents, ranked by:


Proximity to the restaurant


Agent's current number of active orders (load-balanced; agents may carry more than one order at a time, up to a cap)


First agent to accept gets the order; the rest are notified the offer is gone


A background job continuously retries assignment for any order still waiting for an agent, so no order is left unassigned purely because the first broadcast didn't land


Manual override (Restaurant / Admin)


Reassign agent


Handle edge cases


Delivery agents can:
Accept


Reject (limited retries)


All of the above happens in real time over the live connection agents and customers are already on — no polling required.



5. Payments & Money Flow
   Payment Methods
   Online payments


Cash on Delivery (COD)



Online Payment Flow
Payment authorized before order confirmation


Idempotent payment handling


Order created only after confirmed payment



COD Flow
Order created without payment


Delivery agent collects cash



Restaurant Balance Model
Each restaurant has a running balance


Balance increases when:


Order is delivered successfully


Platform commission deducted automatically



Payouts
Restaurants are paid externally (bank transfer)


Admin records payout events in the system


A payout moves money from the platform to the restaurant, so it's recorded with no source account (the platform isn't a party with its own ledger account) and the restaurant owner as the destination account


Balance reduced after payout is recorded


Full payout history retained



6. Functional Requirements
   Customer
   Account management


Restaurant discovery


Menu browsing


Cart management


Order placement


Payment selection


Order tracking



Restaurant
Menu CRUD


Order management


Status updates


Financial balance view


Role management (Owner only)



Delivery Agent
Task assignment (broadcast offer, accept/reject — no automatic assignment)


Status updates


Delivery history



Admin
Full visibility across system


Manual overrides


Financial reconciliation


Payout recording
Manage restaurants
Reports



7. Non-Functional Requirements
   Availability: High (order placement & payments are critical)


Latency:


Browsing <1s


Checkout < 1-3s


Consistency:


Strong consistency for orders & payments


Eventual consistency acceptable for analytics


Scalability: Must handle peak traffic


Security:


Strong authorization boundaries


Secure payment handling


Multi-Region:


Active traffic in multiple regions


Regional reads


Strong consistency where required



8. Capacity & Scale (Back-of-the-Envelope)
   Traffic
   MAU: 1,000,000


DAU: 200,000


Actions / user / day: 27


Requests / day: ~5.4M


Average RPS: ~62


Peak RPS: ~620


Read / Write Ratio
Reads: 85%


Writes: 15%



Storage
Orders growth: ~146 GB / year


Bandwidth
~270 GB / day



9. Data Retention
   Orders: retained long-term, we show in the customer app and restaurant only current year orders. Others are stored in another database storage


Payments, same as orders


Logs: time-limited (30 days)


Analytics data: aggregated & archived



10. Multi-Region Assumptions
    Users served from nearest region


Restaurants tied to a primary region


Orders processed in restaurant’s region


Financial data requires strong consistency



11. Constraints & Risks
    Meal-time traffic spikes


Payment provider failures


Delivery agent shortages


Cross-region consistency complexity


Settlement reconciliation errors



12. Success Criteria
    Orders complete end-to-end without loss


Payments are correct and auditable


Restaurant balances are accurate


System remains stable under peak load


Clear ownership and authorization boundaries



13. Out of scope
    Recommendation systems


Loyalty programs


AI-based delivery optimization
Reviews

