// Hosted IndieTix signup (see app.mjs's HOSTED SIGNUP section).
//   signup.html                    the form; submitting goes to Square's sign-in
//   signup.html?result=<result>    back from Square without a new venue
//   signup.html?status=<token>     back from Square; the venue is being created
//   signup.html?set=<token>        the welcome email's set-password link
document.addEventListener('DOMContentLoaded', function () {
    const API_URL = window.INDIETIX_API_URL;
    const params = new URLSearchParams(window.location.search);
    const states = ['loading', 'closed', 'form', 'waiting', 'ready', 'set-password', 'password-set'];
    const RESULTS = {
        expired: ['warning', 'That took too long, so the signup expired. Please start again.'],
        denied: ['warning', 'Square wasn\'t connected, so nothing was set up. You can start again whenever you like.'],
        failed: ['danger', 'Something went wrong connecting Square. Please try again, and contact support if it keeps happening.'],
        exists: ['info', 'That Square account already has an IndieTix box office. Log in, or check your email: if you never set a password, we\'ve sent the link again.']
    };

    function show(name) {
        states.forEach(s => { document.getElementById(`state-${s}`).classList.toggle('d-none', s !== name); });
    }
    function message(kind, text) {
        const box = document.getElementById('message');
        box.className = `alert alert-${kind}`;
        box.textContent = text;
    }

    // ---- set password ----
    if (params.get('set')) {
        show('set-password');
        document.getElementById('password-form').addEventListener('submit', function (e) {
            e.preventDefault();
            const password = document.getElementById('new-password').value;
            if (password.length < 10) return message('warning', 'Use a password of at least 10 characters.');
            if (password !== document.getElementById('confirm-new-password').value) return message('warning', 'The passwords don\'t match.');
            const button = document.getElementById('password-button');
            button.disabled = true;
            fetch(`${API_URL}/api/public/signup/set-password`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: params.get('set'), password })
            })
                .then(r => r.json())
                .then(data => {
                    if (!data.success) throw new Error(data.message || 'Could not set the password');
                    document.getElementById('message').className = 'd-none';
                    document.getElementById('done-client-id').textContent = data.clientId;
                    document.getElementById('login-link').href = `login.html?client=${encodeURIComponent(data.clientId)}`;
                    show('password-set');
                })
                .catch(error => { button.disabled = false; message('danger', error.message); });
        });
        return;
    }

    // ---- waiting for the venue ----
    if (params.get('status')) {
        show('waiting');
        const started = Date.now();
        const poll = () => {
            fetch(`${API_URL}/api/public/signup/status?token=${encodeURIComponent(params.get('status'))}`)
                .then(r => r.json())
                .then(data => {
                    if (!data.success) throw new Error(data.message || 'Could not check on your signup');
                    if (data.ready) {
                        document.getElementById('ready-client-id').textContent = data.clientId;
                        return show('ready');
                    }
                    if (Date.now() - started > 5 * 60 * 1000) {
                        return message('warning', 'This is taking longer than usual. Leave this page open, or contact support.');
                    }
                    setTimeout(poll, 4000);
                })
                .catch(error => message('danger', error.message));
        };
        poll();
        return;
    }

    // ---- the form ----
    const result = RESULTS[params.get('result')];
    if (result) message(result[0], result[1]);

    fetch(`${API_URL}/api/public/signup/config`)
        .then(r => r.json())
        .then(config => {
            if (!config.enabled) return show('closed');
            if (config.sandbox) document.getElementById('sandbox-note').classList.remove('d-none');
            // Link the Terms and Privacy Policy when the site has them.
            const label = document.getElementById('accept-terms-label');
            if (config.termsUrl || config.privacyUrl) {
                label.textContent = 'I agree to IndieTix\'s ';
                const link = (href, text) => {
                    const a = document.createElement('a');
                    a.href = href; a.target = '_blank'; a.rel = 'noopener'; a.textContent = text;
                    return a;
                };
                if (config.termsUrl) label.appendChild(link(config.termsUrl, 'Terms of Service'));
                if (config.termsUrl && config.privacyUrl) label.appendChild(document.createTextNode(' and '));
                if (config.privacyUrl) label.appendChild(link(config.privacyUrl, 'Privacy Policy'));
                label.appendChild(document.createTextNode('.'));
            }
            if (config.siteDomain) {
                document.getElementById('site-name-domain').textContent = `.${config.siteDomain}`;
                document.getElementById('site-name-group').hidden = false;
            }
            show('form');
        })
        .catch(() => show('closed'));

    // Availability, checked as the venue types
    const siteName = document.getElementById('site-name');
    const siteNameStatus = document.getElementById('site-name-status');
    let siteCheckTimer = null;
    siteName.addEventListener('input', function () {
        clearTimeout(siteCheckTimer);
        const name = siteName.value.trim().toLowerCase();
        if (!name) return;
        siteCheckTimer = setTimeout(() => {
            fetch(`${API_URL}/api/public/site-address/check?name=${encodeURIComponent(name)}`)
                .then(r => r.json())
                .then(data => {
                    if (siteName.value.trim().toLowerCase() !== name) return;
                    siteNameStatus.textContent = data.available
                        ? `${name}${document.getElementById('site-name-domain').textContent} is available.`
                        : (data.message || 'That address is not available.');
                })
                .catch(() => {});
        }, 400);
    });

    document.getElementById('signup-form').addEventListener('submit', function (e) {
        e.preventDefault();
        const body = {
            venueName: document.getElementById('venue-name').value.trim(),
            contactName: document.getElementById('contact-name').value.trim(),
            contactEmail: document.getElementById('contact-email').value.trim(),
            acceptTerms: document.getElementById('accept-terms').checked,
            siteName: document.getElementById('site-name').value.trim().toLowerCase()
        };
        if (!body.venueName || !body.contactName || !body.contactEmail) return message('warning', 'Please fill in every field.');
        if (!body.acceptTerms) return message('warning', 'Please accept the Terms of Service and Privacy Policy.');
        const button = document.getElementById('submit-button');
        button.disabled = true;
        fetch(`${API_URL}/api/public/signup/start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        })
            .then(r => r.json())
            .then(data => {
                if (!data.success || !data.url) throw new Error(data.message || 'Could not start signup');
                window.location.href = data.url;
            })
            .catch(error => { button.disabled = false; message('danger', error.message); });
    });
});
