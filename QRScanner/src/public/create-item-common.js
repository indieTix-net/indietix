// create-item-common.js -- what Movie Info Lookup (getMovieInfo.js) and Event
// Info Entry (getEventInfo.js) share besides the showtime form
// (showtime-form.js). Plain global functions, loaded before each page's script.

/** Upload an image straight to S3 through a presigned URL; returns its URL. */
async function uploadBlobToS3(blob, filename, folder = 'movie-posters') {
    // Step 1: get a presigned PUT URL from our backend
    const presignedResponse = await fetch(`${window.INDIETIX_API_URL}/api/presigned-upload`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${localStorage.getItem('authToken')}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({ fileName: filename, contentType: blob.type || 'image/jpeg', folder })
    });
    if (!presignedResponse.ok) {
        const errorData = await presignedResponse.json().catch(() => ({}));
        throw new Error(errorData.error || `Failed to get upload URL: ${presignedResponse.status}`);
    }
    const presignedData = await presignedResponse.json();

    // Step 2: PUT the file directly to S3 (bypasses Lambda / Express body limits)
    const uploadResponse = await fetch(presignedData.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': blob.type || 'image/jpeg' },
        body: blob
    });
    if (!uploadResponse.ok) throw new Error(`S3 upload failed: ${uploadResponse.status}`);
    return presignedData.fileUrl;
}

/** Which integrations (Google Calendar etc.) are set up; null if it can't tell. */
async function loadIntegrationStatus() {
    try {
        const response = await fetch(`${window.INDIETIX_API_URL}/api/integrations/status`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` }
        });
        if (!response.ok) return null;
        return await response.json();
    } catch (error) {
        console.warn('Could not check integration settings:', error);
        return null;
    }
}

/** Untick and grey out "Create calendar events", saying why. */
function disableCalendarCheckbox() {
    const checkbox = document.getElementById('create-calendar-events');
    if (!checkbox) return;
    checkbox.checked = false;
    checkbox.disabled = true;
    const label = document.querySelector('label[for="create-calendar-events"]');
    if (label) {
        const note = document.createElement('small');
        note.className = 'd-block text-muted';
        note.textContent = 'Google Calendar is not set up in Client Settings (service account key and calendar ID).';
        label.appendChild(note);
    }
}
