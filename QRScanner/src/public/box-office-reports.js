// box-office-reports.js -- the Box Office Reports page: pick a date or range,
// get a .zip of that range's RTS (CSV) and FRG (XML) files, one of each per
// day, named exactly like the nightly feed's. Backed by
// /api/box-office-reports (see "BOX OFFICE REPORTS" in app.mjs).
(function() {
    'use strict';

    const API_URL = window.INDIETIX_API_URL;
    const form = document.getElementById('bor-form');
    const fromInput = document.getElementById('bor-from');
    const toInput = document.getElementById('bor-to');
    const submitBtn = document.getElementById('bor-submit');
    const result = document.getElementById('bor-result');
    let lastDownload = null;

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str == null ? '' : String(str);
        return div.innerHTML;
    }

    // Report dates are the venue's (Chicago) calendar days, not the browser's.
    function chicagoToday() {
        const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Chicago', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
        const get = (type) => Number(parts.find(p => p.type === type).value);
        return new Date(Date.UTC(get('year'), get('month') - 1, get('day')));
    }

    function addDays(date, n) {
        const copy = new Date(date);
        copy.setUTCDate(copy.getUTCDate() + n);
        return copy;
    }

    const iso = (date) => date.toISOString().slice(0, 10);

    function quickRange(name) {
        const today = chicagoToday();
        if (name === 'yesterday') return [addDays(today, -1), addDays(today, -1)];
        if (name === 'week') return [addDays(today, -7), addDays(today, -1)];
        if (name === 'month') {
            const first = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - 1, 1));
            const last = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
            return [first, last];
        }
        // The most recent Friday-Sunday that has finished.
        const day = today.getUTCDay(); // 0 = Sunday
        const sunday = addDays(today, day === 0 ? -7 : -day);
        return [addDays(sunday, -2), sunday];
    }

    function formatDate(value) {
        const [y, m, d] = value.split('-').map(Number);
        return new Date(y, m - 1, d).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    }

    const money = (n) => Number(n).toLocaleString(undefined, { style: 'currency', currency: 'USD' });

    function saveZip(download) {
        const bytes = Uint8Array.from(atob(download.zip), c => c.charCodeAt(0));
        const url = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = download.fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
    }

    function renderSummary(data) {
        const totals = data.days.reduce((t, d) => ({ tickets: t.tickets + d.tickets, gross: t.gross + d.gross }), { tickets: 0, gross: 0 });
        const fileCount = data.days.length * (data.eborTheatreNo ? 2 : 1);
        const rows = data.days.map(d => `
            <tr class="${d.rows ? '' : 'bor-no-shows'}">
                <td>${escapeHtml(formatDate(d.date))}</td>
                <td class="num">${d.rows ? d.showtimes : 'No shows'}</td>
                <td class="num">${d.tickets}</td>
                <td class="num">${money(d.gross)}</td>
                <td class="bor-files bor-files-col">${escapeHtml(d.rtsFile)}${d.frgFile ? '<br>' + escapeHtml(d.frgFile) : ''}</td>
            </tr>`).join('');
        result.innerHTML = `
            <div class="bor-summary">
                <p><strong>${escapeHtml(data.fileName)}</strong> (${fileCount} file${fileCount === 1 ? '' : 's'}) was downloaded.
                   <button type="button" class="btn btn-sm btn-outline-secondary ms-2" id="bor-again">Download again</button></p>
                ${data.eborTheatreNo ? '' : '<p class="text-muted small">No FRG files: this venue has no EBOR theatre number in Client Settings.</p>'}
                <div class="bor-table-wrap">
                    <table class="table table-sm bor-table">
                        <thead><tr><th>Date</th><th class="num">Showtimes</th><th class="num">Tickets</th><th class="num">Gross</th><th class="bor-files-col">Files</th></tr></thead>
                        <tbody>${rows}</tbody>
                        <tfoot><tr><th>Total</th><th></th><th class="num">${totals.tickets}</th><th class="num">${money(totals.gross)}</th><th class="bor-files-col"></th></tr></tfoot>
                    </table>
                </div>
            </div>`;
        document.getElementById('bor-again').addEventListener('click', () => saveZip(lastDownload));
    }

    async function download() {
        const from = fromInput.value;
        const to = toInput.value || from;
        if (!from) {
            UIDialogs.fieldError(fromInput, 'Pick a start date.');
            return;
        }
        if (to < from) {
            UIDialogs.fieldError(toInput, 'The end date is before the start date.');
            return;
        }
        submitBtn.disabled = true;
        submitBtn.textContent = 'Building…';
        try {
            const response = await fetch(`${API_URL}/api/box-office-reports?${new URLSearchParams({ from, to })}`, { headers: window.getAuthHeaders() });
            const data = await UIDialogs.readJson(response);
            if (!response.ok || !data || !data.success) {
                UIDialogs.showMessage({ type: 'error', title: 'Couldn’t build the reports', message: (data && data.message) || `The server answered ${response.status}.` });
                return;
            }
            lastDownload = data;
            saveZip(data);
            renderSummary(data);
        } catch (error) {
            UIDialogs.showMessage({ type: 'error', title: 'Couldn’t build the reports', message: error.message });
        } finally {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Download';
        }
    }

    function setRange([from, to]) {
        fromInput.value = iso(from);
        toInput.value = iso(to);
    }

    document.querySelectorAll('[data-quick]').forEach(btn => {
        btn.addEventListener('click', () => setRange(quickRange(btn.dataset.quick)));
    });
    fromInput.addEventListener('change', () => {
        if (!toInput.value || toInput.value < fromInput.value) toInput.value = fromInput.value;
    });
    form.addEventListener('submit', (event) => {
        event.preventDefault();
        download();
    });

    setRange(quickRange('yesterday'));
})();
