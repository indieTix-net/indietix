// showtimes.js -- the Showtimes page: add, change, re-seat or cancel the
// showtimes of an event IndieTix has its own copy of (native events).
// Server rules live in QRScanner/src/utils/native-events.mjs (SHOWTIME
// MANAGEMENT). Everything from the server or the user is set as text,
// never as HTML.
(function () {
    const API_URL = window.INDIETIX_API_URL;
    let rooms = [];
    let currentEvent = null;
    let editingShowingId = null;

    const $ = (id) => document.getElementById(id);

    async function api(method, path, body) {
        const response = await fetch(`${API_URL}${path}`, {
            method,
            headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}`, 'Content-Type': 'application/json' },
            body: body === undefined ? undefined : JSON.stringify(body)
        });
        let data = {};
        try { data = await response.json(); } catch (e) { /* no body */ }
        if (!response.ok) {
            const error = new Error(data.error || `Request failed (${response.status})`);
            error.details = data.details;
            throw error;
        }
        return data;
    }

    function el(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = text;
        return node;
    }

    // "2026-11-21 21:30:00" -> { date: "2026-11-21", time: "21:30" }
    function splitStartsAt(startsAt) {
        return { date: startsAt.slice(0, 10), time: startsAt.slice(11, 16) };
    }

    // Rooms, extras and room seats come from the shared showtime form
    // (showtime-form.js), the same one Add Movie and Add Event use.
    async function loadSettings() {
        rooms = (await ShowtimeForm.load({ onChange: updatePreview })).rooms;
    }

    async function loadEvents(selectId) {
        const select = $('event-select');
        try {
            const data = await api('GET', `/api/events${$('show-archived').checked ? '?archived=1' : ''}`);
            select.replaceChildren();
            const events = data.events || [];
            $('no-events').style.display = events.length ? 'none' : 'block';
            $('no-events').textContent = 'No movies or events yet. Ones made with Movie Info Lookup or Event Info Entry show up here.';
            const placeholder = el('option', null, events.length ? 'Choose one...' : 'None');
            placeholder.value = '';
            select.appendChild(placeholder);
            events.forEach((e) => {
                const next = e.nextStartsAt ? `next ${e.nextStartsAt.slice(0, 16)}` : 'no upcoming showtimes';
                const o = el('option', null, `${e.title} (${e.upcoming} upcoming, ${next})${e.status === 'archived' ? ' [archived]' : ''}`);
                o.value = e.id;
                select.appendChild(o);
            });
            if (selectId) select.value = String(selectId);
            await showEvent(select.value);
        } catch (error) {
            select.replaceChildren(el('option', null, 'Could not load'));
            $('no-events').style.display = 'block';
            $('no-events').textContent = error.message;
        }
    }

    async function showEvent(eventId) {
        stopEditing();
        if (!eventId) { currentEvent = null; $('event-panel').style.display = 'none'; return; }
        try {
            const data = await api('GET', `/api/events/${eventId}`);
            renderEvent(data.event);
        } catch (error) {
            await UIDialogs.showMessage({ type: 'error', title: 'Could not load showtimes', message: error.message });
        }
    }

    function statusText(s) {
        if (s.status === 'cancelled') return 'Cancelled';
        if (s.isPast) return 'Past';
        if (s.status === 'sold_out') return 'Sold out';
        return 'On sale';
    }

    function renderEvent(event) {
        currentEvent = event;
        $('event-panel').style.display = 'block';
        $('event-title').textContent = event.title;
        $('event-meta').textContent = [event.kind === 'movie' ? 'Movie' : 'Event', event.eventType, event.distributor, event.status === 'archived' ? 'Archived in Square (add a showtime to put it back on sale)' : null]
            .filter(Boolean).join(' · ');
        const body = $('showings-body');
        body.replaceChildren();
        if (event.showings.length === 0) {
            const tr = el('tr'); const td = el('td', 'text-muted', 'No showtimes'); td.colSpan = 7; tr.appendChild(td); body.appendChild(tr);
        }
        event.showings.forEach((s) => body.appendChild(showingRow(s)));
    }

    function showingRow(s) {
        const tr = el('tr', s.status === 'cancelled' ? 'is-cancelled' : (s.isPast ? 'is-past' : ''));
        const labelCell = el('td'); labelCell.appendChild(el('span', 'showtime-label', s.label)); tr.appendChild(labelCell);
        tr.appendChild(el('td', null, String(s.sold)));
        const capCell = el('td', null, s.capacity === null ? 'No limit' : String(s.capacity));
        const heldCell = el('td', null, String(s.heldSeats));
        tr.append(capCell, heldCell);
        tr.appendChild(el('td', null, s.available === null ? '—' : String(s.available)));
        tr.appendChild(el('td', null, statusText(s)));
        const actions = el('td'); const box = el('div', 'row-actions'); actions.appendChild(box); tr.appendChild(actions);
        const live = s.status !== 'cancelled' && !s.isPast;
        if (live) {
            const edit = el('button', 'btn btn-sm btn-outline-primary', 'Change time');
            edit.type = 'button';
            edit.addEventListener('click', () => startEditing(s));
            box.appendChild(edit);
        }
        if (s.status !== 'cancelled') {
            const seats = el('button', 'btn btn-sm btn-outline-secondary', 'Seats');
            seats.type = 'button';
            seats.addEventListener('click', () => editSeatsInRow(s, capCell, heldCell, box));
            box.appendChild(seats);
        }
        if (live) {
            const cancel = el('button', 'btn btn-sm btn-outline-danger', 'Cancel showtime');
            cancel.type = 'button';
            cancel.addEventListener('click', () => cancelShowtime(s));
            box.appendChild(cancel);
        }
        return tr;
    }

    function editSeatsInRow(s, capCell, heldCell, box) {
        const cap = el('input', 'form-control form-control-sm seat-input'); cap.type = 'number'; cap.min = '0'; cap.placeholder = 'No limit';
        cap.value = s.capacity === null ? '' : String(s.capacity);
        const held = el('input', 'form-control form-control-sm seat-input'); held.type = 'number'; held.min = '0'; held.value = String(s.heldSeats);
        capCell.replaceChildren(cap); heldCell.replaceChildren(held);
        const save = el('button', 'btn btn-sm btn-primary', 'Save seats'); save.type = 'button';
        const back = el('button', 'btn btn-sm btn-secondary', 'Never mind'); back.type = 'button';
        box.replaceChildren(save, back);
        back.addEventListener('click', () => renderEvent(currentEvent));
        save.addEventListener('click', async () => {
            save.disabled = true;
            try {
                const data = await api('PUT', `/api/events/${currentEvent.id}/showings/${s.id}/seats`, { capacity: cap.value.trim(), heldSeats: held.value.trim() });
                renderEvent(data.event);
                if (data.sync?.action === 'reopened') {
                    await UIDialogs.showMessage({ type: 'success', title: 'Back on sale', message: `There are seats again, so this showtime is back on sale in Square${data.sync.unarchived ? ` (and ${data.event.title} is no longer archived)` : ''}.` });
                } else if (data.sync?.action === 'sold_out') {
                    await UIDialogs.showMessage({ type: 'info', title: 'Sold out', message: `Every seat is now sold, so this showtime was taken off sale in Square${data.sync.archived ? `, and ${data.event.title} was archived (no other upcoming showtimes)` : ''}.` });
                } else if (data.sync?.error) {
                    await UIDialogs.showMessage({ type: 'warning', title: 'Seats saved', message: 'Seats were saved, but Square could not be updated to match. Check this showtime in Square.' });
                }
            } catch (error) {
                save.disabled = false;
                await UIDialogs.showMessage({ type: 'error', title: 'Seats not saved', message: error.message });
            }
        });
        cap.focus();
    }

    // The item's own style: extras inside the brackets for movies, after a dash for events.
    function currentLabel() {
        return ShowtimeForm.currentLabel(currentEvent?.kind);
    }

    function updatePreview() {
        const label = currentLabel();
        $('form-preview').textContent = label ? `Shows in Square as: ${label}` : '';
    }

    function startEditing(s) {
        editingShowingId = s.id;
        const { date, time } = splitStartsAt(s.startsAt);
        $('showtime-date').value = date;
        $('showtime-time').value = time;
        if (!rooms.includes(s.venue)) {
            const o = el('option', null, s.venue); o.value = s.venue; $('showtime-location').appendChild(o);
        }
        $('showtime-location').value = s.venue;
        const extras = s.descriptors ? s.descriptors.split(',').map((d) => d.trim()) : [];
        document.querySelectorAll('#descriptors-checkboxes input').forEach((i) => { i.checked = extras.includes(i.value); });
        $('seats-row').style.display = 'none';
        $('form-heading').textContent = `Change showtime: ${s.label}`;
        $('form-submit').textContent = 'Save change';
        $('form-cancel-edit').style.display = 'inline-block';
        updatePreview();
        $('showtime-form').scrollIntoView({ behavior: 'smooth' });
    }

    function stopEditing() {
        editingShowingId = null;
        $('showtime-form').reset();
        $('showtime-held').value = '0';
        $('seats-row').style.display = '';
        $('form-heading').textContent = 'Add a showtime';
        $('form-submit').textContent = 'Add showtime';
        $('form-cancel-edit').style.display = 'none';
        updatePreview();
    }

    async function submitForm(event) {
        event.preventDefault();
        if (!currentEvent) return;
        const form = ShowtimeForm.read(currentEvent.kind);
        if (!form) return;
        const label = form.label;
        const button = $('form-submit');
        button.disabled = true;
        try {
            let data;
            if (editingShowingId) {
                data = await api('PUT', `/api/events/${currentEvent.id}/showings/${editingShowingId}`, { label });
            } else {
                data = await api('POST', `/api/events/${currentEvent.id}/showings`, { label, capacity: form.capacity === null ? '' : String(form.capacity), heldSeats: String(form.heldSeats) });
            }
            stopEditing();
            renderEvent(data.event);
            if (data.unarchived) {
                await UIDialogs.showMessage({ type: 'success', title: 'Back on sale', message: `${data.event.title} was archived in Square; it's back on sale with the new showtime.` });
            }
            loadEvents(currentEvent.id);
        } catch (error) {
            await UIDialogs.showMessage({ type: 'error', title: editingShowingId ? 'Showtime not changed' : 'Showtime not added', message: error.message, details: error.details });
        } finally {
            button.disabled = false;
        }
    }

    async function cancelShowtime(s) {
        const soldNote = s.sold > 0
            ? ` ${s.sold} ticket${s.sold === 1 ? ' was' : 's were'} sold for it. Cancelling does not refund ${s.sold === 1 ? 'it' : 'them'}; refund ${s.sold === 1 ? 'it' : 'them'} from the Tickets page.`
            : '';
        const ok = await UIDialogs.showConfirm({
            title: 'Cancel this showtime?',
            message: `${s.label} comes off sale online and at the register.${soldNote}`,
            confirmText: 'Cancel showtime', danger: true
        });
        if (!ok) return;
        try {
            const data = await api('POST', `/api/events/${currentEvent.id}/showings/${s.id}/cancel`);
            renderEvent(data.event);
            const notes = [];
            if (data.soldTickets > 0) notes.push(`${data.soldTickets} sold ticket${data.soldTickets === 1 ? '' : 's'} still need${data.soldTickets === 1 ? 's' : ''} a refund.`);
            if (data.archived) notes.push('It was the last upcoming showtime, so the item is archived in Square.');
            if (data.archiveError) notes.push(data.archiveError);
            if (notes.length) await UIDialogs.showMessage({ type: data.archiveError ? 'warning' : 'success', title: 'Showtime cancelled', message: notes.join(' ') });
            loadEvents(currentEvent.id);
        } catch (error) {
            await UIDialogs.showMessage({ type: 'error', title: 'Showtime not cancelled', message: error.message, details: error.details });
        }
    }

    // ---- Bring in existing Square items (native events step 4) ----
    function importSummary(report) {
        const lines = [];
        const showtimes = report.imported.reduce((n, i) => n + i.showtimes, 0);
        lines.push(`${report.imported.length} item${report.imported.length === 1 ? '' : 's'} with ${showtimes} showtime${showtimes === 1 ? '' : 's'}${report.dryRun ? ' would be added' : ' added'}.`);
        if (!report.dryRun) {
            const linked = report.imported.reduce((n, i) => n + (i.ticketsLinked || 0), 0);
            lines.push(`${linked} ticket${linked === 1 ? '' : 's'} already sold now show${linked === 1 ? 's' : ''} which showtime ${linked === 1 ? 'it is' : 'they are'} for.`);
        }
        if (report.skipped.length) lines.push(`${report.skipped.length} skipped (${[...new Set(report.skipped.map((s) => s.reason))].join('; ')}).`);
        const full = report.imported.reduce((n, i) => n + (i.full || []).length, 0);
        if (full && report.dryRun) {
            lines.push(report.enforceCapacity
                ? `${full} showtime${full === 1 ? ' is' : 's are'} already full and will be taken off sale in Square.`
                : `${full} showtime${full === 1 ? ' is' : 's are'} already full; they stay on sale because "Stop selling a showtime when it's full" is off in Client Settings.`);
        } else if (full) {
            const soldOut = report.imported.reduce((n, i) => n + (i.soldOut || []).length, 0);
            lines.push(report.enforceCapacity
                ? `${soldOut} full showtime${soldOut === 1 ? ' was' : 's were'} taken off sale in Square.`
                : `${full} showtime${full === 1 ? ' is' : 's are'} already full but still on sale ("Stop selling a showtime when it's full" is off).`);
        }
        return lines.join(' ');
    }
    function importDetails(report) {
        const parts = report.imported.map((i) => `${i.title}: ${i.showtimes} showtimes${(i.full || []).length ? ` (full: ${i.full.join('; ')})` : ''}`);
        report.problems.forEach((p) => parts.push(`${p.title}: ${p.problem}`));
        return parts.slice(0, 40).join(' \u2022 ') + (parts.length > 40 ? ` \u2022 ...and ${parts.length - 40} more` : '');
    }
    async function runImport() {
        const button = $('import-btn');
        button.disabled = true;
        try {
            const preview = await api('POST', '/api/events/import-from-square', { dryRun: true });
            if (preview.imported.length === 0) {
                await UIDialogs.showMessage({ type: 'info', title: 'Nothing new to bring in', message: importSummary(preview), details: importDetails(preview) });
                return;
            }
            const go = await UIDialogs.showConfirm({
                title: 'Bring these into IndieTix?',
                message: `${importSummary(preview)}${preview.problems.length ? ` ${preview.problems.length} need${preview.problems.length === 1 ? 's' : ''} a look (listed below). ` : ' '}${preview.enforceCapacity && preview.imported.some((i) => (i.full || []).length) ? 'Only the full showtimes change in Square.' : 'Nothing changes in Square.'}`,
                details: importDetails(preview),
                confirmText: 'Bring them in'
            });
            if (!go) return;
            const result = await api('POST', '/api/events/import-from-square', { dryRun: false });
            await UIDialogs.showMessage({ type: result.problems.length ? 'warning' : 'success', title: 'Brought in', message: importSummary(result), details: importDetails(result) });
            await loadEvents($('event-select').value);
        } catch (error) {
            await UIDialogs.showMessage({ type: 'error', title: 'Could not bring items in', message: error.message, details: error.details });
        } finally {
            button.disabled = false;
        }
    }

    document.addEventListener('DOMContentLoaded', async () => {
        $('import-btn').addEventListener('click', runImport);
        $('event-select').addEventListener('change', (e) => showEvent(e.target.value));
        $('show-archived').addEventListener('change', () => loadEvents($('event-select').value));
        $('showtime-form').addEventListener('submit', submitForm);
        $('form-cancel-edit').addEventListener('click', stopEditing);
        ['showtime-date', 'showtime-time'].forEach((id) => $(id).addEventListener('input', updatePreview));
        $('showtime-location').addEventListener('change', updatePreview); // seats follow the room in showtime-form.js
        await loadSettings();
        await loadEvents(new URLSearchParams(location.search).get('event'));
    });
})();
