// email-unsubscribe.js — one-click unsubscribe, reached from an email footer.
// URL contract: /email-unsubscribe.html?token={token}&client={clientId}
// Fires automatically on load -- CAN-SPAM requires unsubscribing to be a
// single click, not a login/confirm flow.
(function () {
    'use strict';

    const API_URL = window.INDIETIX_API_URL;

    const params = new URLSearchParams(window.location.search);
    const token = params.get('token');
    const clientId = params.get('client');

    const els = {
        loading: document.getElementById('state-loading'),
        success: document.getElementById('state-success'),
        error:   document.getElementById('state-error'),
        errorMessage: document.getElementById('error-message')
    };

    function showState(state) {
        els.loading.classList.add('d-none');
        els.success.classList.add('d-none');
        els.error.classList.add('d-none');
        els[state].classList.remove('d-none');
    }

    async function unsubscribe() {
        if (!token || !clientId) {
            els.errorMessage.textContent = 'This link is missing required information.';
            showState('error');
            return;
        }

        try {
            const url = new URL(`${API_URL}/api/public/email-unsubscribe`);
            url.searchParams.set('token', token);
            url.searchParams.set('client', clientId);

            const response = await fetch(url);
            const data = await response.json();

            if (data.success) {
                showState('success');
            } else {
                els.errorMessage.textContent = data.message || 'That unsubscribe link may have expired or already been used.';
                showState('error');
            }
        } catch (error) {
            console.error('Unsubscribe failed:', error);
            els.errorMessage.textContent = 'Something went wrong. Please try again.';
            showState('error');
        }
    }

    unsubscribe();
})();
