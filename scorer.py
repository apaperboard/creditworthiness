import statistics
from config import (
    WEIGHTS, HANDOVER_THRESHOLDS, VADE_THRESHOLDS,
    BALANCE_TREND_THRESHOLDS, CONSISTENCY_CV_THRESHOLDS,
    OUTSTANDING_RATIO_THRESHOLDS, GRADES,
)


def interpolate_score(value, thresholds):
    """Linear interpolation between threshold points."""
    if value <= thresholds[0][0]:
        return thresholds[0][1]
    if value >= thresholds[-1][0]:
        return thresholds[-1][1]

    for i in range(len(thresholds) - 1):
        x0, y0 = thresholds[i]
        x1, y1 = thresholds[i + 1]
        if x0 <= value <= x1:
            ratio = (value - x0) / (x1 - x0) if x1 != x0 else 0
            return y0 + ratio * (y1 - y0)
    return thresholds[-1][1]


def score_handover_speed(matched_pairs):
    """Score based on average days from invoice to check handover."""
    # Credit notes are refunds, not real payment hand-overs — exclude them.
    pairs = [m for m in matched_pairs if m.payment_type != "credit_note"]
    if not pairs:
        return 0, {"avg_days": None, "std_days": None, "detail": "No matched payments"}

    days = [m.days_to_handover for m in pairs]
    avg = statistics.mean(days)
    std = statistics.stdev(days) if len(days) > 1 else 0

    score = interpolate_score(avg, HANDOVER_THRESHOLDS)

    # Penalize high variance (up to -10 points)
    if std > 15:
        penalty = min(10, (std - 15) / 15 * 10)
        score = max(0, score - penalty)

    return round(score), {
        "avg_days": round(avg, 1),
        "std_days": round(std, 1),
        "min_days": min(days),
        "max_days": max(days),
    }


def score_vade_length(matched_pairs):
    """Score based on average vade length (invoice date to check settlement)."""
    vadeli = [m for m in matched_pairs if m.vade_length > 0]
    non_vadeli = [m for m in matched_pairs if m.vade_length == 0]

    if not matched_pairs:
        return 0, {"avg_vade": None, "detail": "No matched payments"}

    if not vadeli:
        return 100, {"avg_vade": 0, "detail": "All payments are immediate (KK/Pesin)"}

    # Weighted average by amount
    total_amount = sum(m.matched_amount for m in matched_pairs)
    if total_amount == 0:
        return 50, {"avg_vade": None, "detail": "Zero total amount"}

    weighted_vade = sum(m.vade_length * m.matched_amount for m in vadeli) / total_amount
    # Non-vadeli contribute 0 vade weighted by their amounts (already excluded from sum)

    score = interpolate_score(weighted_vade, VADE_THRESHOLDS)

    vade_days = [m.vade_length for m in vadeli]
    return round(score), {
        "avg_vade": round(weighted_vade, 1),
        "min_vade": min(vade_days),
        "max_vade": max(vade_days),
        "vadeli_count": len(vadeli),
        "non_vadeli_count": len(non_vadeli),
    }


def score_balance_trend(statement):
    """Score based on whether outstanding balance is growing or shrinking."""
    balances = []
    for tx in statement.transactions:
        if tx.running_balance is not None:
            balances.append(tx.running_balance)

    if len(balances) < 2:
        return 50, {"slope_ratio": None, "detail": "Insufficient data"}

    total_invoiced = statement.total_debit
    if total_invoiced == 0:
        return 50, {"slope_ratio": None, "detail": "No invoices"}

    start_balance = balances[0]
    end_balance = balances[-1]
    slope_ratio = (end_balance - start_balance) / total_invoiced

    score = interpolate_score(slope_ratio, BALANCE_TREND_THRESHOLDS)

    return round(score), {
        "slope_ratio": round(slope_ratio, 3),
        "start_balance": round(start_balance, 2),
        "end_balance": round(end_balance, 2),
    }


def score_payment_consistency(transactions):
    """Score based on regularity of payment intervals."""
    payment_dates = sorted([
        tx.date for tx in transactions
        if tx.tx_type in ("check", "credit_card", "wire") and tx.date
    ])

    if len(payment_dates) < 3:
        return 50, {"cv": None, "detail": "Fewer than 3 payments — insufficient data"}

    intervals = [(payment_dates[i + 1] - payment_dates[i]).days
                 for i in range(len(payment_dates) - 1)]

    avg = statistics.mean(intervals)
    if avg == 0:
        return 50, {"cv": None, "detail": "All payments on same date"}

    std = statistics.stdev(intervals)
    cv = std / avg

    score = interpolate_score(cv, CONSISTENCY_CV_THRESHOLDS)

    return round(score), {
        "cv": round(cv, 2),
        "avg_interval_days": round(avg, 1),
        "std_interval_days": round(std, 1),
        "payment_count": len(payment_dates),
    }


def score_outstanding_ratio(statement):
    """Score based on end balance relative to total invoiced."""
    total_invoiced = statement.total_debit
    if total_invoiced == 0:
        return 100, {"ratio": 0, "detail": "No invoices"}

    end_balance = max(0, statement.end_balance)
    ratio = end_balance / total_invoiced

    score = interpolate_score(ratio, OUTSTANDING_RATIO_THRESHOLDS)

    return round(score), {
        "ratio": round(ratio, 3),
        "end_balance": round(end_balance, 2),
        "total_invoiced": round(total_invoiced, 2),
    }


def get_grade(total_score):
    for min_score, grade, label in GRADES:
        if total_score >= min_score:
            return grade, label
    return "F", "Poor"


def compute_score(statement, matched_pairs, unmatched_invoices):
    """Compute the full credit score with component breakdown."""
    components = {}

    s, d = score_handover_speed(matched_pairs)
    components["handover_speed"] = {"score": s, "weight": WEIGHTS["handover_speed"], "details": d}

    s, d = score_vade_length(matched_pairs)
    components["vade_length"] = {"score": s, "weight": WEIGHTS["vade_length"], "details": d}

    s, d = score_balance_trend(statement)
    components["balance_trend"] = {"score": s, "weight": WEIGHTS["balance_trend"], "details": d}

    s, d = score_payment_consistency(statement.transactions)
    components["payment_consistency"] = {"score": s, "weight": WEIGHTS["payment_consistency"], "details": d}

    s, d = score_outstanding_ratio(statement)
    components["outstanding_ratio"] = {"score": s, "weight": WEIGHTS["outstanding_ratio"], "details": d}

    total_score = round(sum(
        c["score"] * c["weight"] for c in components.values()
    ))

    grade, grade_label = get_grade(total_score)

    return {
        "total_score": total_score,
        "grade": grade,
        "grade_label": grade_label,
        "components": components,
        "unmatched_count": len(unmatched_invoices),
        "unmatched_amount": round(sum(u.remaining_amount for u in unmatched_invoices), 2),
    }
