// marketing.js -- Marquee Engine schedule editor / status page.
// Mirrors client.js's Skeleton Keys section: a list of records with
// inline create/edit/delete, backed by /api/marketing/* routes.
(function() {
    'use strict';

    const API_URL = window.INDIETIX_API_URL;
    const CHANNELS = ['email', 'facebook', 'instagram', 'tiktok'];
    const CHANNEL_LABELS = { email: 'Email', facebook: 'Facebook', instagram: 'Instagram', tiktok: 'TikTok' };

    // Pre-canned phase-builder cadences, keyed by name, so staff don't have
    // to hand-build the same offset list for every title. "daysFromAnchor"
    // is relative to the item's opening showtime (negative = before,
    // positive = during the run) -- same units computePlannedPostSlots in
    // marketingEngine/src/index.mjs expects. Per the Marquee Engine design
    // doc's "Phase builder + presets" decision: applying a preset just
    // fills in the offset rows, which stay fully editable afterward.
    const SCHEDULE_PRESETS = {
        standard_4_week: {
            label: 'Standard 4-week ramp',
            offsets: [
                { daysFromAnchor: -28, time: '11:00' },
                { daysFromAnchor: -14, time: '11:00' },
                { daysFromAnchor: -7, time: '11:00' },
                { daysFromAnchor: -3, time: '11:00' },
                { daysFromAnchor: -1, time: '11:00' },
                { daysFromAnchor: 0, time: '09:00' }
            ]
        },
        big_premiere: {
            label: 'Big premiere',
            offsets: [
                { daysFromAnchor: -21, time: '11:00' },
                { daysFromAnchor: -14, time: '11:00' },
                { daysFromAnchor: -7, time: '11:00' },
                { daysFromAnchor: -3, time: '11:00' },
                { daysFromAnchor: -1, time: '18:00' },
                { daysFromAnchor: 0, time: '09:00' },
                { daysFromAnchor: 1, time: '11:00' }
            ]
        },
        quick_turnaround: {
            label: 'Quick turnaround (short notice)',
            offsets: [
                { daysFromAnchor: -3, time: '11:00' },
                { daysFromAnchor: -1, time: '11:00' },
                { daysFromAnchor: 0, time: '09:00' }
            ]
        }
    };

    let marketingItems = [];
    let currentItemId = null;
    let currentSchedules = {}; // channel -> schedule row (or null)
    let currentWindow = null; // { anchorDate: 'YYYY-MM-DD', lastShowtimeDate: 'YYYY-MM-DD' } | null
    let customPresets = []; // staff-defined, loaded from Client.configuration: [{ name, offsets }]

    function authHeaders() {
        return { 'Content-Type': 'application/json', ...window.getAuthHeaders() };
    }

    // For embedding untrusted text inside an HTML attribute value (quotes
    // specifically) -- escapeHtml below only covers text-node content,
    // where unescaped quotes are harmless; here they'd break out of the
    // value="..." delimiter.
    function escapeAttr(str) {
        return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    }

    // =====================================================
    // CUSTOM SCHEDULE PRESETS
    // =====================================================

    async function loadCustomPresets() {
        try {
            const response = await fetch(`${API_URL}/api/marketing/custom-presets`, { headers: authHeaders() });
            const data = await response.json();
            if (data.success) customPresets = data.presets || [];
            // No-op if the schedule modal hasn't been opened yet (dropdowns
            // don't exist); harmless either way.
            refreshPresetDropdowns();
        } catch (error) {
            console.error('Error loading custom schedule presets:', error);
        }
    }

    function refreshPresetDropdowns() {
        CHANNELS.forEach(channel => {
            const select = document.getElementById(`preset-select-${channel}`);
            if (!select) return;
            const previousValue = select.value;
            select.innerHTML = presetSelectOptionsHtml();
            if (Array.from(select.options).some(o => o.value === previousValue)) {
                select.value = previousValue;
            }
        });
    }

    async function saveAsPreset(channel) {
        const offsets = collectOffsets(channel);
        if (offsets.length === 0) {
            UIDialogs.fieldError(document.getElementById(`offsets-${channel}`), 'Add at least one posting day before saving a preset.');
            return;
        }
        const name = await UIDialogs.showPrompt({
            title: 'Save as preset',
            label: 'Preset name',
            placeholder: 'e.g. Standard 4-week ramp',
            confirmText: 'Save Preset',
            requiredMessage: 'Enter a name for the preset.'
        });
        if (!name) return;

        try {
            const response = await fetch(`${API_URL}/api/marketing/custom-presets`, {
                method: 'POST',
                headers: authHeaders(),
                body: JSON.stringify({ name: name.trim(), offsets })
            });
            const data = await response.json();
            if (!data.success) {
                UIDialogs.showMessage({ type: 'error', title: "Couldn't save preset", message: data.message || 'The preset could not be saved.' });
                return;
            }
            customPresets = data.presets || [];
            refreshPresetDropdowns();
        } catch (error) {
            console.error('Error saving custom preset:', error);
            UIDialogs.showMessage({ type: 'error', title: "Couldn't save preset", message: 'Something went wrong. Please try again.', details: error.message });
        }
    }

    async function deleteSelectedPreset(channel) {
        const select = document.getElementById(`preset-select-${channel}`);
        const value = select.value;
        if (!value.startsWith('custom:')) {
            UIDialogs.fieldError(select, 'Only presets you saved can be deleted. The built-in ones are always available.');
            return;
        }
        const name = value.slice('custom:'.length);
        if (!await UIDialogs.showConfirm({ title: 'Delete preset?', message: `Delete the "${name}" preset? This can't be undone.`, confirmText: 'Delete Preset', danger: true })) return;

        try {
            const response = await fetch(`${API_URL}/api/marketing/custom-presets?name=${encodeURIComponent(name)}`, {
                method: 'DELETE',
                headers: authHeaders()
            });
            const data = await response.json();
            if (!data.success) {
                UIDialogs.showMessage({ type: 'error', title: "Couldn't delete preset", message: data.message || 'The preset could not be deleted.' });
                return;
            }
            customPresets = data.presets || [];
            refreshPresetDropdowns();
        } catch (error) {
            console.error('Error deleting custom preset:', error);
            UIDialogs.showMessage({ type: 'error', title: "Couldn't delete preset", message: 'Something went wrong. Please try again.', details: error.message });
        }
    }

    // =====================================================
    // DIGEST SETTINGS
    // =====================================================

    let digestBackgroundDataUrl = null; // set only if the admin picked a new background file this visit

    // Check/string booleans both show up depending on how the config was
    // written (Postgres JSON booleans vs. JSON strings) -- same convention
    // as every other boolean config value in this platform.
    function isTrueVal(v) {
        return v === true || v === 'true';
    }

    async function loadDigestSettings() {
        try {
            const response = await fetch(`${API_URL}/api/marketing/digest-settings`, { headers: authHeaders() });
            const data = await response.json();
            if (!data.success) return;

            const s = data.settings;
            document.getElementById('digest-enabled').checked = s.DIGEST_ENABLED === 'true' || s.DIGEST_ENABLED === true;
            document.getElementById('digest-day').value = s.DIGEST_DAY_OF_WEEK || 'monday';
            document.getElementById('digest-time').value = s.DIGEST_TIME || '10:00';

            const channels = Array.isArray(s.DIGEST_CHANNELS) ? s.DIGEST_CHANNELS : ['email'];
            document.querySelectorAll('.digest-channel').forEach(cb => {
                cb.checked = channels.includes(cb.value);
            });

            const bounds = s.DIGEST_TEXT_BOUNDS || {};
            document.getElementById('digest-bounds-top').value = bounds.top || 0;
            document.getElementById('digest-bounds-right').value = bounds.right || 0;
            document.getElementById('digest-bounds-bottom').value = bounds.bottom || 0;
            document.getElementById('digest-bounds-left').value = bounds.left || 0;

            document.getElementById('digest-date-font-size').value = s.DIGEST_DATE_FONT_SIZE || 16;
            document.getElementById('digest-date-bold').checked = !(s.DIGEST_DATE_BOLD === false || s.DIGEST_DATE_BOLD === 'false');
            document.getElementById('digest-event-font-size').value = s.DIGEST_EVENT_FONT_SIZE || 14;
            document.getElementById('digest-event-bold').checked = !(s.DIGEST_EVENT_BOLD === false || s.DIGEST_EVENT_BOLD === 'false');
            document.getElementById('digest-time-font-size').value = s.DIGEST_TIME_FONT_SIZE || 14;
            document.getElementById('digest-time-bold').checked = isTrueVal(s.DIGEST_TIME_BOLD);

            document.getElementById('digest-header-text').value = s.DIGEST_HEADER_TEXT || '';
            document.getElementById('digest-header-font-size').value = s.DIGEST_HEADER_FONT_SIZE || 16;
            document.getElementById('digest-header-bold').checked = !(s.DIGEST_HEADER_BOLD === false || s.DIGEST_HEADER_BOLD === 'false');
            document.getElementById('digest-header-in-image').checked = isTrueVal(s.DIGEST_HEADER_IN_IMAGE);
            document.getElementById('digest-header-in-caption').checked = isTrueVal(s.DIGEST_HEADER_IN_CAPTION);

            document.getElementById('digest-footer-text').value = s.DIGEST_FOOTER_TEXT || '';
            document.getElementById('digest-footer-font-size').value = s.DIGEST_FOOTER_FONT_SIZE || 16;
            document.getElementById('digest-footer-bold').checked = !(s.DIGEST_FOOTER_BOLD === false || s.DIGEST_FOOTER_BOLD === 'false');
            document.getElementById('digest-footer-in-image').checked = isTrueVal(s.DIGEST_FOOTER_IN_IMAGE);
            document.getElementById('digest-footer-in-caption').checked = isTrueVal(s.DIGEST_FOOTER_IN_CAPTION);

            const previewEl = document.getElementById('digest-background-preview');
            const emptyEl = document.getElementById('digest-background-empty');
            const dimsEl = document.getElementById('digest-background-dims');
            if (s.DIGEST_BACKGROUND_IMAGE_URL) {
                previewEl.src = s.DIGEST_BACKGROUND_IMAGE_URL;
                previewEl.style.display = 'block';
                emptyEl.style.display = 'none';
                showDigestBackgroundDims(previewEl, dimsEl);
            } else {
                previewEl.style.display = 'none';
                emptyEl.style.display = 'block';
                dimsEl.style.display = 'none';
            }
        } catch (error) {
            console.error('Error loading digest settings:', error);
        }
    }

    // Shows the uploaded background's actual pixel size below the preview --
    // the text-overlay offsets are now measured against this image's real
    // dimensions (it's no longer force-cropped to a fixed 1080x1080 square),
    // so the admin needs to see it to set sensible offsets.
    function showDigestBackgroundDims(imgEl, dimsEl) {
        const render = () => {
            if (imgEl.naturalWidth && imgEl.naturalHeight) {
                dimsEl.textContent = `${imgEl.naturalWidth} × ${imgEl.naturalHeight} px`;
                dimsEl.style.display = 'block';
            }
        };
        if (imgEl.complete) {
            render();
        } else {
            imgEl.addEventListener('load', render, { once: true });
        }
    }

    function handleDigestBackgroundUpload(event) {
        const file = event.target.files[0];
        if (!file) return;

        if (!file.type.startsWith('image/')) {
            UIDialogs.fieldError(event.target, 'Choose an image file.');
            event.target.value = '';
            return;
        }
        // Same 4MB cap as the post-image uploader, and for the same reason:
        // this is base64-encoded into the JSON body, which inflates size
        // ~33% and needs to stay under the Lambda Function URL's 6MB limit.
        if (file.size > 4 * 1024 * 1024) {
            UIDialogs.fieldError(event.target, 'That image is over 4 MB. Choose a smaller one.');
            event.target.value = '';
            return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            digestBackgroundDataUrl = e.target.result;
            const previewEl = document.getElementById('digest-background-preview');
            previewEl.src = digestBackgroundDataUrl;
            previewEl.style.display = 'block';
            document.getElementById('digest-background-empty').style.display = 'none';
            showDigestBackgroundDims(previewEl, document.getElementById('digest-background-dims'));
        };
        reader.readAsDataURL(file);
    }

    async function saveDigestSettings() {
        const statusEl = document.getElementById('digest-save-status');
        const channels = Array.from(document.querySelectorAll('.digest-channel:checked')).map(cb => cb.value);

        const body = {
            DIGEST_ENABLED: document.getElementById('digest-enabled').checked ? 'true' : 'false',
            DIGEST_DAY_OF_WEEK: document.getElementById('digest-day').value,
            DIGEST_TIME: document.getElementById('digest-time').value,
            DIGEST_CHANNELS: channels,
            DIGEST_TEXT_BOUNDS: {
                top: parseInt(document.getElementById('digest-bounds-top').value, 10) || 0,
                right: parseInt(document.getElementById('digest-bounds-right').value, 10) || 0,
                bottom: parseInt(document.getElementById('digest-bounds-bottom').value, 10) || 0,
                left: parseInt(document.getElementById('digest-bounds-left').value, 10) || 0
            },
            DIGEST_DATE_FONT_SIZE: parseInt(document.getElementById('digest-date-font-size').value, 10) || 16,
            DIGEST_DATE_BOLD: document.getElementById('digest-date-bold').checked ? 'true' : 'false',
            DIGEST_EVENT_FONT_SIZE: parseInt(document.getElementById('digest-event-font-size').value, 10) || 14,
            DIGEST_EVENT_BOLD: document.getElementById('digest-event-bold').checked ? 'true' : 'false',
            DIGEST_TIME_FONT_SIZE: parseInt(document.getElementById('digest-time-font-size').value, 10) || 14,
            DIGEST_TIME_BOLD: document.getElementById('digest-time-bold').checked ? 'true' : 'false',
            DIGEST_HEADER_TEXT: document.getElementById('digest-header-text').value.trim(),
            DIGEST_HEADER_FONT_SIZE: parseInt(document.getElementById('digest-header-font-size').value, 10) || 16,
            DIGEST_HEADER_BOLD: document.getElementById('digest-header-bold').checked ? 'true' : 'false',
            DIGEST_HEADER_IN_IMAGE: document.getElementById('digest-header-in-image').checked ? 'true' : 'false',
            DIGEST_HEADER_IN_CAPTION: document.getElementById('digest-header-in-caption').checked ? 'true' : 'false',
            DIGEST_FOOTER_TEXT: document.getElementById('digest-footer-text').value.trim(),
            DIGEST_FOOTER_FONT_SIZE: parseInt(document.getElementById('digest-footer-font-size').value, 10) || 16,
            DIGEST_FOOTER_BOLD: document.getElementById('digest-footer-bold').checked ? 'true' : 'false',
            DIGEST_FOOTER_IN_IMAGE: document.getElementById('digest-footer-in-image').checked ? 'true' : 'false',
            DIGEST_FOOTER_IN_CAPTION: document.getElementById('digest-footer-in-caption').checked ? 'true' : 'false'
        };
        if (digestBackgroundDataUrl) body.backgroundImageDataUrl = digestBackgroundDataUrl;

        try {
            const response = await fetch(`${API_URL}/api/marketing/digest-settings`, {
                method: 'PUT',
                headers: authHeaders(),
                body: JSON.stringify(body)
            });
            const data = await response.json();
            statusEl.textContent = data.success ? 'Saved.' : (data.message || 'Save failed.');
            digestBackgroundDataUrl = null;
            setTimeout(() => { statusEl.textContent = ''; }, 3000);
        } catch (error) {
            console.error('Error saving digest settings:', error);
            statusEl.textContent = 'Save failed.';
        }
    }

    // =====================================================
    // CAMPAIGN ITEMS LIST
    // =====================================================

    async function loadMarketingItems() {
        const statusEl = document.getElementById('marketing-items-status');
        try {
            const response = await fetch(`${API_URL}/api/marketing/items`, { headers: authHeaders() });
            const data = await response.json();
            if (!data.success) {
                statusEl.textContent = data.message || 'Failed to load items.';
                return;
            }
            marketingItems = data.items || [];
            statusEl.textContent = marketingItems.length === 0
                ? 'No active ticketed items found.'
                : `${marketingItems.length} active item(s).`;
            renderMarketingItems();
        } catch (error) {
            console.error('Error loading marketing items:', error);
            statusEl.textContent = 'Failed to load items.';
        }
    }

    function escapeHtml(str) {
        const div = document.createElement('div');
        div.textContent = str || '';
        return div.innerHTML;
    }

    // Card-level "Delete Schedule" -- removes every channel's schedule for
    // this item in one shot. Distinct from the per-channel "Remove" buttons
    // inside the Edit Schedule modal.
    async function deleteItemSchedule(squareItemId, itemName) {
        if (!await UIDialogs.showConfirm({ title: 'Delete schedule?', message: `Delete the entire marketing schedule for "${itemName}" (all channels)? Posts already sent stay in the history below.`, confirmText: 'Delete Schedule', danger: true })) return;

        try {
            const response = await fetch(`${API_URL}/api/marketing/schedules/${encodeURIComponent(squareItemId)}`, {
                method: 'DELETE',
                headers: authHeaders()
            });
            const data = await response.json();
            if (!data.success) {
                UIDialogs.showMessage({ type: 'error', title: "Couldn't delete schedule", message: data.message || 'The schedule could not be deleted.' });
                return;
            }
            await loadMarketingItems();
        } catch (error) {
            console.error('Error deleting item schedule:', error);
            UIDialogs.showMessage({ type: 'error', title: "Couldn't delete schedule", message: 'Something went wrong. Please try again.', details: error.message });
        }
    }

    function renderMarketingItems() {
        const container = document.getElementById('marketing-items-container');
        container.innerHTML = marketingItems.map(item => {
            const safeName = escapeHtml(item.name).replace(/'/g, "&#39;");
            const deleteBtn = item.hasSchedule
                ? `<button type="button" class="btn btn-outline-danger btn-sm ms-1" onclick="MarketingPage.deleteItemSchedule('${escapeHtml(item.squareItemId)}', '${safeName}')">Delete Schedule</button>`
                : '';
            return `
            <div class="skeleton-key-card" id="item-card-${escapeHtml(item.squareItemId)}">
                <div class="skeleton-key-header">
                    <div class="skeleton-key-info">
                        <h6>${escapeHtml(item.name)}</h6>
                    </div>
                    <div class="skeleton-key-actions">
                        <button type="button" class="btn btn-outline-primary btn-sm" onclick="MarketingPage.openScheduleModal('${escapeHtml(item.squareItemId)}', '${safeName}')">
                            Edit Schedule
                        </button>
                        ${deleteBtn}
                    </div>
                </div>
            </div>
        `;
        }).join('');
    }

    // =====================================================
    // SCHEDULE MODAL (per item, tabbed per channel)
    // =====================================================

    function offsetRowHtml(offset) {
        return `
            <div class="offset-row">
                <input type="number" class="form-control form-control-sm offset-days" value="${offset ? offset.daysFromAnchor : 0}" placeholder="Days from opening">
                <input type="time" class="form-control form-control-sm offset-time" value="${offset ? offset.time : '11:30'}">
                <span class="offset-preview-date text-muted small"></span>
                <button type="button" class="btn btn-sm btn-outline-danger" onclick="this.parentElement.remove()">&times;</button>
            </div>
        `;
    }

    // Parses a 'YYYY-MM-DD' calendar date (no timezone conversion -- noon
    // avoids any DST edge case when later adding/subtracting days) and adds
    // daysFromAnchor, mirroring computePlannedPostSlots in
    // marketingEngine/src/index.mjs so the preview matches what the poller
    // will actually schedule.
    function resolveOffsetDate(anchorDateStr, daysFromAnchor) {
        if (!anchorDateStr) return null;
        const [y, m, d] = anchorDateStr.split('-').map(Number);
        const date = new Date(y, m - 1, d, 12);
        date.setDate(date.getDate() + daysFromAnchor);
        return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    }

    // MarketingPost.ScheduledFor is a wall-clock value with no timezone
    // semantics (same convention as ProductDate elsewhere in this platform
    // -- "11:00" means 11:00, period, not an instant to convert). The API
    // hands it back as e.g. "2026-11-03T11:00:00.000Z" because that's how
    // Postgres timestamps round-trip through pg + JSON, but that trailing
    // Z does NOT mean UTC here -- `new Date(...).toLocaleString()` would
    // treat it as a real UTC instant and shift it by the *viewer's*
    // timezone offset, which is exactly the bug reported (11am showing as
    // 5-6am). Parsing the digits directly and reconstructing a local Date
    // from them avoids any timezone math entirely.
    function formatWallClockDateTime(isoLikeString) {
        const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(isoLikeString || '');
        if (!match) return isoLikeString || '';
        const [, y, m, d, h, min] = match;
        const date = new Date(Number(y), Number(m) - 1, Number(d), Number(h), Number(min));
        return date.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    }

    function refreshOffsetPreviews(channel) {
        const rows = document.querySelectorAll(`#offsets-${channel} .offset-row`);
        rows.forEach(row => {
            const days = parseInt(row.querySelector('.offset-days').value, 10) || 0;
            const previewEl = row.querySelector('.offset-preview-date');
            if (!currentWindow) {
                previewEl.textContent = '';
                return;
            }
            const resolved = resolveOffsetDate(currentWindow.anchorDate, days);
            previewEl.textContent = resolved ? `-> ${resolved}` : '';
        });
    }

    // presetValue is "builtin:<key>" or "custom:<name>" -- see
    // presetSelectOptionsHtml.
    async function applyPreset(channel, presetValue) {
        let preset = null;
        if (presetValue.startsWith('builtin:')) {
            preset = SCHEDULE_PRESETS[presetValue.slice('builtin:'.length)];
        } else if (presetValue.startsWith('custom:')) {
            const name = presetValue.slice('custom:'.length);
            const found = customPresets.find(p => p.name === name);
            if (found) preset = { label: found.name, offsets: found.offsets };
        }
        if (!preset) return;

        const container = document.getElementById(`offsets-${channel}`);
        const hasExistingRows = container.querySelectorAll('.offset-row').length > 0;
        if (hasExistingRows && !await UIDialogs.showConfirm({ title: 'Replace posting days?', message: `Replace the current ${CHANNEL_LABELS[channel]} posting days with the "${preset.label}" preset? You can still edit, add or remove days afterward.`, confirmText: 'Replace' })) {
            return;
        }

        container.innerHTML = preset.offsets.map(offsetRowHtml).join('');
        refreshOffsetPreviews(channel);
    }

    function presetSelectOptionsHtml() {
        const builtin = Object.entries(SCHEDULE_PRESETS)
            .map(([key, preset]) => `<option value="builtin:${key}">${escapeHtml(preset.label)}</option>`)
            .join('');
        const custom = customPresets
            .map(p => `<option value="custom:${escapeAttr(p.name)}">${escapeHtml(p.name)}</option>`)
            .join('');
        return `
            <option value="">Start from a preset&hellip;</option>
            <optgroup label="Built-in">${builtin}</optgroup>
            ${custom ? `<optgroup label="Custom">${custom}</optgroup>` : ''}
        `;
    }

    function presetOptionsHtml(channel) {
        return `
            <div class="preset-row mb-2">
                <select class="form-select form-select-sm" id="preset-select-${channel}" style="max-width: 260px; display: inline-block;">
                    ${presetSelectOptionsHtml()}
                </select>
                <button type="button" class="btn btn-sm btn-outline-primary ms-2" onclick="MarketingPage.applyPreset('${channel}', document.getElementById('preset-select-${channel}').value)">Apply</button>
                <button type="button" class="btn btn-sm btn-outline-secondary ms-2" onclick="MarketingPage.saveAsPreset('${channel}')">Save current days as preset&hellip;</button>
                <button type="button" class="btn btn-sm btn-outline-danger ms-2" onclick="MarketingPage.deleteSelectedPreset('${channel}')">Delete selected preset</button>
            </div>
        `;
    }

    function renderChannelTab(channel, schedule) {
        const offsets = schedule?.PhaseConfig?.offsets || [];
        const enabled = schedule ? schedule.Enabled : true;
        const useAi = schedule ? schedule.UseAiCaptions : false;

        return `
            <div class="mb-3">
                <div class="form-check form-switch">
                    <input class="form-check-input" type="checkbox" id="channel-enabled-${channel}" ${enabled ? 'checked' : ''}>
                    <label class="form-check-label" for="channel-enabled-${channel}">Enabled</label>
                </div>
                <div class="form-check form-switch">
                    <input class="form-check-input" type="checkbox" id="channel-ai-${channel}" ${useAi ? 'checked' : ''}>
                    <label class="form-check-label" for="channel-ai-${channel}">
                        Use AI-generated captions for this campaign
                        <small class="text-muted d-block">Off by default -- captions are pulled from canned templates + Square item fields unless this is checked. AI only runs when you opt in here, so it never generates spend on its own.</small>
                    </label>
                </div>
            </div>
            ${presetOptionsHtml(channel)}
            <label class="form-label">Posting days (relative to the item's opening showtime; negative = before, positive = during the run)</label>
            <div id="offsets-${channel}">
                ${offsets.map(offsetRowHtml).join('') || offsetRowHtml(null)}
            </div>
            <button type="button" class="btn btn-sm btn-outline-secondary" onclick="MarketingPage.addOffsetRow('${channel}')">+ Add posting day</button>
            <div class="mt-3">
                <button type="button" class="btn btn-primary btn-sm" onclick="MarketingPage.saveChannelSchedule('${channel}')">Save ${CHANNEL_LABELS[channel]} Schedule</button>
                <button type="button" class="btn btn-outline-danger btn-sm" onclick="MarketingPage.deleteChannelSchedule('${channel}')" ${schedule ? '' : 'disabled'}>Remove</button>
                <span id="channel-save-status-${channel}" class="ms-2 text-muted"></span>
            </div>
        `;
    }

    async function openScheduleModal(squareItemId, itemName) {
        currentItemId = squareItemId;
        document.getElementById('schedule-modal-title').textContent = `Schedule: ${itemName}`;

        const tabsEl = document.getElementById('channel-tabs');
        const contentEl = document.getElementById('channel-tab-content');

        tabsEl.innerHTML = CHANNELS.map((c, i) => `
            <li class="nav-item" role="presentation">
                <button class="nav-link ${i === 0 ? 'active' : ''}" data-bs-toggle="tab" data-bs-target="#tab-${c}" type="button">${CHANNEL_LABELS[c]}</button>
            </li>
        `).join('');
        contentEl.innerHTML = CHANNELS.map((c, i) => `
            <div class="tab-pane fade ${i === 0 ? 'show active' : ''}" id="tab-${c}"></div>
        `).join('');

        currentSchedules = {};
        currentWindow = null;
        const windowInfoEl = document.getElementById('schedule-window-info');
        windowInfoEl.textContent = '';

        try {
            const response = await fetch(`${API_URL}/api/marketing/schedules/${encodeURIComponent(squareItemId)}`, { headers: authHeaders() });
            const data = await response.json();
            if (data.success) {
                (data.schedules || []).forEach(s => { currentSchedules[s.Channel] = s; });
            }
        } catch (error) {
            console.error('Error loading item schedules:', error);
        }

        try {
            const windowResponse = await fetch(`${API_URL}/api/marketing/items/${encodeURIComponent(squareItemId)}/window`, { headers: authHeaders() });
            const windowData = await windowResponse.json();
            if (windowData.success && windowData.window) {
                currentWindow = windowData.window;
                const opens = resolveOffsetDate(currentWindow.anchorDate, 0);
                const closes = resolveOffsetDate(currentWindow.lastShowtimeDate, 0);
                windowInfoEl.textContent = `Opening: ${opens} — Last showtime: ${closes}. Posting days below are shown with their resulting calendar date.`;
            } else {
                windowInfoEl.textContent = 'No showtimes found for this item yet — posting days are shown as day offsets only, without calendar dates.';
            }
        } catch (error) {
            console.error('Error loading item showtime window:', error);
            windowInfoEl.textContent = '';
        }

        CHANNELS.forEach(c => {
            document.getElementById(`tab-${c}`).innerHTML = renderChannelTab(c, currentSchedules[c] || null);
            refreshOffsetPreviews(c);
            document.getElementById(`offsets-${c}`).addEventListener('input', (e) => {
                if (e.target.classList.contains('offset-days')) refreshOffsetPreviews(c);
            });
        });

        const modal = new bootstrap.Modal(document.getElementById('schedule-modal'));
        modal.show();
    }

    function addOffsetRow(channel) {
        document.getElementById(`offsets-${channel}`).insertAdjacentHTML('beforeend', offsetRowHtml(null));
        refreshOffsetPreviews(channel);
    }

    function collectOffsets(channel) {
        const rows = document.querySelectorAll(`#offsets-${channel} .offset-row`);
        return Array.from(rows).map(row => ({
            daysFromAnchor: parseInt(row.querySelector('.offset-days').value, 10) || 0,
            time: row.querySelector('.offset-time').value || '11:30'
        }));
    }

    async function saveChannelSchedule(channel) {
        const statusEl = document.getElementById(`channel-save-status-${channel}`);
        const body = {
            phaseConfig: { offsets: collectOffsets(channel) },
            enabled: document.getElementById(`channel-enabled-${channel}`).checked,
            useAiCaptions: document.getElementById(`channel-ai-${channel}`).checked
        };

        try {
            const response = await fetch(`${API_URL}/api/marketing/schedules/${encodeURIComponent(currentItemId)}/${channel}`, {
                method: 'PUT',
                headers: authHeaders(),
                body: JSON.stringify(body)
            });
            const data = await response.json();
            statusEl.textContent = data.success ? 'Saved.' : (data.message || 'Save failed.');
            setTimeout(() => { statusEl.textContent = ''; }, 3000);
        } catch (error) {
            console.error('Error saving channel schedule:', error);
            statusEl.textContent = 'Save failed.';
        }
    }

    async function deleteChannelSchedule(channel) {
        if (!await UIDialogs.showConfirm({ title: 'Remove schedule?', message: `Remove the ${CHANNEL_LABELS[channel]} schedule for this item? Posts already sent stay in the history below.`, confirmText: 'Remove Schedule', danger: true })) return;

        try {
            await fetch(`${API_URL}/api/marketing/schedules/${encodeURIComponent(currentItemId)}/${channel}`, {
                method: 'DELETE',
                headers: authHeaders()
            });
            document.getElementById(`tab-${channel}`).innerHTML = renderChannelTab(channel, null);
        } catch (error) {
            console.error('Error deleting channel schedule:', error);
        }
    }

    // =====================================================
    // STATUS / HISTORY TABLE
    // =====================================================

    let statusPosts = []; // cache of the last-loaded status table rows, so the edit modal doesn't need its own fetch

    async function loadStatusTable() {
        const status = document.getElementById('status-filter').value;
        const url = new URL(`${API_URL}/api/marketing/status`);
        if (status) url.searchParams.set('status', status);

        try {
            const response = await fetch(url, { headers: authHeaders() });
            const data = await response.json();
            const tbody = document.getElementById('status-table-body');
            statusPosts = data.posts || [];
            if (!data.success || !statusPosts.length) {
                tbody.innerHTML = '<tr><td colspan="6" class="text-muted">No posts found.</td></tr>';
                return;
            }

            tbody.innerHTML = statusPosts.map(post => {
                const item = marketingItems.find(i => i.squareItemId === post.SquareItemID);
                const scheduledFor = formatWallClockDateTime(post.ScheduledFor);
                const detail = post.FailureReason || (post.PostContent?.dryRun ? 'dry run -- sender not yet configured' : '');
                const caption = post.PostContent?.caption || '';
                const imageUrl = post.PostContent?.imageUrl || '';
                const aiTag = post.PostContent?.aiRegenerated ? ' <span class="channel-badge enabled">AI</span>' : '';
                const thumb = imageUrl
                    ? `<img src="${escapeAttr(imageUrl)}" alt="" style="width:40px;height:40px;object-fit:cover;border-radius:4px;float:left;margin-right:8px;">`
                    : '';
                const actions = [];
                if (post.Status === 'draft') {
                    // AI regeneration assumes a single source item -- doesn't apply to a digest, which rounds up everything.
                    if (post.PostType !== 'digest') {
                        actions.push(`<button type="button" class="btn btn-outline-secondary btn-sm" onclick="MarketingPage.regenerateCaption(${post.ID}, this)">Regenerate with AI</button>`);
                    }
                    actions.push(`<button type="button" class="btn btn-outline-primary btn-sm ms-1" onclick="MarketingPage.approvePost(${post.ID}, this)">Approve</button>`);
                }
                if (post.Status === 'approved' && post.Channel === 'email') {
                    actions.push(`<button type="button" class="btn btn-success btn-sm ms-1" onclick="MarketingPage.sendPostNow(${post.ID}, this)">Send Now</button>`);
                }
                if (post.Status === 'draft' || post.Status === 'approved') {
                    actions.push(`<button type="button" class="btn btn-outline-secondary btn-sm ms-1" onclick="MarketingPage.openEditPostModal(${post.ID})">Edit</button>`);
                }
                if (post.Status !== 'sent') {
                    actions.push(`<button type="button" class="btn btn-outline-danger btn-sm ms-1" onclick="MarketingPage.deletePost(${post.ID})">Delete</button>`);
                }
                return `
                    <tr>
                        <td>${escapeHtml(item ? item.name : post.SquareItemID)}</td>
                        <td>${escapeHtml(post.Channel)}</td>
                        <td>${escapeHtml(post.PostType)}</td>
                        <td>${escapeHtml(scheduledFor)}</td>
                        <td><span class="channel-badge ${post.Status === 'sent' ? 'enabled' : ''}">${escapeHtml(post.Status)}</span></td>
                        <td class="small" style="max-width: 320px;">${thumb}${escapeHtml(caption)}${aiTag}</td>
                        <td class="text-muted">${escapeHtml(detail)}</td>
                        <td>${actions.join('')}</td>
                    </tr>
                `;
            }).join('');
        } catch (error) {
            console.error('Error loading status table:', error);
        }
    }

    // One-off AI touch-up for a single draft post -- distinct from a
    // schedule's batch UseAiCaptions opt-in. Only ever runs when a human
    // clicks this button.
    async function regenerateCaption(postId, buttonEl) {
        buttonEl.disabled = true;
        buttonEl.textContent = 'Regenerating…';
        try {
            const response = await fetch(`${API_URL}/api/marketing/posts/${postId}/regenerate-caption`, {
                method: 'POST',
                headers: authHeaders()
            });
            const data = await response.json();
            if (!data.success) {
                UIDialogs.showMessage({ type: 'error', title: "Couldn't regenerate caption", message: data.message || 'The caption could not be regenerated.' });
                buttonEl.disabled = false;
                buttonEl.textContent = 'Regenerate with AI';
                return;
            }
            await loadStatusTable();
        } catch (error) {
            console.error('Error regenerating caption:', error);
            UIDialogs.showMessage({ type: 'error', title: "Couldn't regenerate caption", message: 'Something went wrong. Please try again.', details: error.message });
            buttonEl.disabled = false;
            buttonEl.textContent = 'Regenerate with AI';
        }
    }

    // The human-review gate -- a draft can't be sent until approved here.
    async function approvePost(postId, buttonEl) {
        buttonEl.disabled = true;
        try {
            const response = await fetch(`${API_URL}/api/marketing/posts/${postId}/approve`, {
                method: 'PUT',
                headers: authHeaders()
            });
            const data = await response.json();
            if (!data.success) {
                UIDialogs.showMessage({ type: 'error', title: "Couldn't approve post", message: data.message || 'The post could not be approved.' });
                buttonEl.disabled = false;
                return;
            }
            await loadStatusTable();
        } catch (error) {
            console.error('Error approving post:', error);
            UIDialogs.showMessage({ type: 'error', title: "Couldn't approve post", message: 'Something went wrong. Please try again.', details: error.message });
            buttonEl.disabled = false;
        }
    }

    // Real send -- email only for now. One message per active email
    // contact, fired right now rather than waiting on the automatic poller.
    async function sendPostNow(postId, buttonEl) {
        if (!await UIDialogs.showConfirm({ title: 'Send email now?', message: 'This sends the email right now to every active contact on your Email List.', confirmText: 'Send Now', danger: true })) return;

        buttonEl.disabled = true;
        buttonEl.textContent = 'Sending…';
        try {
            const response = await fetch(`${API_URL}/api/marketing/posts/${postId}/send-now`, {
                method: 'POST',
                headers: authHeaders()
            });
            const data = await response.json();
            if (!data.success) {
                UIDialogs.showMessage({ type: 'error', title: "Couldn't send email", message: data.message || 'The email could not be sent.' });
                buttonEl.disabled = false;
                buttonEl.textContent = 'Send Now';
                return;
            }
            UIDialogs.showMessage(data.failed
                ? { type: 'warning', title: 'Email sent, with failures', message: `Sent to ${data.sent} recipient(s). ${data.failed} could not be sent.` }
                : { type: 'success', title: 'Email sent', message: `Sent to ${data.sent} recipient(s).` });
            await loadStatusTable();
        } catch (error) {
            console.error('Error sending post:', error);
            UIDialogs.showMessage({ type: 'error', title: "Couldn't send email", message: 'Something went wrong. Check the post history before trying again, in case some emails went out.', details: error.message });
            buttonEl.disabled = false;
            buttonEl.textContent = 'Send Now';
        }
    }

    // =====================================================
    // EDIT / DELETE POST
    // =====================================================

    let editPostId = null;
    let editPostImageDataUrl = null; // set only if the admin picked a replacement file

    function openEditPostModal(postId) {
        const post = statusPosts.find(p => p.ID === postId);
        if (!post) return;

        editPostId = postId;
        editPostImageDataUrl = null;

        document.getElementById('edit-post-caption').value = post.PostContent?.caption || '';
        document.getElementById('edit-post-image-upload').value = '';
        document.getElementById('edit-post-error').classList.add('d-none');

        const imageUrl = post.PostContent?.imageUrl || '';
        const previewEl = document.getElementById('edit-post-image-preview');
        const emptyEl = document.getElementById('edit-post-image-empty');
        if (imageUrl) {
            previewEl.src = imageUrl;
            previewEl.style.display = 'block';
            emptyEl.style.display = 'none';
        } else {
            previewEl.style.display = 'none';
            emptyEl.style.display = 'block';
        }

        const modal = new bootstrap.Modal(document.getElementById('edit-post-modal'));
        modal.show();
    }

    function handleEditPostImageUpload(event) {
        const file = event.target.files[0];
        if (!file) return;

        if (!file.type.startsWith('image/')) {
            UIDialogs.fieldError(event.target, 'Choose an image file.');
            event.target.value = '';
            return;
        }
        // 4MB raw, not 5MB -- this gets base64-encoded into a JSON body (not
        // a presigned S3 PUT, since the server needs to run it through
        // sharp), and base64 inflates size ~33%. 4MB keeps the encoded
        // payload safely under the Lambda Function URL's 6MB request limit.
        if (file.size > 4 * 1024 * 1024) {
            UIDialogs.fieldError(event.target, 'That image is over 4 MB. Choose a smaller one.');
            event.target.value = '';
            return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            editPostImageDataUrl = e.target.result;
            const previewEl = document.getElementById('edit-post-image-preview');
            previewEl.src = editPostImageDataUrl;
            previewEl.style.display = 'block';
            document.getElementById('edit-post-image-empty').style.display = 'none';
        };
        reader.readAsDataURL(file);
    }

    async function saveEditPost() {
        const errorEl = document.getElementById('edit-post-error');
        errorEl.classList.add('d-none');
        const saveBtn = document.getElementById('edit-post-save-btn');
        saveBtn.disabled = true;

        const body = { caption: document.getElementById('edit-post-caption').value };
        if (editPostImageDataUrl) body.imageDataUrl = editPostImageDataUrl;

        try {
            const response = await fetch(`${API_URL}/api/marketing/posts/${editPostId}`, {
                method: 'PUT',
                headers: authHeaders(),
                body: JSON.stringify(body)
            });
            const data = await response.json();
            if (!data.success) {
                errorEl.textContent = data.message || 'Could not save changes.';
                errorEl.classList.remove('d-none');
                saveBtn.disabled = false;
                return;
            }
            bootstrap.Modal.getInstance(document.getElementById('edit-post-modal')).hide();
            await loadStatusTable();
        } catch (error) {
            console.error('Error saving post edit:', error);
            errorEl.textContent = 'Could not save changes.';
            errorEl.classList.remove('d-none');
        } finally {
            saveBtn.disabled = false;
        }
    }

    async function deletePost(postId) {
        if (!await UIDialogs.showConfirm({ title: 'Delete post?', message: "Delete this post? This can't be undone.", confirmText: 'Delete Post', danger: true })) return;

        try {
            const response = await fetch(`${API_URL}/api/marketing/posts/${postId}`, {
                method: 'DELETE',
                headers: authHeaders()
            });
            const data = await response.json();
            if (!data.success) {
                UIDialogs.showMessage({ type: 'error', title: "Couldn't delete post", message: data.message || 'The post could not be deleted.' });
                return;
            }
            await loadStatusTable();
        } catch (error) {
            console.error('Error deleting post:', error);
            UIDialogs.showMessage({ type: 'error', title: "Couldn't delete post", message: 'Something went wrong. Please try again.', details: error.message });
        }
    }

    // =====================================================
    // WIRING
    // =====================================================

    document.addEventListener('DOMContentLoaded', function() {
        loadDigestSettings();
        loadMarketingItems();
        loadStatusTable();
        loadCustomPresets();

        document.getElementById('save-digest-btn').addEventListener('click', saveDigestSettings);
        document.getElementById('digest-background-upload').addEventListener('change', handleDigestBackgroundUpload);
        document.getElementById('refresh-status-btn').addEventListener('click', loadStatusTable);
        document.getElementById('status-filter').addEventListener('change', loadStatusTable);
        document.getElementById('edit-post-save-btn').addEventListener('click', saveEditPost);
        document.getElementById('edit-post-image-upload').addEventListener('change', handleEditPostImageUpload);
    });

    // Exposed for inline onclick handlers, same pattern as client.js's
    // skeleton-key card actions.
    window.MarketingPage = {
        openScheduleModal,
        deleteItemSchedule,
        addOffsetRow,
        applyPreset,
        saveAsPreset,
        deleteSelectedPreset,
        saveChannelSchedule,
        deleteChannelSchedule,
        regenerateCaption,
        approvePost,
        sendPostNow,
        openEditPostModal,
        deletePost
    };
})();
