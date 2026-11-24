// showtime-form.js -- the one showtime form, shared by Movie Info Lookup,
// Event Info Entry and the Showtimes page so they can't drift apart.
//
// Each page keeps its own markup with these ids (all optional except the
// first three): showtime-date, showtime-time, showtime-location,
// descriptors-row + descriptors-checkboxes, showtime-capacity, showtime-held.
// This file fills the room and extras choices from Client Settings, starts
// capacity at the room's seats, reads and checks the form, and builds the
// text Square shows (the same rules the server's parseShowtimeLabel reads).
(function () {
    const API_URL = window.INDIETIX_API_URL;
    const $ = (id) => document.getElementById(id);
    const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    let settings = { rooms: [], descriptors: [], roomCapacity: {} };

    /**
     * The showtime as Square shows it. Movies put extras inside the brackets,
     * events after a dash, as Add Movie and Add Event always have:
     *   movie: "Sun 01-18-2026 7:00 PM (Spacement, All ages)"
     *   event: "Sun 01-18-2026 7:00 PM (Spacement) - All ages"
     */
    function formatShowtime(dateString, timeString, room, extras = [], kind = 'movie') {
        const date = new Date(`${dateString}T${timeString}`);
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        let hours = date.getHours();
        const minutes = String(date.getMinutes()).padStart(2, '0');
        const ampm = hours >= 12 ? 'PM' : 'AM';
        hours = hours % 12 || 12;
        const when = `${DAYS[date.getDay()]} ${month}-${day}-${date.getFullYear()} ${hours}:${minutes} ${ampm}`;
        if (!extras.length) return `${when} (${room})`;
        return kind === 'event' ? `${when} (${room}) - ${extras.join(' - ')}` : `${when} (${room}, ${extras.join(', ')})`;
    }

    /** The room's seats from Client Settings ('' = no limit set). */
    function seatsForRoom(room) {
        const key = Object.keys(settings.roomCapacity).find((r) => r.trim().toLowerCase() === String(room).trim().toLowerCase());
        const seats = key === undefined ? '' : settings.roomCapacity[key];
        return seats === null || seats === undefined ? '' : String(seats);
    }

    function addOption(select, value, text) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = text;
        select.appendChild(option);
    }

    /**
     * Load rooms, extras and room seats from Client Settings and fill the
     * form's choices. onChange (optional) runs when an extra is ticked.
     */
    async function load({ onChange } = {}) {
        try {
            const response = await fetch(`${API_URL}/api/client/ui-config`, {
                headers: { Authorization: `Bearer ${localStorage.getItem('authToken')}`, 'Content-Type': 'application/json' }
            });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const config = (await response.json()).client?.configuration || {};
            settings = {
                rooms: Array.isArray(config.EVENT_LOCATIONS) && config.EVENT_LOCATIONS.length ? config.EVENT_LOCATIONS : ['Main Auditorium'],
                descriptors: Array.isArray(config.EVENT_DESCRIPTORS) ? config.EVENT_DESCRIPTORS : [],
                roomCapacity: config.ROOM_CAPACITY && typeof config.ROOM_CAPACITY === 'object' ? config.ROOM_CAPACITY : {}
            };
        } catch (error) {
            console.error('Could not load rooms from Client Settings:', error);
            settings = { rooms: ['Main Auditorium'], descriptors: [], roomCapacity: {} };
        }

        const select = $('showtime-location');
        if (select) {
            select.replaceChildren();
            addOption(select, '', 'Choose a room...');
            settings.rooms.forEach((room) => addOption(select, room, room));
            select.addEventListener('change', () => {
                const capacity = $('showtime-capacity');
                if (capacity) capacity.value = seatsForRoom(select.value);
            });
        }
        const box = $('descriptors-checkboxes');
        if (box) {
            box.replaceChildren();
            settings.descriptors.forEach((descriptor, i) => {
                const wrap = document.createElement('span');
                wrap.className = 'descriptor-checkbox';
                const input = document.createElement('input');
                input.type = 'checkbox';
                input.id = `descriptor-${i}`;
                input.value = descriptor;
                if (onChange) input.addEventListener('change', onChange);
                const label = document.createElement('label');
                label.htmlFor = input.id;
                label.textContent = descriptor;
                wrap.append(input, label);
                box.appendChild(wrap);
            });
        }
        const row = $('descriptors-row');
        if (row) row.style.display = settings.descriptors.length ? 'block' : 'none';
        return settings;
    }

    function selectedExtras() {
        return Array.from(document.querySelectorAll('#descriptors-checkboxes input:checked')).map((i) => i.value);
    }

    /** The label for what's typed now, or '' while date, time or room is missing. */
    function currentLabel(kind) {
        const date = $('showtime-date')?.value; const time = $('showtime-time')?.value; const room = $('showtime-location')?.value;
        return date && time && room ? formatShowtime(date, time, room, selectedExtras(), kind) : '';
    }

    // Capacity / held seats as typed; the same rules as the server.
    function checkSeats(capacityText, heldText) {
        const capacity = capacityText === '' ? null : Number(capacityText);
        const held = heldText === '' ? 0 : Number(heldText);
        if (capacity !== null && (!Number.isInteger(capacity) || capacity < 0)) return { error: 'Capacity must be a whole number of seats, or blank for no limit.', field: 'showtime-capacity' };
        if (!Number.isInteger(held) || held < 0) return { error: 'Held seats must be a whole number.', field: 'showtime-held' };
        if (capacity === null && held > 0) return { error: 'Held seats need a capacity to be held from.', field: 'showtime-held' };
        if (capacity !== null && held > capacity) return { error: "Held seats can't be more than the capacity.", field: 'showtime-held' };
        return { capacity, heldSeats: held };
    }

    /**
     * Read and check the form. Shows the problem next to the field and returns
     * null if something's missing; else { date, time, room, extras, label,
     * capacity, heldSeats } (capacity null = no limit; seats omitted when the
     * page has no seat boxes).
     */
    function read(kind) {
        const date = $('showtime-date'); const time = $('showtime-time'); const room = $('showtime-location');
        if (!date.value) { UIDialogs.fieldError(date, 'Choose a date.'); return null; }
        if (!time.value) { UIDialogs.fieldError(time, 'Choose a time.'); return null; }
        if (!room.value) { UIDialogs.fieldError(room, 'Choose a room.'); return null; }
        const result = { date: date.value, time: time.value, room: room.value, extras: selectedExtras() };
        result.label = formatShowtime(result.date, result.time, result.room, result.extras, kind);
        const capacity = $('showtime-capacity');
        if (capacity) {
            const seats = checkSeats(capacity.value.trim(), ($('showtime-held')?.value || '').trim());
            if (seats.error) { UIDialogs.fieldError($(seats.field), seats.error); return null; }
            result.capacity = seats.capacity;
            result.heldSeats = seats.heldSeats;
        }
        return result;
    }

    /** Ready for the next showtime: keep date and room, clear time and extras, seats back to the room's. */
    function clearForNext() {
        if ($('showtime-time')) $('showtime-time').value = '';
        document.querySelectorAll('#descriptors-checkboxes input').forEach((i) => { i.checked = false; });
        if ($('showtime-capacity')) $('showtime-capacity').value = seatsForRoom($('showtime-location')?.value || '');
        if ($('showtime-held')) $('showtime-held').value = '0';
    }

    /** "300 seats, 4 held" / "no limit" for a list of chosen showtimes. */
    function describeSeats(capacity, heldSeats) {
        if (capacity === null || capacity === undefined) return 'no seat limit';
        return `${capacity} seat${capacity === 1 ? '' : 's'}${heldSeats ? `, ${heldSeats} held` : ''}`;
    }

    window.ShowtimeForm = { load, formatShowtime, seatsForRoom, selectedExtras, currentLabel, checkSeats, read, clearForNext, describeSeats };
})();
