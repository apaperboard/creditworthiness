// --- DOM refs ---
const fileInput = document.getElementById('file-input');
const dropZone = document.getElementById('drop-zone');
const dropZoneText = document.getElementById('drop-zone-text');
const analyzeBtn = document.getElementById('analyze-btn');
const uploadForm = document.getElementById('upload-form');
const uploadSection = document.getElementById('upload-section');
const portfolioSection = document.getElementById('portfolio-section');
const dashboard = document.getElementById('dashboard');
const errorMsg = document.getElementById('error-msg');
const batchProgress = document.getElementById('batch-progress');
const progressFill = document.getElementById('progress-fill');
const progressLabel = document.getElementById('progress-label');
const fileListEl = document.getElementById('file-list');
const portfolioBody = document.getElementById('portfolio-body');
const portfolioMeta = document.getElementById('portfolio-meta');
const portfolioTable = document.getElementById('portfolio-table');
const backToPortfolioBtn = document.getElementById('back-to-portfolio-btn');
const newAnalysisBtn = document.getElementById('new-analysis-btn');
const portfolioNewBtn = document.getElementById('portfolio-new-btn');

// --- State ---
let selectedFiles = [];
let portfolioResults = [];
let portfolioSort = { key: 'score', dir: 'desc' };
let currentView = 'upload';
let drillSourceView = 'upload';
let batchInFlight = false;
let charts = [];

const DROP_ZONE_DEFAULT_TEXT = 'Drop one or more Excel balance statements here or click to select';

// --- Helpers ---
function showView(name) {
    currentView = name;
    uploadSection.classList.toggle('hidden', name !== 'upload');
    portfolioSection.classList.toggle('hidden', name !== 'portfolio');
    dashboard.classList.toggle('hidden', name !== 'single');
}

function resetCharts() {
    charts.forEach(c => c.destroy());
    charts = [];
}

async function postAnalyze(file) {
    const formData = new FormData();
    formData.append('file', file);
    const res = await fetch('/analyze', { method: 'POST', body: formData });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    return data;
}

// --- File selection ---
dropZone.addEventListener('click', () => fileInput.click());
dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length) {
        addFiles(e.dataTransfer.files);
    }
});
fileInput.addEventListener('change', () => {
    if (fileInput.files.length) {
        addFiles(fileInput.files);
    }
});

function addFiles(fileList) {
    const existingNames = new Set(selectedFiles.map(f => f.name));
    for (const f of fileList) {
        if (!f.name.match(/\.(xlsx|xls)$/i)) continue;
        if (existingNames.has(f.name)) continue;
        selectedFiles.push(f);
        existingNames.add(f.name);
    }
    renderFileList();
    analyzeBtn.disabled = selectedFiles.length === 0;
    errorMsg.classList.add('hidden');
    if (selectedFiles.length > 0) {
        dropZoneText.textContent = selectedFiles.length === 1
            ? selectedFiles[0].name
            : `${selectedFiles.length} files selected`;
    } else {
        dropZoneText.textContent = DROP_ZONE_DEFAULT_TEXT;
    }
}

function renderFileList() {
    if (selectedFiles.length === 0) {
        fileListEl.classList.add('hidden');
        fileListEl.innerHTML = '';
        return;
    }
    fileListEl.classList.remove('hidden');
    fileListEl.innerHTML = selectedFiles.map((f, i) => `
        <li class="file-chip pending" data-idx="${i}">
            <span class="chip-name" title="${escapeHtml(f.name)}">${escapeHtml(f.name)}</span>
            <span class="chip-status"></span>
            <span class="chip-remove" data-remove="${i}">&times;</span>
        </li>
    `).join('');
}

fileListEl.addEventListener('click', e => {
    if (batchInFlight) return;
    const removeBtn = e.target.closest('[data-remove]');
    if (!removeBtn) return;
    const idx = parseInt(removeBtn.dataset.remove, 10);
    selectedFiles.splice(idx, 1);
    renderFileList();
    analyzeBtn.disabled = selectedFiles.length === 0;
    if (selectedFiles.length === 0) {
        dropZoneText.textContent = DROP_ZONE_DEFAULT_TEXT;
        fileInput.value = '';
    } else {
        dropZoneText.textContent = selectedFiles.length === 1
            ? selectedFiles[0].name
            : `${selectedFiles.length} files selected`;
    }
});

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
}

// --- Submit ---
uploadForm.addEventListener('submit', async e => {
    e.preventDefault();
    if (selectedFiles.length === 0 || batchInFlight) return;

    errorMsg.classList.add('hidden');
    analyzeBtn.disabled = true;

    if (selectedFiles.length === 1) {
        await runSingle(selectedFiles[0]);
    } else {
        await runBatch(selectedFiles);
    }
});

async function runSingle(file) {
    batchInFlight = true;
    batchProgress.classList.remove('hidden');
    progressFill.style.width = '100%';
    progressLabel.textContent = 'Analyzing...';
    try {
        const data = await postAnalyze(file);
        drillSourceView = 'upload';
        backToPortfolioBtn.classList.add('hidden');
        renderDashboard(data);
        showView('single');
    } catch (err) {
        showError('Failed to analyze file: ' + err.message);
    } finally {
        batchProgress.classList.add('hidden');
        progressFill.style.width = '0%';
        batchInFlight = false;
        analyzeBtn.disabled = selectedFiles.length === 0;
    }
}

async function runBatch(files) {
    batchInFlight = true;
    batchProgress.classList.remove('hidden');
    progressFill.style.width = '0%';

    portfolioResults = files.map((f, i) => ({
        index: i,
        fileName: f.name,
        status: 'pending',
        data: null,
        error: null,
    }));

    let cursor = 0;
    let completed = 0;
    const total = files.length;

    const updateProgress = () => {
        progressFill.style.width = `${Math.round((completed / total) * 100)}%`;
        progressLabel.textContent = `Analyzing ${completed} / ${total}...`;
    };
    updateProgress();

    const setChipStatus = (i, status) => {
        const chip = fileListEl.querySelector(`[data-idx="${i}"]`);
        if (chip) {
            chip.classList.remove('pending', 'in-flight', 'success', 'error');
            chip.classList.add(status);
            const statusEl = chip.querySelector('.chip-status');
            if (statusEl) {
                statusEl.textContent = status === 'in-flight' ? '…'
                    : status === 'success' ? '\u2713'
                    : status === 'error' ? '\u2717' : '';
            }
        }
    };

    async function worker() {
        while (cursor < total) {
            const i = cursor++;
            portfolioResults[i].status = 'in-flight';
            setChipStatus(i, 'in-flight');
            try {
                const data = await postAnalyze(files[i]);
                portfolioResults[i] = buildSuccessRecord(i, files[i].name, data);
                setChipStatus(i, 'success');
            } catch (err) {
                portfolioResults[i] = buildErrorRecord(i, files[i].name, err.message);
                setChipStatus(i, 'error');
            }
            completed++;
            updateProgress();
        }
    }

    await Promise.all([worker(), worker(), worker()]);

    batchProgress.classList.add('hidden');
    progressFill.style.width = '0%';
    batchInFlight = false;

    renderPortfolio();
    showView('portfolio');
}

function buildSuccessRecord(index, fileName, data) {
    return {
        index,
        fileName,
        status: 'success',
        data,
        error: null,
        _customer: data.customer || '(unknown)',
        _score: data.score.total_score,
        _grade: data.score.grade,
        _outstanding: data.summary.unmatched_amount,
        _avgVade: data.summary.avg_vade_days,
        _avgHandover: data.summary.avg_handover_days,
        _coverage: data.summary.payment_coverage_pct,
        _periodStart: data.period.start,
        _periodEnd: data.period.end,
        _unmatchedCount: data.summary.unmatched_invoices,
    };
}

function buildErrorRecord(index, fileName, errorMessage) {
    return {
        index,
        fileName,
        status: 'error',
        data: null,
        error: errorMessage,
        _customer: fileName,
        _score: null,
        _grade: null,
        _outstanding: null,
        _avgVade: null,
        _avgHandover: null,
        _coverage: null,
        _periodStart: null,
        _periodEnd: null,
    };
}

function showError(msg) {
    errorMsg.textContent = msg;
    errorMsg.classList.remove('hidden');
    analyzeBtn.disabled = selectedFiles.length === 0;
}

// --- Portfolio rendering ---
const GRADE_ORDER = { A: 5, B: 4, C: 3, D: 2, F: 1 };

function sortPortfolioResults() {
    const key = portfolioSort.key;
    const dir = portfolioSort.dir === 'asc' ? 1 : -1;
    const sorted = [...portfolioResults];
    sorted.sort((a, b) => {
        // Error rows always sink to the bottom regardless of direction
        if (a.status === 'error' && b.status !== 'error') return 1;
        if (b.status === 'error' && a.status !== 'error') return -1;
        if (a.status === 'error' && b.status === 'error') return 0;

        let av, bv;
        switch (key) {
            case 'customer':
                av = (a._customer || '').toLowerCase();
                bv = (b._customer || '').toLowerCase();
                return av < bv ? -1 * dir : av > bv ? 1 * dir : 0;
            case 'period':
                av = a._periodStart || '';
                bv = b._periodStart || '';
                return av < bv ? -1 * dir : av > bv ? 1 * dir : 0;
            case 'grade':
                av = GRADE_ORDER[a._grade] || 0;
                bv = GRADE_ORDER[b._grade] || 0;
                return (av - bv) * dir;
            case 'status':
                return 0; // errors already handled above
            case 'score':
            case 'outstanding':
            case 'avg_vade':
            case 'avg_handover':
            case 'coverage':
                const keyMap = {
                    score: '_score',
                    outstanding: '_outstanding',
                    avg_vade: '_avgVade',
                    avg_handover: '_avgHandover',
                    coverage: '_coverage',
                };
                av = a[keyMap[key]];
                bv = b[keyMap[key]];
                if (av == null && bv == null) return 0;
                if (av == null) return 1;   // nulls always last
                if (bv == null) return -1;
                return (av - bv) * dir;
            default:
                return 0;
        }
    });
    return sorted;
}

function renderPortfolio() {
    const sorted = sortPortfolioResults();
    const successCount = portfolioResults.filter(r => r.status === 'success').length;
    const errorCount = portfolioResults.filter(r => r.status === 'error').length;
    const total = portfolioResults.length;
    portfolioMeta.textContent = errorCount > 0
        ? `${successCount} of ${total} analyzed, ${errorCount} error${errorCount > 1 ? 's' : ''}`
        : `${successCount} of ${total} analyzed`;

    portfolioBody.innerHTML = sorted.map(r => {
        if (r.status === 'error') {
            return `<tr class="error-row" data-index="${r.index}" title="${escapeHtml(r.error || '')}">
                <td class="customer-cell" title="${escapeHtml(r.fileName)}">${escapeHtml(r.fileName)}</td>
                <td>—</td>
                <td class="numeric">—</td>
                <td>—</td>
                <td class="numeric">—</td>
                <td class="numeric">—</td>
                <td class="numeric">—</td>
                <td class="numeric">—</td>
                <td><span class="status-pill err" title="${escapeHtml(r.error || '')}">Error</span></td>
            </tr>`;
        }
        const periodStr = fmtDate(r._periodStart) + ' – ' + fmtDate(r._periodEnd);
        const color = scoreColor(r._score);
        const outstandingStr = fmt(r._outstanding) + (r._unmatchedCount ? ` (${r._unmatchedCount})` : '');
        return `<tr data-clickable="true" data-index="${r.index}">
            <td class="customer-cell" title="${escapeHtml(r._customer)}">${escapeHtml(r._customer)}</td>
            <td>${periodStr}</td>
            <td class="numeric" style="color:${color};font-weight:700">${r._score}</td>
            <td><span class="grade-badge grade-${r._grade}">${r._grade}</span></td>
            <td class="numeric">${outstandingStr}</td>
            <td class="numeric">${r._avgVade != null ? r._avgVade + ' d' : '—'}</td>
            <td class="numeric">${r._avgHandover != null ? r._avgHandover + ' d' : '—'}</td>
            <td class="numeric">${r._coverage != null ? r._coverage + '%' : '—'}</td>
            <td><span class="status-pill ok">OK</span></td>
        </tr>`;
    }).join('');

    // Update sort indicator
    portfolioTable.querySelectorAll('th').forEach(th => {
        th.classList.remove('sort-asc', 'sort-desc');
        if (th.dataset.sort === portfolioSort.key) {
            th.classList.add(portfolioSort.dir === 'asc' ? 'sort-asc' : 'sort-desc');
        }
    });
}

// Sort handler
portfolioTable.querySelector('thead').addEventListener('click', e => {
    const th = e.target.closest('th[data-sort]');
    if (!th) return;
    const key = th.dataset.sort;
    if (portfolioSort.key === key) {
        portfolioSort.dir = portfolioSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
        portfolioSort.key = key;
        // Numeric columns default to desc, text columns default to asc
        const numericKeys = ['score', 'outstanding', 'avg_vade', 'avg_handover', 'coverage', 'grade'];
        portfolioSort.dir = numericKeys.includes(key) ? 'desc' : 'asc';
    }
    renderPortfolio();
});

// Drill-down: click a row
portfolioBody.addEventListener('click', e => {
    const row = e.target.closest('tr[data-clickable="true"]');
    if (!row) return;
    const idx = parseInt(row.dataset.index, 10);
    const record = portfolioResults.find(r => r.index === idx);
    if (!record || record.status !== 'success') return;
    drillSourceView = 'portfolio';
    backToPortfolioBtn.classList.remove('hidden');
    renderDashboard(record.data);
    showView('single');
    window.scrollTo({ top: 0, behavior: 'smooth' });
});

// --- Navigation buttons ---
backToPortfolioBtn.addEventListener('click', () => {
    resetCharts();
    showView('portfolio');
    window.scrollTo({ top: 0, behavior: 'smooth' });
});

newAnalysisBtn.addEventListener('click', () => {
    resetCharts();
    if (drillSourceView === 'portfolio') {
        // Full reset: clear portfolio too
        portfolioResults = [];
    }
    resetUploadState();
    showView('upload');
});

portfolioNewBtn.addEventListener('click', () => {
    portfolioResults = [];
    resetUploadState();
    showView('upload');
});

function resetUploadState() {
    selectedFiles = [];
    fileInput.value = '';
    dropZoneText.textContent = DROP_ZONE_DEFAULT_TEXT;
    analyzeBtn.disabled = true;
    errorMsg.classList.add('hidden');
    renderFileList();
    backToPortfolioBtn.classList.add('hidden');
}

// Formatting
function fmt(n) {
    if (n == null) return '-';
    return new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n);
}

function fmtDate(d) {
    if (!d) return '-';
    const dt = new Date(d);
    return dt.toLocaleDateString('tr-TR');
}

function scoreColor(score) {
    if (score >= 85) return '#6ee7b7';
    if (score >= 70) return '#60a5fa';
    if (score >= 55) return '#fbbf24';
    if (score >= 40) return '#fb923c';
    return '#f87171';
}

// Render
function renderDashboard(data) {
    document.getElementById('customer-name').textContent = data.customer;
    document.getElementById('period-range').textContent =
        fmtDate(data.period.start) + ' — ' + fmtDate(data.period.end);

    const totalScore = data.score.total_score;
    const scoreValue = document.getElementById('score-value');
    scoreValue.textContent = totalScore;
    scoreValue.style.color = scoreColor(totalScore);

    const badge = document.getElementById('grade-badge');
    badge.textContent = data.score.grade + ' - ' + data.score.grade_label;
    badge.className = 'grade-badge grade-' + data.score.grade;

    renderComponents(data.score.components);
    renderCharts(data.charts);
    renderMetrics(data.summary);
    renderDetailTable(data.details);
}

const COMPONENT_LABELS = {
    handover_speed: 'Handover Speed',
    vade_length: 'Vade Length',
    balance_trend: 'Balance Trend',
    payment_consistency: 'Payment Consistency',
    outstanding_ratio: 'Outstanding Ratio',
};

function renderComponents(components) {
    const container = document.getElementById('score-components');
    container.innerHTML = '';

    for (const [key, comp] of Object.entries(components)) {
        const color = scoreColor(comp.score);
        const details = comp.details;
        let detailText = '';

        if (key === 'handover_speed' && details.avg_days != null)
            detailText = `Avg: ${details.avg_days} days (${details.min_days}-${details.max_days})`;
        else if (key === 'vade_length' && details.avg_vade != null)
            detailText = `Avg: ${details.avg_vade} days, ${details.vadeli_count} vadeli`;
        else if (key === 'balance_trend' && details.slope_ratio != null)
            detailText = `Trend: ${details.slope_ratio > 0 ? '+' : ''}${(details.slope_ratio * 100).toFixed(1)}%`;
        else if (key === 'payment_consistency' && details.cv != null)
            detailText = `CV: ${details.cv}, avg interval: ${details.avg_interval_days} days`;
        else if (key === 'outstanding_ratio' && details.ratio != null)
            detailText = `${(details.ratio * 100).toFixed(1)}% outstanding`;
        else if (details.detail)
            detailText = details.detail;

        container.innerHTML += `
            <div class="component">
                <div class="component-header">
                    <span class="component-name">${COMPONENT_LABELS[key] || key}</span>
                    <span class="component-score" style="color:${color}">${comp.score}</span>
                </div>
                <div class="component-bar">
                    <div class="component-fill" style="width:${comp.score}%;background:${color}"></div>
                </div>
                <div class="component-detail">${detailText}</div>
            </div>`;
    }
}

function renderCharts(chartData) {
    charts.forEach(c => c.destroy());
    charts = [];

    const defaultOpts = {
        responsive: true,
        maintainAspectRatio: false,   // container div controls height cross-browser
        plugins: { legend: { labels: { color: '#94a3b8' } } },
        scales: {
            x: { ticks: { color: '#64748b' }, grid: { color: '#1e293b' } },
            y: { ticks: { color: '#64748b' }, grid: { color: '#1e293b' } },
        },
    };

    // Helper: format a timestamp (ms) or ISO string as short locale date
    const fmtTs = v => new Date(v).toLocaleDateString('tr-TR', { day: '2-digit', month: 'short', year: '2-digit' });

    // Timeline — use numeric timestamps on x so no date adapter is needed
    charts.push(new Chart(document.getElementById('chart-timeline'), {
        type: 'scatter',
        data: {
            datasets: [
                {
                    label: 'Invoices',
                    data: chartData.timeline_invoices.map(d => ({ x: new Date(d.x).getTime(), y: d.y, label: d.label })),
                    backgroundColor: '#f87171',
                    pointRadius: 6,
                },
                {
                    label: 'Payments',
                    data: chartData.timeline_payments.map(d => ({ x: new Date(d.x).getTime(), y: d.y, label: d.label })),
                    backgroundColor: '#6ee7b7',
                    pointRadius: 6,
                    pointStyle: 'triangle',
                },
            ],
        },
        options: {
            ...defaultOpts,
            scales: {
                x: {
                    type: 'linear',
                    ticks: { color: '#64748b', callback: fmtTs, maxTicksLimit: 8 },
                    grid: { color: '#1e293b' },
                },
                y: { ticks: { color: '#64748b', callback: v => fmt(v) }, grid: { color: '#1e293b' } },
            },
            plugins: {
                ...defaultOpts.plugins,
                tooltip: {
                    callbacks: {
                        title: ctx => fmtTs(ctx[0].parsed.x),
                        label: ctx => (ctx.dataset.data[ctx.dataIndex].label || '') + ': ' + fmt(ctx.parsed.y) + ' TL',
                    },
                },
            },
        },
    }));

    // Balance Trend — category scale, labels are already ISO strings
    charts.push(new Chart(document.getElementById('chart-balance'), {
        type: 'line',
        data: {
            labels: chartData.balance_trend.map(d => fmtDate(d.x)),
            datasets: [{
                label: 'Balance (TL)',
                data: chartData.balance_trend.map(d => d.y),
                borderColor: '#3b82f6',
                backgroundColor: 'rgba(59,130,246,0.1)',
                fill: true,
                tension: 0.3,
                pointRadius: 3,
            }],
        },
        options: {
            ...defaultOpts,
            scales: {
                x: { ticks: { color: '#64748b', maxTicksLimit: 8 }, grid: { color: '#1e293b' } },
                y: { ticks: { color: '#64748b', callback: v => fmt(v) }, grid: { color: '#1e293b' } },
            },
        },
    }));

    // Vade Histogram
    charts.push(new Chart(document.getElementById('chart-vade'), {
        type: 'bar',
        data: {
            labels: chartData.vade_histogram.labels,
            datasets: [{
                label: 'Count',
                data: chartData.vade_histogram.values,
                backgroundColor: chartData.vade_histogram.labels.map((_, i) => {
                    const colors = ['#6ee7b7', '#60a5fa', '#fbbf24', '#fb923c', '#f87171', '#ef4444'];
                    return colors[i] || '#ef4444';
                }),
            }],
        },
        options: { ...defaultOpts, plugins: { ...defaultOpts.plugins, legend: { display: false } } },
    }));

    // Handover Histogram
    charts.push(new Chart(document.getElementById('chart-handover'), {
        type: 'bar',
        data: {
            labels: chartData.handover_histogram.labels,
            datasets: [{
                label: 'Count',
                data: chartData.handover_histogram.values,
                backgroundColor: chartData.handover_histogram.labels.map((_, i) => {
                    const colors = ['#6ee7b7', '#60a5fa', '#fbbf24', '#fb923c', '#f87171', '#ef4444'];
                    return colors[i] || '#ef4444';
                }),
            }],
        },
        options: { ...defaultOpts, plugins: { ...defaultOpts.plugins, legend: { display: false } } },
    }));

    // Monthly Comparison
    charts.push(new Chart(document.getElementById('chart-monthly'), {
        type: 'bar',
        data: {
            labels: chartData.monthly.labels,
            datasets: [
                { label: 'Invoiced', data: chartData.monthly.invoiced, backgroundColor: '#f87171' },
                { label: 'Paid', data: chartData.monthly.paid, backgroundColor: '#6ee7b7' },
            ],
        },
        options: {
            ...defaultOpts,
            scales: {
                x: { ticks: { color: '#64748b' }, grid: { color: '#1e293b' } },
                y: { ticks: { color: '#64748b', callback: v => fmt(v) }, grid: { color: '#1e293b' } },
            },
        },
    }));
}

function renderMetrics(summary) {
    const grid = document.getElementById('metrics-grid');
    const items = [
        ['Total Invoiced', fmt(summary.total_invoiced) + ' TL'],
        ['Total Paid', fmt(summary.total_paid) + ' TL'],
        ['End Balance', fmt(summary.end_balance) + ' TL'],
        ['Invoices', summary.num_invoices],
        ['Payments', summary.num_payments],
        ['Avg Vade', summary.avg_vade_days != null ? summary.avg_vade_days + ' days' : '-'],
        ['Max Vade', summary.max_vade_days != null ? summary.max_vade_days + ' days' : '-'],
        ['Avg Handover', summary.avg_handover_days != null ? summary.avg_handover_days + ' days' : '-'],
        ['Coverage', summary.payment_coverage_pct + '%'],
        ['Outstanding', fmt(summary.unmatched_amount) + ' TL (' + summary.unmatched_invoices + ' inv)'],
    ];

    grid.innerHTML = items.map(([label, value]) => `
        <div class="metric">
            <div class="metric-value">${value}</div>
            <div class="metric-label">${label}</div>
        </div>
    `).join('');
}

function renderDetailTable(details) {
    const tbody = document.getElementById('detail-body');
    tbody.innerHTML = details.map(row => {
        const statusClass = row.status === 'Paid' ? 'status-paid' :
                           row.status === 'Partial' ? 'status-partial' : 'status-outstanding';
        return `<tr>
            <td>${row.invoice_number || '-'}</td>
            <td>${fmtDate(row.invoice_date)}</td>
            <td>${fmt(row.invoice_amount)}</td>
            <td>${fmt(row.matched_amount)}</td>
            <td>${fmtDate(row.payment_date)}</td>
            <td>${row.payment_desc || '-'}</td>
            <td>${row.payment_type || '-'}</td>
            <td>${row.handover_days != null ? row.handover_days : '-'}</td>
            <td>${row.vade_days != null ? row.vade_days : '-'}</td>
            <td>${fmtDate(row.settlement_date)}</td>
            <td class="${statusClass}">${row.status}${row.remaining ? ' (' + fmt(row.remaining) + ')' : ''}</td>
        </tr>`;
    }).join('');
}
