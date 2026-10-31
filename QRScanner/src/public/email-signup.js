// email-signup.js — public, no-login email list signup page.
//
// URL contract: /email-signup.html?client={clientId}
// Reached via a QR code at the box office -- no per-user token, since
// nobody's been identified yet (they're about to submit their own email).
// Same public-route family as opt-in.html: the client is required because
// this page has no JWT and the API is multi-tenant.
(function () {
    'use strict';

    const API_URL = window.INDIETIX_API_URL;

    function getClientIdFromUrl() {
        return new URLSearchParams(window.location.search).get('client');
    }

    const els = {
        form:         document.getElementById('signup-form'),
        emailInput:   document.getElementById('email-input'),
        emailError:   document.getElementById('email-error'),
        submitButton: document.getElementById('submit-button'),
        submitError:  document.getElementById('submit-error'),
        stateForm:    document.getElementById('state-form'),
        stateSuccess: document.getElementById('state-success'),
        venueName:    document.getElementById('signup-venue-name')
    };

    const clientId = getClientIdFromUrl();

    function showError(el, message) {
        el.textContent = message;
        el.classList.remove('d-none');
    }
    function hideError(el) {
        el.classList.add('d-none');
    }

    els.form.addEventListener('submit', async function (e) {
        e.preventDefault();
        hideError(els.emailError);
        hideError(els.submitError);

        const email = els.emailInput.value.trim();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            showError(els.emailError, 'Please enter a valid email address.');
            return;
        }
        if (!clientId) {
            showError(els.submitError, 'This link is missing required information. Please use the QR code or link from the theater.');
            return;
        }

        els.submitButton.disabled = true;
        els.submitButton.textContent = 'Signing up…';

        try {
            const response = await fetch(`${API_URL}/api/public/email-signup`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ client: clientId, email })
            });
            const data = await response.json();

            if (!data.success) {
                showError(els.submitError, data.message || 'Something went wrong. Please try again.');
                els.submitButton.disabled = false;
                els.submitButton.textContent = 'Sign Up';
                return;
            }

            if (data.venueName) {
                els.venueName.textContent = `Get ${data.venueName} updates by email`;
            }
            els.stateForm.classList.add('d-none');
            els.stateSuccess.classList.remove('d-none');
        } catch (error) {
            console.error('Signup failed:', error);
            showError(els.submitError, 'Something went wrong. Please try again.');
            els.submitButton.disabled = false;
            els.submitButton.textContent = 'Sign Up';
        }
    });
})();
