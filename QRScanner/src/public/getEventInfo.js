// getEventInfo.js - Event Information Entry and Square Integration

// API URL - call Lambda directly
const API_URL = window.INDIETIX_API_URL;

// State management
let currentEventData = null;
let showtimes = []; // Array of showtime objects { date, time, location, descriptors, formatted }
let eventLocations = []; // Will be loaded from client config
let eventDescriptors = []; // Will be loaded from client config
let customPosterFile = null; // Store uploaded poster file
let customPosterUrl = null; // Will be set to S3 URL after upload

// Load event locations and descriptors from client configuration
async function loadEventLocations() {
    // Rooms, extras and room seats from Client Settings, through the shared
    // showtime form (showtime-form.js) the Showtimes page uses too.
    const settings = await ShowtimeForm.load();
    eventLocations = settings.rooms;
    eventDescriptors = settings.descriptors;
}

// The showtime as Square shows it; see showtime-form.js (events put extras
// after a dash, as Add Event always has).
function formatShowtime(dateString, timeString, location, descriptors = []) {
    return ShowtimeForm.formatShowtime(dateString, timeString, location, descriptors, 'event');
}

// Add a showtime to the list
function addShowtime() {
    // Read and check date, time, room, extras and seats (shared showtime form).
    const form = ShowtimeForm.read('event');
    if (!form) return;
    if (showtimes.some(st => st.formatted === form.label)) {
        UIDialogs.fieldError(document.getElementById('showtime-date'), 'That showtime is already in the list.');
        return;
    }
    showtimes.push({
        date: form.date,
        time: form.time,
        location: form.room,
        descriptors: form.extras,
        formatted: form.label,
        capacity: form.capacity,
        heldSeats: form.heldSeats
    });
    // Keep date and room for the next one; seats back to the room's.
    ShowtimeForm.clearForNext();
    renderShowtimes();
}

// Remove a showtime from the list
function removeShowtime(index) {
    showtimes.splice(index, 1);
    renderShowtimes();
}

// Render the showtimes list
function renderShowtimes() {
    const showtimesList = document.getElementById('showtimes-list');
    
    if (showtimes.length === 0) {
        showtimesList.innerHTML = '<p class="text-muted">No showtimes added yet.</p>';
        document.getElementById('showtime-warning').style.display = 'block';
        return;
    }
    
    document.getElementById('showtime-warning').style.display = 'none';
    
    showtimesList.innerHTML = showtimes.map((showtime, index) => `
        <div class="showtime-item">
            <span class="showtime-text">${showtime.formatted} <small class="text-muted">(${ShowtimeForm.describeSeats(showtime.capacity, showtime.heldSeats)})</small></span>
            <button class="btn btn-sm btn-danger" onclick="removeShowtime(${index})">Remove</button>
        </div>
    `).join('');
}

// Handle custom poster upload
function handlePosterUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    
    // Validate file type
    if (!file.type.startsWith('image/')) {
        UIDialogs.fieldError(event.target, 'Choose an image file.');
        return;
    }
    
    // Validate file size (max 5MB)
    if (file.size > 5 * 1024 * 1024) {
        UIDialogs.fieldError(event.target, 'That image is over 5 MB. Choose a smaller one.');
        return;
    }
    
    customPosterFile = file;
    
    // Read file as data URL for preview
    const reader = new FileReader();
    reader.onload = function(e) {
        customPosterUrl = e.target.result;
        
        // Show preview in form section
        const previewImg = document.getElementById('poster-preview-img');
        const previewDiv = document.getElementById('poster-preview');
        if (previewImg && previewDiv) {
            previewImg.src = customPosterUrl;
            previewDiv.style.display = 'block';
        }
        
        // Update status text
        const statusDiv = document.getElementById('custom-poster-status');
        const filenameSpan = document.getElementById('custom-poster-filename');
        if (statusDiv && filenameSpan) {
            filenameSpan.textContent = `Uploaded: ${file.name}`;
            statusDiv.style.display = 'block';
        }
        
        console.log('Custom poster uploaded:', file.name);
    };
    reader.readAsDataURL(file);
}

// Remove custom poster
function removeCustomPoster() {
    customPosterFile = null;
    customPosterUrl = null;
    
    // Clear file input
    const fileInput = document.getElementById('custom-poster-upload');
    if (fileInput) fileInput.value = '';
    
    // Hide preview in form section
    const previewDiv = document.getElementById('poster-preview');
    if (previewDiv) previewDiv.style.display = 'none';
    
    // Hide status
    const statusDiv = document.getElementById('custom-poster-status');
    if (statusDiv) statusDiv.style.display = 'none';
    
    // Update event poster if in details view
    if (currentEventData) {
        const eventPoster = document.getElementById('event-poster');
        const noPoster = document.querySelector('.no-poster');
        if (eventPoster && noPoster) {
            eventPoster.style.display = 'none';
            noPoster.style.display = 'flex';
        }
    }
    
    console.log('Custom poster removed');
}

// Upload custom poster to S3 (same logic as movie system)
async function uploadCustomPosterToS3() {
    if (!customPosterFile) {
        return null;
    }
    try {
        // Shared with the other create page (create-item-common.js).
        customPosterUrl = await uploadBlobToS3(customPosterFile, customPosterFile.name, 'movie-posters');
        console.log('Custom poster uploaded successfully:', customPosterUrl);
        return customPosterUrl;
    } catch (error) {
        console.error('Error uploading custom poster:', error);
        throw new Error(`Failed to upload custom poster: ${error.message}`);
    }
}

// Handle event form submission
async function handleEventFormSubmit(event) {
    event.preventDefault();
    
    const title = document.getElementById('event-title').value.trim();
    const performer = document.getElementById('event-performer').value.trim();
    const genre = document.getElementById('event-genre').value.trim();
    const description = document.getElementById('event-description').value.trim();
    
    if (!title) {
        return UIDialogs.fieldError(document.getElementById('event-title'), 'Enter the event title.');
    }
    if (!description) {
        return UIDialogs.fieldError(document.getElementById('event-description'), 'Enter a description.');
    }
    
    // Upload poster to S3 if one was selected (same as movie system)
    let posterUrl = null;
    if (customPosterFile) {
        try {
            posterUrl = await uploadCustomPosterToS3();
        } catch (error) {
            await UIDialogs.showMessage({ type: 'warning', title: "Poster didn't upload", message: 'The event will continue without a poster. You can add one in Square later.', details: error.message });
            console.error(error);
        }
    }
    
    // Store event data
    currentEventData = {
        title,
        performer,
        genre,
        description,
        posterUrl: posterUrl // S3 URL or null
    };
    
    // Show event details section
    document.querySelector('.event-form-section').style.display = 'none';
    document.getElementById('event-details').style.display = 'block';
    
    // Populate display fields
    document.getElementById('display-title').textContent = title;
    document.getElementById('display-performer').textContent = performer || 'N/A';
    document.getElementById('display-genre').textContent = genre || 'N/A';
    document.getElementById('display-description').textContent = description;
    
    // Show poster if available
    const eventPoster = document.getElementById('event-poster');
    const noPoster = document.querySelector('.no-poster');
    
    if (customPosterUrl) {
        eventPoster.src = customPosterUrl;
        eventPoster.style.display = 'block';
        if (noPoster) noPoster.style.display = 'none';
    } else {
        eventPoster.style.display = 'none';
        if (noPoster) noPoster.style.display = 'flex';
    }
    
    // Update copy formats
    updateCopyFormats();
    
    console.log('Event data prepared:', currentEventData);
}

// Update copy formats
function updateCopyFormats() {
    if (!currentEventData) return;
    
    // Calendar event title format
    const titleFormat = `${currentEventData.title}${currentEventData.performer ? ` - ${currentEventData.performer}` : ''}`;
    document.getElementById('format-title').value = titleFormat;
    
    // Event description format
    let descriptionFormat = `${currentEventData.title}\n`;
    if (currentEventData.performer) {
        descriptionFormat += `Performer: ${currentEventData.performer}\n`;
    }
    if (currentEventData.genre) {
        descriptionFormat += `Genre: ${currentEventData.genre}\n`;
    }
    descriptionFormat += `\n${currentEventData.description}`;
    
    document.getElementById('format-description').value = descriptionFormat;
}

// Create event item in Square
async function createSquareItem() {
    if (!currentEventData) {
        UIDialogs.showMessage({ type: 'error', title: "Couldn't create item", message: 'The event details are missing. Go back and fill in the event form.' });
        return;
    }
    
    if (showtimes.length === 0) {
        UIDialogs.fieldError(document.getElementById('showtime-date'), 'Add at least one showtime before creating the item in Square.');
        return;
    }
    
    const createButton = document.getElementById('create-square-item');
    const buttonText = createButton.querySelector('.btn-text');
    const buttonLoading = createButton.querySelector('.btn-loading');
    
    // Disable button and show loading
    createButton.disabled = true;
    buttonText.style.display = 'none';
    buttonLoading.style.display = 'inline';
    
    try {
        // Prepare event data for API
        const eventPayload = {
            title: currentEventData.title,
            performer: currentEventData.performer,
            genre: currentEventData.genre,
            description: currentEventData.description,
            posterUrl: currentEventData.posterUrl,
            showtimes: showtimes.map(st => st.formatted),
            showtimeSeats: showtimes.map(st => ({ capacity: st.capacity, heldSeats: st.heldSeats })),
            onlineDisplayName: currentEventData.title
        };
        
        // Check if calendar events should be created
        const createCalendarEvents = document.getElementById('create-calendar-events').checked;
        
        console.log('Creating Square item with data:', eventPayload);
        console.log('Create calendar events:', createCalendarEvents);
        
        const response = await fetch(`${API_URL}/api/square/create-event-item`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('authToken')}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                eventData: eventPayload,
                createCalendarEvents: createCalendarEvents
            })
        });
        
        const data = await response.json();
        
        if (!response.ok) {
            throw new Error(data.error || 'Failed to create item in Square');
        }
        
        console.log('Square item created successfully:', data);
        
        // Show success message with link.
        // Square's API can't set Square Online fulfillment, so it's a manual step.
        UIDialogs.showMessage({
            type: 'success',
            title: 'Event created in Square',
            message: `${data.message || 'The event item was created.'}\n\nOne more step: in Square, set this item's fulfillment to Pickup only (turn off Shipping and Delivery).`,
            link: [
                ...(data.squareUrl ? [{ href: data.squareUrl, text: 'View in Square' }] : []),
                ...(data.eventId ? [{ href: new URL(`showtimes.html?event=${data.eventId}`, window.location.href).href, text: 'Manage its showtimes' }] : [])
            ]
        });
        
        // Reset form
        resetForm();
        
    } catch (error) {
        console.error('Error creating Square item:', error);
        UIDialogs.showMessage({ type: 'error', title: "Couldn't create item in Square", message: error.message });
    } finally {
        // Re-enable button
        createButton.disabled = false;
        buttonText.style.display = 'inline';
        buttonLoading.style.display = 'none';
    }
}

// Reset form and go back to initial state
function resetForm() {
    // Clear event data
    currentEventData = null;
    showtimes = [];
    customPosterFile = null;
    customPosterUrl = null;
    
    // Reset form inputs
    document.getElementById('event-form').reset();
    
    // Hide preview
    const previewDiv = document.getElementById('poster-preview');
    if (previewDiv) previewDiv.style.display = 'none';
    
    const statusDiv = document.getElementById('custom-poster-status');
    if (statusDiv) statusDiv.style.display = 'none';
    
    // Clear showtime inputs
    document.getElementById('showtime-date').value = '';
    document.getElementById('showtime-time').value = '';
    document.getElementById('showtime-location').value = '';
    
    // Uncheck all descriptor checkboxes
    document.querySelectorAll('#descriptors-checkboxes input[type="checkbox"]').forEach(cb => {
        cb.checked = false;
    });
    
    // Clear showtimes list
    renderShowtimes();
    
    // Show form section, hide details section
    document.querySelector('.event-form-section').style.display = 'block';
    document.getElementById('event-details').style.display = 'none';
    
    console.log('Form reset');
}

// Copy text to clipboard
function copyToClipboard(elementId) {
    const element = document.getElementById(elementId);
    
    if (element.tagName === 'TEXTAREA' || element.tagName === 'INPUT') {
        element.select();
        element.setSelectionRange(0, 99999); // For mobile devices
    }
    
    navigator.clipboard.writeText(element.value).then(() => {
        // Show temporary success feedback
        const button = document.querySelector(`[data-copy="${elementId}"]`);
        if (button) {
            const originalText = button.textContent;
            button.textContent = 'Copied!';
            button.classList.add('btn-secondary');
            button.classList.remove('btn-success');
            
            setTimeout(() => {
                button.textContent = originalText;
                button.classList.remove('btn-secondary');
                button.classList.add('btn-success');
            }, 2000);
        }
    }).catch(err => {
        console.error('Failed to copy:', err);
        UIDialogs.showMessage({ type: 'error', title: "Couldn't copy", message: 'Your browser blocked copying to the clipboard. Select the text and copy it yourself.' });
    });
}

// Initialize page
document.addEventListener('DOMContentLoaded', function() {
    console.log('Event Info page loaded');
    
    // Load event locations and descriptors
    loadEventLocations();

    // Disable the calendar checkbox if Google Calendar isn't set up (see INTEGRATION STATUS)
    loadIntegrationStatus().then((status) => {
        if (status && !status.eventCalendar) disableCalendarCheckbox();
    });
    
    // Event form submission
    const eventForm = document.getElementById('event-form');
    if (eventForm) {
        eventForm.addEventListener('submit', handleEventFormSubmit);
    }
    
    // Back to form button
    const backToFormButton = document.getElementById('back-to-form');
    if (backToFormButton) {
        backToFormButton.addEventListener('click', function() {
            document.getElementById('event-details').style.display = 'none';
            document.querySelector('.event-form-section').style.display = 'block';
        });
    }
    
    // Custom poster upload
    const posterUpload = document.getElementById('custom-poster-upload');
    if (posterUpload) {
        posterUpload.addEventListener('change', handlePosterUpload);
    }
    
    // Remove custom poster button
    const removePosterButton = document.getElementById('remove-custom-poster');
    if (removePosterButton) {
        removePosterButton.addEventListener('click', removeCustomPoster);
    }
    
    // Add showtime button
    const addShowtimeButton = document.getElementById('add-showtime-btn');
    if (addShowtimeButton) {
        addShowtimeButton.addEventListener('click', addShowtime);
    }
    
    // Create Square item button
    const createSquareButton = document.getElementById('create-square-item');
    if (createSquareButton) {
        createSquareButton.addEventListener('click', createSquareItem);
    }
    
    // Copy buttons
    document.querySelectorAll('[data-copy]').forEach(button => {
        button.addEventListener('click', function() {
            const targetId = this.getAttribute('data-copy');
            copyToClipboard(targetId);
        });
    });
    
    console.log('Event Info page initialized');
});


// ---- END INTEGRATION STATUS ----
