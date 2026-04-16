from dataclasses import dataclass
import datetime


@dataclass
class MatchedPair:
    invoice_row: int
    invoice_date: datetime.date
    invoice_number: str
    invoice_amount: float
    payment_row: int
    payment_date: datetime.date        # date check was handed over
    payment_description: str
    matched_amount: float
    days_to_handover: int              # invoice_date -> payment_date
    vade_length: int                   # invoice_date -> check settlement_date (Vadeli)
    settlement_date: datetime.date     # when check actually clears (None for KK/Pesin)
    payment_type: str                  # check / credit_card / wire
    is_partial: bool


@dataclass
class UnmatchedInvoice:
    row: int
    date: datetime.date
    invoice_number: str
    total_amount: float
    remaining_amount: float
    age_days: int                      # period_end - invoice_date


def fifo_match(transactions, period_start, period_end):
    """
    FIFO-match payments against invoices.
    Returns (matched_pairs, unmatched_invoices).
    """
    invoices = []
    payments = []

    for tx in transactions:
        if tx.tx_type == "balance_forward":
            if tx.amount_debit > 0:
                invoices.append({
                    "row": tx.row_index,
                    "date": tx.date or period_start,
                    "invoice_number": "DEVIR",
                    "amount": tx.amount_debit,
                    "remaining": tx.amount_debit,
                })
        elif tx.tx_type == "invoice":
            invoices.append({
                "row": tx.row_index,
                "date": tx.date,
                "invoice_number": tx.invoice_number or tx.parsed_details.get("invoice_number", ""),
                "amount": tx.amount_debit,
                "remaining": tx.amount_debit,
            })
        elif tx.tx_type in ("check", "credit_card", "wire", "credit_note"):
            payments.append({
                "row": tx.row_index,
                "date": tx.date,
                "description": tx.description,
                "amount": tx.amount_credit,
                "remaining": tx.amount_credit,
                "type": tx.tx_type,
                "settlement_date": tx.parsed_details.get("settlement_date"),
            })

    invoices.sort(key=lambda x: (x["date"] or datetime.date.min, x["row"]))
    payments.sort(key=lambda x: (x["date"] or datetime.date.min, x["row"]))

    matched_pairs = []
    inv_idx = 0
    pay_idx = 0

    while inv_idx < len(invoices) and pay_idx < len(payments):
        inv = invoices[inv_idx]
        pay = payments[pay_idx]

        if inv["remaining"] <= 0:
            inv_idx += 1
            continue
        if pay["remaining"] <= 0:
            pay_idx += 1
            continue

        match_amount = min(inv["remaining"], pay["remaining"])
        inv["remaining"] -= match_amount
        pay["remaining"] -= match_amount

        inv_date = inv["date"] or period_start
        pay_date = pay["date"] or period_start
        settlement = pay["settlement_date"]

        days_handover = (pay_date - inv_date).days
        vade = (settlement - inv_date).days if settlement else 0

        matched_pairs.append(MatchedPair(
            invoice_row=inv["row"],
            invoice_date=inv_date,
            invoice_number=inv["invoice_number"],
            invoice_amount=inv["amount"],
            payment_row=pay["row"],
            payment_date=pay_date,
            payment_description=pay["description"],
            matched_amount=match_amount,
            days_to_handover=max(0, days_handover),
            vade_length=max(0, vade),
            settlement_date=settlement,
            payment_type=pay["type"],
            is_partial=(match_amount < inv["amount"]),
        ))

        if inv["remaining"] <= 0.01:
            inv["remaining"] = 0
            inv_idx += 1
        if pay["remaining"] <= 0.01:
            pay["remaining"] = 0
            pay_idx += 1

    unmatched = []
    for inv in invoices:
        if inv["remaining"] > 0.01:
            inv_date = inv["date"] or period_start
            age = (period_end - inv_date).days if period_end else 0
            unmatched.append(UnmatchedInvoice(
                row=inv["row"],
                date=inv_date,
                invoice_number=inv["invoice_number"],
                total_amount=inv["amount"],
                remaining_amount=round(inv["remaining"], 2),
                age_days=max(0, age),
            ))

    return matched_pairs, unmatched
