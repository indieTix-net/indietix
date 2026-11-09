// status.js -- the public status page. Reads GET /api/public/status (one
// line per part of IndieTix, from the environment's error alarms) and
// refreshes every minute. If the API itself can't be reached, that's shown
// as a problem too: this page is served separately (CloudFront/S3), so it
// still loads when the app is down.
(function () {
    const API_URL = window.INDIETIX_API_URL;
    const REFRESH_MS = 60 * 1000;

    // ---- VENUE LOGO ----
    // On a venue's own address (<name>.<INDIETIX_VENUE_SITE_DOMAIN>) the page
    // wears that venue's logo and name, read from its public site.json like
    // the login page does; anywhere else, or if the venue has none, IndieTix's.
    (function showLogo() {
        const logo = document.getElementById('status-logo');
        if (!logo) return;
        const useLogo = (src, alt) => { logo.src = src; logo.alt = alt; logo.hidden = false; };
        const useDefault = () => useLogo('indieTixLogo.png', 'IndieTix');
        const domain = String(window.INDIETIX_VENUE_SITE_DOMAIN || '').toLowerCase();
        const host = window.location.hostname.toLowerCase();
        if (!domain || !host.endsWith(`.${domain}`)) return useDefault();
        const name = host.slice(0, -(domain.length + 1));
        if (!/^[a-z0-9][a-z0-9-]{1,28}[a-z0-9]$/.test(name)) return useDefault();
        fetch(`venue-sites/${name}/site.json`, { cache: 'no-cache' })
            .then(response => (response.ok ? response.json() : null))
            .then(site => {
                const file = site && site.logoFile;
                if (!file || !/^[A-Za-z0-9._\/-]+$/.test(file) || file.includes('..')) return useDefault();
                useLogo(file, site.venueName ? `${site.venueName} logo` : 'Venue logo');
                if (site.venueName) document.title = `${site.venueName} - System status`;
            })
            .catch(useDefault);
    })();

    const overallEl = document.getElementById('overall');
    const componentsEl = document.getElementById('components');
    const checkedAtEl = document.getElementById('checked-at');

    function setOverall(kind, text) {
        overallEl.className = `alert ${kind === 'operational' ? 'alert-success' : kind === 'problem' ? 'alert-danger' : 'alert-secondary'}`;
        overallEl.textContent = text;
    }

    function renderComponents(components) {
        componentsEl.replaceChildren();
        for (const component of components) {
            const row = document.createElement('div');
            row.className = `status-row status-${component.status}`;
            const name = document.createElement('span');
            const dot = document.createElement('span');
            dot.className = 'status-dot';
            name.append(dot, document.createTextNode(component.name));
            const label = document.createElement('span');
            label.className = 'status-label';
            label.textContent = component.status === 'operational' ? 'Working normally' : 'Problem detected';
            row.append(name, label);
            componentsEl.appendChild(row);
        }
    }

    async function refresh() {
        try {
            const response = await fetch(`${API_URL}/api/public/status`);
            const data = await response.json();
            if (data.enabled === false) {
                setOverall('unknown', "Status reporting isn't set up on this site.");
                componentsEl.replaceChildren();
                checkedAtEl.textContent = '';
                return;
            }
            if (!response.ok || !Array.isArray(data.components)) {
                throw new Error(data.message || `status ${response.status}`);
            }
            setOverall(data.overall, data.overall === 'operational'
                ? 'All systems are working normally.'
                : "Something isn't working right. We've been notified and are looking into it.");
            renderComponents(data.components);
            checkedAtEl.textContent = `Last checked ${new Date(data.checkedAt).toLocaleString()}`;
        } catch (error) {
            console.error('Status check failed:', error);
            setOverall('problem', "IndieTix can't be reached right now, so box office pages and door scanning may not work. If this lasts more than a few minutes, contact support.");
            renderComponents([]);
            checkedAtEl.textContent = `Last tried ${new Date().toLocaleString()}`;
        }
    }

    refresh();
    setInterval(refresh, REFRESH_MS);
})();
