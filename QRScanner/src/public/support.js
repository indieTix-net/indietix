// Public support page: shows this site's support email (HOSTED_SUPPORT_EMAIL,
// from /api/public/signup/config). Without one, the generic wording stays.
document.addEventListener('DOMContentLoaded', function () {
    fetch(`${window.INDIETIX_API_URL}/api/public/signup/config`)
        .then(r => r.json())
        .then(config => {
            if (!config.supportEmail) return;
            const slot = document.getElementById('support-email');
            slot.textContent = '';
            const link = document.createElement('a');
            link.href = `mailto:${config.supportEmail}`;
            link.textContent = config.supportEmail;
            slot.appendChild(link);
        })
        .catch(() => { /* keep the generic wording */ });
});
