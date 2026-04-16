# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Purpose

Locally-hosted Flask tool that parses customer balance statements (xlsx) and computes a credit-worthiness score with a Chart.js dashboard. The business target is a 30-day close cycle; deviations from that drive the score.

## Commands

```bash
# Install deps
pip install -r requirements.txt

# Run the app (debug mode, port 3031)
python app.py
```

There are no tests, no linter, and no build step. Iteration happens by re-running `app.py` and re-uploading a real xlsx through the browser at **http://localhost:3031**.

To exercise the backend without the UI:
```bash
curl -X POST -F "file=@path/to/statement.xlsx" http://localhost:3031/analyze
```

## Architecture

### Pipeline (single request)

`parser.py` → `matcher.py` → `scorer.py` → `app.py` assembles the JSON response.

1. **Parser** (`parser.py`) loads the workbook with `openpyxl`, extracts `customer_name` from B1 and `period_start`/`period_end` from G1/I1, then reads transaction rows starting at row 3. Each row follows a fixed column layout: **A=debit (invoices)**, **B=credit (payments)**, **C=description**, **D=notes**, **E=payment_terms (Vadeli/KK/Pesin)**, **F=date**, **G=invoice#**, **H=running_balance**.
   - **Summary-row detection is critical**: different templates have a variable number of total/balance rows at the bottom (1–3 rows). The parser scans **from the bottom upward** and stops at the first row whose Column C does *not* match `SUMMARY_KEYWORDS` (Turkish + Arabic totals keywords in `config.py`). Do not replace this with a hardcoded offset — a previous version hardcoded "last 2 rows" and silently turned the 3rd summary row into a spurious `unknown` transaction.
   - Each transaction is classified by regex against the description (`RE_INVOICE`, `RE_CHECK`, `RE_CREDIT_CARD`, `RE_WIRE`, `RE_BALANCE_FORWARD`). The check regex is `^(.+?)\s+(\d{2}/\d{2}/\d{4})\s+(.+?)\s+No\s*(\d+)$` — the `\s*` (not `\s+`) after `No` is deliberate because real data has `No935` without a space.
   - `correct_settlement_date` handles the 31st-of-a-30-day-month rollover (settlement dates roll to the 1st of the next month).

2. **Matcher** (`matcher.py`) runs **FIFO matching**: invoices and payments are sorted by date, then the oldest payment settles the oldest invoice first, partials allowed. Third-party endorsed checks look identical to own checks to the parser and are matched the same way — this is intentional. Produces `MatchedPair` records carrying both `days_to_handover` (invoice → check hand-over) and `vade_length` (invoice → check settlement date). `balance_forward` transactions (Devir / رصيد اول المدة) are injected as a synthetic opening invoice so they participate in FIFO.

3. **Scorer** (`scorer.py`) computes 5 components, each via piecewise-linear interpolation over threshold tables in `config.py`:
   | Component | Weight | Driven by |
   |---|---|---|
   | `handover_speed` | 30% | mean days from invoice to payment hand-over (+ std-dev penalty above 15d) |
   | `vade_length` | 25% | amount-weighted mean vade (invoice → settlement) |
   | `balance_trend` | 20% | `(end_balance - start_balance) / total_invoiced` |
   | `payment_consistency` | 15% | coefficient of variation of payment intervals (needs ≥3 payments) |
   | `outstanding_ratio` | 10% | `end_balance / total_invoiced` |

   All tunables live in `config.py` — weights, threshold tables, grade cutoffs, regex, summary keywords, and histogram buckets. **Change scoring behavior by editing `config.py`, not the scorer functions.**

4. **app.py** glues it all together and also shapes the three presentation payloads consumed by the dashboard: `chart_data` (6 chart datasets), `summary` (KPI grid), and `details` (per-invoice table). The `/analyze` route is the single backend endpoint; it always returns the same JSON shape described below.

### `/analyze` response shape

The frontend relies on these exact keys — keep them in sync if you change them:

```
{
  customer, period: {start, end},
  score: { total_score, grade, grade_label, components: {...}, unmatched_count, unmatched_amount },
  summary: { total_invoiced, total_paid, end_balance, num_invoices, num_payments,
             avg_vade_days, max_vade_days, avg_handover_days, payment_coverage_pct,
             unmatched_invoices, unmatched_amount },
  charts: { timeline_invoices, timeline_payments, balance_trend,
            vade_histogram, handover_histogram, monthly },
  details: [...]
}
```

### Frontend (`docs/index.html`, `docs/static/dashboard.js`, `docs/static/pipeline.js`)

All frontend assets live in `docs/` because GitHub Pages serves that folder, and Flask is configured (`app = Flask(__name__, template_folder="docs", static_folder="docs/static")`) to use the same folder — so `python app.py` and the deployed Pages site serve identical files. There is no root-level `templates/` or `static/`.

`pipeline.js` is a client-side port of `parser.py` + `matcher.py` + `scorer.py` + the builder functions in `app.py`, using SheetJS to read xlsx in-browser. `dashboard.js`'s `postAnalyze` calls `window.VadePipeline.analyzeFile(file)` directly — no network call. The Flask `/analyze` endpoint still exists but is effectively dead code; keep the Python modules as the spec/reference implementation.

**If you change scoring or parsing logic, update both `pipeline.js` AND the corresponding Python module** — they're parallel implementations and must stay in sync. `config.py` → top-of-file constants in `pipeline.js`; `parser.py` → `parseExcel` / `classifyTransaction`; `matcher.py` → `fifoMatch`; `scorer.py` → `score*` / `computeScore`; `app.py` builders → `buildChartData` / `buildSummary` / `buildDetailTable`.

Single-page app with **three views** switched via `showView(name)` which toggles a `hidden` class on `#upload-section`, `#portfolio-section`, `#dashboard`:

- **upload** — drop zone + file chips list + Analyze button
- **portfolio** — sortable table, one row per customer (only shown when >1 file uploaded)
- **single** — full Chart.js dashboard for one customer

The **mass-upload flow runs entirely client-side** — `runBatch()` dispatches files through a **worker pool with concurrency 3** (`await Promise.all([worker(), worker(), worker()])`), each worker calling `postAnalyze` → `VadePipeline.analyzeFile`. Each result is denormalized into a flat record via `buildSuccessRecord`/`buildErrorRecord` for fast sorting. Error rows always sink to the bottom of the portfolio regardless of sort direction.

Drill-down from portfolio row → single dashboard is a pure client-side transition (`renderDashboard(record.data); showView('single')`) — the analyze response is cached in `portfolioResults` so going back and forth costs nothing. `drillSourceView` tracks where the user came from so "New Analysis" clears state correctly.

Chart.js instances are tracked in a module-level `charts` array and destroyed via `resetCharts()` before any re-render to prevent canvas leaks.

## Gotchas

- **Column layout is hardcoded** in the parser (A–H). Input templates that shift columns will silently produce nonsense — verify with known-good files (e.g., Hisar, Özgül) after parser changes.
- **Customer name comes from cell B1**, period dates from G1/I1. These are not discovered dynamically.
- When modifying `RE_CHECK`, test against real descriptions like `"Kalia Kozmetix 03/10/2025 Deniz Bank No935"` (no space between `No` and the digits).
- `payment_consistency` and `balance_trend` return `50` (neutral) when they have insufficient data rather than `0` — don't "fix" this to 0, it's intentional to avoid punishing small/new accounts.
- The frontend reads `data.customer` (not `customer_name`) and `data.summary.avg_vade_days` etc. — if you rename any response key, grep `dashboard.js` for `buildSuccessRecord`, `renderDashboard`, `renderCharts`, `renderMetrics` and update all consumers.
