import re

# --- Scoring Weights ---
WEIGHTS = {
    "handover_speed": 0.30,
    "vade_length": 0.25,
    "balance_trend": 0.20,
    "payment_consistency": 0.15,
    "outstanding_ratio": 0.10,
}

# --- Scoring Thresholds ---
# Each list: [(threshold, score), ...] — linear interpolation between points
HANDOVER_THRESHOLDS = [
    (0, 100), (15, 100), (30, 85), (60, 50), (90, 25), (120, 0),
]

VADE_THRESHOLDS = [
    (0, 100), (30, 100), (60, 80), (90, 60), (120, 40), (180, 20), (240, 0),
]

BALANCE_TREND_THRESHOLDS = [
    (-0.1, 100), (0.0, 90), (0.1, 70), (0.3, 50), (0.5, 30), (1.0, 10),
]

CONSISTENCY_CV_THRESHOLDS = [
    (0.0, 100), (0.3, 100), (0.5, 80), (0.8, 60), (1.2, 40), (2.0, 20),
]

OUTSTANDING_RATIO_THRESHOLDS = [
    (0.0, 100), (0.05, 100), (0.10, 90), (0.20, 70), (0.35, 50), (0.50, 30), (1.0, 10),
]

# --- Grade Mapping ---
GRADES = [
    (85, "A", "Excellent"),
    (70, "B", "Good"),
    (55, "C", "Fair"),
    (40, "D", "Below Average"),
    (0,  "F", "Poor"),
]

# --- Regex Patterns for Description Parsing ---
RE_INVOICE = re.compile(r'Fatura\s+No\s+(SH\w+)', re.IGNORECASE)
RE_CHECK = re.compile(r'^(.+?)\s+(\d{2}/\d{2}/\d{4})\s+(.+?)\s+No\s*(\d+)$')
RE_CREDIT_CARD = re.compile(r'KK\s+Tek\s+Cekim\s+No\s+(\d+)', re.IGNORECASE)
RE_WIRE = re.compile(r'^Havale$', re.IGNORECASE)
RE_BALANCE_FORWARD = re.compile(r'Devir|رصيد اول المدة', re.IGNORECASE)

# Keywords that identify summary/total rows at the bottom of the sheet
SUMMARY_KEYWORDS = [
    'مجموع',        # "total" (Arabic)
    'الاجمالي',      # "grand total" (Arabic)
    'الرصيد',        # "balance" (Arabic)
    'Toplam',       # "total" (Turkish)
    'Genel Toplam', # "grand total" (Turkish)
    'Bakiye',       # "balance" (Turkish)
]

# --- Vade Histogram Buckets ---
VADE_BUCKETS = [
    (0, 30, "0-30"),
    (31, 60, "31-60"),
    (61, 90, "61-90"),
    (91, 120, "91-120"),
    (121, 150, "121-150"),
    (151, 999, "150+"),
]
