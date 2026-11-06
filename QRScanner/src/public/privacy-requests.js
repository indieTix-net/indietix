// privacy-requests.js -- the Privacy Requests page (client login only):
// find one customer's data by email/phone, download it, or erase their
// details (POST /api/privacy/search, /export, /redact; GET /requests).
// Everything is written with textContent.
document.addEventListener('DOMContentLoaded', function () {
    const API_URL = window.INDIETIX_API_URL;
    const emailInput = document.getElementById('privacy-email');
    const phoneInput = document.getElementById('privacy-phone');
    const searchBtn = document.getElementById('privacy-search-btn');
    const results = document.getElementById('privacy-results');
    const countsList = document.getElementById('privacy-counts');
    const ordersBody = document.getElementById('privacy-orders');
    const consentNote = document.getElementById('privacy-consent');
    const verificationInput = document.getElementById('privacy-verification');
    const receivedInput = document.getElementById('privacy-received');
    const exportBtn = document.getElementById('privacy-export-btn');
    const redactBtn = document.getElementById('privacy-redact-btn');
    const logBody = document.getElementById('privacy-log');

    // [one, many]
    const COUNT_LABELS = {
        orders: ['order', 'orders'], tickets: ['ticket', 'tickets'], customers: ['customer record', 'customer records'],
        consents: ['text-message consent record (kept as proof)', 'text-message consent records (kept as proof)'],
        texts: ['text sent', 'texts sent'], emailContacts: ['email list entry', 'email list entries'],
        apiReplays: ['stored API response', 'stored API responses']
    };
    const countLabel = (key, count) => `${count} ${(COUNT_LABELS[key] || [key, key])[count === 1 ? 0 : 1]}`;
    const TYPE_LABELS = { export: 'Download', redact: 'Erasure' };
    let lastSubject = null;

    receivedInput.value = new Date().toLocaleDateString('en-CA');

    function subject() {
        return { email: emailInput.value.trim(), phone: phoneInput.value.trim() };
    }

    function cell(text) {
        const td = document.createElement('td');
        td.textContent = text == null || text === '' ? '-' : String(text);
        return td;
    }

    function formatDate(value) {
        if (!value) return '-';
        const date = new Date(value);
        return isNaN(date) ? String(value) : date.toLocaleDateString();
    }

    async function postJson(path, body) {
        const response = await fetch(`${API_URL}${path}`, {
            method: 'POST',
            headers: { ...getAuthHeaders(), 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const data = await UIDialogs.readJson(response);
        if (!response.ok || !data.success) throw Object.assign(new Error(data.message || `Request failed (${response.status})`), { status: response.status });
        return data;
    }

    function showResults(data) {
        countsList.replaceChildren();
        for (const [key, count] of Object.entries(data.counts)) {
            if (!count) continue;
            const li = document.createElement('li');
            li.textContent = countLabel(key, count);
            countsList.appendChild(li);
        }
        if (!countsList.children.length) {
            const li = document.createElement('li');
            li.textContent = 'Nothing matches that email or phone.';
            countsList.appendChild(li);
        }
        ordersBody.replaceChildren();
        for (const order of data.orders) {
            const tr = document.createElement('tr');
            tr.append(cell(order.orderId), cell(formatDate(order.created)), cell(order.name), cell(order.email), cell(order.phone), cell(order.status));
            ordersBody.appendChild(tr);
        }
        consentNote.textContent = data.textConsent.length
            ? `Text messages: ${data.textConsent.some(c => c.status === 'active') ? 'currently subscribed (erasing stops texts)' : 'not subscribed'}.`
            : '';
        const found = Object.values(data.counts).some(Boolean);
        exportBtn.disabled = !found;
        redactBtn.disabled = !found;
        results.hidden = false;
    }

    searchBtn.addEventListener('click', async function () {
        UIDialogs.clearFieldErrors();
        const who = subject();
        if (!who.email && !who.phone) {
            UIDialogs.fieldError(emailInput, 'Enter their email address or phone number.');
            return;
        }
        searchBtn.disabled = true;
        try {
            const data = await postJson('/api/privacy/search', who);
            lastSubject = who;
            showResults(data);
        } catch (error) {
            results.hidden = true;
            UIDialogs.showMessage({ type: 'error', title: "Couldn't search", message: error.message });
        } finally {
            searchBtn.disabled = false;
        }
    });

    // Changing who you're looking for hides the last results, so an action
    // can never run against a different person than the one shown.
    for (const input of [emailInput, phoneInput]) {
        input.addEventListener('input', () => { results.hidden = true; lastSubject = null; });
    }

    function details() {
        const verification = verificationInput.value.trim();
        if (verification.length < 5) {
            UIDialogs.fieldError(verificationInput, 'Say how you confirmed the request came from them.');
            return null;
        }
        return { ...lastSubject, verification, receivedDate: receivedInput.value || undefined };
    }

    exportBtn.addEventListener('click', async function () {
        if (!lastSubject) return;
        const body = details();
        if (!body) return;
        exportBtn.disabled = true;
        try {
            const data = await postJson('/api/privacy/export', body);
            const blob = new Blob([JSON.stringify(data.data, null, 2)], { type: 'application/json' });
            const link = document.createElement('a');
            link.href = URL.createObjectURL(blob);
            link.download = `privacy-export-${data.requestId}.json`;
            document.body.appendChild(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(link.href), 10000);
            UIDialogs.showMessage({ type: 'success', title: 'Data downloaded', message: `Send the downloaded file to the person. This is logged as request #${data.requestId}.` });
            loadLog();
        } catch (error) {
            UIDialogs.showMessage({ type: 'error', title: "Couldn't download their data", message: error.message });
        } finally {
            exportBtn.disabled = false;
        }
    });

    redactBtn.addEventListener('click', async function () {
        if (!lastSubject) return;
        const body = details();
        if (!body) return;
        const ok = await UIDialogs.showConfirm({
            title: 'Erase their details?',
            message: "Their name, email and phone are replaced on every order, ticket and list entry. This can't be undone. Orders, tickets and sales totals stay, and their tickets keep working.",
            confirmText: 'Erase Their Details',
            danger: true
        });
        if (!ok) return;
        redactBtn.disabled = true;
        try {
            const data = await postJson('/api/privacy/redact', { ...body, confirm: true });
            results.hidden = true;
            lastSubject = null;
            emailInput.value = '';
            phoneInput.value = '';
            verificationInput.value = '';
            const r = data.redacted;
            UIDialogs.showMessage({
                type: 'success',
                title: 'Details erased',
                message: `Erased from ${countLabel('orders', r.orders)}, ${countLabel('tickets', r.tickets)} and ${countLabel('customers', r.customers)}.${r.consentsRevoked ? ' Texts to them are stopped.' : ''} Logged as request #${data.requestId}.`
            });
            loadLog();
        } catch (error) {
            UIDialogs.showMessage({ type: 'error', title: "Couldn't erase their details", message: error.message });
        } finally {
            redactBtn.disabled = false;
        }
    });

    function loadLog() {
        fetch(`${API_URL}/api/privacy/requests`, { headers: getAuthHeaders() })
            .then(response => response.json())
            .then(data => {
                logBody.replaceChildren();
                if (!data.success) return;
                if (!data.requests.length) {
                    const tr = document.createElement('tr');
                    const td = cell('No requests yet.');
                    td.colSpan = 7;
                    tr.appendChild(td);
                    logBody.appendChild(tr);
                    return;
                }
                for (const request of data.requests) {
                    const found = Object.entries(request.Matches || {})
                        .filter(([key, count]) => count && COUNT_LABELS[key])
                        .map(([key, count]) => countLabel(key, count).replace(' (kept as proof)', ''))
                        .join(', ');
                    const tr = document.createElement('tr');
                    tr.append(cell(request.ID), cell(formatDate(request.CreatedDate)), cell(TYPE_LABELS[request.RequestType] || request.RequestType),
                        cell(request.ReceivedDate), cell(request.Verification), cell(found), cell(request.RequestedBy));
                    logBody.appendChild(tr);
                }
            })
            .catch(error => console.error('Could not load the request log:', error));
    }

    loadLog();
});
