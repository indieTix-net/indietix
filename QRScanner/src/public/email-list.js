// email-list.js -- dedicated Email List page, split out of marketing.js
// (which was getting crowded) to its own page. Backed by the same
// /api/marketing/email-contacts routes as before -- no backend change.
(function() {
    'use strict';

    const API_URL = window.INDIETIX_API_URL;

    let emailContacts = [];

    function authHeaders() {
        return { 'Content-Type': 'application/json', ...window.getAuthHeaders() };
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str || '';
        return div.innerHTML;
    }

    async function loadEmailContacts() {
        const statusEl = document.getElementById('email-contact-status');
        try {
            const response = await fetch(`${API_URL}/api/marketing/email-contacts`, { headers: authHeaders() });
            const data = await response.json();
            if (!data.success) {
                statusEl.textContent = data.message || 'Failed to load email list.';
                return;
            }
            emailContacts = data.contacts || [];
            renderEmailContacts();
        } catch (error) {
            console.error('Error loading email contacts:', error);
            statusEl.textContent = 'Failed to load email list.';
        }
    }

    function renderEmailContacts() {
        const statusEl = document.getElementById('email-contact-status');
        const tbody = document.getElementById('email-contact-table-body');
        const filter = (document.getElementById('email-contact-search').value || '').trim().toLowerCase();

        const activeCount = emailContacts.filter(c => c.Status === 'active').length;
        statusEl.textContent = `${emailContacts.length} total (${activeCount} active, ${emailContacts.length - activeCount} unsubscribed).`;

        const visible = filter ? emailContacts.filter(c => c.Email.toLowerCase().includes(filter)) : emailContacts;

        if (visible.length === 0) {
            tbody.innerHTML = `<tr><td colspan="4" class="text-muted">${emailContacts.length === 0 ? 'No email addresses yet.' : 'No matches.'}</td></tr>`;
            return;
        }

        tbody.innerHTML = visible.map(c => {
            const added = c.CreatedDate ? new Date(c.CreatedDate).toLocaleDateString() : '';
            const isActive = c.Status === 'active';
            const toggleLabel = isActive ? 'Unsubscribe' : 'Resubscribe';
            return `
                <tr>
                    <td>${escapeHtml(c.Email)}</td>
                    <td><span class="channel-badge ${isActive ? 'enabled' : ''}">${escapeHtml(c.Status)}</span></td>
                    <td>${escapeHtml(added)}</td>
                    <td>
                        <button type="button" class="btn btn-outline-secondary btn-sm" onclick="EmailListPage.toggleEmailContactStatus(${c.ID}, ${isActive})">${toggleLabel}</button>
                        <button type="button" class="btn btn-outline-danger btn-sm ms-1" onclick="EmailListPage.deleteEmailContact(${c.ID})">Delete</button>
                    </td>
                </tr>
            `;
        }).join('');
    }

    async function addEmailContact() {
        const input = document.getElementById('email-contact-input');
        const errorEl = document.getElementById('email-contact-add-error');
        errorEl.classList.add('d-none');

        const email = input.value.trim();
        if (!email) return;

        try {
            const response = await fetch(`${API_URL}/api/marketing/email-contacts`, {
                method: 'POST',
                headers: authHeaders(),
                body: JSON.stringify({ email })
            });
            const data = await response.json();
            if (!data.success) {
                errorEl.textContent = data.message || 'Could not add that email.';
                errorEl.classList.remove('d-none');
                return;
            }
            input.value = '';
            await loadEmailContacts();
        } catch (error) {
            console.error('Error adding email contact:', error);
            errorEl.textContent = 'Could not add that email.';
            errorEl.classList.remove('d-none');
        }
    }

    async function toggleEmailContactStatus(id, isCurrentlyActive) {
        try {
            const response = await fetch(`${API_URL}/api/marketing/email-contacts/${id}/status`, {
                method: 'PUT',
                headers: authHeaders(),
                body: JSON.stringify({ status: isCurrentlyActive ? 'unsubscribed' : 'active' })
            });
            const data = await response.json();
            if (!data.success) {
                UIDialogs.showMessage({ type: 'error', title: "Couldn't update contact", message: data.message || 'The contact could not be updated.' });
                return;
            }
            await loadEmailContacts();
        } catch (error) {
            console.error('Error updating email contact:', error);
            UIDialogs.showMessage({ type: 'error', title: "Couldn't update contact", message: 'Something went wrong. Please try again.', details: error.message });
        }
    }

    async function deleteEmailContact(id) {
        if (!await UIDialogs.showConfirm({ title: 'Remove email address?', message: "Remove this email address from the list? This can't be undone.", confirmText: 'Remove', danger: true })) return;

        try {
            const response = await fetch(`${API_URL}/api/marketing/email-contacts/${id}`, {
                method: 'DELETE',
                headers: authHeaders()
            });
            const data = await response.json();
            if (!data.success) {
                UIDialogs.showMessage({ type: 'error', title: "Couldn't remove contact", message: data.message || 'The contact could not be removed.' });
                return;
            }
            await loadEmailContacts();
        } catch (error) {
            console.error('Error deleting email contact:', error);
            UIDialogs.showMessage({ type: 'error', title: "Couldn't remove contact", message: 'Something went wrong. Please try again.', details: error.message });
        }
    }

    document.addEventListener('DOMContentLoaded', function() {
        loadEmailContacts();

        document.getElementById('add-email-contact-btn').addEventListener('click', addEmailContact);
        document.getElementById('email-contact-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') addEmailContact();
        });
        document.getElementById('email-contact-search').addEventListener('input', renderEmailContacts);
    });

    window.EmailListPage = {
        toggleEmailContactStatus,
        deleteEmailContact
    };
})();
