/* =============================================================================
 *  dashboard.js  —  IndieTix "Today's Shows" dashboard
 * =============================================================================
 *  Fetches GET /api/dashboard/today and renders one card per showing today,
 *  with tickets-sold / checked-in counts. Refreshes itself automatically.
 *
 *  Patterns reused from reports.js:
 *    - getAuthHeaders() comes from auth-helper.js (loaded globally); auth-helper
 *      also redirects to login if the token is missing/expired.
 *    - The auto-refresh loop mirrors reports.js live-update: a fixed interval,
 *      a 1s "last refreshed" ticker, and pause-on-hidden-tab via
 *      visibilitychange (background tabs throttle setInterval).
 * ========================================================================== */

document.addEventListener('DOMContentLoaded', function () {
    const API_URL = window.INDIETIX_API_URL;

    // How often to quietly refresh. 30s matches the reports page cadence.
    const REFRESH_MS = 30000;
    const MAX_CARDS  = 12;

    // Elements
    const grid              = document.getElementById('dashboard-grid');
    const emptyState        = document.getElementById('dash-empty');
    const emptyStateText    = document.getElementById('dash-empty-text');
    const loadingIndicator  = document.getElementById('loading');
    const dateLabel         = document.getElementById('dash-date');
    const titleEl           = document.getElementById('dash-title');
    const lastRefreshedEl   = document.getElementById('dash-last-refreshed');
    const datePicker        = document.getElementById('dash-date-picker');
    const todayButton       = document.getElementById('dash-today-btn');
    const liveIndicator     = document.getElementById('dash-live');

    // State
    let refreshTimer        = null;
    let lastRefreshedAt     = null;
    let lastRefreshedTicker = null;
    let firstLoadDone       = false;

    // selectedDate is null while viewing "today" (auto-refreshing, server
    // picks the date). Once the picker is used it holds a YYYY-MM-DD string
    // and auto-refresh pauses -- polling a fixed past/future date forever
    // would be pointless. todayStr is filled in from the server's own
    // response on first load, so the picker/"Today" button use the venue's
    // timezone, not the browser's.
    let selectedDate         = null;
    let todayStr             = null;

    // Snapshot of the previous render keyed by showing, so we know which cards
    // changed and should flash. Key = itemId|displayTime|location.
    let prevStats = {};

    /* ---------------------------------------------------------------------
     *  Helpers
     * ------------------------------------------------------------------- */

    // Escape HTML to prevent XSS (same approach as reports.js).
    function escapeHtml(text) {
        if (text === null || text === undefined) return '';
        const div = document.createElement('div');
        div.textContent = String(text);
        return div.innerHTML;
    }

    // Stable identity for a showing.
    function cardKey(ev) {
        return [ev.itemId || '', ev.displayTime || '', ev.location || ''].join('|');
    }

    // "Saturday, May 16, 2026" from a YYYY-MM-DD string. Parsed at noon so the
    // local-time conversion can't roll over to the previous/next day.
    function formatDateLabel(ymd) {
        if (!ymd) return '';
        const d = new Date(ymd + 'T12:00:00');
        if (isNaN(d.getTime())) return ymd;
        return d.toLocaleDateString(undefined, {
            weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
        });
    }

    // Short relative-time string for the "Last refreshed" label.
    function formatRelativeTime(date) {
        if (!date) return '';
        const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
        if (seconds < 5)  return 'just now';
        if (seconds < 60) return seconds + 's ago';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return minutes + 'm ago';
        const hours = Math.floor(minutes / 60);
        if (hours < 24)   return hours + 'h ago';
        return date.toLocaleString();
    }

    function updateLastRefreshedDisplay() {
        if (!lastRefreshedEl) return;
        if (!lastRefreshedAt) {
            lastRefreshedEl.textContent = '';
            return;
        }
        lastRefreshedEl.textContent = 'Updated ' + formatRelativeTime(lastRefreshedAt);
        lastRefreshedEl.title = lastRefreshedAt.toLocaleString();
    }

    // Stamp the refresh time and start a once-per-second display ticker so the
    // label ages gracefully ("8s ago" -> "1m ago" -> ...).
    function setLastRefreshed(date) {
        lastRefreshedAt = date;
        updateLastRefreshedDisplay();
        if (!lastRefreshedTicker) {
            lastRefreshedTicker = setInterval(updateLastRefreshedDisplay, 1000);
        }
    }

    /* ---------------------------------------------------------------------
     *  Rendering
     * ------------------------------------------------------------------- */

    function cardHtml(ev) {
        const sold     = Number(ev.ticketsSold) || 0;
        const checked  = Number(ev.checkedIn) || 0;
        const pct      = sold > 0 ? Math.round((checked / sold) * 100) : 0;
        const complete = sold > 0 && checked >= sold;

        const descriptors = Array.isArray(ev.descriptors) ? ev.descriptors : [];
        const badges = descriptors
            .map(d => `<span class="dash-badge">${escapeHtml(d)}</span>`)
            .join('');

        const runtimeText = ev.runtime ? escapeHtml(ev.runtime + ' min') : '';

        return `
            <article class="dash-card${complete ? ' is-complete' : ''}" data-key="${escapeHtml(cardKey(ev))}">
                <header class="dash-card__head">
                    <span class="dash-card__time">${escapeHtml(ev.displayTime || '')}</span>
                    <span class="dash-card__venue">${escapeHtml(ev.location || '')}</span>
                </header>
                <h2 class="dash-card__title" title="${escapeHtml(ev.title || '')}">${escapeHtml(ev.title || 'Untitled')}</h2>
                <div class="dash-card__stats">
                    <div class="dash-stat">
                        <span class="dash-stat__num">${sold}</span>
                        <span class="dash-stat__label">Sold</span>
                    </div>
                    <div class="dash-stat dash-stat--checked">
                        <span class="dash-stat__num">${checked}</span>
                        <span class="dash-stat__label">Checked In</span>
                    </div>
                </div>
                <div class="dash-progress" role="progressbar"
                     aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100">
                    <div class="dash-progress__fill" style="width:${pct}%"></div>
                </div>
                <footer class="dash-card__foot">
                    <span class="dash-card__pct">${pct}% checked in</span>
                    <span class="dash-card__meta">${runtimeText}${badges}</span>
                </footer>
            </article>`;
    }

    function render(events) {
        const list = Array.isArray(events) ? events.slice(0, MAX_CARDS) : [];

        if (list.length === 0) {
            grid.innerHTML = '';
            grid.style.display = 'none';
            emptyState.style.display = 'block';
            prevStats = {};
            return;
        }

        emptyState.style.display = 'none';
        grid.style.display = 'grid';

        // Build the new render and capture stats for diffing.
        const newStats = {};
        list.forEach(ev => {
            newStats[cardKey(ev)] = {
                sold:    Number(ev.ticketsSold) || 0,
                checked: Number(ev.checkedIn) || 0
            };
        });

        grid.innerHTML = list.map(cardHtml).join('');

        // Flash any card whose numbers changed since the last render — but not
        // on the very first load (everything would flash at once).
        if (firstLoadDone) {
            Object.keys(newStats).forEach(key => {
                const before = prevStats[key];
                const after  = newStats[key];
                const changed = before &&
                    (before.sold !== after.sold || before.checked !== after.checked);
                if (changed) {
                    const el = grid.querySelector(`[data-key="${CSS.escape(key)}"]`);
                    if (el) {
                        el.classList.remove('flash-update');
                        // Force reflow so the animation can re-trigger.
                        void el.offsetWidth;
                        el.classList.add('flash-update');
                    }
                }
            });
        }

        prevStats = newStats;
    }

    function showError(message) {
        // Only blocks the screen on the initial load; refresh failures keep the
        // last good data on screen (the "Updated 2m ago" label shows staleness).
        const existing = document.querySelector('.dash-error-alert');
        if (existing) existing.remove();

        const alertDiv = document.createElement('div');
        alertDiv.className = 'alert alert-danger dash-error-alert';
        alertDiv.role = 'alert';
        alertDiv.textContent = message;
        grid.parentNode.insertBefore(alertDiv, grid);
    }

    function clearError() {
        const existing = document.querySelector('.dash-error-alert');
        if (existing) existing.remove();
    }

    /* ---------------------------------------------------------------------
     *  Data fetch
     * ------------------------------------------------------------------- */

    async function fetchDashboard() {
        try {
            const url = selectedDate
                ? `${API_URL}/api/dashboard/today?date=${encodeURIComponent(selectedDate)}`
                : `${API_URL}/api/dashboard/today`;
            const response = await fetch(url, {
                method: 'GET',
                headers: getAuthHeaders()
            });

            if (!response.ok) {
                // auth-helper's fetch interceptor handles 401/403 redirects.
                throw new Error('HTTP ' + response.status);
            }

            const data = await response.json();

            clearError();
            if (loadingIndicator) loadingIndicator.style.display = 'none';

            if (dateLabel) dateLabel.textContent = formatDateLabel(data.date);

            // The very first load (selectedDate still null) is always "today"
            // per the server's own default -- capture its date string once so
            // the picker and "Today" button are anchored to the venue's
            // timezone rather than the browser's.
            if (!todayStr && !selectedDate && data.date) {
                todayStr = data.date;
            }
            if (datePicker && data.date) datePicker.value = data.date;
            // Dashboard data comes from Square's LIVE catalog (getShowtimesForDate),
            // not the DB -- and expireQRCodeSquareModifiers archives/removes a
            // showtime's modifiers once it's passed. So a past date always comes
            // back with zero showtimes here regardless of whether tickets were
            // actually sold that day, surfacing as a misleading "No shows
            // scheduled" empty state. Past-date reporting belongs on the Event
            // Report page (DB-backed, not Square-catalog-backed) -- disallow
            // picking a past date here instead of showing a result that looks
            // like "no sales" but actually means "Square doesn't have this
            // showtime anymore." Re-set on every fetch (not just the first) so
            // the cutoff rolls forward correctly if the tab stays open past
            // midnight.
            if (datePicker && todayStr) datePicker.min = todayStr;
            updateViewingState();

            if (emptyStateText) {
                emptyStateText.textContent = (!selectedDate || selectedDate === todayStr)
                    ? 'No shows scheduled for today.'
                    : `No shows scheduled for ${formatDateLabel(data.date)}.`;
            }

            render(data.events || []);

            setLastRefreshed(new Date());
            firstLoadDone = true;

        } catch (err) {
            console.error('Dashboard fetch error:', err);
            if (loadingIndicator) loadingIndicator.style.display = 'none';

            // Initial load failed -> surface it. Refresh failed -> stay quiet
            // and leave the last good data on screen.
            if (!firstLoadDone) {
                showError('Could not load the dashboard: ' +
                    (err.message || 'Network error') + '. Retrying automatically...');
                // updateViewingState() (which normally starts polling) only
                // runs after a successful response -- if the very first
                // fetch fails, make sure the retry loop still starts instead
                // of leaving the page permanently stuck.
                if (!refreshTimer && isViewingToday()) startAutoRefresh();
            } else {
                console.warn('Dashboard refresh failed; keeping previous data.');
            }
        }
    }

    /* ---------------------------------------------------------------------
     *  Auto-refresh loop (only while viewing today)
     * ------------------------------------------------------------------- */

    function isViewingToday() {
        return !selectedDate || (!!todayStr && selectedDate === todayStr);
    }

    // Reflects the current today/other-date state in the UI and starts or
    // stops polling to match -- called after every fetch, since the date
    // actually rendered (data.date) is the source of truth, not just whatever
    // the picker happens to say.
    function updateViewingState() {
        const isToday = isViewingToday();
        if (titleEl) titleEl.textContent = isToday ? "Today's Shows" : 'Shows';
        if (liveIndicator) liveIndicator.style.display = isToday ? '' : 'none';
        if (todayButton) todayButton.style.display = isToday ? 'none' : 'inline-block';
        if (isToday) {
            startAutoRefresh();
        } else {
            stopAutoRefresh();
        }
    }

    function startAutoRefresh() {
        stopAutoRefresh();
        refreshTimer = setInterval(fetchDashboard, REFRESH_MS);
    }

    function stopAutoRefresh() {
        if (refreshTimer) {
            clearInterval(refreshTimer);
            refreshTimer = null;
        }
    }

    // Background tabs throttle setInterval, so pause fully when hidden and do an
    // immediate refresh on return (data may be well stale by then). Only
    // resumes polling if still viewing today -- a backgrounded tab looking at
    // a past date shouldn't start auto-refreshing just because it came back.
    document.addEventListener('visibilitychange', function () {
        if (document.hidden) {
            stopAutoRefresh();
        } else {
            fetchDashboard();
            if (isViewingToday()) startAutoRefresh();
        }
    });

    /* ---------------------------------------------------------------------
     *  Date picker / "Today" jump
     * ------------------------------------------------------------------- */

    if (datePicker) {
        // Several mobile browsers (in-app/WebView browsers, some Android
        // Chrome versions) don't reliably fire 'change' on <input type="date">
        // when a date is picked via the native OS picker, even though the
        // value visibly updates -- 'input' is the more consistently-fired
        // event there. Still not universal: confirmed in production that at
        // least one mobile browser updates the field's displayed value
        // without firing EITHER 'change' or 'input'. 'blur' is the backstop
        // -- it fires whenever focus leaves the field regardless of how the
        // value got there, so it catches that case too. All three share the
        // same guarded handler, so no double-fetching on browsers where
        // more than one fires for the same selection.
        const handleDatePickerChange = function () {
            if (!datePicker.value || datePicker.value === selectedDate) return;
            selectedDate = datePicker.value;
            if (loadingIndicator) loadingIndicator.style.display = 'block';
            fetchDashboard();
        };
        datePicker.addEventListener('change', handleDatePickerChange);
        datePicker.addEventListener('input', handleDatePickerChange);
        datePicker.addEventListener('blur', handleDatePickerChange);
    }

    if (todayButton) {
        todayButton.addEventListener('click', function () {
            selectedDate = null;
            if (loadingIndicator) loadingIndicator.style.display = 'block';
            fetchDashboard();
        });
    }

    window.addEventListener('beforeunload', stopAutoRefresh);

    /* ---------------------------------------------------------------------
     *  Logout (same pattern as reports.js)
     * ------------------------------------------------------------------- */

    function logout() {
        if (window.authHelper) {
            window.authHelper.logout('Manual logout');
        } else {
            localStorage.removeItem('authToken');
            window.location.href = 'login.html';
        }
    }

    const logoutButton = document.getElementById('logout-btn');
    if (logoutButton) {
        logoutButton.addEventListener('click', logout);
    }

    /* ---------------------------------------------------------------------
     *  Kick things off
     * ------------------------------------------------------------------- */
    // No explicit startAutoRefresh() call here -- fetchDashboard's own
    // updateViewingState() starts it once the first response confirms
    // we're viewing today.
    fetchDashboard();
});
