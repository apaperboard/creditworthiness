import datetime
from collections import defaultdict
from flask import Flask, request, jsonify, render_template
from parser import parse_excel
from matcher import fifo_match
from scorer import compute_score
from config import VADE_BUCKETS

app = Flask(__name__, template_folder="docs", static_folder="docs/static")
app.config["MAX_CONTENT_LENGTH"] = 16 * 1024 * 1024  # 16MB


def date_to_str(d):
    if isinstance(d, datetime.date):
        return d.isoformat()
    return str(d) if d else None


def build_chart_data(statement, matched_pairs, unmatched_invoices):
    """Build all chart datasets from statement and match results."""

    # Payment Timeline — scatter data
    timeline_invoices = []
    timeline_payments = []
    for tx in statement.transactions:
        if tx.tx_type == "invoice":
            timeline_invoices.append({
                "x": date_to_str(tx.date),
                "y": tx.amount_debit,
                "label": tx.invoice_number,
            })
        elif tx.tx_type in ("check", "credit_card", "wire"):
            timeline_payments.append({
                "x": date_to_str(tx.date),
                "y": tx.amount_credit,
                "label": tx.description[:40],
            })

    # Balance Trend — line chart
    balance_trend = []
    for tx in statement.transactions:
        if tx.date and tx.running_balance is not None:
            balance_trend.append({
                "x": date_to_str(tx.date),
                "y": round(tx.running_balance, 2),
            })

    # Vade Distribution histogram
    vade_hist = {b[2]: 0 for b in VADE_BUCKETS}
    for m in matched_pairs:
        if m.vade_length > 0:
            for lo, hi, label in VADE_BUCKETS:
                if lo <= m.vade_length <= hi:
                    vade_hist[label] += 1
                    break

    # Handover Days histogram — credit notes are refunds, not hand-overs
    handover_hist = {b[2]: 0 for b in VADE_BUCKETS}
    for m in matched_pairs:
        if m.payment_type == "credit_note":
            continue
        for lo, hi, label in VADE_BUCKETS:
            if lo <= m.days_to_handover <= hi:
                handover_hist[label] += 1
                break

    # Monthly Invoice vs Payment
    monthly = defaultdict(lambda: {"invoiced": 0, "paid": 0})
    for tx in statement.transactions:
        if tx.date:
            month_key = tx.date.strftime("%Y-%m")
            if tx.tx_type == "invoice":
                monthly[month_key]["invoiced"] += tx.amount_debit
            elif tx.tx_type in ("check", "credit_card", "wire"):
                monthly[month_key]["paid"] += tx.amount_credit

    months_sorted = sorted(monthly.keys())
    monthly_data = {
        "labels": months_sorted,
        "invoiced": [round(monthly[m]["invoiced"], 2) for m in months_sorted],
        "paid": [round(monthly[m]["paid"], 2) for m in months_sorted],
    }

    return {
        "timeline_invoices": timeline_invoices,
        "timeline_payments": timeline_payments,
        "balance_trend": balance_trend,
        "vade_histogram": {"labels": list(vade_hist.keys()), "values": list(vade_hist.values())},
        "handover_histogram": {"labels": list(handover_hist.keys()), "values": list(handover_hist.values())},
        "monthly": monthly_data,
    }


def build_summary(statement, matched_pairs, unmatched_invoices):
    """Build summary metrics."""
    vade_days = [m.vade_length for m in matched_pairs if m.vade_length > 0]
    handover_days = [m.days_to_handover for m in matched_pairs if m.payment_type != "credit_note"]

    return {
        "total_invoiced": round(statement.total_debit, 2),
        "total_paid": round(statement.total_credit, 2),
        "end_balance": round(statement.end_balance, 2),
        "num_invoices": sum(1 for tx in statement.transactions if tx.tx_type == "invoice"),
        "num_payments": sum(1 for tx in statement.transactions if tx.tx_type in ("check", "credit_card", "wire")),
        "avg_vade_days": round(sum(vade_days) / len(vade_days), 1) if vade_days else None,
        "max_vade_days": max(vade_days) if vade_days else None,
        "avg_handover_days": round(sum(handover_days) / len(handover_days), 1) if handover_days else None,
        "payment_coverage_pct": round(statement.total_credit / statement.total_debit * 100, 1) if statement.total_debit else 0,
        "unmatched_invoices": len(unmatched_invoices),
        "unmatched_amount": round(sum(u.remaining_amount for u in unmatched_invoices), 2),
    }


def build_detail_table(matched_pairs, unmatched_invoices):
    """Build per-invoice detail rows."""
    # An invoice whose MatchedPairs sum to its full amount is "Paid" — even if
    # the matches are split across several checks and each individual match is
    # a partial slice. Only invoices that still have a remaining balance (i.e.
    # show up in unmatched_invoices) should display as "Partial".
    unmatched_rows = {u.row for u in unmatched_invoices}

    rows = []
    for m in matched_pairs:
        status = "Partial" if m.invoice_row in unmatched_rows else "Paid"
        rows.append({
            "invoice_number": m.invoice_number,
            "invoice_date": date_to_str(m.invoice_date),
            "invoice_amount": round(m.invoice_amount, 2),
            "matched_amount": round(m.matched_amount, 2),
            "payment_date": date_to_str(m.payment_date),
            "payment_desc": m.payment_description[:50],
            "payment_type": m.payment_type,
            "handover_days": m.days_to_handover,
            "vade_days": m.vade_length,
            "settlement_date": date_to_str(m.settlement_date),
            "status": status,
        })

    for u in unmatched_invoices:
        rows.append({
            "invoice_number": u.invoice_number,
            "invoice_date": date_to_str(u.date),
            "invoice_amount": round(u.total_amount, 2),
            "matched_amount": round(u.total_amount - u.remaining_amount, 2),
            "payment_date": None,
            "payment_desc": "",
            "payment_type": "",
            "handover_days": None,
            "vade_days": None,
            "settlement_date": None,
            "status": "Outstanding",
            "age_days": u.age_days,
            "remaining": round(u.remaining_amount, 2),
        })

    return rows


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/analyze", methods=["POST"])
def analyze():
    if "file" not in request.files:
        return jsonify({"error": "No file uploaded"}), 400

    file = request.files["file"]
    if not file.filename.endswith((".xlsx", ".xls")):
        return jsonify({"error": "Please upload an Excel file (.xlsx)"}), 400

    try:
        statement = parse_excel(file)
        matched_pairs, unmatched_invoices = fifo_match(
            statement.transactions, statement.period_start, statement.period_end
        )
        score_result = compute_score(statement, matched_pairs, unmatched_invoices)
        chart_data = build_chart_data(statement, matched_pairs, unmatched_invoices)
        summary = build_summary(statement, matched_pairs, unmatched_invoices)
        details = build_detail_table(matched_pairs, unmatched_invoices)

        return jsonify({
            "customer": statement.customer_name,
            "period": {
                "start": date_to_str(statement.period_start),
                "end": date_to_str(statement.period_end),
            },
            "score": score_result,
            "charts": chart_data,
            "summary": summary,
            "details": details,
        })

    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == "__main__":
    app.run(debug=True, port=3031)
