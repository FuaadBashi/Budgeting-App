# Handoff

State of play as at 25 September 2026. Read [FINANCIAL_RULEBOOK.md](FINANCIAL_RULEBOOK.md) first —
it is the contract, and where code disagrees with it that is a defect, not a variation.

---

## 1. Where things stand

**Explain mode.** A persistent “Explain this screen” switch in `AppShell` adds
route-specific guides on all eleven screens, contextual form help, and expandable
calculations on dashboard, budget and analytics figures. `ExplainMode.tsx` owns
the hydration-safe, storage-optional preference; `lib/explanations.ts` owns help copy;
`lib/metric-explanations.ts` formats existing API results, never recomputes financial
figures. Optional detailed traces are used only when their total matches the displayed
snapshot. Turning the mode off removes the added help, not existing financial warnings.
Run `cd frontend && npm test` for the presentation-builder regression tests.

**Anchored 30-day budgets.** Migration 0014 adds support for exact 30-day cycles in
the existing budget engine and creation form. These do not reset at calendar month-end.
The month-plan view still reports calendar months and prorates overlapping budget cycles.

**Vault visual refresh, 25 September.** Vault Noir now has a labelled desktop sidebar,
an editorial dashboard with a prominent cash-runway panel, merchant initials in the ledger,
and circular savings-goal progress. Responsive page headings and surfaces share that language.
Existing appearance choices remain available while this direction is reviewed. This is a
presentation change; financial calculations and API contracts are unchanged.

| Phase | Scope | Status |
|---|---|---|
| 0 | Rulebook, decisions | ✅ |
| 1 | Core ledger — accounts, transactions, transfers, balances | ✅ |
| 2 | Dashboard — KPIs, drill-down | ✅ |
| 3 | Budget engine — periods, rollover, pace, recovery, warnings | ✅ |
| 4 | Goals, obligations, recurrence, financial calendar | ✅ |
| 5 | Analytics and export (CSV + JSON; XLSX/PDF deferred) | ✅ |
| 6 | Structured imports, candidate inbox, duplicate detection | ✅ |
| 7 | OCR / vision ingestion | ✅ |
| 8 | Simulation lab | ✅ |
| 9 | Intelligence — explanations, recommendations | ✅ |
| 10 | Polish, backups, hosting | ◐ backups and exposure hardening done; the deploy itself is yours |
| 11 | Assisted categorisation (LLM) | ✅ |

**Phases 0–9 and 11 complete; Phase 10's backup half is done.** 975 backend tests and 25
browser tests. Deployment is the only substantial thing left from the original plan, and
`docs/RUNNING.md` already describes the setup worth having (Tailscale, real certificates, nothing
exposed to the internet) — but see "Recommended next task" below, which is not that.

Frontend has eleven screens — dashboard, transactions, accounts, analytics, insights, budgets,
calendar, goals, simulator, import and data — and every nav item is live. Accounts, categories,
budgets, goals and commitments can all be created from the UI; a fresh install lands on a setup
checklist rather than a dashboard of zeros.
The Add button records expenses, income, transfers/debt payments and refunds as balanced two-leg
transactions, including category-split expenses. The transactions screen
lists history, shows each row's effect on liquid cash, and offers both correction paths: Void
for a wrong amount or date, edit-in-place for a wrong description, merchant or category. Voided
rows are hidden by default and never deleted. The list pages through all of history, 100 rows at
a time.

Accounts now also hosts deterministic categorisation rules and opt-in UK Open Banking through
Enable Banking. Synced rows are candidates in the existing Import inbox, never direct ledger
writes. Budgets has a zero-based month-plan view, and Calendar has a month grid alongside the
existing balance curve.

**A UX audit's ten top findings were worked through on 24 September 2026** (nine fixed; the tenth,
adopt a single design, was declined on 7 October — see `docs/DECISIONS.md`, *Four designs stay*). The ones worth knowing: the phone bar is four tabs
plus More, the gear lives inside the rail in Vault Noir and Command Ledger, every chart answers
tap and arrow keys as well as hover, and text on the accent colour comes from `--on-accent`.

**A visual design system landed 2 September 2026.** Four complete design directions — Vault Noir,
Field Ledger, Raw Ledger, Command Ledger, each with its own light and dark palette (eight
palettes total) and its own desktop nav treatment (icon rail / masthead / floating dock / rail
plus a functional jump-to bar) — are switchable from a Preferences control (the gear icon: inside the icon rail in Vault Noir and
Command Ledger on desktop, bottom-left everywhere else) and persist across reloads. See "Frontend" below for where the
system lives, and `docs/DECISIONS.md` for why it is built the way it is, including two real bugs
found and fixed along the way that are worth reading before touching `lib/design.tsx` again.

**A motion layer landed for Vault Noir, on the Dashboard and Budgets screens, 2 September 2026.**
Entrance stagger for cards and list rows, a line-draw-in for the balance chart, budget meters that
grow from empty, hero figures that count up (`AnimatedAmount.tsx`), route/modal transitions, and
the rail's dead vertical space filled with a live clock and tick marks — all scoped to
`[data-design="noir"]` in `globals.css` and gated on `prefers-reduced-motion`.

**It reached the other eight screens on 4 October 2026.** Page blocks rise in order (`.stagger-in`
with an inline `--i`); list rows follow their block one by one (`.stagger-rows` on the list, which
numbers its own rows); bars grow (`.bar-grow`, `.bar-rise`), goal dials sweep to their percentage,
and the simulator's lines draw in.

**The other three designs got their own motion on 5 October 2026**, on the same hooks, in section F
of `globals.css`. Field inks in place (opacity and a fading blur, no movement) and its bars wick
slowly along. Raw drops blocks in hard and linear with no fade, fills bars in visible steps, and
shoves a pressed button 2px. Command repaints blocks top to bottom, types rows out left to right and
fills bars like a progress meter. `AnimatedAmount`'s count-up stays noir's alone.

---

## 2. Architecture

Request → FastAPI → domain services → SQLAlchemy → Postgres. The domain layer is where the rules
live; routes only translate to and from integer minor units.

| Module | Responsibility |
|---|---|
| `domain/clock.py` | The single source of "today", in the reporting timezone |
| `domain/periods.py` | Budget period resolution, stepping, day counts |
| `domain/categories.py` | Cycle-safe subtree scoping; the account default-category stamp |
| `domain/spend.py` | The definition of `Spent` |
| `domain/budgets.py` | Rollover chain, allowance, pace |
| `domain/projection.py` | Projected period-end spend |
| `domain/budget_warnings.py` | W1–W6 and warning (e) |
| `domain/merchant_baseline.py` | Warning (e): robust z against a merchant's own history |
| `domain/budget_recovery.py` | Cash headroom, goal sacrifice ordering |
| `domain/recurrence.py` | RRULE building and expansion |
| `domain/obligations.py` | Instance generation and transaction matching |
| `domain/obligation_scope.py` | When an instance still counts: the one predicate every forecast reads (O1) |
| `domain/ledger_scope.py` | `posted_transaction_ids` — the transaction set every ledger engine reads (X3) |
| `domain/calendar.py` | Projected balance curve |
| `domain/income.py` | Expected income occurrences, derived from the rule |
| `domain/reimbursement.py` | Netting repayments out of budget spend, by day and by merchant |
| `domain/impact.py` | W3 -- what one transaction did to a budget |
| `domain/analytics.py` | Period and monthly summaries |
| `domain/restore.py` | Rebuilding the ledger from a JSON backup |
| `auth.py` | Password hashing, session cookies, the route guard |
| `domain/disposable.py` | Safe to spend, net worth, account balances |
| `domain/profile.py` | The settings row; `protected_buffer`, the one read of the buffer every engine subtracts |
| `domain/account_lifecycle.py` | What archiving an account requires, and what an archived account refuses (X30) |
| `domain/classification.py` | Derived transaction type |
| `domain/simulation.py` | Scenario projection; reads the ledger, writes nothing (P1) |
| `domain/importing.py` | Statement parsing, duplicate detection, acceptance (M1–M4) |
| `domain/rules.py` | Ordered deterministic categorisation rules, preview and historical apply |
| `domain/plan.py` | Zero-based month plan from expected income and budget allocations |
| `domain/bank_sync.py` | Opt-in bank consent and idempotent sync into the candidate inbox |
| `domain/explain.py` | Derivation traces; terms sum to the figure (E1) |
| `domain/insights.py` | Observations, each citing evidence (E2); read-only (E3) |
| `domain/backup.py` | Atomic backup writes, retention, staleness (B-A/B-B/B-C) |
| `scheduler.py` | The lifespan timer that calls it |
| `ratelimit.py` | Exponential login backoff, global (there is one password) |
| `domain/enrichment.py` | Merchant → category, cache-first (A1/A2/A3); a second independent pass can reject a pick (X23) |
| `domain/receipts.py` | Reads a photographed receipt into a candidate (A1'); a second pass re-checks the reading against the image |

**Enforced in the database, not application code** (so it holds for raw SQL too):

- `L1` — postings sum to zero, and at least two legs (deferred trigger)
- `L3` — a transaction cannot be both voided and reversed (deferred trigger)
- `G1` — goal attribution cannot exceed its savings account balance (deferred trigger)
- `B-CFG1/2` — daily budgets cannot roll over; a revision cannot predate its budget
- CHECKs — anchor iff fortnightly or thirty-day, end ≥ start, no self-parent category, GBP-only postings

### Frontend

Next.js App Router, `frontend/src/`. Every file below exists; check here before grepping for
where something lives.

**Pages** (`app/`) — each is a server component that fetches its own data and renders inside
`AppShell`:

| File | Screen |
|---|---|
| `app/page.tsx` | Dashboard — the four KPI tiles, the projected balance curve, budget cards |
| `app/transactions/page.tsx` | History, void, edit-in-place, Older/Newer paging |
| `app/accounts/page.tsx` | Accounts, categories, categorisation rules, bank connections; the setup checklist |
| `app/analytics/page.tsx` | Period and monthly summaries, category bars |
| `app/insights/page.tsx` | Observations with evidence, including merchant anomalies |
| `app/budgets/page.tsx` | Budget list/create/edit, account defaults, period cards and zero-based month plan |
| `app/calendar/page.tsx` | Projected balance curve and navigable month grid |
| `app/goals/page.tsx` | Savings goals list/create/edit |
| `app/simulator/page.tsx` | Scenario list/create/compare, the projection chart |
| `app/import/page.tsx` | Statement upload, one-by-one candidate triage, receipt photo |
| `app/data/page.tsx` | Exports, JSON backup, restore, backup staleness status |
| `app/layout.tsx` | Root layout: fonts (`lib/fonts.ts`), `DesignProvider`, `<html>`/`<body>`; serves the default `data-design`/`data-theme` so motion starts at first paint |
| `app/globals.css` | Every design token (see below), `.card`/`.form-control`/`.font-display`, the motion hooks (`.stagger-in`, `.stagger-rows`, `.bar-grow`, `.chart-draw`, ...): noir's in section E, the other three designs' in F, and Field, Raw and Command's structure and dead space in G |
| `app/manifest.ts` | PWA installability — why receipt capture can reach for a camera |

**Components** (`components/`):

| File | Responsibility |
|---|---|
| `AppShell.tsx` | Nav chrome for all four designs (rail / masthead / dock / rail+command-bar), plus Command Ledger's `ConsoleStatus` panel at 2xl; mobile top bar and bottom tabs (four plus a More sheet), identical across designs |
| `PreferencesPanel.tsx` | The gear-icon control: pick a design, pick System/Light/Dark. `placement="rail"` puts it inside the icon rail |
| `AccountManager.tsx` | Account and category lists and creation forms, with per-account rename, archive and restore and per-category rename (one shared `RenameForm`); the one line where "amount owed" becomes a negative balance |
| `BufferSetting.tsx` | The protected cash buffer card on Accounts (`#buffer`); the dashboard's "none set" note links to it |
| `SetupChecklist.tsx` | What the ledger still needs before Add can record anything; on the dashboard and Accounts |
| `StatTile.tsx` | Label + value + optional support/footnote; `lead` marks the one hero figure per screen |
| `AnimatedAmount.tsx` | Counts a money figure up on mount/change; noir only, gated on `prefers-reduced-motion` |
| `BudgetCard.tsx` | One budget period: meter, warnings (including merchant anomaly), the "where this comes from" breakdown |
| `BudgetManager.tsx` | Budget list, creation form, inline edit (amount, rollover policy, rollover reset) |
| `BudgetMeter.tsx` | The spent/allowance progress bar `BudgetCard` renders |
| `AccountDefaults.tsx` | Per-account default-category editor, on the Budgets screen |
| `GoalManager.tsx` | Goals list, creation form, inline edit |
| `ObligationManager.tsx` | Commitments list, creation form, inline edit |
| `ScenarioManager.tsx` | Scenario list, creation, compare, delete |
| `ScenarioChart.tsx` | The simulator's projection chart (mind the aqua-on-light note in Traps) |
| `BalanceCurve.tsx` | The dashboard/calendar projected balance chart; tap, point or arrow keys for day detail |
| `CategoryBars.tsx` | Spend-by-category ranked bars (Analytics) |
| `MonthlyBars.tsx` | Month-over-month spend bars (Analytics) |
| `InsightPanel.tsx` | Renders one `Insight`: title, evidence, action |
| `TransactionEntry.tsx` | The "Add" modal — expense/income/transfer/refund, including balanced category splits; `iconOnly` prop for narrow nav rails |
| `TransactionList.tsx` | Transaction history table: void, edit-in-place |
| `InlineEditor.tsx` | Shared edit-in-place form behind budgets/goals/obligations/accounts — one component so the three behave identically |
| `ImportInbox.tsx` | Statement upload, receipt photo upload, candidate list |
| `TriageDeck.tsx` | One-by-one accept/reject for import candidates |
| `DataManager.tsx` | Export buttons (CSV/JSON/XLSX/PDF), backup download, restore with preview |
| `BackupPanel.tsx` | Backup staleness/status shown on the Data screen |
| `RuleManager.tsx` | Create, order, preview and apply categorisation rules |
| `BankManager.tsx` | Connect, map, sync and revoke opt-in bank feeds |
| `MonthPlanView.tsx` | Assign expected monthly income to budgets, goals and obligations |
| `MonthGrid.tsx` | Calendar-month overview with selected-day detail |
| `LoginGate.tsx` | The password form shown when a session is required and missing |

**Lib** (`lib/`):

| File | Responsibility |
|---|---|
| `api.ts` | Typed fetch wrappers for every backend route; `forwardedCookies` for server-side auth |
| `money.ts` | `formatMinor`, `parseMajorToMinor` — minor units at the boundary, never a float |
| `guard.tsx` | `requireSession()` — server-side auth check every page calls before rendering |
| `design.tsx` | `DesignProvider`/`useDesign()` — the four-design, light/dark/system state machine. **Read the comment above `DesignProvider` before changing initial-state logic** — it explains two hydration bugs already found there |
| `setup.ts` | `setupSteps()` — which account kinds the Add form needs, shared by dashboard and Accounts |
| `chartSelection.ts` | `useChartSelection()` — picking a chart point by mouse, touch, pen or keyboard, for all three charts |
| `fonts.ts` | `next/font/google` loaders for the four design typefaces (Fraunces, Instrument Serif, Archivo, IBM Plex Mono), exposed as CSS variables |

**The design-token system**, in `globals.css`: every component styles against the same variable
names (`--surface-1`, `--text-primary`, `--accent`, `--radius`, `--font-display`, ...) regardless
of which design is active. Colour tokens are keyed by `[data-design="x"][data-theme="y"]`; shape
tokens (radius, border weight, which typeface plays which role) are keyed by `[data-design="x"]`
alone, since they do not change between light and dark. `<html>` is served carrying the default
pair by `app/layout.tsx`; `DesignProvider` writes a stored choice over it, and nothing else does.
See `docs/DECISIONS.md`'s design-system entry for why the values are what they are and what the
four are named.

Text or icons drawn on `--accent` use `--on-accent`, chosen per palette to clear 4.5:1.
`backend/tests/unit/test_design_tokens.py` fails if a palette lacks it, if it drops below AA, or if a
component puts a fixed colour on the accent.

**Browser tests** (`frontend/e2e/`, Playwright) run the real stack: `playwright.config.ts`
migrates and seeds a database whose name must end in `_e2e`, then starts the API on :8100 and a
production build on :3100. `flows.spec.ts` drives the transaction form and a category rename
through to the ledger; `motion.spec.ts` checks hover lift, reduced motion and that the entrance
starts from the server's HTML; `screens.spec.ts` sweeps every screen in every design for AA
contrast and for sideways scroll at phone width. Each asserts against the figure before it, never
a fixed amount, because the seed dates everything from today.

---

## 3. Cross-engine agreement

Six engines can now disagree about the same money: ledger, safe-to-spend, budgets, recovery,
calendar, simulation. `BUDGET_ENGINE_SPEC.md` §4 lists ten contradiction points. Honest status:

| # | Risk | Guard test? |
|---|---|---|
| X1 | §4 must gain no budget-overspend term (would double-count) | ✅ `test_cross_engine_guards.py` |
| X2 | Card-funded overspend moves budget `Spent` but not cash | ✅ `test_cross_engine_guards.py` |
| X3 | Budget `Spent` and `account_balances` must read the same transaction set | ✅ Shared `posted_transaction_ids` selector plus integration test |
| X4 | Void semantics identical across engines | ✅ `test_corrections.py` |
| X5 | Future-dated transactions: deliberate divergence | ✅ Both sides tested |
| X6 | Goal period ≠ budget period | ✅ Implicit in `horizon_for` tests |
| X7 | Near-term window ≠ recovery horizon | ✅ `test_budget_recovery.py` |
| X8 | One implementation of the S1 clamp | ✅ Integration and AST source-policy guards |
| X9 | `date.today()` banned in `app/` | ✅ AST source-policy guard |
| X10 | `TotalAccessible` releases flexible balance and unmade contribution | ✅ Named regression plus golden month |
| X11 | Expected income: all engines derive occurrences from the rule | ✅ `test_income_occurrences.py` |
| X12 | Simulation reads the ledger and never writes to it (P1) | ✅ `test_simulation.py` asserts balances, net worth and transaction count are unchanged after run/fetch/compare |
| X13 | Staging an import never moves a balance; only acceptance does | ✅ `test_importing.py::test_staging_never_touches_the_ledger` |
| X14 | An explanation's terms sum to the figure it explains (E1) | ✅ `test_explain.py` — safe-to-spend, total-accessible and net worth, in Decimal and in minor units |
| X15 | Insights read the engines rather than recomputing them | ✅ `test_explain.py::test_budget_insights_cite_the_budget_s_own_numbers` |
| X16 | A scheduled backup and `/export/backup.json` are the same bytes (B-A) | ✅ `test_backup.py::test_the_written_file_matches_the_export_endpoint_byte_for_byte` |
| X17 | A backup file restores to identical balances and net worth (B-B) | ✅ `test_backup.py::test_a_backup_file_restores` |
| X18 | No model output can become a figure — only an existing category (A1) | ✅ `test_enrichment.py` — invented categories and numeric answers both resolve to none |
| X19 | The app is unchanged with no API key (A3) | ✅ `test_enrichment.py` — import works, no network, no error |
| X20 | A receipt reaches the ledger only through the candidate inbox (A1') | ✅ `test_receipts.py` — staging leaves balances and transaction count untouched |
| X21 | The merchant baseline reads the same postings `Spent` does, netted the same way | ✅ Shared `_legs_in_scope` selector for scope; shared `reimbursement._offsets` walk for netting. `test_merchant_anomaly.py::test_the_baseline_reads_the_same_postings_budget_spent_does` and `::test_a_fully_reimbursed_trip_does_not_trip_the_merchant_warning` |
| X22 | An account default is stamped on the write, never derived on the read | ✅ `test_account_defaults.py` — changing a default leaves written postings alone, and a restore reproduces the file |
| X23 | A category the second opinion rejects is never cached as an answer, and is surfaced on the candidate, not just silently blanked | ✅ `test_enrichment.py::test_a_downgraded_pick_is_not_cached_at_all`, `::test_a_downgraded_merchant_is_asked_about_again_next_time`; `test_receipts.py::test_a_second_check_that_disagrees_is_surfaced_not_applied` |
| X24 | Safe-to-spend, the balance curve and the projection release an obligation on the same event | ✅ `test_cross_engine_guards.py::test_X24_every_forecast_engine_drops_an_obligation_on_the_same_event`, plus `test_obligation_api.py::test_projected_spend_is_the_same_whether_or_not_a_match_is_confirmed` |
| X25 | An automatic obligation match is unambiguous and reversible | ✅ `test_obligation_api.py::test_an_ambiguous_same_amount_pair_is_not_auto_matched`, `::test_unmatching_restores_the_commitment_and_survives_sync` |
| X26 | Voiding a matched payment reopens the obligation atomically | ✅ `test_obligation_api.py::test_voiding_a_matched_payment_reopens_the_commitment`; migration 0011 repairs old voided links |
| X27 | Recurring-rule edits change the future, never historical occurrences | ✅ `test_obligation_api.py::test_changing_the_amount_rewrites_only_current_and_future_instances`, `::test_shortening_and_clearing_the_end_date_reshapes_only_the_future_schedule` |
| X28 | A bank feed remains idempotent when its ledger-account mapping changes | ✅ `test_bank_sync.py::test_remapping_a_link_does_not_restage_a_row` |
| X29 | Portable backups never carry live bank consent credentials | ✅ `test_backup.py::test_bank_consent_credentials_are_redacted_and_restore_as_revoked` |
| X30 | An archived account holds nothing, so engines that skip inactive accounts agree with net worth, which reads them all | ✅ `account_lifecycle`: archiving needs a zero balance, and posting to, accepting into or voiding against an archived account is refused. `test_account_lifecycle.py::test_archiving_an_empty_account_leaves_every_headline_figure_unchanged` and `::test_voiding_a_transaction_on_an_archived_account_is_refused` |

### Assisted categorisation and receipt reading (Phases 7 and 11)

**Off by default, on here.** `LLM_PROVIDER=none` means no model feature runs and nothing is
called. A key left in `.env` does not switch anything on — choosing a provider is the deliberate
act, and this install has made it: `LLM_PROVIDER=openai_compatible` against a local Ollama with
`llama3.2` (categorisation) and `llama3.2-vision` (receipts) pulled, so merchant names never
leave the machine.

| Provider | `LLM_PROVIDER` | Notes |
|---|---|---|
| Ollama (local) | `openai_compatible` | Free, no key, **nothing leaves the machine**. `LLM_BASE_URL=http://localhost:11434/v1` |
| Groq / OpenRouter / Together / LM Studio | `openai_compatible` | Same code path; set base URL and key |
| Anthropic | `anthropic` | Needs the optional extra: `pip install -e '.[llm]'` |

The open-model path uses `httpx`, already a FastAPI dependency, so it needs **no extra package**.

For financial data the local option is worth defaulting to. Merchant names are a spending
profile; Ollama keeps them on the machine and costs nothing.

The cost design is the cache, not the prompt. `merchant_suggestions` is keyed on
`normalise_description` — the same function duplicate detection uses — so every variant of
`TESCO STORES 3421` collapses to one row and one question. A merchant is asked about once, ever;
a user correction is stored as theirs and outranks the model permanently (A2).

**A second-opinion pass landed 2 September 2026 (X23).** Both `enrichment.resolve()` and
`receipts.stage()` now follow up a model's own extraction with an independent check of that
specific claim — "is this category actually right for this description", "does this total match
what the image shows" — rather than trusting a single pass's self-reported confidence. Purely
informational for receipts (a disagreement lands as `raw.verification_note` on the candidate,
never changes the staged amount — A1' is unmoved); for categorisation, an explicit disagreement
additionally means the pick is **not cached**, so the merchant is a genuine miss again on the next
import rather than settling on "no category" forever from one disagreement. Both `verify()` calls
degrade to a no-op (old-style suggester/reader without one, a failed call, `NullSuggester`/
`NullReader`) without touching the original suggestion — the second opinion is an extra layer of
caution, never a new dependency. `ImportInbox.tsx` surfaces a disagreement as a warning line on
the row itself, not behind "Source row".

**Recommended next task, set by the user 2 September 2026.** The motion pass is done for all four
designs on all ten screens — see "A motion layer landed" above for exactly what exists. What's left
of the original three-part ask:

1. ~~**Motion.**~~ Done: each design has its own motion language on every screen.
2. ~~**Variance.**~~ Done, on every screen, in section G of `globals.css`. Field Ledger is a
   ruled page: cards lose their fill and frame and keep a rule, with an italic title under a
   double rule. Raw Ledger labels sections with inverted tags, underlines the title like a
   poster and puts its figures on tinted fills. Command Ledger reads as a console: `//`
   section comments, a `>` prompt title and tight 1px-framed panels.
3. ~~**Dead space.**~~ Done, at lg and up. Field sets the content on a sheet of ledger paper with
   a red double margin rule; Raw stands a hard-framed slab on hatched gutters; Command gets a
   live status panel at 2xl (`ConsoleStatus`: the time, the route, safe to spend and net worth).
   Vault Noir's ambient glow and grid now actually show; see the trap on inline backgrounds.

Everything else the earlier handoffs listed as outstanding has landed: `rollover_reset` has a
control on the budgets screen, transactions can be edited for their non-monetary fields, receipt
vision reads a photograph into the candidate inbox, and the two rollover defects an adversarial
review found are closed with named tests. The correctness and security debt below are both
empty. The deploy itself (`docs/RUNNING.md` / `deploy/`) is unchanged and still waiting whenever
it becomes the priority again.

---

## 4. Everything left to do

### Blocking real use

Nothing outstanding for local use.

**Before exposing it to a network**, the code side is now done: login failures back off
exponentially (capped at ten minutes, never a permanent lockout), security headers are sent on
every response, and CORS origins are configurable. What remains is yours: set a password
(`scripts/set_password.py`), run something that terminates TLS — `deploy/Caddyfile` does it with
automatic certificates — then set `COOKIE_SECURE=true` and `CORS_ORIGINS` to the real origin. The
app warns at every startup until `COOKIE_SECURE` is true. See `deploy/README.md`.

Backup and restore are done, with a round-trip test asserting balances and net worth survive a
wipe, and reachable from `/data` rather than only by hand.

**Scheduled backups now run.** A lifespan timer writes one every `BACKUP_INTERVAL_HOURS` (24 by
default) into `BACKUP_DIR` (`backend/backups/`, gitignored), keeping the newest `BACKUP_KEEP`.
Writes are atomic and land at 0600. The timer only runs while the API does — which is why the
age of the newest file is reported at `/backups`, shown on `/data`, and raised as an insight when
it goes stale. For a backup that does not depend on the app being open:

```
0 3 * * *  cd /path/to/backend && .venv/bin/python scripts/backup.py
```

### Security debt

None outstanding. Sessions are signed with a dedicated `SESSION_SECRET`, generated by
`scripts/set_password.py`, so the password hash only ever verifies a password. Revocation on
password change is preserved by a fingerprint carried in each token rather than by coupling the
signing key to the hash.

An install with no `SESSION_SECRET` still works — it falls back to the old derived key — but says
so loudly at startup, because that path is the weakness the separation removes.

### Correctness debt

None outstanding. Reimbursement netting, W3 wiring and the expected-income drift are all closed,
each with named tests.

### Product gaps

1. Deleting. Budgets, goals and commitments can be created and edited, and archived via an
   active flag, but never deleted: they are referenced by history, so removing one would change
   what a closed period meant. Scenarios are the single exception — they are hypotheticals with
   no audit trail to preserve, so `DELETE /scenarios/{id}` exists and the UI offers it. The rule
   is stated in `scenario_routes.delete_scenario`.
2. ~~`rollover_reset` has no UI~~ — done. The budget editor offers "write it off from this
   period on", sent only when chosen so an unrelated amount change cannot silently un-forgive an
   earlier write-off. A budget's period and anchor still cannot be changed after creation, and
   that stays deliberate: it reshapes every historical boundary.
3. ~~XLSX and PDF export~~ — done. All four §10 formats ship. The workbook writes amounts as
   numbers so a spreadsheet can sum them; the PDF is a statement for reading, not re-importing.
   `transactions.csv` stays canonical and both new formats are tested against it.
4. ~~No restore UI~~ — done. `/data` handles all four exports, the JSON backup, and restore with
   a client-side parse, a preview of what the file contains, and a typed confirmation when the
   database is not empty.
5. ~~Transaction editing~~ — done. `PATCH /api/transactions/{id}` corrects description,
   merchant and category in place; amount and booking date are refused with a 422 naming the
   void endpoint, because those are the corrections that have to say the money was wrong.
6. ~~Accounts can be created on `/accounts`, but not renamed or archived.~~ Done.
   `PATCH /api/accounts/{id}` takes `name` and `active`. Archiving is refused while the account
   holds money or an active goal, commitment, expected income or bank feed still uses it; after
   that, nothing may post to, accept into or void against it (X30). Pickers for new money skip
   archived accounts, and history keeps their names. Categories can now be renamed too:
   `PATCH /api/categories/{id}` takes `name` only, and the rename relabels past breakdowns as
   well, because they read the name through the id. A new nature or parent is refused with its
   reason; see `docs/DECISIONS.md`, *A category rename relabels history*.
7. ~~**The protected cash buffer has no API or UI.**~~ Done. `GET`/`PUT /api/protected-buffer`
   sets it from a card on Accounts, and the dashboard's "none set" note links there. Every engine
   reads it through `domain/profile.protected_buffer`, so the card shows what each one subtracts.
8. ~~**Open from the 24 September audit.**~~ Decided 7 October: item 10, adopt one design, is
   declined and all four stay (`docs/DECISIONS.md`, *Four designs stay*). The concrete product
   gaps are closed: opt-in UK Open Banking sync, categorisation rules,
   split entry, a month-grid calendar and a zero-based "assign every pound" view now ship. The
   eight palettes also have automated AA contrast coverage.

### Goal integrity coverage

`G1` is enforced by a deferred database trigger across contribution edits, goal-account changes
and balance-changing ledger writes; it also rejects links to non-savings accounts. A direct-SQL
regression proves the rule is not ORM-specific. `G2` has a named test that pins the recovery gap,
flexible sacrifice order and projected contribution total. The August golden fixture then
reconciles these engines with the ledger, budget and calendar for one complete month.

### Known sharp edges

- **Seed data is measured from today, and re-seeding wipes the ledger.** `scripts/seed_demo.py`
  now writes seven months ending at `clock.today`, so the demo no longer drifts into the past —
  but it still TRUNCATEs every data table first. Never point it at anything but the dev database.
  An AST guard fails the suite if a fixed date is reintroduced.
- **`alembic` targets the dev database by default.** `alembic downgrade base` wipes `budgetapp`.
  Point it at `budgetapp_test` when experimenting.
- **Fortnightly budgets need `anchor_date`; everything else must not have one.** A CHECK enforces
  it, so a bad payload gets a 422, not a silent default.
- **Only `POSTED` transactions count anywhere.** `CANDIDATE` exists for Phase 6 and is invisible
  to every engine today.
- **G1 is deferred until commit.** An invalid goal or balance-changing write may flush before the
  database rejects the transaction at commit; callers must handle the rollback.

---

## 5. Traps worth knowing before changing anything

These are bugs already found and fixed. They will come back if the reasoning is lost.

- **Anything that writes files must be off in tests.** The backup timer starts in the FastAPI
  lifespan, so every `TestClient` fixture started it — against the *real* database, writing real
  ledger backups into `backend/backups/`. `conftest` now disables it the same way it disables
  auth. Check this for any future background task.
- **Wall-clock time goes through `clock.now()`, never `datetime.now()`.** The X9 guard permits
  `datetime.now` in `domain/clock.py` only. Reporting questions use `clock.today(session)`;
  genuinely wall-clock ones (when a file was written) use `clock.now()`. Do not add a per-file
  exemption to the guard.
- **`budget_warnings.evaluate()` is keyword-only, and `enrich` has already called it.** The
  warnings are on `BudgetPeriodResult.warnings`. Calling it again is a second call site for the
  same arithmetic, and it will not even bind positionally.
- **A candidate fingerprint must not carry a date component.** Baking in the month looks
  harmless and fails silently across a boundary: a payment exported as 31 August and again as
  1 September is one day apart, inside the matching window, but lands under a different key.
  The key answers "same payment?", the window answers "same occasion?".
- **Mirroring a server-component prop into `useState` freezes it.** `router.refresh()` updates
  the prop; the copy never hears. The import inbox reads its list straight from props for this
  reason. This bug looks like "the action worked but the screen is stale".
- **Stepping a date month by month ratchets.** Once a 31st clamps to the 28th in February it
  never recovers. `simulation._add_months` always measures from the original date via the
  `(year, month)` ordinal; the budget engine does the same. Never add a month to the last result.
- **The simulator's third series is aqua, which sits under 3:1 on the light surface.** The
  palette's relief rule makes the table toggle in `ScenarioChart` mandatory, not a nicety.
  Removing it breaks the accessibility contract even though nothing will fail to compile.
- **CSS outside a layer beats every Tailwind utility, whatever the specificity.** `.form-control`
  was unlayered, so `pl-7` lost to its padding and the £ sign sat on the first digit; `w-24` and
  `py-1.5` were silently ignored the same way. Component classes go in `@layer components`.
- **Sorting on a column that can repeat needs the primary key last.** Ties come back in physical
  row order, which an edit changes. That made backups differ between two exports of the same data
  (X16 failed intermittently) and made transaction paging repeat some rows and skip others —
  `created_at` is `now()` for a whole database transaction, so an import batch ties on it.
- **`Decimal("-7") // Decimal("2")` is `-3`**, while `-7 // 2` is `-4`. Decimal floor division
  truncates toward zero. Never use `//` on money — `floor_money` exists for this.
- **RFC 5545 skips, it does not clamp.** `BYMONTHDAY=31` drops five months a year.
- **`date.today()` is the server's date.** Always `clock.today(session)`.
- **Liabilities are credit-normal.** Money owed is stored negative, so net worth is a plain sum.
- **Never derive `Spent` from `TransactionClass`.** It is a posting-level, expense-kind sum. A
  category-only filter nets a fully tagged transaction to zero — a silent zero.
- **`days_remaining` is `None` for a closed period, not `0`.** Zero is the exhausted-allowance
  value and the two states must stay distinguishable.
- **Elapsed + remaining = total + 1.** Today counts in both. Deriving one from the other is off
  by one every day and divides by zero on the last day of every period.
- **Tests must never read the developer's `.env`.** `conftest.py` forces auth off for every
  test; without it, setting a real password turned auth on for the whole suite and 53 tests
  failed with 401. A suite whose result depends on local configuration tests the environment.
- **Obligation instances carry a copy of the amount.** Editing an obligation must rewrite the
  unfulfilled ones or the projection keeps the old figure while the obligation shows the new —
  two numbers for one bill. Fulfilled instances keep theirs; they record what was committed.
- **Server components have no cookie jar.** `credentials: "include"` does nothing in Node, so a
  server-side fetch is anonymous unless the incoming request's cookies are forwarded by hand
  (`lib/api.ts::forwardedCookies`). Without it, login *succeeds*, sets a cookie, and then the very
  next server render asks "am I authenticated?" without it and is told no — for ever. The symptom
  is a login form that silently reappears, which reads as a wrong password.
- **Cross-origin fetches need `credentials: "include"`.** The API is a different origin, so
  without it the session cookie is never sent and every request looks anonymous.
- **Two savings figures, not one.** `savings_rate` is `(income − spending) / income`, the standard
  definition. `set_aside_rate` is what was deliberately moved. Reporting only the second told a
  careful saver with no savings account that they saved nothing.
- **TRUNCATE is invisible to the SQLAlchemy identity map.** `expunge_all()` after it, or the
  session still holds rows that no longer exist and re-inserting their ids collides.
- **Compare money as `Decimal`, not as strings.** A value round-tripped through `NUMERIC(19,4)`
  comes back with the column's scale: `Decimal("2000")` becomes `Decimal("2000.0000")`.
- **Money crosses JSON as strings, never numbers.** A JSON number round-trips through a float.
- **Exports are posting-level.** A transaction has no single amount; inventing one is what stops
  a report reconciling.
- **A stored "next X date" is a derived value and will drift.** `ExpectedIncome` once had
  `next_expected_date`; nothing advanced it, and two of its three readers took the name
  literally. Occurrences come from the rule. The column is `first_expected_date`, an anchor.
- **A budget edit must append a `BudgetRevision`, never mutate one.** Mutating rewrites history:
  a £300→£400 change moved an eight-month chain's answer from £390 to £1,090.
- **A PATCH field that is not optional is a field every edit overwrites.** `rollover_reset` was
  `bool = False`, so bumping an amount resent `false` and silently un-forgave an overspend
  written off earlier in the same period. Partial-update fields are `T | None = None`, applied
  only when not None, and read through `model_fields_set` so an explicit `null` still clears.
  `test_rollover_reset.py` pins it; `AccountEditIn` follows the same shape.
- **A MAD of zero is the common case, not the corner.** Every fixed subscription has a median
  absolute deviation of exactly zero, so the merchant z-score divides by zero on the most
  predictable merchants in the ledger. The epsilon-guarded version is worse than the crash: it
  reports a 50p rise on a £10.99 subscription as a 26-sigma event. `merchant_baseline` falls back
  to `|x − median| >= max(£10.00, 25% · median)`, and the tests pin both branches.
- **Absence is not a zero.** A merchant that did not appear in a period contributes no
  observation to its baseline. Filling the gap with zero drags the median down until the next
  ordinary purchase looks extraordinary.
- **The merchant baseline shipped once without reimbursement netting.** `chain()`'s `Spent`
  nets a repaid expense to zero; `merchant_spend_by_booking_date` did not, so a fully reimbursed
  £600 trip could fire `merchant_anomaly` over money the budget itself already reads as £0. Found
  in review, not by the first round of tests -- `test_the_baseline_reads_the_same_postings...`
  covered scope agreement but not netting agreement, which is a different claim. Fixed by
  `reimbursement._offsets`, one walk over the reimbursements both `netting_by_booking_date` and
  the new `merchant_netting_by_booking_date` read from, so they cannot drift apart the way the
  original two independent queries did.
- **An account default is stamped on the write, never applied on the read.** Deriving it at read
  time would silently recategorise every historical untagged posting the moment the default
  changed — last March's essential rent becoming discretionary, with nothing on screen saying so.
  `restore` deliberately does not stamp, or a backup would stop round-tripping (X17).
- **`enrich` needs its merchant history passed in.** It is a required argument rather than an
  optional one precisely so a caller cannot forget it: a `None` default would downgrade the
  merchant warning to `not_evaluated` silently, which is the quietest possible way to lose a
  warning. `budget_routes` fetches once for the whole chain, never once per period.
- **Never give `.finance-shell` an inline `background`.** The shorthand resets
  `background-image`, and an inline value beats every stylesheet rule, so no design could layer
  anything over the page: Vault Noir's glow and ambient grid were written, documented as done,
  and never painted. The page colour lives in CSS now, and noir's shell is transparent so the
  body's ambient shows through.
- **Motion scoped to a design needs that design on the first paint.** `<html>` used to be served
  with no `data-design`, so every motion rule started matching only when `DesignProvider`'s effect
  set it after hydration: each cold load painted the page whole, then snapped it back to hidden to
  play the entrance. The layout now serves the defaults, which paint exactly as the bare `:root`
  fallback does; `tests/design-defaults.test.mjs` keeps them equal to `DEFAULT_DESIGN` and
  `DEFAULT_APPEARANCE`. A stored non-default design still swaps in after hydration, as the next
  entry explains. Related: every page renders its own `AppShell`, so anything in it remounts on
  each navigation; the Command rail's entrance is limited to once a visit for that reason.
- **Never read `localStorage` inside a `useState` initializer.** `DesignProvider` first tried it,
  and it threw a hard hydration failure on every returning visitor whose stored design differed
  from the default. The initializer runs on the client's very first render, before hydration
  reconciles anything — so a stored non-default choice made that first render produce a
  *structurally different component tree* (a masthead instead of an icon rail) than the one the
  server sent down. That is not an attribute mismatch `suppressHydrationWarning` can absorb; React
  discards the whole SSR output and re-renders from scratch. State must start at the same default
  on server and client alike, with the stored value applied only inside a post-mount
  `useLayoutEffect` — the honest cost is a single-frame flash of the default on a cold load, not
  the zero-flash a blocking script would have given.
- **A literal `<script>` element in the App Router root layout's `<body>` broke hydration outright
  in this Next.js/Turbopack combination.** Every variant was tried — `next/script` at every
  strategy, a raw `dangerouslySetInnerHTML` tag, with and without `async`, inside a manual `<head>`
  and inside `<body>` — and all of them threw "Encountered a script tag while rendering React
  component" on every load. This is why `lib/design.tsx` reads storage in an effect instead of a
  blocking boot script the way most theme-switchers do; do not reintroduce one without confirming
  this was a version-specific bug that has since been fixed upstream.
- **An entrance animation must fill `backwards`, never `forwards`.** A forwards fill holds the last
  keyframe for good, and an animated value outranks every ordinary rule. `.stagger-in` once ended
  on `transform: none` and `filter: blur(0)`, so every staggered card on the dashboard and budgets
  screens silently lost its hover lift and shadow. Backwards holds the first keyframe through the
  delay, so nothing flashes, then hands the element back. `test_motion_rules.py` fails on a
  forwards or both fill for any keyframe that moves a transform or filter, and on any animation
  outside the `prefers-reduced-motion: no-preference` query.
- **A stale browser console buffer looks exactly like a real bug.** Debugging the two traps above
  took far longer than it should have because `read_console_messages`-style tools return
  accumulated history, not just the latest reload's output — a fix that worked read as broken
  because the previous failure was still sitting in the buffer. Test hydration/boot-sequence
  changes in a genuinely new tab, not a reloaded one, or the wrong fix gets abandoned.

---

## 6. Running it

See the README. In short: Postgres running, `alembic upgrade head`, `uvicorn` on :8000,
`npm run dev` on :3000.

Verify a change end to end with:

```bash
cd backend && ./.venv/bin/python -m pytest -q && ./.venv/bin/python scripts/seed_demo.py
```

and the browser tests, which need Postgres and a disposable database (created once with
`createdb budgetapp_e2e`):

```bash
cd frontend && E2E_DATABASE_URL=postgresql+psycopg://localhost/budgetapp_e2e npm run e2e
```
