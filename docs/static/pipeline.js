// Vade Suresi — client-side analysis pipeline.
// Ported from parser.py, matcher.py, scorer.py, app.py (config.py).
// Requires SheetJS (global XLSX) loaded before this script.
// Exposes window.VadePipeline.analyzeFile(file) which returns the same JSON
// shape the Flask /analyze endpoint returned.

(function () {
    'use strict';

    // --- Config (mirrors config.py) ---
    const WEIGHTS = {
        handover_speed: 0.30,
        vade_length: 0.25,
        balance_trend: 0.20,
        payment_consistency: 0.15,
        outstanding_ratio: 0.10,
    };

    const HANDOVER_THRESHOLDS = [
        [0, 100], [15, 100], [30, 85], [60, 50], [90, 25], [120, 0],
    ];
    const VADE_THRESHOLDS = [
        [0, 100], [30, 100], [60, 80], [90, 60], [120, 40], [180, 20], [240, 0],
    ];
    const BALANCE_TREND_THRESHOLDS = [
        [-0.1, 100], [0.0, 90], [0.1, 70], [0.3, 50], [0.5, 30], [1.0, 10],
    ];
    const CONSISTENCY_CV_THRESHOLDS = [
        [0.0, 100], [0.3, 100], [0.5, 80], [0.8, 60], [1.2, 40], [2.0, 20],
    ];
    const OUTSTANDING_RATIO_THRESHOLDS = [
        [0.0, 100], [0.05, 100], [0.10, 90], [0.20, 70], [0.35, 50], [0.50, 30], [1.0, 10],
    ];

    const GRADES = [
        [85, 'A', 'Excellent'],
        [70, 'B', 'Good'],
        [55, 'C', 'Fair'],
        [40, 'D', 'Below Average'],
        [0,  'F', 'Poor'],
    ];

    const RE_INVOICE = /Fatura\s+No\s+(SH\w+)/i;
    // Note: \s* (not \s+) after "No" — real data has "No935" without a space.
    const RE_CHECK = /^(.+?)\s+(\d{2}\/\d{2}\/\d{4})\s+(.+?)\s+No\s*(\d+)$/;
    const RE_CREDIT_CARD = /KK\s+Tek\s+Cekim\s+No\s+(\d+)/i;
    const RE_WIRE = /^Havale$/i;
    const RE_BALANCE_FORWARD = /Devir|رصيد اول المدة/i;
    const RE_FATURA_ANY = /Fatura\s+No\s+\S+/i;

    const SUMMARY_KEYWORDS = [
        'مجموع', 'الاجمالي', 'الرصيد',
        'Toplam', 'Genel Toplam', 'Bakiye',
    ];

    const VADE_BUCKETS = [
        [0, 30, '0-30'],
        [31, 60, '31-60'],
        [61, 90, '61-90'],
        [91, 120, '91-120'],
        [121, 150, '121-150'],
        [151, 999, '150+'],
    ];

    // --- Helpers ---
    const MS_PER_DAY = 86400000;

    function daysBetween(d1, d2) {
        if (!(d1 instanceof Date) || !(d2 instanceof Date)) return 0;
        return Math.round((d1.getTime() - d2.getTime()) / MS_PER_DAY);
    }

    function dateToStr(d) {
        if (!(d instanceof Date)) return d ? String(d) : null;
        const y = d.getUTCFullYear();
        const m = String(d.getUTCMonth() + 1).padStart(2, '0');
        const day = String(d.getUTCDate()).padStart(2, '0');
        return y + '-' + m + '-' + day;
    }

    function dateYM(d) {
        if (!(d instanceof Date)) return null;
        const y = d.getUTCFullYear();
        const m = String(d.getUTCMonth() + 1).padStart(2, '0');
        return y + '-' + m;
    }

    function correctSettlementDate(day, month, year) {
        // month is 1-indexed
        const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
        if (day > maxDay) {
            if (month === 12) return new Date(Date.UTC(year + 1, 0, 1));
            return new Date(Date.UTC(year, month, 1));
        }
        return new Date(Date.UTC(year, month - 1, day));
    }

    function parseCheckDate(s) {
        const parts = s.split('/');
        return correctSettlementDate(
            parseInt(parts[0], 10),
            parseInt(parts[1], 10),
            parseInt(parts[2], 10)
        );
    }

    function toFloat(v) {
        if (v === null || v === undefined) return 0;
        if (typeof v === 'number') return v;
        const n = parseFloat(v);
        return isNaN(n) ? 0 : n;
    }

    function toDate(v) {
        if (v instanceof Date) {
            // Normalize to UTC midnight so day math is clean.
            return new Date(Date.UTC(v.getUTCFullYear(), v.getUTCMonth(), v.getUTCDate()));
        }
        return null;
    }

    function cellValue(ws, row, col) {
        const addr = XLSX.utils.encode_cell({ r: row - 1, c: col - 1 });
        const cell = ws[addr];
        return cell ? cell.v : null;
    }

    function cellA1(ws, a1) {
        const cell = ws[a1];
        return cell ? cell.v : null;
    }

    function isSummaryRow(desc) {
        if (!desc) return false;
        const s = String(desc);
        for (const kw of SUMMARY_KEYWORDS) {
            if (s.indexOf(kw) !== -1) return true;
        }
        return false;
    }

    function mean(arr) {
        if (arr.length === 0) return 0;
        let s = 0;
        for (const x of arr) s += x;
        return s / arr.length;
    }

    function stdevSample(arr) {
        // Sample standard deviation (N-1 denominator), matches statistics.stdev.
        if (arr.length < 2) return 0;
        const m = mean(arr);
        let v = 0;
        for (const x of arr) v += (x - m) * (x - m);
        return Math.sqrt(v / (arr.length - 1));
    }

    // --- Classification (parser.classify_transaction) ---
    function classifyTransaction(description) {
        if (!description) return { type: 'unknown', details: {} };
        const desc = String(description).trim();

        if (RE_BALANCE_FORWARD.test(desc)) {
            return { type: 'balance_forward', details: {} };
        }

        let m = desc.match(RE_INVOICE);
        if (m) return { type: 'invoice', details: { invoice_number: m[1] } };

        m = desc.match(RE_CREDIT_CARD);
        if (m) return { type: 'credit_card', details: { receipt_number: m[1] } };

        m = desc.match(RE_WIRE);
        if (m) return { type: 'wire', details: {} };

        m = desc.match(RE_CHECK);
        if (m) {
            return {
                type: 'check',
                details: {
                    payee_name: m[1].trim(),
                    settlement_date: parseCheckDate(m[2]),
                    bank: m[3].trim(),
                    check_number: m[4],
                },
            };
        }

        return { type: 'unknown', details: {} };
    }

    // --- Parser (parser.parse_excel) ---
    function parseExcel(arrayBuffer) {
        const wb = XLSX.read(arrayBuffer, { type: 'array', cellDates: true });
        const ws = wb.Sheets[wb.SheetNames[0]];
        if (!ws) throw new Error('Workbook has no sheets');

        const customerName = String(cellA1(ws, 'B1') || 'Unknown');
        const periodStart = toDate(cellA1(ws, 'G1'));
        const periodEnd = toDate(cellA1(ws, 'I1'));

        const range = XLSX.utils.decode_range(ws['!ref'] || 'A1:A1');
        const maxRow = range.e.r + 1; // 1-indexed

        // Scan from bottom up: skip trailing fully-blank rows first, then
        // collect summary rows (identified by keywords in column C).
        let row = maxRow;
        while (row >= 3) {
            const a = toFloat(cellValue(ws, row, 1));
            const b = toFloat(cellValue(ws, row, 2));
            const c = cellValue(ws, row, 3);
            if (a === 0 && b === 0 && !c) row -= 1;
            else break;
        }

        const summaryRows = [];
        while (row >= 3) {
            const desc = cellValue(ws, row, 3);
            if (isSummaryRow(desc)) {
                summaryRows.push(row);
                row -= 1;
            } else {
                break;
            }
        }

        const dataEndRow = row;

        let totalDebit = 0;
        let totalCredit = 0;
        let endBalance = 0;
        const sortedSummary = summaryRows.slice().sort((a, b) => a - b);
        for (const sr of sortedSummary) {
            const a = toFloat(cellValue(ws, sr, 1));
            const b = toFloat(cellValue(ws, sr, 2));
            if (a > 0 && b > 0) {
                // Totals row — keep the largest (handles dup grand-total rows)
                if (a > totalDebit) {
                    totalDebit = a;
                    totalCredit = b;
                }
            } else {
                // Balance row — one column has the end balance
                endBalance = a !== 0 ? a : b;
            }
        }

        const transactions = [];
        for (let r = 3; r <= dataEndRow; r++) {
            const amountDebit = toFloat(cellValue(ws, r, 1));
            const amountCredit = toFloat(cellValue(ws, r, 2));
            const descriptionRaw = cellValue(ws, r, 3);
            const description = descriptionRaw == null ? '' : String(descriptionRaw);
            const notesRaw = cellValue(ws, r, 4);
            const notes = notesRaw == null ? '' : String(notesRaw);
            const paymentTermsRaw = cellValue(ws, r, 5);
            const paymentTerms = paymentTermsRaw == null ? '' : String(paymentTermsRaw);
            const txDate = toDate(cellValue(ws, r, 6));
            const invoiceNumberRaw = cellValue(ws, r, 7);
            const invoiceNumber = invoiceNumberRaw == null ? '' : String(invoiceNumberRaw);
            const runningBalance = toFloat(cellValue(ws, r, 8));

            if (amountDebit === 0 && amountCredit === 0) continue;

            let { type: txType, details: parsedDetails } = classifyTransaction(description);

            // A Fatura-like row with amount in the credit column is a credit
            // note / refund — treat it as a payment so FIFO can settle AR.
            if (amountDebit === 0 && amountCredit > 0 &&
                (txType === 'invoice' || RE_FATURA_ANY.test(description))) {
                txType = 'credit_note';
                parsedDetails = {};
            }

            transactions.push({
                row_index: r,
                amount_debit: amountDebit,
                amount_credit: amountCredit,
                description: description,
                notes: notes,
                payment_terms: paymentTerms,
                date: txDate,
                invoice_number: invoiceNumber,
                running_balance: runningBalance,
                tx_type: txType,
                parsed_details: parsedDetails,
            });
        }

        return {
            customer_name: customerName,
            period_start: periodStart,
            period_end: periodEnd,
            transactions: transactions,
            total_debit: totalDebit,
            total_credit: totalCredit,
            end_balance: endBalance,
        };
    }

    // --- Matcher (matcher.fifo_match) ---
    const DATE_MIN_KEY = -8640000000000000;
    function dateKey(d) { return d instanceof Date ? d.getTime() : DATE_MIN_KEY; }

    function fifoMatch(transactions, periodStart, periodEnd) {
        const invoices = [];
        const payments = [];

        for (const tx of transactions) {
            if (tx.tx_type === 'balance_forward') {
                if (tx.amount_debit > 0) {
                    invoices.push({
                        row: tx.row_index,
                        date: tx.date || periodStart,
                        invoice_number: 'DEVIR',
                        amount: tx.amount_debit,
                        remaining: tx.amount_debit,
                    });
                }
            } else if (tx.tx_type === 'invoice') {
                invoices.push({
                    row: tx.row_index,
                    date: tx.date,
                    invoice_number: tx.invoice_number || tx.parsed_details.invoice_number || '',
                    amount: tx.amount_debit,
                    remaining: tx.amount_debit,
                });
            } else if (
                tx.tx_type === 'check' || tx.tx_type === 'credit_card' ||
                tx.tx_type === 'wire' || tx.tx_type === 'credit_note'
            ) {
                payments.push({
                    row: tx.row_index,
                    date: tx.date,
                    description: tx.description,
                    amount: tx.amount_credit,
                    remaining: tx.amount_credit,
                    type: tx.tx_type,
                    settlement_date: tx.parsed_details.settlement_date || null,
                });
            }
        }

        const byDateRow = (a, b) => {
            const k = dateKey(a.date) - dateKey(b.date);
            if (k !== 0) return k;
            return a.row - b.row;
        };
        invoices.sort(byDateRow);
        payments.sort(byDateRow);

        const matchedPairs = [];
        let invIdx = 0, payIdx = 0;

        while (invIdx < invoices.length && payIdx < payments.length) {
            const inv = invoices[invIdx];
            const pay = payments[payIdx];

            if (inv.remaining <= 0) { invIdx++; continue; }
            if (pay.remaining <= 0) { payIdx++; continue; }

            const matchAmount = Math.min(inv.remaining, pay.remaining);
            inv.remaining -= matchAmount;
            pay.remaining -= matchAmount;

            const invDate = inv.date || periodStart;
            const payDate = pay.date || periodStart;
            const settlement = pay.settlement_date;

            const daysHandover = daysBetween(payDate, invDate);
            const vade = settlement ? daysBetween(settlement, invDate) : 0;

            matchedPairs.push({
                invoice_row: inv.row,
                invoice_date: invDate,
                invoice_number: inv.invoice_number,
                invoice_amount: inv.amount,
                payment_row: pay.row,
                payment_date: payDate,
                payment_description: pay.description,
                matched_amount: matchAmount,
                days_to_handover: Math.max(0, daysHandover),
                vade_length: Math.max(0, vade),
                settlement_date: settlement,
                payment_type: pay.type,
                is_partial: matchAmount < inv.amount,
            });

            if (inv.remaining <= 0.01) { inv.remaining = 0; invIdx++; }
            if (pay.remaining <= 0.01) { pay.remaining = 0; payIdx++; }
        }

        const unmatched = [];
        for (const inv of invoices) {
            if (inv.remaining > 0.01) {
                const invDate = inv.date || periodStart;
                const age = periodEnd ? daysBetween(periodEnd, invDate) : 0;
                unmatched.push({
                    row: inv.row,
                    date: invDate,
                    invoice_number: inv.invoice_number,
                    total_amount: inv.amount,
                    remaining_amount: Math.round(inv.remaining * 100) / 100,
                    age_days: Math.max(0, age),
                });
            }
        }

        return [matchedPairs, unmatched];
    }

    // --- Scorer (scorer.py) ---
    function interpolateScore(value, thresholds) {
        if (value <= thresholds[0][0]) return thresholds[0][1];
        const last = thresholds[thresholds.length - 1];
        if (value >= last[0]) return last[1];
        for (let i = 0; i < thresholds.length - 1; i++) {
            const [x0, y0] = thresholds[i];
            const [x1, y1] = thresholds[i + 1];
            if (x0 <= value && value <= x1) {
                const ratio = x1 !== x0 ? (value - x0) / (x1 - x0) : 0;
                return y0 + ratio * (y1 - y0);
            }
        }
        return last[1];
    }

    function scoreHandoverSpeed(matchedPairs) {
        const pairs = matchedPairs.filter(m => m.payment_type !== 'credit_note');
        if (pairs.length === 0) return [0, { avg_days: null, std_days: null, detail: 'No matched payments' }];
        const days = pairs.map(m => m.days_to_handover);
        const avg = mean(days);
        const std = days.length > 1 ? stdevSample(days) : 0;
        let score = interpolateScore(avg, HANDOVER_THRESHOLDS);
        if (std > 15) {
            const penalty = Math.min(10, (std - 15) / 15 * 10);
            score = Math.max(0, score - penalty);
        }
        return [Math.round(score), {
            avg_days: Math.round(avg * 10) / 10,
            std_days: Math.round(std * 10) / 10,
            min_days: Math.min.apply(null, days),
            max_days: Math.max.apply(null, days),
        }];
    }

    function scoreVadeLength(matchedPairs) {
        const vadeli = matchedPairs.filter(m => m.vade_length > 0);
        const nonVadeli = matchedPairs.filter(m => m.vade_length === 0);
        if (matchedPairs.length === 0) return [0, { avg_vade: null, detail: 'No matched payments' }];
        if (vadeli.length === 0) return [100, { avg_vade: 0, detail: 'All payments are immediate (KK/Pesin)' }];
        const totalAmount = matchedPairs.reduce((s, m) => s + m.matched_amount, 0);
        if (totalAmount === 0) return [50, { avg_vade: null, detail: 'Zero total amount' }];
        const weightedVade = vadeli.reduce((s, m) => s + m.vade_length * m.matched_amount, 0) / totalAmount;
        const score = interpolateScore(weightedVade, VADE_THRESHOLDS);
        const vadeDays = vadeli.map(m => m.vade_length);
        return [Math.round(score), {
            avg_vade: Math.round(weightedVade * 10) / 10,
            min_vade: Math.min.apply(null, vadeDays),
            max_vade: Math.max.apply(null, vadeDays),
            vadeli_count: vadeli.length,
            non_vadeli_count: nonVadeli.length,
        }];
    }

    function scoreBalanceTrend(statement) {
        const balances = [];
        for (const tx of statement.transactions) {
            if (tx.running_balance !== null && tx.running_balance !== undefined) {
                balances.push(tx.running_balance);
            }
        }
        if (balances.length < 2) return [50, { slope_ratio: null, detail: 'Insufficient data' }];
        const totalInvoiced = statement.total_debit;
        if (totalInvoiced === 0) return [50, { slope_ratio: null, detail: 'No invoices' }];
        const startBalance = balances[0];
        const endBalance = balances[balances.length - 1];
        const slopeRatio = (endBalance - startBalance) / totalInvoiced;
        const score = interpolateScore(slopeRatio, BALANCE_TREND_THRESHOLDS);
        return [Math.round(score), {
            slope_ratio: Math.round(slopeRatio * 1000) / 1000,
            start_balance: Math.round(startBalance * 100) / 100,
            end_balance: Math.round(endBalance * 100) / 100,
        }];
    }

    function scorePaymentConsistency(transactions) {
        const paymentDates = transactions
            .filter(tx => (tx.tx_type === 'check' || tx.tx_type === 'credit_card' || tx.tx_type === 'wire') && tx.date)
            .map(tx => tx.date)
            .sort((a, b) => a.getTime() - b.getTime());
        if (paymentDates.length < 3) return [50, { cv: null, detail: 'Fewer than 3 payments — insufficient data' }];
        const intervals = [];
        for (let i = 0; i < paymentDates.length - 1; i++) {
            intervals.push(daysBetween(paymentDates[i + 1], paymentDates[i]));
        }
        const avg = mean(intervals);
        if (avg === 0) return [50, { cv: null, detail: 'All payments on same date' }];
        const std = stdevSample(intervals);
        const cv = std / avg;
        const score = interpolateScore(cv, CONSISTENCY_CV_THRESHOLDS);
        return [Math.round(score), {
            cv: Math.round(cv * 100) / 100,
            avg_interval_days: Math.round(avg * 10) / 10,
            std_interval_days: Math.round(std * 10) / 10,
            payment_count: paymentDates.length,
        }];
    }

    function scoreOutstandingRatio(statement) {
        const totalInvoiced = statement.total_debit;
        if (totalInvoiced === 0) return [100, { ratio: 0, detail: 'No invoices' }];
        const endBalance = Math.max(0, statement.end_balance);
        const ratio = endBalance / totalInvoiced;
        const score = interpolateScore(ratio, OUTSTANDING_RATIO_THRESHOLDS);
        return [Math.round(score), {
            ratio: Math.round(ratio * 1000) / 1000,
            end_balance: Math.round(endBalance * 100) / 100,
            total_invoiced: Math.round(totalInvoiced * 100) / 100,
        }];
    }

    function getGrade(totalScore) {
        for (const [min, g, label] of GRADES) {
            if (totalScore >= min) return [g, label];
        }
        return ['F', 'Poor'];
    }

    function computeScore(statement, matchedPairs, unmatchedInvoices) {
        const components = {};

        let r = scoreHandoverSpeed(matchedPairs);
        components.handover_speed = { score: r[0], weight: WEIGHTS.handover_speed, details: r[1] };

        r = scoreVadeLength(matchedPairs);
        components.vade_length = { score: r[0], weight: WEIGHTS.vade_length, details: r[1] };

        r = scoreBalanceTrend(statement);
        components.balance_trend = { score: r[0], weight: WEIGHTS.balance_trend, details: r[1] };

        r = scorePaymentConsistency(statement.transactions);
        components.payment_consistency = { score: r[0], weight: WEIGHTS.payment_consistency, details: r[1] };

        r = scoreOutstandingRatio(statement);
        components.outstanding_ratio = { score: r[0], weight: WEIGHTS.outstanding_ratio, details: r[1] };

        const totalScore = Math.round(
            Object.values(components).reduce((s, c) => s + c.score * c.weight, 0)
        );
        const [grade, gradeLabel] = getGrade(totalScore);

        return {
            total_score: totalScore,
            grade: grade,
            grade_label: gradeLabel,
            components: components,
            unmatched_count: unmatchedInvoices.length,
            unmatched_amount: Math.round(unmatchedInvoices.reduce((s, u) => s + u.remaining_amount, 0) * 100) / 100,
        };
    }

    // --- Presentation builders (app.py) ---
    function buildChartData(statement, matchedPairs /*, unmatchedInvoices*/) {
        const timelineInvoices = [];
        const timelinePayments = [];
        for (const tx of statement.transactions) {
            if (tx.tx_type === 'invoice') {
                timelineInvoices.push({ x: dateToStr(tx.date), y: tx.amount_debit, label: tx.invoice_number });
            } else if (tx.tx_type === 'check' || tx.tx_type === 'credit_card' || tx.tx_type === 'wire') {
                timelinePayments.push({ x: dateToStr(tx.date), y: tx.amount_credit, label: (tx.description || '').slice(0, 40) });
            }
        }

        const balanceTrend = [];
        for (const tx of statement.transactions) {
            if (tx.date && tx.running_balance !== null && tx.running_balance !== undefined) {
                balanceTrend.push({ x: dateToStr(tx.date), y: Math.round(tx.running_balance * 100) / 100 });
            }
        }

        const vadeHist = {};
        for (const b of VADE_BUCKETS) vadeHist[b[2]] = 0;
        for (const m of matchedPairs) {
            if (m.vade_length > 0) {
                for (const [lo, hi, label] of VADE_BUCKETS) {
                    if (lo <= m.vade_length && m.vade_length <= hi) { vadeHist[label]++; break; }
                }
            }
        }

        const handoverHist = {};
        for (const b of VADE_BUCKETS) handoverHist[b[2]] = 0;
        for (const m of matchedPairs) {
            if (m.payment_type === 'credit_note') continue;
            for (const [lo, hi, label] of VADE_BUCKETS) {
                if (lo <= m.days_to_handover && m.days_to_handover <= hi) { handoverHist[label]++; break; }
            }
        }

        const monthly = {};
        for (const tx of statement.transactions) {
            if (!tx.date) continue;
            const mk = dateYM(tx.date);
            if (!monthly[mk]) monthly[mk] = { invoiced: 0, paid: 0 };
            if (tx.tx_type === 'invoice') monthly[mk].invoiced += tx.amount_debit;
            else if (tx.tx_type === 'check' || tx.tx_type === 'credit_card' || tx.tx_type === 'wire') monthly[mk].paid += tx.amount_credit;
        }
        const monthsSorted = Object.keys(monthly).sort();
        const monthlyData = {
            labels: monthsSorted,
            invoiced: monthsSorted.map(m => Math.round(monthly[m].invoiced * 100) / 100),
            paid: monthsSorted.map(m => Math.round(monthly[m].paid * 100) / 100),
        };

        return {
            timeline_invoices: timelineInvoices,
            timeline_payments: timelinePayments,
            balance_trend: balanceTrend,
            vade_histogram: { labels: Object.keys(vadeHist), values: Object.values(vadeHist) },
            handover_histogram: { labels: Object.keys(handoverHist), values: Object.values(handoverHist) },
            monthly: monthlyData,
        };
    }

    function buildSummary(statement, matchedPairs, unmatchedInvoices) {
        const vadeDays = matchedPairs.filter(m => m.vade_length > 0).map(m => m.vade_length);
        const handoverDays = matchedPairs.filter(m => m.payment_type !== 'credit_note').map(m => m.days_to_handover);
        const numInvoices = statement.transactions.filter(tx => tx.tx_type === 'invoice').length;
        const numPayments = statement.transactions.filter(tx => tx.tx_type === 'check' || tx.tx_type === 'credit_card' || tx.tx_type === 'wire').length;
        return {
            total_invoiced: Math.round(statement.total_debit * 100) / 100,
            total_paid: Math.round(statement.total_credit * 100) / 100,
            end_balance: Math.round(statement.end_balance * 100) / 100,
            num_invoices: numInvoices,
            num_payments: numPayments,
            avg_vade_days: vadeDays.length ? Math.round(mean(vadeDays) * 10) / 10 : null,
            max_vade_days: vadeDays.length ? Math.max.apply(null, vadeDays) : null,
            avg_handover_days: handoverDays.length ? Math.round(mean(handoverDays) * 10) / 10 : null,
            payment_coverage_pct: statement.total_debit ? Math.round(statement.total_credit / statement.total_debit * 1000) / 10 : 0,
            unmatched_invoices: unmatchedInvoices.length,
            unmatched_amount: Math.round(unmatchedInvoices.reduce((s, u) => s + u.remaining_amount, 0) * 100) / 100,
        };
    }

    function buildDetailTable(matchedPairs, unmatchedInvoices) {
        const unmatchedRows = new Set(unmatchedInvoices.map(u => u.row));
        const rows = [];
        for (const m of matchedPairs) {
            const status = unmatchedRows.has(m.invoice_row) ? 'Partial' : 'Paid';
            rows.push({
                invoice_number: m.invoice_number,
                invoice_date: dateToStr(m.invoice_date),
                invoice_amount: Math.round(m.invoice_amount * 100) / 100,
                matched_amount: Math.round(m.matched_amount * 100) / 100,
                payment_date: dateToStr(m.payment_date),
                payment_desc: (m.payment_description || '').slice(0, 50),
                payment_type: m.payment_type,
                handover_days: m.days_to_handover,
                vade_days: m.vade_length,
                settlement_date: dateToStr(m.settlement_date),
                status: status,
            });
        }
        for (const u of unmatchedInvoices) {
            rows.push({
                invoice_number: u.invoice_number,
                invoice_date: dateToStr(u.date),
                invoice_amount: Math.round(u.total_amount * 100) / 100,
                matched_amount: Math.round((u.total_amount - u.remaining_amount) * 100) / 100,
                payment_date: null,
                payment_desc: '',
                payment_type: '',
                handover_days: null,
                vade_days: null,
                settlement_date: null,
                status: 'Outstanding',
                age_days: u.age_days,
                remaining: Math.round(u.remaining_amount * 100) / 100,
            });
        }
        return rows;
    }

    // --- Entry point ---
    async function analyzeFile(file) {
        if (typeof XLSX === 'undefined') {
            throw new Error('SheetJS (XLSX) not loaded');
        }
        const buffer = await file.arrayBuffer();
        const statement = parseExcel(buffer);
        const [matched, unmatched] = fifoMatch(statement.transactions, statement.period_start, statement.period_end);
        const score = computeScore(statement, matched, unmatched);
        return {
            customer: statement.customer_name,
            period: {
                start: dateToStr(statement.period_start),
                end: dateToStr(statement.period_end),
            },
            score: score,
            charts: buildChartData(statement, matched, unmatched),
            summary: buildSummary(statement, matched, unmatched),
            details: buildDetailTable(matched, unmatched),
        };
    }

    window.VadePipeline = { analyzeFile: analyzeFile };
})();
