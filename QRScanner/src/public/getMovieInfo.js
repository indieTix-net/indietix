// getMovieInfo.js - Movie Information Lookup and Square Integration

// API URL - call Lambda directly
const API_URL = window.INDIETIX_API_URL;

// State management
let currentMovieData = null;
let showtimes = []; // Array of showtime objects { date, time, location, descriptors, formatted }
let eventLocations = []; // Will be loaded from client config
let eventDescriptors = []; // Will be loaded from client config

// NEW: Timeline state management
let currentTimelineDate = null;
let currentTimelineLocation = null;
let existingShowtimes = [];
let bufferMinutes = 15;  // Default, will be loaded from config

// Load event locations and descriptors from client configuration
async function loadEventLocations() {
    try {
        const response = await fetch(`${API_URL}/api/client/ui-config`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('authToken')}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            throw new Error('Failed to load client configuration');
        }
        
        const data = await response.json();
        const config = data.client?.configuration || {};
        
        // Get EVENT_LOCATIONS array, default to these locations if not set
        eventLocations = config.EVENT_LOCATIONS || ['Main Auditorium', 'Little Theater', 'Spacement'];
        
        // Populate location dropdown
        const locationSelect = document.getElementById('showtime-location');
        locationSelect.innerHTML = '<option value="">Select location...</option>';
        
        eventLocations.forEach(location => {
            const option = document.createElement('option');
            option.value = location;
            option.textContent = location;
            locationSelect.appendChild(option);
        });
        
        console.log('Event locations loaded:', eventLocations);
        
        // Get EVENT_DESCRIPTORS array, default to empty if not set
        eventDescriptors = config.EVENT_DESCRIPTORS || [];
        
        // Populate descriptor checkboxes
        const descriptorsCheckboxes = document.getElementById('descriptors-checkboxes');
        const descriptorsRow = document.getElementById('descriptors-row');
        
        if (eventDescriptors.length > 0) {
            descriptorsCheckboxes.innerHTML = eventDescriptors.map((descriptor, index) => `
                <div class="descriptor-checkbox">
                    <input type="checkbox" id="descriptor-${index}" value="${descriptor}">
                    <label for="descriptor-${index}">${descriptor}</label>
                </div>
            `).join('');
            descriptorsRow.style.display = 'block';
        } else {
            descriptorsRow.style.display = 'none';
        }
        
        console.log('Event descriptors loaded:', eventDescriptors);
        
    } catch (error) {
        console.error('Error loading event locations:', error);
        // Use default locations as fallback
        eventLocations = ['Main Auditorium', 'Little Theater', 'Spacement'];
        eventDescriptors = [];
        
        const locationSelect = document.getElementById('showtime-location');
        locationSelect.innerHTML = '<option value="">Select location...</option>';
        eventLocations.forEach(location => {
            const option = document.createElement('option');
            option.value = location;
            option.textContent = location;
            locationSelect.appendChild(option);
        });
    }
}

// Format a date/time/location/descriptors combo into Square modifier format
// Format: "DayOfWeek MM-DD-YYYY HH:MM AM/PM (Location, descriptor1, descriptor2)"
// Example: "Sun 01-18-2026 7:00 PM (Spacement, All ages, Closed Captioned)"
// Or without descriptors: "Sun 01-18-2026 7:00 PM (Spacement)"
function formatShowtime(dateString, timeString, location, descriptors = []) {
    const date = new Date(`${dateString}T${timeString}`);
    
    // Get day of week (short form)
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dayOfWeek = days[date.getDay()];
    
    // Format date as MM-DD-YYYY
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const year = date.getFullYear();
    const formattedDate = `${month}-${day}-${year}`;
    
    // Format time as HH:MM AM/PM
    let hours = date.getHours();
    const minutes = String(date.getMinutes()).padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12 || 12; // Convert to 12-hour format
    const formattedTime = `${hours}:${minutes} ${ampm}`;
    
    // Build location/descriptor part
    let locationPart = location;
    if (descriptors && descriptors.length > 0) {
        locationPart += ', ' + descriptors.join(', ');
    }
    
    // Combine into final format
    return `${dayOfWeek} ${formattedDate} ${formattedTime} (${locationPart})`;
}

// Add a showtime to the list
function addShowtime() {
    const dateInput = document.getElementById('showtime-date');
    const timeInput = document.getElementById('showtime-time');
    const locationSelect = document.getElementById('showtime-location');
    
    const date = dateInput.value;
    const time = timeInput.value;
    const location = locationSelect.value;
    
    // Validate inputs
    if (!date) return UIDialogs.fieldError(dateInput, 'Choose a date.');
    if (!time) return UIDialogs.fieldError(timeInput, 'Choose a time.');
    if (!location) return UIDialogs.fieldError(locationSelect, 'Choose a location.');
    
    // Get selected descriptors (optional)
    const descriptorCheckboxes = document.querySelectorAll('#descriptors-checkboxes input[type="checkbox"]:checked');
    const descriptors = Array.from(descriptorCheckboxes).map(cb => cb.value);
    
    // Format the showtime with descriptors
    const formatted = formatShowtime(date, time, location, descriptors);
    
    // Add to showtimes array
    const showtimeObj = {
        date,
        time,
        location,
        descriptors,
        formatted
    };
    
    showtimes.push(showtimeObj);
    
    // Clear time input only (keep date and location for next showtime)
    timeInput.value = '';
    
    // Uncheck all descriptor checkboxes
    descriptorCheckboxes.forEach(cb => cb.checked = false);
    
    // Re-render showtimes list
    renderShowtimesList();
    
    // Update timeline to show newly added showtime
    renderTimeline();
    checkConflicts();
    
    // Hide warning if showtimes exist
    updateSquareButtonWarning();
}

// Remove a showtime from the list
function removeShowtime(index) {
    showtimes.splice(index, 1);
    renderShowtimesList();
    renderTimeline();  // Update timeline visual
    checkConflicts();  // Update conflict status
    updateSquareButtonWarning();
}

// Render the showtimes list
function renderShowtimesList() {
    const listContainer = document.getElementById('showtimes-list');
    
    if (showtimes.length === 0) {
        listContainer.innerHTML = '';
        return;
    }
    
    listContainer.innerHTML = showtimes.map((showtime, index) => `
        <div class="showtime-item">
            <div class="showtime-item-info">
                ${showtime.formatted}
            </div>
            <div class="showtime-item-actions">
                <button class="btn btn-sm btn-danger" onclick="removeShowtime(${index})">
                    Remove
                </button>
            </div>
        </div>
    `).join('');
}

// Update warning message for Square button
function updateSquareButtonWarning() {
    const warning = document.getElementById('showtime-warning');
    if (showtimes.length === 0) {
        warning.style.display = 'block';
    } else {
        warning.style.display = 'none';
    }
}

// Initialize the page
document.addEventListener('DOMContentLoaded', function() {
    // Load event locations from client config
    loadEventLocations();

    // Warn up front about integrations that aren't set up (see INTEGRATION STATUS)
    loadIntegrationStatus().then((status) => {
        if (!status) return;
        if (!status.omdb) showOmdbMissingWarning();
        if (!status.cinemaCalendar) disableCalendarCheckbox();
    });
    
    // Search form submission
    const searchForm = document.getElementById('search-form');
    searchForm.addEventListener('submit', handleSearch);
    
    // Add showtime button
    const addShowtimeBtn = document.getElementById('add-showtime-btn');
    addShowtimeBtn.addEventListener('click', addShowtime);
    
    // Custom poster upload
    const customPosterUpload = document.getElementById('custom-poster-upload');
    customPosterUpload.addEventListener('change', handleCustomPosterUpload);
    
    const removeCustomPosterBtn = document.getElementById('remove-custom-poster');
    removeCustomPosterBtn.addEventListener('click', removeCustomPoster);
    
    // Update copy formats when editable fields change
    const editableFields = ['edit-title', 'edit-year', 'edit-rated', 'edit-runtime', 'edit-plot'];
    editableFields.forEach(fieldId => {
        const field = document.getElementById(fieldId);
        if (field) {
            field.addEventListener('input', updateCopyFormats);
        }
    });
    
    // Back to results button
    const backBtn = document.getElementById('back-to-results');
    backBtn.addEventListener('click', function() {
        document.getElementById('movie-details').style.display = 'none';
        document.getElementById('search-results').style.display = 'block';
        
        // Clear showtimes when going back
        showtimes = [];
        renderShowtimesList();
        updateSquareButtonWarning();
    });
    
    // Create Square item button
    const createSquareBtn = document.getElementById('create-square-item');
    createSquareBtn.addEventListener('click', createSquareItem);
    
    // Copy buttons
    document.querySelectorAll('[data-copy]').forEach(button => {
        button.addEventListener('click', function() {
            const targetId = this.getAttribute('data-copy');
            const target = document.getElementById(targetId);
            
            target.select();
            document.execCommand('copy');
            
            // Visual feedback
            const originalText = this.textContent;
            this.textContent = 'Copied!';
            setTimeout(() => {
                this.textContent = originalText;
            }, 2000);
        });
    });
    
    // Download poster button
    const downloadPosterBtn = document.getElementById('copy-poster-url');
    downloadPosterBtn.addEventListener('click', downloadPoster);
    
    // Initialize warning state
    updateSquareButtonWarning();
    
    // NEW: Initialize timeline visualization
    initializeTimeline();
});
// Search handling
async function handleSearch(e) {
    e.preventDefault();
    
    const searchBtn = document.getElementById('search-btn');
    const title = document.getElementById('movie-title').value.trim();
    const year = document.getElementById('movie-year').value.trim();
    
    if (!title) {
        showError('Please enter a movie title');
        return;
    }
    
    // Show loading state
    searchBtn.disabled = true;
    searchBtn.querySelector('.btn-text').style.display = 'none';
    searchBtn.querySelector('.btn-loading').style.display = 'inline';
    
    try {
        // Search OMDB through our backend (it holds the venue's OMDB key)
        let url = `${API_URL}/api/omdb/search?title=${encodeURIComponent(title)}`;
        
        if (year) {
            url += `&year=${encodeURIComponent(year)}`;
        }
        
        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` }
        });
        const data = await response.json();
        
        if (data.Response === 'False') {
            showError(data.Error || 'No movies found');
            return;
        }
        
        displaySearchResults(data.Search);
        
    } catch (error) {
        console.error('Search error:', error);
        showError('An error occurred while searching. Please try again.');
    } finally {
        // Reset button state
        searchBtn.disabled = false;
        searchBtn.querySelector('.btn-text').style.display = 'inline';
        searchBtn.querySelector('.btn-loading').style.display = 'none';
    }
}

// Display search results
function displaySearchResults(movies) {
    const resultsContainer = document.getElementById('results-container');
    const resultsSection = document.getElementById('search-results');
    const errorMessage = document.getElementById('error-message');
    
    errorMessage.style.display = 'none';
    resultsSection.style.display = 'block';
    document.getElementById('movie-details').style.display = 'none';
    
    resultsContainer.innerHTML = movies.map(movie => `
        <div class="result-card" onclick="selectMovie('${movie.imdbID}')">
            <img src="${movie.Poster !== 'N/A' ? movie.Poster : 'https://via.placeholder.com/300x450?text=No+Poster'}" 
                 alt="${movie.Title}">
            <h4>${movie.Title}</h4>
            <p>${movie.Year}</p>
        </div>
    `).join('');
}

// Custom poster upload state
let customPosterFile = null;
let customPosterUrl = null; // Will be set after S3 upload

// Update copy formats based on current editable field values
function updateCopyFormats() {
    const title = document.getElementById('edit-title').value;
    const year = document.getElementById('edit-year').value;
    const rated = document.getElementById('edit-rated').value;
    const runtime = document.getElementById('edit-runtime').value;
    const plot = document.getElementById('edit-plot').value;
    
    document.getElementById('format-title').value = `${title} (${year})`;
    document.getElementById('format-description').value = 
        `${title} (${year})\nRated: ${rated} | Runtime: ${runtime}\n\n${plot}`;
}

// Handle custom poster file selection
function handleCustomPosterUpload(event) {
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
    customPosterUrl = null; // Reset URL until upload
    
    // Show file status
    const statusDiv = document.getElementById('custom-poster-status');
    const filenameSpan = document.getElementById('custom-poster-filename');
    filenameSpan.textContent = `Custom: ${file.name}`;
    statusDiv.style.display = 'block';
    
    // Preview the custom poster
    const reader = new FileReader();
    reader.onload = function(e) {
        document.getElementById('movie-poster').src = e.target.result;
    };
    reader.readAsDataURL(file);
}

// Remove custom poster
function removeCustomPoster() {
    customPosterFile = null;
    customPosterUrl = null;
    
    // Hide status
    document.getElementById('custom-poster-status').style.display = 'none';
    document.getElementById('custom-poster-upload').value = '';
    
    // Restore original poster
    const poster = document.getElementById('movie-poster');
    if (currentMovieData && currentMovieData.Poster !== 'N/A') {
        poster.src = currentMovieData.Poster;
    } else {
        poster.src = 'https://via.placeholder.com/400x600?text=No+Poster';
    }
}

// Reset custom poster upload state
function resetCustomPosterUpload() {
    customPosterFile = null;
    customPosterUrl = null;
    document.getElementById('custom-poster-status').style.display = 'none';
    document.getElementById('custom-poster-upload').value = '';
}

// Create a Blob (image/jpeg) of a 600x600 square-letterboxed version of the poster.
// Accepts either a File object (custom uploads) or a URL string (OMDb).
// Black bars on left/right for a 2:3 movie poster — image is preserved, not cropped.
// Fetch the OMDb poster through our backend. Returns a Blob, or null if the
// venue has no OMDB key set or the movie has no poster.
async function fetchOmdbPosterBlob(imdbID) {
    try {
        const response = await fetch(`${API_URL}/api/omdb/poster/${encodeURIComponent(imdbID)}`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` }
        });
        if (!response.ok) return null;
        const { contentType, data } = await response.json();
        const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
        return new Blob([bytes], { type: contentType });
    } catch (error) {
        console.warn('Could not fetch OMDb poster:', error);
        return null;
    }
}

async function createSquarePosterBlob(source) {
    return new Promise((resolve, reject) => {
        const tempImg = new Image();

        tempImg.onload = function () {
            try {
                const canvas = document.createElement('canvas');
                const ctx = canvas.getContext('2d');
                const size = 600;
                canvas.width = size;
                canvas.height = size;

                // Black letterbox background
                ctx.fillStyle = '#000000';
                ctx.fillRect(0, 0, size, size);

                // Draw poster centered, preserving aspect ratio
                const imgAspect = tempImg.width / tempImg.height;
                let drawWidth, drawHeight, offsetX, offsetY;
                if (imgAspect > 1) {
                    drawWidth = size;
                    drawHeight = size / imgAspect;
                    offsetX = 0;
                    offsetY = (size - drawHeight) / 2;
                } else {
                    drawHeight = size;
                    drawWidth = size * imgAspect;
                    offsetX = (size - drawWidth) / 2;
                    offsetY = 0;
                }
                ctx.drawImage(tempImg, offsetX, offsetY, drawWidth, drawHeight);

                // toBlob throws / yields null if the canvas was tainted by a cross-origin image
                canvas.toBlob((blob) => {
                    if (blob) resolve(blob);
                    else reject(new Error('Failed to create blob from canvas (possible CORS taint)'));
                }, 'image/jpeg', 0.95);
            } catch (err) {
                reject(err);
            }
        };
        tempImg.onerror = () => reject(new Error('Failed to load poster image for cropping'));

        if (typeof source === 'string') {
            // URL path - need crossOrigin to avoid canvas tainting
            tempImg.crossOrigin = 'anonymous';
            tempImg.src = source;
        } else if (source instanceof Blob) {
            // Local file, or a poster fetched through our backend - read
            // first, then load into the image element
            const reader = new FileReader();
            reader.onload = (e) => { tempImg.src = e.target.result; };
            reader.onerror = () => reject(new Error('Failed to read poster image'));
            reader.readAsDataURL(source);
        } else {
            reject(new Error('Invalid poster source type'));
        }
    });
}

// Upload a Blob to S3 via the existing presigned-upload flow. Returns the public S3 URL.
async function uploadBlobToS3(blob, filename, folder = 'movie-posters') {
    // Step 1: get a presigned PUT URL from our backend
    const presignedResponse = await fetch(`${API_URL}/api/presigned-upload`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${localStorage.getItem('authToken')}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            fileName: filename,
            contentType: blob.type || 'image/jpeg',
            folder: folder
        })
    });

    if (!presignedResponse.ok) {
        const errorData = await presignedResponse.json().catch(() => ({}));
        throw new Error(errorData.error || `Failed to get upload URL: ${presignedResponse.status}`);
    }

    const presignedData = await presignedResponse.json();

    // Step 2: PUT the blob directly to S3 (bypasses Lambda / Express body limits)
    const uploadResponse = await fetch(presignedData.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': blob.type || 'image/jpeg' },
        body: blob
    });

    if (!uploadResponse.ok) {
        throw new Error(`S3 upload failed: ${uploadResponse.status}`);
    }

    return presignedData.fileUrl;
}

// Upload custom poster to S3
async function uploadCustomPosterToS3() {
    if (!customPosterFile) {
        return null;
    }
    
    try {
        console.log('Uploading custom poster to S3...');
        
        // Step 1: Get presigned upload URL from backend
        const presignedResponse = await fetch(`${API_URL}/api/presigned-upload`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('authToken')}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                fileName: customPosterFile.name,
                contentType: customPosterFile.type,
                folder: 'movie-posters'
            })
        });
        
        if (!presignedResponse.ok) {
            const errorData = await presignedResponse.json();
            throw new Error(errorData.error || 'Failed to get upload URL');
        }
        
        const presignedData = await presignedResponse.json();
        console.log('Presigned URL obtained');
        
        // Step 2: Upload file directly to S3 using presigned URL
        const uploadResponse = await fetch(presignedData.uploadUrl, {
            method: 'PUT',
            headers: {
                'Content-Type': customPosterFile.type
            },
            body: customPosterFile // Upload file directly (no base64 needed!)
        });
        
        if (!uploadResponse.ok) {
            throw new Error(`Failed to upload to S3: ${uploadResponse.status}`);
        }
        
        customPosterUrl = presignedData.fileUrl;
        console.log('Custom poster uploaded successfully:', customPosterUrl);
        
        return customPosterUrl;
        
    } catch (error) {
        console.error('Error uploading custom poster:', error);
        throw new Error(`Failed to upload custom poster: ${error.message}`);
    }
}

// Select and display movie details
async function selectMovie(imdbID) {
    try {
        const response = await fetch(`${API_URL}/api/omdb/movie/${encodeURIComponent(imdbID)}`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` }
        });
        const movie = await response.json();
        
        if (movie.Response === 'False') {
            showError(movie.Error || 'Failed to load movie details');
            return;
        }
        
        currentMovieData = movie;
        displayMovieDetails(movie);
        
    } catch (error) {
        console.error('Error loading movie details:', error);
        showError('An error occurred while loading movie details');
    }
}

// Display movie details
function displayMovieDetails(movie) {
    // Hide search results, show details
    document.getElementById('search-results').style.display = 'none';
    document.getElementById('movie-details').style.display = 'block';
    
    // Populate EDITABLE movie info fields
    document.getElementById('edit-title').value = movie.Title;
    document.getElementById('edit-year').value = movie.Year;
    document.getElementById('edit-rated').value = movie.Rated;
    document.getElementById('edit-runtime').value = movie.Runtime;
    document.getElementById('edit-genre').value = movie.Genre;
    document.getElementById('edit-director').value = movie.Director;
    document.getElementById('edit-actors').value = movie.Actors;
    document.getElementById('edit-production').value = movie.Production || 'N/A';
    document.getElementById('edit-plot').value = movie.Plot;
    document.getElementById('detail-rating').textContent = `${movie.imdbRating}/10 (${movie.imdbVotes} votes)`;
    
    // Trailer info (OMDB doesn't provide this, so we'll show IMDB link)
    const trailerP = document.getElementById('detail-trailer');
    if (movie.imdbID) {
        trailerP.innerHTML = `<a href="https://www.imdb.com/title/${movie.imdbID}" target="_blank">View on IMDb</a>`;
    } else {
        trailerP.textContent = 'N/A';
    }
    
    // Set poster
    const poster = document.getElementById('movie-poster');
    if (movie.Poster !== 'N/A') {
        poster.src = movie.Poster;
    } else {
        poster.src = 'https://via.placeholder.com/400x600?text=No+Poster';
    }
    
    // Reset custom poster upload state
    resetCustomPosterUpload();
    
    // Copy formats - will be updated when values change
    updateCopyFormats();
    
    // Reset showtimes for new movie
    showtimes = [];
    renderShowtimesList();
    updateSquareButtonWarning();
    
    console.log('displayMovieDetails finished');
    
    // If a date is selected, refresh the timeline to show existing showtimes
    const dateInput = document.getElementById('showtime-date');
    console.log('Date input value:', dateInput?.value);
    
    if (dateInput && dateInput.value) {
        console.log('Date is set, calling updateTimeline()...');
        updateTimeline();
    } else {
        console.log('Date not set, skipping timeline refresh');
    }
}

// Show error message
function showError(message) {
    const errorDiv = document.getElementById('error-message');
    errorDiv.textContent = message;
    errorDiv.style.display = 'block';
    
    document.getElementById('search-results').style.display = 'none';
    document.getElementById('movie-details').style.display = 'none';
    
    // Auto-hide after 5 seconds
    setTimeout(() => {
        errorDiv.style.display = 'none';
    }, 5000);
}
// Download poster function
async function downloadPoster() {
    if (!currentMovieData || !currentMovieData.Poster || currentMovieData.Poster === 'N/A') {
        UIDialogs.showMessage({ type: 'info', title: 'No poster', message: "OMDb doesn't have a poster for this movie." });
        return;
    }
    
    try {
        // Open poster in new tab
        window.open(currentMovieData.Poster, '_blank');
    } catch (error) {
        console.error('Error opening poster:', error);
        UIDialogs.showMessage({ type: 'error', title: "Couldn't open poster", message: error.message });
    }
}

// Create Square item with showtimes

async function createSquareItem() {
    // Validate showtimes
    if (showtimes.length === 0) {
        document.getElementById('showtime-warning').style.display = 'block';
        return;
    }
    
    document.getElementById('showtime-warning').style.display = 'none';
    
    const createBtn = document.getElementById('create-square-item');
    const btnText = createBtn.querySelector('.btn-text');
    const btnLoading = createBtn.querySelector('.btn-loading');
    
    try {
        createBtn.disabled = true;
        btnText.style.display = 'none';
        btnLoading.style.display = 'inline';
        
        // Determine the source for the poster:
        //   - Custom uploaded file takes priority
        //   - Otherwise the OMDb poster, fetched through our backend (which
        //     holds the venue's OMDB key) so the canvas crop isn't tainted
        //   - Fall back to currentMovieData.Poster (Amazon CDN URL) if that fails
        let posterSource = null;
        if (customPosterFile) {
            posterSource = customPosterFile;
        } else {
            posterSource = (currentMovieData.imdbID && await fetchOmdbPosterBlob(currentMovieData.imdbID))
                || (currentMovieData.Poster && currentMovieData.Poster !== 'N/A' ? currentMovieData.Poster : null);
        }

        // Crop to a 600x600 square (black letterboxing) and upload to S3 via presigned URL.
        // We upload to S3 instead of inlining the image in the JSON body to avoid
        // Express's body-parser size limit (and Lambda/API Gateway payload limits).
        let posterUrl = null;
        if (posterSource) {
            try {
                console.log('Creating 600x600 square-cropped poster...');
                const blob = await createSquarePosterBlob(posterSource);
                console.log(`Square poster generated (${Math.round(blob.size / 1024)}KB)`);

                const baseTitle = (currentMovieData.Title || currentMovieData.imdbID || 'poster')
                    .replace(/[^a-z0-9]/gi, '_')
                    .toLowerCase()
                    .substring(0, 80);
                const filename = `${baseTitle}_square_${Date.now()}.jpg`;

                console.log(`Uploading square poster to S3 as: ${filename}`);
                posterUrl = await uploadBlobToS3(blob, filename);
                console.log(`Square poster uploaded: ${posterUrl}`);
            } catch (cropOrUploadError) {
                console.error('Square poster generation/upload failed:', cropOrUploadError);
                if (typeof posterSource === 'string') {
                    // Fall back to the original (non-square) URL so the user at least gets a poster
                    console.warn('Falling back to original (non-square) poster URL');
                    posterUrl = posterSource;
                } else if (posterSource !== customPosterFile) {
                    // The fetched OMDb poster couldn't be processed; carry on without one
                    console.warn('Continuing without a poster');
                } else {
                    // Custom file failed - ask the user how to proceed
                    if (!await UIDialogs.showConfirm({ title: "Your poster didn't process", message: 'Use the OMDb poster for this movie instead?', details: cropOrUploadError.message, confirmText: 'Use OMDb Poster', cancelText: 'Stop' })) {
                        throw cropOrUploadError;
                    }
                    const fallbackPoster = currentMovieData.imdbID ? await fetchOmdbPosterBlob(currentMovieData.imdbID) : null;
                    if (fallbackPoster) {
                        try {
                            const fallbackBlob = await createSquarePosterBlob(fallbackPoster);
                            const fallbackName = `omdb_${currentMovieData.imdbID}_square_${Date.now()}.jpg`;
                            posterUrl = await uploadBlobToS3(fallbackBlob, fallbackName);
                        } catch (e) {
                            console.warn('OMDb fallback crop/upload also failed; using raw URL', e);
                            posterUrl = fallbackUrl;
                        }
                    }
                }
            }
        }
        
        // Get checkbox value
        const shouldCreateCalendarEvents = document.getElementById('create-calendar-events').checked;
        
        // Read values from EDITABLE fields
        const title = document.getElementById('edit-title').value;
        const year = document.getElementById('edit-year').value;
        const rated = document.getElementById('edit-rated').value;
        const runtime = document.getElementById('edit-runtime').value;
        const genre = document.getElementById('edit-genre').value;
        const director = document.getElementById('edit-director').value;
        const actors = document.getElementById('edit-actors').value;
        const production = document.getElementById('edit-production').value;
        const plot = document.getElementById('edit-plot').value;
        
        // Prepare movie data with EDITED values and showtimes
        const movieData = {
            imdbID: currentMovieData.imdbID,
            title: `${title} (${year})`,
            description: document.getElementById('format-description').value,
            year: year,
            rated: rated,
            runtime: runtime,
            genre: genre,
            director: director,
            actors: actors,
            production: production,
            plot: plot,
            posterUrl: posterUrl,
            showtimes: showtimes.map(st => st.formatted)
        };
        
        console.log('Creating Square item with data:', movieData);
        console.log('Create calendar events:', shouldCreateCalendarEvents);
        
        const response = await fetch(`${API_URL}/api/square/create-movie-item`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('authToken')}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ 
                movieData: movieData,
                createCalendarEvents: shouldCreateCalendarEvents,
                userTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone
            })
        });
        
        console.log('Response status:', response.status);
        console.log('Response headers:', response.headers);
        
        const responseText = await response.text();
        console.log('Response body:', responseText);
        
        let data;
        try {
            data = JSON.parse(responseText);
        } catch (parseError) {
            console.error('Failed to parse response as JSON:', parseError);
            throw new Error('Invalid response from server');
        }
        
        if (!response.ok) {
            throw new Error(data.error || data.details || 'Failed to create item');
        }
        
        // Square's API can't set Square Online fulfillment, so it's a manual step.
        UIDialogs.showMessage({
            type: 'success',
            title: 'Movie created in Square',
            message: `${data.message || 'The movie item was created.'}\n\nOne more step: in Square, set this item's fulfillment to Pickup only (turn off Shipping and Delivery).`,
            link: data.squareUrl ? { href: data.squareUrl, text: 'View in Square' } : undefined
        });
        
        // Clear showtimes after successful creation
        showtimes = [];
        renderShowtimesList();
        updateSquareButtonWarning();
        
        // Reset custom poster after successful creation
        resetCustomPosterUpload();
        
    } catch (error) {
        console.error('Error creating Square item:', error);
        UIDialogs.showMessage({ type: 'error', title: "Couldn't create item in Square", message: error.message });
    } finally {
        createBtn.disabled = false;
        btnText.style.display = 'inline';
        btnLoading.style.display = 'none';
    }
}

// Make removeShowtime globally accessible
window.removeShowtime = removeShowtime;
// Add these to getMovieInfo.js

// ==========================================
// ==========================================
// IMPROVED HORIZONTAL TIMELINE V2
// 12pm-12am Only, Simpler & More Readable
// ==========================================

const TIMELINE_START_HOUR = 13;  // 1pm
const TIMELINE_END_HOUR = 25;     // 1am next day (treat as hour 25)
const TIMELINE_HOURS = 12;  // 12 hours total (1pm-1am)

// Load buffer configuration
async function loadBufferConfig() {
    try {
        const response = await fetch(`${API_URL}/api/client/ui-config`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('authToken')}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (response.ok) {
            const data = await response.json();
            const config = data.client?.configuration || {};
            bufferMinutes = parseInt(config.SHOWTIME_BUFFER_MINUTES) || 15;
            console.log(`Buffer time configured: ${bufferMinutes} minutes`);
        }
    } catch (error) {
        console.warn('Could not load buffer config, using default:', error);
    }
}

// Fetch existing showtimes for a date and location
async function fetchShowtimesForDate(date, location) {
    try {
        const params = new URLSearchParams({ date });
        if (location) params.append('location', location);
        
        const response = await fetch(`${API_URL}/api/square/showtimes-for-date?${params}`, {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${localStorage.getItem('authToken')}`,
                'Content-Type': 'application/json'
            }
        });
        
        if (!response.ok) {
            throw new Error('Failed to fetch showtimes');
        }
        
        const data = await response.json();
        existingShowtimes = data.showtimes || [];
        return existingShowtimes;
    } catch (error) {
        console.error('Error fetching showtimes:', error);
        existingShowtimes = [];
        return [];
    }
}

// Update timeline when date or location changes
async function updateTimeline() {
    const dateInput = document.getElementById('showtime-date');
    const dateDisplay = document.getElementById('timeline-date-display');

    console.log('updateTimeline called');

    if (!dateInput) return;

    const showTimelineToggle = document.getElementById('show-timeline-toggle');
    if (showTimelineToggle && !showTimelineToggle.checked) {
        // Off by default -- skip the fetch entirely, not just the display,
        // so toggling this off actually avoids the async call.
        document.getElementById('timeline-visualization').style.display = 'none';
        existingShowtimes = [];
        return;
    }

    const date = dateInput.value;
    console.log('Selected date:', date);

    if (!date) {
        document.getElementById('timeline-visualization').style.display = 'none';
        return;
    }

    if (dateDisplay && date) {
        const d = new Date(date + 'T00:00:00');
        const dayName = d.toLocaleDateString('en-US', { weekday: 'short' });
        const monthDay = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        dateDisplay.textContent = `${dayName}, ${monthDay}`;
    }
    
    // Store current timeline state
    currentTimelineDate = date;
    
    // Show timeline
    document.getElementById('timeline-visualization').style.display = 'block';
    
    // Fetch all showtimes for this date (all locations)
    console.log('Fetching showtimes for date:', date);
    await fetchShowtimesForDate(date);
    console.log('Existing showtimes from Square:', existingShowtimes.length, existingShowtimes);
    
    renderTimeline();
    checkConflicts();
}

// Render timeline with V2 design (12pm-12am)
function renderTimeline() {
    const showTimelineToggle = document.getElementById('show-timeline-toggle');
    if (showTimelineToggle && !showTimelineToggle.checked) return;

    console.log('renderTimeline called');
    console.log('   - existingShowtimes:', existingShowtimes.length);
    console.log('   - local showtimes:', showtimes.length);
    
    // Get all three venue tracks
    const tracks = {
        'Main Auditorium': document.getElementById('timeline-track-main'),
        'Little Theater': document.getElementById('timeline-track-little'),
        'Spacement': document.getElementById('timeline-track-spacement')
    };
    
    // Clear all tracks
    Object.values(tracks).forEach(track => {
        if (track) {
            const movieBlocks = track.querySelectorAll('.movie-block, .buffer-zone');
            movieBlocks.forEach(block => block.remove());
        }
    });
    
    // Get selected date - parse as local midnight, not UTC midnight (prevents timezone shift)
    const dateInput = document.getElementById('showtime-date');
    const targetDate = dateInput.value ? new Date(dateInput.value + 'T00:00:00').toDateString() : null;
    
    console.log('   - Target date:', targetDate);
    
    // Render existing showtimes from Square to their respective tracks
    let renderedFromSquare = 0;
    existingShowtimes.forEach((showtime) => {
        const showtimeDate = new Date(showtime.startTime).toDateString();
        console.log('   - Checking showtime:', showtime.title, showtimeDate, 'vs', targetDate);
        
        if (targetDate && showtimeDate === targetDate) {
            const track = tracks[showtime.location];
            console.log('   - Rendering to track:', showtime.location, 'track exists:', !!track);
            
            if (track) {
                const block = createMovieBlockV2(showtime, 'existing');
                if (block) {
                    track.appendChild(block);
                    renderedFromSquare++;
                    console.log('   - Rendered:', showtime.title, 'at', showtime.location);
                }
                
                if (bufferMinutes > 0) {
                    const bufferBlock = createBufferBlockV2(showtime);
                    if (bufferBlock) track.appendChild(bufferBlock);
                }
            }
        }
    });
    
    console.log('   - Rendered', renderedFromSquare, 'showtimes from Square');
    
    // Render current movie's already-added showtimes to their respective tracks
    if (currentMovieData && showtimes.length > 0 && targetDate) {
        const runtime = extractRuntimeFromMovie(currentMovieData) || 120;
        
        showtimes.forEach(st => {
            // FIX: Parse as local midnight to avoid UTC timezone shift
            const stDate = new Date(st.date + 'T00:00:00');
            if (stDate.toDateString() === targetDate) {
                const [hours, minutes] = st.time.split(':').map(Number);
                const startTime = new Date(stDate.getFullYear(), stDate.getMonth(), stDate.getDate(), hours, minutes);
                const endTime = new Date(startTime.getTime() + runtime * 60 * 1000);
                
                const alreadyAddedShowtime = {
                    title: `${currentMovieData.Title}`,
                    location: st.location,
                    startTime: startTime.toISOString(),
                    endTime: endTime.toISOString(),
                    runtime
                };
                
                const track = tracks[st.location];
                if (track) {
                    const block = createMovieBlockV2(alreadyAddedShowtime, 'existing');
                    if (block) track.appendChild(block);
                    
                    if (bufferMinutes > 0) {
                        const bufferBlock = createBufferBlockV2(alreadyAddedShowtime);
                        if (bufferBlock) track.appendChild(bufferBlock);
                    }
                }
            }
        });
    }
    
    // Render preview to the selected location's track
    const timeInput = document.getElementById('showtime-time');
    const locationSelect = document.getElementById('showtime-location');
    if (timeInput.value && currentMovieData && locationSelect.value) {
        const previewShowtime = createPreviewShowtime();
        if (previewShowtime) {
            const conflicts = detectConflicts(previewShowtime);
            const classType = conflicts.hasHardConflict ? 'preview-conflict' : 
                            conflicts.hasBufferConflict ? 'preview-warning' : 'preview-ok';
            const track = tracks[locationSelect.value];
            if (track) {
                const block = createMovieBlockV2(previewShowtime, classType);
                if (block) track.appendChild(block);
            }
        }
    }
    
    // Update empty messages for each track
    Object.entries(tracks).forEach(([location, track]) => {
        if (track) {
            const emptyMessage = track.querySelector('.empty-timeline');
            const hasMovies = track.querySelectorAll('.movie-block').length > 0;
            if (emptyMessage) {
                emptyMessage.style.display = hasMovies ? 'none' : 'block';
            }
        }
    });
}

// Create movie block for V2 horizontal timeline (1pm-1am)
function createMovieBlockV2(showtime, type) {
    const start = new Date(showtime.startTime);
    const end = new Date(showtime.endTime);
    
    let startHour = start.getHours();
    let endHour = end.getHours();
    
    // Handle midnight wraparound: 0am and 1am become 24 and 25
    if (startHour >= 0 && startHour < TIMELINE_START_HOUR) {
        startHour += 24;
    }
    if (endHour >= 0 && endHour < TIMELINE_START_HOUR) {
        endHour += 24;
    }
    
    // Only show movies in 1pm-1am range (13-25)
    if (endHour < TIMELINE_START_HOUR || startHour >= TIMELINE_END_HOUR) {
        return null;
    }
    
    const block = document.createElement('div');
    block.className = `movie-block ${type}`;
    
    // Calculate position (0% = 1pm, 100% = 1am)
    const startMinutes = (startHour * 60 + start.getMinutes()) - (TIMELINE_START_HOUR * 60);
    const duration = (end - start) / (1000 * 60);
    
    const leftPercent = Math.max(0, (startMinutes / (TIMELINE_HOURS * 60)) * 100);
    const widthPercent = Math.min(100 - leftPercent, (duration / (TIMELINE_HOURS * 60)) * 100);
    
    // Debug logging
    console.log(`📍 ${showtime.title} | ${formatTime(start)} | Hour: ${startHour} | Minutes from 1pm: ${startMinutes} | Position: ${leftPercent.toFixed(1)}%`);
    
    // Set background color based on type (semi-transparent)
    let backgroundColor;
    if (type === 'existing') {
        backgroundColor = 'rgba(102, 126, 234, 0.85)'; // Purple, semi-transparent
    } else if (type === 'preview-ok') {
        backgroundColor = 'rgba(86, 171, 47, 0.85)'; // Green, semi-transparent
    } else if (type === 'preview-conflict') {
        backgroundColor = 'rgba(235, 51, 73, 0.85)'; // Red, semi-transparent
    } else if (type === 'preview-warning') {
        backgroundColor = 'rgba(247, 151, 30, 0.85)'; // Orange, semi-transparent
    }
    
    // FORCE positioning with cssText to override any CSS
    block.style.cssText = `
        position: absolute !important;
        left: ${leftPercent}% !important;
        width: ${widthPercent}% !important;
        height: 60px;
        border-radius: 6px;
        padding: 8px;
        font-size: 12px;
        color: white;
        overflow: hidden;
        cursor: pointer;
        box-shadow: 0 2px 4px rgba(0,0,0,0.1);
        background: ${backgroundColor} !important;
        border: 2px solid rgba(255,255,255,0.3);
    `;
    
    console.log(`✅ Set styles: left=${leftPercent}%, width=${widthPercent}%, bg=${backgroundColor}`);
    
    // Content
    const title = showtime.title.replace(' (New)', '').replace(' (Already Added)', '').replace(' (Added)', '');
    const startTimeStr = formatTime(start);
    const endTimeStr = formatTime(end);
    
    block.innerHTML = `
        <div class="movie-title" title="${title}">${title}</div>
        <div class="movie-time">${startTimeStr} - ${endTimeStr}</div>
    `;
    
    return block;
}

// Create buffer zone block for V2
function createBufferBlockV2(showtime) {
    const end = new Date(showtime.endTime);
    const bufferEnd = new Date(end.getTime() + bufferMinutes * 60 * 1000);
    
    let endHour = end.getHours();
    
    // Handle midnight wraparound: 0am and 1am become 24 and 25
    if (endHour >= 0 && endHour < TIMELINE_START_HOUR) {
        endHour += 24;
    }
    
    // Don't show buffer if movie ends after timeline range
    if (endHour >= TIMELINE_END_HOUR) {
        return null;
    }
    
    const block = document.createElement('div');
    block.className = 'buffer-zone';
    
    const endMinutes = (endHour * 60 + end.getMinutes()) - (TIMELINE_START_HOUR * 60);
    const bufferDuration = bufferMinutes;
    
    const leftPercent = Math.max(0, (endMinutes / (TIMELINE_HOURS * 60)) * 100);
    const widthPercent = Math.min(100 - leftPercent, (bufferDuration / (TIMELINE_HOURS * 60)) * 100);
    
    block.style.left = `${leftPercent}%`;
    block.style.width = `${widthPercent}%`;
    
    return block;
}

// Create preview showtime
function createPreviewShowtime() {
    const dateInput = document.getElementById('showtime-date');
    const timeInput = document.getElementById('showtime-time');
    const locationSelect = document.getElementById('showtime-location');
    
    if (!dateInput.value || !timeInput.value || !locationSelect.value || !currentMovieData) {
        return null;
    }
    
    const [hours, minutes] = timeInput.value.split(':').map(Number);
    // FIX: Parse as local midnight to avoid UTC timezone shift
    const date = new Date(dateInput.value + 'T00:00:00');
    const startTime = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hours, minutes);
    
    const runtime = extractRuntimeFromMovie(currentMovieData) || 120;
    const endTime = new Date(startTime.getTime() + runtime * 60 * 1000);
    
    return {
        title: `${currentMovieData.Title} (New)`,
        location: locationSelect.value,
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        runtime
    };
}

// Detect conflicts with existing and already-added showtimes
function detectConflicts(newShowtime) {
    if (!newShowtime) return { hasHardConflict: false, hasBufferConflict: false };
    
    const newStart = new Date(newShowtime.startTime);
    const newEnd = new Date(newShowtime.endTime);
    const newEndWithBuffer = new Date(newEnd.getTime() + bufferMinutes * 60 * 1000);
    
    let hasHardConflict = false;
    let hasBufferConflict = false;
    let conflictDetails = [];
    
    // Build combined list: existing + already-added
    const allShowtimesToCheck = [...existingShowtimes];
    
    if (currentMovieData && showtimes.length > 0) {
        const runtime = extractRuntimeFromMovie(currentMovieData) || 120;
        
        showtimes.forEach(st => {
            if (st.location === newShowtime.location) {
                const [hours, minutes] = st.time.split(':').map(Number);
                // FIX: Parse as local midnight to avoid UTC timezone shift
                const stDate = new Date(st.date + 'T00:00:00');
                const startTime = new Date(stDate.getFullYear(), stDate.getMonth(), stDate.getDate(), hours, minutes);
                const endTime = new Date(startTime.getTime() + runtime * 60 * 1000);
                
                const newDate = new Date(newShowtime.startTime);
                if (stDate.toDateString() === newDate.toDateString()) {
                    allShowtimesToCheck.push({
                        title: `${currentMovieData.Title} (Already Added)`,
                        location: st.location,
                        startTime: startTime.toISOString(),
                        endTime: endTime.toISOString(),
                        runtime
                    });
                }
            }
        });
    }
    
    // Check all showtimes
    allShowtimesToCheck.forEach(existing => {
        const existStart = new Date(existing.startTime);
        const existEnd = new Date(existing.endTime);
        const existEndWithBuffer = new Date(existEnd.getTime() + bufferMinutes * 60 * 1000);
        
        // Hard overlap
        if ((newStart < existEnd && newEnd > existStart)) {
            hasHardConflict = true;
            conflictDetails.push({
                type: 'hard',
                movie: existing.title,
                time: `${formatTime(existStart)} - ${formatTime(existEnd)}`
            });
        }
        // Buffer violation
        else if ((newStart < existEndWithBuffer && newStart >= existEnd)) {
            hasBufferConflict = true;
            conflictDetails.push({
                type: 'buffer',
                movie: existing.title,
                time: `${formatTime(existStart)} - ${formatTime(existEnd)}`
            });
        }
        else if ((newEndWithBuffer > existStart && newEnd <= existStart)) {
            hasBufferConflict = true;
            conflictDetails.push({
                type: 'buffer',
                movie: existing.title,
                time: `${formatTime(existStart)} - ${formatTime(existEnd)}`
            });
        }
    });
    
    return { hasHardConflict, hasBufferConflict, conflictDetails };
}

// Update status message (V2 - single clear message)
function updateStatusMessage(conflicts) {
    const statusDiv = document.getElementById('timeline-status-message');
    const statusIcon = document.getElementById('status-icon');
    const statusText = document.getElementById('status-text');
    
    if (!statusDiv || !statusIcon || !statusText) return;
    
    statusDiv.classList.remove('success', 'warning', 'error');
    
    if (!conflicts) {
        statusDiv.style.display = 'none';
        return;
    }
    
    statusDiv.style.display = 'flex';
    
    if (conflicts.hasHardConflict) {
        statusDiv.classList.add('error');
        statusIcon.textContent = '✗';
        const conflictMovie = conflicts.conflictDetails[0];
        statusText.textContent = `Time conflict with ${conflictMovie.movie} (${conflictMovie.time})`;
    } else if (conflicts.hasBufferConflict) {
        statusDiv.classList.add('warning');
        statusIcon.textContent = '!';
        const bufferMovie = conflicts.conflictDetails[0];
        statusText.textContent = `Less than ${bufferMinutes} min after ${bufferMovie.movie} - tight schedule!`;
    } else {
        statusDiv.classList.add('success');
        statusIcon.textContent = '✓';
        statusText.textContent = 'All clear - no conflicts!';
    }
}

// Check conflicts and update status
function checkConflicts() {
    const preview = createPreviewShowtime();
    
    if (!preview) {
        updateStatusMessage(null);
        return;
    }
    
    const conflicts = detectConflicts(preview);
    updateStatusMessage(conflicts);
}

// Time shortcut: Next available slot
function findNextAvailable() {
    const dateInput = document.getElementById('showtime-date');
    const timeInput = document.getElementById('showtime-time');
    const locationSelect = document.getElementById('showtime-location');
    
    if (!dateInput.value) return UIDialogs.fieldError(dateInput, 'Choose a date first.');
    if (!locationSelect.value) return UIDialogs.fieldError(locationSelect, 'Choose a location first.');
    if (!currentMovieData) return;
    
    const runtime = extractRuntimeFromMovie(currentMovieData) || 120;
    const location = locationSelect.value;
    // FIX: Parse as local midnight to avoid UTC timezone shift
    const date = new Date(dateInput.value + 'T00:00:00');
    
    // Combine all showtimes
    const allShowtimes = [...existingShowtimes];
    
    if (currentMovieData && showtimes.length > 0) {
        showtimes.forEach(st => {
            if (st.location === location) {
                const [hours, minutes] = st.time.split(':').map(Number);
                // FIX: Parse as local midnight to avoid UTC timezone shift
                const stDate = new Date(st.date + 'T00:00:00');
                if (stDate.toDateString() === date.toDateString()) {
                    const startTime = new Date(stDate.getFullYear(), stDate.getMonth(), stDate.getDate(), hours, minutes);
                    const endTime = new Date(startTime.getTime() + runtime * 60 * 1000);
                    allShowtimes.push({
                        startTime: startTime.toISOString(),
                        endTime: endTime.toISOString()
                    });
                }
            }
        });
    }
    
    // Sort by start time
    allShowtimes.sort((a, b) => new Date(a.startTime) - new Date(b.startTime));
    
    // Find gap
    let proposedStart = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12, 0);
    
    for (const showtime of allShowtimes) {
        const existEnd = new Date(showtime.endTime);
        const gapStart = new Date(existEnd.getTime() + bufferMinutes * 60 * 1000);
        const gapEnd = new Date(gapStart.getTime() + runtime * 60 * 1000);
        
        if (proposedStart < gapStart) {
            break;
        }
        
        proposedStart = gapStart;
    }
    
    const hours = proposedStart.getHours();
    const minutes = proposedStart.getMinutes();
    timeInput.value = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    
    updateTimeline();
}

// Time shortcut: Add to end
function addToEndOfDay() {
    const dateInput = document.getElementById('showtime-date');
    const timeInput = document.getElementById('showtime-time');
    
    if (!currentMovieData || existingShowtimes.length === 0) {
        UIDialogs.fieldError(dateInput, 'There are no showtimes on this date and location to add after.');
        return;
    }
    
    const lastShowtime = existingShowtimes[existingShowtimes.length - 1];
    const lastEnd = new Date(lastShowtime.endTime);
    const proposedStart = new Date(lastEnd.getTime() + bufferMinutes * 60 * 1000);
    
    const hours = proposedStart.getHours();
    const minutes = proposedStart.getMinutes();
    timeInput.value = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
    
    updateTimeline();
}

// Helper functions
function formatTime(date) {
    const hours = date.getHours();
    const minutes = date.getMinutes();
    const ampm = hours >= 12 ? 'PM' : 'AM';
    const displayHours = hours % 12 || 12;
    return `${displayHours}:${String(minutes).padStart(2, '0')} ${ampm}`;
}

function formatDateForDisplay(dateStr) {
    const date = new Date(dateStr + 'T00:00:00');
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function extractRuntimeFromMovie(movie) {
    if (movie.Runtime) {
        const match = movie.Runtime.match(/\d+/);
        if (match) return parseInt(match[0]);
    }
    return 120;
}


// Initialize timeline - set up event listeners
function initializeTimeline() {
    // Load buffer config
    loadBufferConfig();
    
    // Add event listeners to date/time/location inputs
    const dateInput = document.getElementById('showtime-date');
    const timeInput = document.getElementById('showtime-time');
    const locationSelect = document.getElementById('showtime-location');
    
    if (dateInput) dateInput.addEventListener('change', updateTimeline);
    if (locationSelect) locationSelect.addEventListener('change', updateTimeline);
    if (timeInput) {
        timeInput.addEventListener('input', () => {
            renderTimeline();
            checkConflicts();
        });
    }

    // Off by default -- checking it on fetches/shows immediately if a date
    // is already picked; unchecking hides it and stops the async fetch
    // (handled inside updateTimeline/renderTimeline themselves).
    const showTimelineToggle = document.getElementById('show-timeline-toggle');
    if (showTimelineToggle) {
        showTimelineToggle.addEventListener('change', () => {
            if (showTimelineToggle.checked) {
                updateTimeline();
            } else {
                document.getElementById('timeline-visualization').style.display = 'none';
                existingShowtimes = [];
                updateStatusMessage(null);
            }
        });
    }


    // Time shortcut buttons
    const btnEnd = document.getElementById('btn-add-to-end');
    const btnNext = document.getElementById('btn-next-available');
    
    if (btnEnd) btnEnd.addEventListener('click', addToEndOfDay);
    if (btnNext) btnNext.addEventListener('click', findNextAvailable);
}

// ---- INTEGRATION STATUS ----
// Asks the server which integrations Client Settings has set up (booleans
// only). Without Google Calendar the "Create event(s) in Google Calendar"
// box is unchecked and disabled, rather than left checked to "succeed" at
// nothing. If the check itself fails, the page is left as it was -- the
// server skips an unconfigured calendar on its own either way.
async function loadIntegrationStatus() {
    try {
        const response = await fetch(`${API_URL}/api/integrations/status`, {
            headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` }
        });
        if (!response.ok) return null;
        return await response.json();
    } catch (error) {
        console.warn('Could not check integration settings:', error);
        return null;
    }
}

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

// No OMDB key means search can't find anything: say so on load and disable
// the search form instead of letting every search fail.
function showOmdbMissingWarning() {
    const section = document.querySelector('.search-section');
    if (!section) return;
    const warning = document.createElement('div');
    warning.className = 'alert alert-warning';
    warning.innerHTML = '<strong>Movie lookup isn\'t set up.</strong> Add an OMDB API Key in Client Settings to search for movies. Search is disabled until then.';
    section.insertBefore(warning, section.querySelector('form'));
    document.querySelectorAll('#search-form input, #search-form button').forEach((el) => { el.disabled = true; });
}
// ---- END INTEGRATION STATUS ----
