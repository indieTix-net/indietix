// opt-in.js — public opt-in page controller.
//
// URL contract:
//   /opt-in/{token}?client={clientId}      (CloudFront rewrite -> opt-in.html)
//   /opt-in.html?token={token}&client={clientId}  (direct)
//
// Both are supported; the JS reads whichever is present. The clientId is
// required because this page is public (no JWT) and the API is multi-tenant
// -- the API endpoints can't know which client database to query without it.
//
// Flow:
//   1. Parse token + clientId from URL
//   2. GET /api/public/opt-in?token=X&client=Y
//      -> returns { orderExists, consentState: 'new'|'active'|'revoked',
//                   venueName, phoneMasked, tickets, previousUnsubscribeDate }
//   3. Render one of five states:
//      - loading (default)
//      - not-found  (orderExists=false)
//      - already-opted-in  (consentState='active') + auto-fire the resend
//      - form  (consentState='new' or 'revoked')
//      - success  (after successful POST)
//   4. On form submit: POST /api/public/opt-in with token, client, phone,
//      consentText verbatim -> API records SmsConsent, sends ticket SMS(es).

(function () {
    'use strict';

    // ---- Config ------------------------------------------------------------
    // API URL matches header-loader.js. When we split QRScanner API to
    // a per-client endpoint later, update here.
    const API_URL = window.INDIETIX_API_URL;

    // Element handles cached at load time
    const els = {
        // State containers
        loading:         document.getElementById('state-loading'),
        notFound:        document.getElementById('state-not-found'),
        alreadyOptedIn:  document.getElementById('state-already-opted-in'),
        form:            document.getElementById('state-form'),
        success:         document.getElementById('state-success'),

        // Header
        venueName:       document.getElementById('optin-venue-name'),

        // Already-opted-in view
        alreadyPhone:    document.getElementById('already-phone-display'),
        alreadyVenues:   document.querySelectorAll('.already-venue-name'),

        // Resubscribe banner
        resubBanner:     document.getElementById('resubscribe-banner'),
        resubDate:       document.getElementById('resubscribe-date'),
        resubOrigNumber: document.getElementById('resubscribe-orig-number'),

        // Form headline (differs for resub vs new)
        formHeadline:    document.getElementById('form-headline'),
        formSubheadline: document.getElementById('form-subheadline'),

        // Ticket list in card
        ticketList:      document.getElementById('order-ticket-list'),

        // Form controls
        phoneInput:      document.getElementById('phone-input'),
        phoneError:      document.getElementById('phone-error'),
        consentCheck:    document.getElementById('consent-checkbox'),
        consentLabel:    document.getElementById('consent-label-text'),
        submitButton:    document.getElementById('submit-button'),
        submitError:     document.getElementById('submit-error'),

        // Success view
        successPhone:    document.getElementById('success-phone-display')
    };

    // ---- URL parsing -------------------------------------------------------

    /**
     * Extract token from either the path (/opt-in/{token}) or a query param
     * (?token=X). Path wins if both are present; that's the canonical form
     * we advertise in email CTAs.
     */
    function getTokenFromUrl() {
        // Path form: /opt-in/{token}  (with or without trailing slash)
        const pathMatch = window.location.pathname.match(/^\/opt-in\/([A-Za-z0-9_-]+)\/?$/);
        if (pathMatch && pathMatch[1]) return pathMatch[1];

        // Query form: ?token=X
        const params = new URLSearchParams(window.location.search);
        return params.get('token');
    }

    function getClientIdFromUrl() {
        const params = new URLSearchParams(window.location.search);
        return params.get('client');
    }

    // ---- Phone normalization / display -------------------------------------
    // Mirrors utils/phone.mjs on the server, but simpler: we only need to
    // decide whether to enable the submit button, not authoritatively
    // normalize. The server does the authoritative normalization.

    /**
     * Strip everything except digits. Returns the digit string.
     */
    function stripToDigits(str) {
        return (str || '').replace(/\D+/g, '');
    }

    /**
     * Client-side phone shape check. Accepts 10 digits (US/CA local) or
     * 11 digits starting with 1. Doesn't validate area code -- server will
     * reject bad ones authoritatively.
     */
    function looksLikeValidPhone(str) {
        const digits = stripToDigits(str);
        if (digits.length === 10) return true;
        if (digits.length === 11 && digits[0] === '1') return true;
        return false;
    }

    /**
     * Format for display: (555) 123-4567 for 10 digits, +1 (555) 123-4567
     * for 11 leading with 1.
     */
    function formatPhoneDisplay(str) {
        const d = stripToDigits(str);
        if (d.length === 10) {
            return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
        }
        if (d.length === 11 && d[0] === '1') {
            return `+1 (${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}`;
        }
        return str; // fall back to raw input
    }

    // ---- State toggle ------------------------------------------------------

    function showState(name) {
        [els.loading, els.notFound, els.alreadyOptedIn, els.form, els.success]
            .forEach(el => el.classList.add('d-none'));
        const target = ({
            loading:        els.loading,
            'not-found':    els.notFound,
            'already':      els.alreadyOptedIn,
            form:           els.form,
            success:        els.success
        })[name];
        if (target) target.classList.remove('d-none');
    }

    // ---- Consent text ------------------------------------------------------
    // This is the exact string we store in SmsConsent.ConsentText for audit.
    // Keep it in sync with the 10DLC campaign submission's opt-in flow description.
    // Scaled back to describe only the one message that actually ships today
    // (ticket delivery) -- showtime-reminder and door-open-alert texts were
    // never built, so the old copy was promising messages customers never
    // got. Sending fewer messages than disclosed isn't a compliance problem
    // the way sending more/different ones would be, so this direction is
    // safe relative to the registered 10DLC campaign.
    function buildConsentText(venueName) {
        return (
            `By checking this box, I agree to receive an automated ticket ` +
            `delivery text from ${venueName}. Msg & data rates may apply. ` +
            `Reply STOP to unsubscribe, HELP for help.`
        );
    }

    // ---- Order info fetch --------------------------------------------------

    async function fetchOrderInfo(token, clientId) {
        const url = `${API_URL}/api/public/opt-in?token=${encodeURIComponent(token)}&client=${encodeURIComponent(clientId)}`;
        const res = await fetch(url, {
            method: 'GET',
            headers: { 'Content-Type': 'application/json' }
        });
        if (!res.ok) {
            // 404 is expected for unknown tokens; treat as "not found" state
            if (res.status === 404) return null;
            throw new Error(`HTTP ${res.status}`);
        }
        return res.json();
    }

    // ---- Render helpers ----------------------------------------------------

    function renderVenueName(name) {
        const safe = name || 'this venue';
        els.venueName.textContent = safe;
        els.alreadyVenues.forEach(el => el.textContent = safe);
        // Update browser tab title to include venue name for clearer context
        if (name) {
            document.title = `Get your ticket by text \u00b7 ${name}`;
        }
    }

    function renderTicketList(tickets) {
        if (!tickets || !tickets.length) {
            els.ticketList.innerHTML = '<li class="text-muted">Your ticket(s)</li>';
            return;
        }
        els.ticketList.innerHTML = tickets
            .map(t => {
                const parts = [t.name, t.dateLabel].filter(Boolean).join(' &middot; ');
                return `<li>${escapeHtml(parts)}</li>`;
            })
            .join('');
    }

    function renderResubscribeBanner(info) {
        if (info.consentState !== 'revoked') return;
        els.resubBanner.classList.remove('d-none');
        if (info.previousUnsubscribeDate) {
            els.resubDate.textContent = info.previousUnsubscribeDate;
        }
        if (info.originationNumberDisplay) {
            els.resubOrigNumber.textContent = info.originationNumberDisplay;
        }
        els.formHeadline.textContent = 'Resubscribe to ticket texts';
        els.submitButton.textContent = 'Resubscribe';
    }

    function renderConsentLabel(venueName) {
        // Set the checkbox label to include the exact consent text. This is
        // what the customer literally reads and agrees to; it goes verbatim
        // into SmsConsent.ConsentText for the audit trail.
        els.consentLabel.textContent = buildConsentText(venueName);
    }

    function escapeHtml(s) {
        return String(s || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // ---- Form validation and submit ---------------------------------------

    function updateSubmitEnabled() {
        const phoneOk   = looksLikeValidPhone(els.phoneInput.value);
        const consentOk = els.consentCheck.checked;
        els.submitButton.disabled = !(phoneOk && consentOk);
    }

    function showSubmitError(msg) {
        els.submitError.textContent = msg;
        els.submitError.classList.remove('d-none');
    }

    function clearSubmitError() {
        els.submitError.classList.add('d-none');
        els.submitError.textContent = '';
    }

    async function submitOptIn(token, clientId, venueName) {
        clearSubmitError();
        els.submitButton.disabled = true;
        const originalButtonText = els.submitButton.textContent;
        els.submitButton.textContent = 'Sending\u2026';

        const rawPhone = els.phoneInput.value;
        const consentText = buildConsentText(venueName);

        try {
            const res = await fetch(`${API_URL}/api/public/opt-in`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    token: token,
                    clientId: clientId,
                    phone: rawPhone,
                    consentText: consentText
                })
            });

            const data = await res.json().catch(() => ({}));

            if (!res.ok) {
                // Server returned an error message we can show to the user
                const msg = (data && data.message) || `Something went wrong (HTTP ${res.status}). Please try again.`;
                showSubmitError(msg);
                els.submitButton.disabled = false;
                els.submitButton.textContent = originalButtonText;
                return;
            }

            // Success -- show the confirmation state
            const displayPhone = (data && data.phoneMasked) || formatPhoneDisplay(rawPhone);
            els.successPhone.textContent = displayPhone;
            showState('success');
        } catch (err) {
            console.error('Opt-in POST error:', err);
            showSubmitError('Network error. Please check your connection and try again.');
            els.submitButton.disabled = false;
            els.submitButton.textContent = originalButtonText;
        }
    }

    // ---- Main --------------------------------------------------------------

    async function init() {
        const token    = getTokenFromUrl();
        const clientId = getClientIdFromUrl();

        // Missing either piece -> not-found. We don't try to be helpful
        // about "you're missing the client param" because that would leak
        // implementation detail; the customer just needs a working link.
        if (!token || !clientId) {
            showState('not-found');
            return;
        }

        // Basic clientId shape check -- matches the server's validation.
        // Prevents obviously-malformed values from even making the API call.
        if (!/^[A-Za-z0-9]+$/.test(clientId)) {
            showState('not-found');
            return;
        }

        let info;
        try {
            info = await fetchOrderInfo(token, clientId);
        } catch (err) {
            console.error('Opt-in GET error:', err);
            // On network error we still show the not-found state -- the
            // customer's next best action (check email for PDF) is the same
            // either way, and we don't want to leak "the server is broken"
            showState('not-found');
            return;
        }

        if (!info || !info.orderExists) {
            showState('not-found');
            return;
        }

        renderVenueName(info.venueName);
        renderTicketList(info.tickets);

        if (info.consentState === 'active') {
            // Already opted in -- the API already re-fired the ticket SMS
            // on our behalf as part of the GET response. Just show the
            // confirmation.
            els.alreadyPhone.textContent = info.phoneMasked || 'your phone';
            showState('already');
            return;
        }

        // consentState is 'new' or 'revoked' -- show the form
        renderConsentLabel(info.venueName || 'this venue');
        renderResubscribeBanner(info);
        showState('form');

        // Wire up form events
        els.phoneInput.addEventListener('input', updateSubmitEnabled);
        els.consentCheck.addEventListener('change', updateSubmitEnabled);
        els.submitButton.addEventListener('click', () => {
            submitOptIn(token, clientId, info.venueName || 'this venue');
        });

        // Also allow enter-key submit from the phone field
        els.phoneInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !els.submitButton.disabled) {
                e.preventDefault();
                submitOptIn(token, clientId, info.venueName || 'this venue');
            }
        });
    }

    // Fire on DOMContentLoaded if we're not already past it.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
