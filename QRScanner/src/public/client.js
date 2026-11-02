document.addEventListener('DOMContentLoaded', function() {
    console.log('Client.js DOMContentLoaded fired');
    console.log('Bootstrap available:', typeof bootstrap !== 'undefined');
    
    const API_URL = window.INDIETIX_API_URL;

    // Terms & Privacy page fields: [input id, Client.configuration key].
    const LEGAL_FIELDS = [
        ['legal_name', 'LEGAL_NAME'], ['legal_short_name', 'LEGAL_SHORT_NAME'],
        ['legal_address', 'LEGAL_ADDRESS'], ['legal_phone', 'LEGAL_PHONE'],
        ['legal_email', 'LEGAL_EMAIL'], ['legal_state', 'LEGAL_STATE'],
        ['legal_court_county', 'LEGAL_COURT_COUNTY']
    ];

    // ---- SECRET SETTINGS (write-only) ----
    // GET /api/client never sends these values, only savedSecrets (which
    // ones are set). Each box stays empty and read-only until "Change" is
    // clicked, so a password manager can't fill it (LastPass put the
    // venue's login into FTP1's password box on 2026-11-01, and Save stored
    // it), and Save sends only the secrets someone chose to change or
    // remove. PUT /api/client also treats a blank secret as "keep".
    const SECRET_FIELDS = [
        ['square-access-token', 'SQUARE_ACCESS_TOKEN'], ['square-signature-key', 'SQUARE_SIGNATURE_KEY'],
        ['google_service_account_key', 'GOOGLE_SERVICE_ACCOUNT_KEY'], ['anthropic_api_key', 'ANTHROPIC_API_KEY'],
        ['omdb_api_key', 'OMDB_API_KEY'], ['ftp1-password', 'FTP1_PASSWORD'],
        ['ftp2-password', 'FTP2_PASSWORD'], ['ftp3-password', 'FTP3_PASSWORD'],
        ['meta-page-access-token', 'META_PAGE_ACCESS_TOKEN'], ['tiktok-client-secret', 'TIKTOK_CLIENT_SECRET'],
        ['tiktok-access-token', 'TIKTOK_ACCESS_TOKEN'], ['tiktok-refresh-token', 'TIKTOK_REFRESH_TOKEN']
    ];
    const secretFields = SECRET_FIELDS.map(([id, key]) => {
        const input = document.getElementById(id);
        const field = { key, input, hint: input.placeholder, saved: false, mode: 'keep' };
        const bar = document.createElement('div');
        bar.className = 'd-flex flex-wrap gap-2 mt-1';
        field.changeBtn = document.createElement('button');
        field.removeBtn = document.createElement('button');
        for (const btn of [field.changeBtn, field.removeBtn]) {
            btn.type = 'button';
            btn.className = 'btn btn-sm btn-outline-secondary';
            bar.appendChild(btn);
        }
        field.removeBtn.textContent = 'Remove saved value';
        input.after(bar);
        field.changeBtn.addEventListener('click', () => {
            if (field.mode !== 'keep') return resetSecretField(field, field.saved);
            field.mode = 'change';
            input.readOnly = false;
            input.placeholder = field.saved ? 'New value (leave blank to keep the saved one)' : (field.hint || 'Enter a value');
            field.changeBtn.textContent = 'Cancel';
            field.removeBtn.hidden = true;
            input.focus();
        });
        field.removeBtn.addEventListener('click', () => {
            field.mode = 'remove';
            input.value = '';
            input.readOnly = true;
            input.placeholder = 'Will be removed when you save';
            field.changeBtn.textContent = 'Cancel';
            field.removeBtn.hidden = true;
        });
        return field;
    });
    function resetSecretField(field, saved) {
        field.saved = saved;
        field.mode = 'keep';
        field.input.value = '';
        field.input.readOnly = true;
        field.input.placeholder = saved ? 'Saved (hidden). Click Change to replace it.' : 'Not set. Click Change to enter one.';
        field.changeBtn.textContent = 'Change';
        field.removeBtn.hidden = !saved;
    }
    // ---- END SECRET SETTINGS ----

    // Get form elements
    const clientForm = document.getElementById('client-form');
    const loadingIndicator = document.getElementById('loading');
    const saveButton = document.getElementById('save-client-btn');
    const cancelButton = document.getElementById('cancel-btn');
    const userInfo = document.getElementById('user-info');
    
    // Client information fields
    const contactNameInput = document.getElementById('contact-name');
    const clientEmailInput = document.getElementById('client-email');
    const clientSecretInput = document.getElementById('client-secret');
    const confirmPasswordInput = document.getElementById('confirm-password');

    // ---- MASTER PASSWORD: CLIENT LOGIN ONLY ----
    // PUT /api/client refuses a clientSecret change from any sub-user (an
    // admin who could reset the master password could then log in as the
    // client), so don't offer the field to them at all.
    const isClientLogin = (() => {
        try {
            return JSON.parse(atob(localStorage.getItem('authToken').split('.')[1])).userType === 'client';
        } catch (e) {
            return false;
        }
    })();
    if (!isClientLogin) {
        clientSecretInput.closest('.row').hidden = true;
    }
    // ---- END MASTER PASSWORD ----
    
    // Configuration fields (USER_DEFINABLE)
    const squareAccessTokenInput = document.getElementById('square-access-token');
    const squareSignatureKeyInput = document.getElementById('square-signature-key');
    const squareWebhookUrlInput = document.getElementById('square-webhook-url');
    const squareLocationIdInput = document.getElementById('square-location-id');
    const distributorNameInput = document.getElementById('distributor-name');
    const eventTypeInput = document.getElementById('event-type');
    const theaterIdInput = document.getElementById('theater-id');
    const theaterNameInput = document.getElementById('theater-name');
    const webHeaderCompanyInput = document.getElementById('web-header-company');
    const logoFileInput = document.getElementById('logo-file');
    const eborTheatreNoInput = document.getElementById('ebor-theatre-no');
    const ticketOrientationInput = document.getElementById('ticket-orientation');
    const ticketFilenameInput = document.getElementById('ticket-filename');
    const modifierNameFilterInput = document.getElementById('modifier-name-filter');
    const targetCategoriesInput = document.getElementById('target-categories');
    const sendSmsInput = document.getElementById('send-sms');
    const useFtpInput = document.getElementById('use-ftp');
    
    // FTP fields
    const ftpSettingsDiv = document.getElementById('ftp-settings');
    const ftp1HostInput = document.getElementById('ftp1-host');
    const ftp1PortInput = document.getElementById('ftp1-port');
    const ftp1TypeInput = document.getElementById('ftp1-type');
    const ftp1RemotePathInput = document.getElementById('ftp1-remote-path');
    const ftp1UserInput = document.getElementById('ftp1-user');
    const ftp1PasswordInput = document.getElementById('ftp1-password');
    const ftp2HostInput = document.getElementById('ftp2-host');
    const ftp2PortInput = document.getElementById('ftp2-port');
    const ftp2TypeInput = document.getElementById('ftp2-type');
    const ftp2RemotePathInput = document.getElementById('ftp2-remote-path');
    const ftp2UserInput = document.getElementById('ftp2-user');
    const ftp2PasswordInput = document.getElementById('ftp2-password');
    const ftp3HostInput = document.getElementById('ftp3-host');
    const ftp3PortInput = document.getElementById('ftp3-port');
    const ftp3TypeInput = document.getElementById('ftp3-type');
    const ftp3RemotePathInput = document.getElementById('ftp3-remote-path');
    const ftp3UserInput = document.getElementById('ftp3-user');
    const ftp3PasswordInput = document.getElementById('ftp3-password');

    // Marquee Engine: social media fields
    const metaPageAccessTokenInput = document.getElementById('meta-page-access-token');
    const metaPageIdInput = document.getElementById('meta-page-id');
    const metaIgBusinessIdInput = document.getElementById('meta-ig-business-id');
    const tiktokClientKeyInput = document.getElementById('tiktok-client-key');
    const tiktokClientSecretInput = document.getElementById('tiktok-client-secret');
    const tiktokAccessTokenInput = document.getElementById('tiktok-access-token');
    const tiktokRefreshTokenInput = document.getElementById('tiktok-refresh-token');
    const tiktokPrivacyLevelInput = document.getElementById('tiktok-privacy-level');

    // EVENT_LOCATIONS management
    let eventLocations = [];
    const newLocationInput = document.getElementById('new-location');
    const addLocationBtn = document.getElementById('add-location-btn');
    const locationsListDiv = document.getElementById('locations-list');
    
    // Add location button event
    addLocationBtn.addEventListener('click', function() {
        const locationName = newLocationInput.value.trim();
        
        if (!locationName) {
            alert('Please enter a location name');
            return;
        }
        
        // Check for duplicates
        if (eventLocations.includes(locationName)) {
            alert('This location already exists');
            return;
        }
        
        // Add to array
        eventLocations.push(locationName);
        
        // Clear input
        newLocationInput.value = '';
        
        // Re-render list
        renderLocationsList();
    });
    
    // Remove location function (globally accessible)
    window.removeLocation = function(index) {
        if (confirm('Are you sure you want to remove this location?')) {
            eventLocations.splice(index, 1);
            renderLocationsList();
        }
    };
    
    // Render locations list
    function renderLocationsList() {
        if (eventLocations.length === 0) {
            locationsListDiv.innerHTML = '';
            return;
        }
        
        locationsListDiv.innerHTML = eventLocations.map((location, index) => `
            <div class="location-item">
                <div class="location-item-name">${location}</div>
                <div class="location-item-actions">
                    <button type="button" class="btn btn-sm btn-danger" onclick="removeLocation(${index})">
                        Remove
                    </button>
                </div>
            </div>
        `).join('');
    }
    
    // SCREEN_NUMBERS management: rows of [venue text, screen number]
    const screenNumbersList = document.getElementById('screen-numbers-list');
    document.getElementById('add-screen-number-btn').addEventListener('click', () => addScreenNumberRow('', ''));

    function addScreenNumberRow(text, screen) {
        const row = document.createElement('div');
        row.className = 'screen-number-row';
        row.style.cssText = 'display: flex; gap: 10px; align-items: center; margin-bottom: 8px;';
        row.innerHTML = `
            <input type="text" class="form-control screen-text" placeholder="Location contains, e.g. Little" style="flex: 3;">
            <input type="number" class="form-control screen-number" placeholder="Screen" min="1" max="999" step="1" style="flex: 1;">
            <button type="button" class="btn btn-sm btn-danger">Remove</button>`;
        row.querySelector('.screen-text').value = text;
        row.querySelector('.screen-number').value = screen;
        row.querySelector('button').addEventListener('click', () => row.remove());
        screenNumbersList.appendChild(row);
    }

    function setScreenNumbers(screens) {
        screenNumbersList.innerHTML = '';
        Object.entries(screens && typeof screens === 'object' ? screens : {})
            .forEach(([text, screen]) => addScreenNumberRow(text, screen));
    }

    function getScreenNumbers() {
        const screens = {};
        screenNumbersList.querySelectorAll('.screen-number-row').forEach(row => {
            const text = row.querySelector('.screen-text').value.trim();
            const screen = row.querySelector('.screen-number').value.trim();
            if (text && screen) screens[text] = screen;
        });
        return screens;
    }

    // EVENT_DESCRIPTORS management
    let eventDescriptors = [];
    const newDescriptorInput = document.getElementById('new-descriptor');
    const addDescriptorBtn = document.getElementById('add-descriptor-btn');
    const descriptorsListDiv = document.getElementById('descriptors-list');
    
    // Add descriptor button event
    addDescriptorBtn.addEventListener('click', function() {
        const descriptorName = newDescriptorInput.value.trim();
        
        if (!descriptorName) {
            alert('Please enter a descriptor name');
            return;
        }
        
        // Check for duplicates
        if (eventDescriptors.includes(descriptorName)) {
            alert('This descriptor already exists');
            return;
        }
        
        // Add to array
        eventDescriptors.push(descriptorName);
        
        // Clear input
        newDescriptorInput.value = '';
        
        // Re-render list
        renderDescriptorsList();
    });
    
    // Remove descriptor function (globally accessible)
    window.removeDescriptor = function(index) {
        if (confirm('Are you sure you want to remove this descriptor?')) {
            eventDescriptors.splice(index, 1);
            renderDescriptorsList();
        }
    };
    
    // Render descriptors list
    function renderDescriptorsList() {
        if (eventDescriptors.length === 0) {
            descriptorsListDiv.innerHTML = '';
            return;
        }
        
        descriptorsListDiv.innerHTML = eventDescriptors.map((descriptor, index) => `
            <div class="descriptor-item">
                <div class="descriptor-item-name">${descriptor}</div>
                <div class="descriptor-item-actions">
                    <button type="button" class="btn btn-sm btn-danger" onclick="removeDescriptor(${index})">
                        Remove
                    </button>
                </div>
            </div>
        `).join('');
    }
    
    // USER_NAMES management
    let userNames = [];
    const newUserNameInput = document.getElementById('new-user-name');
    const addUserNameBtn = document.getElementById('add-user-name-btn');
    const userNamesListDiv = document.getElementById('user-names-list');
    
    // Add user name button event
    addUserNameBtn.addEventListener('click', function() {
        const userName = newUserNameInput.value.trim();
        
        if (!userName) {
            alert('Please enter a user name');
            return;
        }
        
        // Check for duplicates
        if (userNames.includes(userName)) {
            alert('This user name already exists');
            return;
        }
        
        // Add to array
        userNames.push(userName);
        
        // Clear input
        newUserNameInput.value = '';
        
        // Re-render list
        renderUserNamesList();
    });
    
    // Remove user name function (globally accessible)
    window.removeUserName = function(index) {
        if (confirm('Are you sure you want to remove this user?')) {
            userNames.splice(index, 1);
            renderUserNamesList();
        }
    };
    
    // Render user names list
    function renderUserNamesList() {
        if (userNames.length === 0) {
            userNamesListDiv.innerHTML = '';
            return;
        }
        
        userNamesListDiv.innerHTML = userNames.map((userName, index) => `
            <div class="user-name-item">
                <div class="user-name-item-name">${userName}</div>
                <div class="user-name-item-actions">
                    <button type="button" class="btn btn-sm btn-danger" onclick="removeUserName(${index})">
                        Remove
                    </button>
                </div>
            </div>
        `).join('');
    }
    
    // Success modal
    const successModal = new bootstrap.Modal(document.getElementById('success-modal'));
    
    let originalClientData = null;
    
    console.log('DOM Elements found:', {
        clientForm: !!clientForm,
        loadingIndicator: !!loadingIndicator,
        saveButton: !!saveButton,
        contactNameInput: !!contactNameInput,
        clientEmailInput: !!clientEmailInput,
        webHeaderCompanyInput: !!webHeaderCompanyInput,
        logoFileInput: !!logoFileInput,
        ticketOrientationInput: !!ticketOrientationInput,
        ticketFilenameInput: !!ticketFilenameInput
    });
    
    // Token checking now handled by auth-helper.js automatically
    // auth-helper will redirect to login if token is missing/expired
    
    // Add logout button
    const headerControls = document.querySelector('.footer');
    const logoutButton = document.createElement("button");
    logoutButton.textContent = "Logout";
    logoutButton.className = "logout-button";
    logoutButton.onclick = logout;
    headerControls.appendChild(logoutButton);
    
    // Display username if available from URL parameters
    const urlParams = new URLSearchParams(window.location.search);
    const username = urlParams.get('username');
    if (username) {
        userInfo.textContent = `Logged in as: ${username}`;
        userInfo.style.display = 'block';
    }
    
    function logout() {
        // Use auth-helper logout for consistency
        if (window.authHelper) {
            window.authHelper.logout('Manual logout');
        } else {
            // Fallback if auth-helper not loaded
            localStorage.removeItem('authToken');
            window.location.href = 'login.html';
        }
    }
    
    // FTP settings toggle
    useFtpInput.addEventListener('change', function() {
        if (this.checked) {
            ftpSettingsDiv.style.display = 'block';
        } else {
            ftpSettingsDiv.style.display = 'none';
        }
    });
    
    // Password confirmation validation
    function validatePasswords() {
        const password = clientSecretInput.value;
        const confirmPassword = confirmPasswordInput.value;
        
        // Clear previous validation states
        clientSecretInput.classList.remove('is-invalid', 'is-valid');
        confirmPasswordInput.classList.remove('is-invalid', 'is-valid');
        
        // Remove existing feedback
        document.querySelectorAll('.password-feedback').forEach(el => el.remove());
        
        if (password || confirmPassword) {
            if (password !== confirmPassword) {
                confirmPasswordInput.classList.add('is-invalid');
                
                const feedback = document.createElement('div');
                feedback.className = 'invalid-feedback password-feedback';
                feedback.textContent = 'Passwords do not match';
                confirmPasswordInput.parentNode.appendChild(feedback);
                
                return false;
            } else if (password.length > 0) {
                clientSecretInput.classList.add('is-valid');
                confirmPasswordInput.classList.add('is-valid');
            }
        }
        
        return true;
    }
    
    clientSecretInput.addEventListener('input', validatePasswords);
    confirmPasswordInput.addEventListener('input', validatePasswords);
    
    // Load client data on page load
    loadClientData();
    
    // silent=true is used for the quiet refresh after a successful save --
    // the form is already visible with the user's own just-saved values, so
    // there's no need to show the full-page spinner or hide the form again
    // (that overlay also sits above the success modal, z-index 9999 vs the
    // modal's ~1050, hiding it from view until the reload finishes -- and
    // on error, only the spinner used to clear, leaving the form hidden).
    function loadClientData(silent) {
        console.log('Loading client data...', silent ? '(silent refresh)' : '');

        if (!silent) {
            loadingIndicator.style.display = 'block';
            clientForm.style.display = 'none';
        }

        fetch(`${API_URL}/api/client`, {
            headers: getAuthHeaders()
        })
        .then(response => {
            console.log('API Response received:', response.status, response.statusText);

            if (!response.ok) {
                throw new Error(`Network response was not ok: ${response.status}`);
            }

            return response.json();
        })
        .then(data => {
            console.log('Client data received:', data);

            if (!silent) {
                loadingIndicator.style.display = 'none';
                clientForm.style.display = 'block';
            }

            if (data.success && data.client) {
                originalClientData = data.client;
                populateForm(data.client);
            } else {
                throw new Error(data.message || 'Failed to load client data');
            }
        })
        .catch(error => {
            console.error('Error loading client data:', error);
            loadingIndicator.style.display = 'none';
            clientForm.style.display = 'block';

            if (!silent) {
                alert('Error loading client settings: ' + error.message + '. Please try refreshing the page.');
            }
        });
    }
    
    function populateForm(clientData) {
        console.log('Populating form with client data:', clientData);
        
        // Populate basic client information
        contactNameInput.value = clientData.contactName || '';
        clientEmailInput.value = clientData.clientEmail || '';
        
        // Don't populate password fields for security
        clientSecretInput.value = '';
        confirmPasswordInput.value = '';
        
        // Populate configuration fields
        const config = clientData.configuration || {};
        const savedSecrets = clientData.savedSecrets || [];
        secretFields.forEach((field) => resetSecretField(field, savedSecrets.includes(field.key)));

        squareWebhookUrlInput.value = config.SQUARE_WEBHOOK_URL || '';
        squareLocationIdInput.value = config.SQUARE_LOCATION_ID || '';
        distributorNameInput.value = config.DISTRIBUTOR_NAME || '';
        eventTypeInput.value = config.EVENT_TYPE || '';
        theaterIdInput.value = config.THEATER_ID || '';
        theaterNameInput.value = config.THEATER_NAME || '';
        webHeaderCompanyInput.value = config.WEB_HEADER_COMPANY || '';
        logoFileInput.value = config.LOGO_FILE || 'indieTixLogo.png';
        eborTheatreNoInput.value = config.EBOR_THEATRE_NO || '';
        document.getElementById('sales-tax-rate').value = config.SALES_TAX_RATE || '';
        setScreenNumbers(config.SCREEN_NUMBERS);
        ticketOrientationInput.value = config.TICKET_ORIENTATION || '';
        ticketFilenameInput.value = config.TICKET_FILENAME || '';
        modifierNameFilterInput.value = config.MODIFIER_NAME_FILTER || '';
        targetCategoriesInput.value = config.TARGET_CATEGORIES || '';
        
        // Checkbox fields
        sendSmsInput.checked = config.SEND_SMS === 'true';
        useFtpInput.checked = config.USE_FTP === 'true';
        
        // Show/hide FTP settings based on checkbox
        if (useFtpInput.checked) {
            ftpSettingsDiv.style.display = 'block';
        } else {
            ftpSettingsDiv.style.display = 'none';
        }
        
        // FTP settings
        ftp1HostInput.value = config.FTP1_HOST || '';
        ftp1PortInput.value = config.FTP1_PORT || '';
        ftp1TypeInput.value = config.FTP1_TYPE || 'ftp';
        ftp1RemotePathInput.value = config.FTP1_REMOTE_PATH || '';
        ftp1UserInput.value = config.FTP1_USER || '';
        
        ftp2HostInput.value = config.FTP2_HOST || '';
        ftp2PortInput.value = config.FTP2_PORT || '';
        ftp2TypeInput.value = config.FTP2_TYPE || 'ftp';
        ftp2RemotePathInput.value = config.FTP2_REMOTE_PATH || '';
        ftp2UserInput.value = config.FTP2_USER || '';

        ftp3HostInput.value = config.FTP3_HOST || '';
        ftp3PortInput.value = config.FTP3_PORT || '';
        ftp3TypeInput.value = config.FTP3_TYPE || 'ftp';
        ftp3RemotePathInput.value = config.FTP3_REMOTE_PATH || '';
        ftp3UserInput.value = config.FTP3_USER || '';

        // Marquee Engine: social media fields
        metaPageIdInput.value = config.META_PAGE_ID || '';
        metaIgBusinessIdInput.value = config.META_IG_BUSINESS_ID || '';
        tiktokClientKeyInput.value = config.TIKTOK_CLIENT_KEY || '';
        tiktokPrivacyLevelInput.value = config.TIKTOK_PRIVACY_LEVEL || '';

        // Load EVENT_LOCATIONS
        eventLocations = config.EVENT_LOCATIONS || ['Main Auditorium'];
        renderLocationsList();
        
        // Load EVENT_DESCRIPTORS
        eventDescriptors = config.EVENT_DESCRIPTORS || [];
        renderDescriptorsList();
        
        // Load USERS_NAMES
        userNames = config.USERS_NAMES || [];
        renderUserNamesList();
        
	// Load API configuration
	document.getElementById('cinema_calendar_id').value = config.CINEMA_CALENDAR_ID || '';
	document.getElementById('event_calendar_id').value = config.EVENT_CALENDAR_ID || '';
	document.getElementById('ecommerce_site_url').value = config.ECOMMERCE_SITE_URL || '';
	document.getElementById('sender_email').value = config.SENDER_EMAIL || '';
	document.getElementById('owner_bcc_email').value = config.OWNER_BCC_EMAIL || '';
	document.getElementById('one_per_email_items').value = config.ONE_PER_EMAIL_ITEMS || '';
	// Terms & Privacy pages (LEGAL_*); blank fields show the pages' placeholders.
	LEGAL_FIELDS.forEach(([id, key]) => { document.getElementById(id).value = config[key] || ''; });
        console.log('Form populated successfully');
    }
    
    function collectFormData() {
        const formData = {
            contactName: contactNameInput.value.trim(),
            clientEmail: clientEmailInput.value.trim(),
            configuration: {}
        };
        
        // Include password only if provided
        if (clientSecretInput.value.trim() !== '') {
            formData.clientSecret = clientSecretInput.value.trim();
        }
        
        // Collect configuration data (USER_DEFINABLE fields)
        const config = formData.configuration;
        
        config.SQUARE_WEBHOOK_URL = squareWebhookUrlInput.value.trim();
        config.SQUARE_LOCATION_ID = squareLocationIdInput.value.trim();
        config.DISTRIBUTOR_NAME = distributorNameInput.value.trim();
        config.EVENT_TYPE = eventTypeInput.value.trim();
        config.THEATER_ID = theaterIdInput.value.trim();
        config.THEATER_NAME = theaterNameInput.value.trim();
        config.WEB_HEADER_COMPANY = webHeaderCompanyInput.value.trim();
        // Default to indieTixLogo.png if field is empty
        config.LOGO_FILE = logoFileInput.value.trim() || 'indieTixLogo.png';
        config.EBOR_THEATRE_NO = eborTheatreNoInput.value.trim();
        config.SALES_TAX_RATE = document.getElementById('sales-tax-rate').value.trim();
        config.SCREEN_NUMBERS = getScreenNumbers();
        config.TICKET_ORIENTATION = ticketOrientationInput.value.trim();
        config.TICKET_FILENAME = ticketFilenameInput.value.trim();
        config.MODIFIER_NAME_FILTER = modifierNameFilterInput.value.trim();
        config.TARGET_CATEGORIES = targetCategoriesInput.value.trim();
        config.SEND_SMS = sendSmsInput.checked ? 'true' : 'false';
        config.USE_FTP = useFtpInput.checked ? 'true' : 'false';
        
        // FTP settings
        config.FTP1_HOST = ftp1HostInput.value.trim();
        config.FTP1_PORT = ftp1PortInput.value.trim();
        config.FTP1_TYPE = ftp1TypeInput.value.trim();
        config.FTP1_REMOTE_PATH = ftp1RemotePathInput.value.trim();
        config.FTP1_USER = ftp1UserInput.value.trim();
        
        config.FTP2_HOST = ftp2HostInput.value.trim();
        config.FTP2_PORT = ftp2PortInput.value.trim();
        config.FTP2_TYPE = ftp2TypeInput.value.trim();
        config.FTP2_REMOTE_PATH = ftp2RemotePathInput.value.trim();
        config.FTP2_USER = ftp2UserInput.value.trim();

        config.FTP3_HOST = ftp3HostInput.value.trim();
        config.FTP3_PORT = ftp3PortInput.value.trim();
        config.FTP3_TYPE = ftp3TypeInput.value.trim();
        config.FTP3_REMOTE_PATH = ftp3RemotePathInput.value.trim();
        config.FTP3_USER = ftp3UserInput.value.trim();

        // Marquee Engine: social media fields
        config.META_PAGE_ID = metaPageIdInput.value.trim();
        config.META_IG_BUSINESS_ID = metaIgBusinessIdInput.value.trim();
        config.TIKTOK_CLIENT_KEY = tiktokClientKeyInput.value.trim();
        config.TIKTOK_PRIVACY_LEVEL = tiktokPrivacyLevelInput.value.trim();

        // Save EVENT_LOCATIONS array
        config.EVENT_LOCATIONS = eventLocations;
        
        // Save EVENT_DESCRIPTORS array
        config.EVENT_DESCRIPTORS = eventDescriptors;
        
        // Save USERS_NAMES array
        config.USERS_NAMES = userNames;
        
    	config.CINEMA_CALENDAR_ID = document.getElementById('cinema_calendar_id').value.trim();
    	config.EVENT_CALENDAR_ID = document.getElementById('event_calendar_id').value.trim();
    	config.ECOMMERCE_SITE_URL = document.getElementById('ecommerce_site_url').value.trim();
    	// A blank sender would stop every email, so blank keeps the current one.
    	const senderEmail = document.getElementById('sender_email').value.trim();
    	if (senderEmail) config.SENDER_EMAIL = senderEmail;
    	config.OWNER_BCC_EMAIL = document.getElementById('owner_bcc_email').value.trim();
    	config.ONE_PER_EMAIL_ITEMS = document.getElementById('one_per_email_items').value.trim();
    	LEGAL_FIELDS.forEach(([id, key]) => { config[key] = document.getElementById(id).value.trim(); });

        // Secrets: only the ones changed or removed (see SECRET SETTINGS).
        const clearSecrets = [];
        secretFields.forEach((field) => {
            const value = field.input.value.trim();
            if (field.mode === 'change' && value) config[field.key] = value;
            else if (field.mode === 'remove') clearSecrets.push(field.key);
        });
        if (clearSecrets.length) formData.clearSecrets = clearSecrets;

        return formData;
    }
    
    function validateForm() {
        let isValid = true;
        
        // Clear previous validation states
        document.querySelectorAll('.form-control, .form-select').forEach(el => {
            el.classList.remove('is-invalid', 'is-valid');
        });
        
        // Remove existing validation feedback
        document.querySelectorAll('.validation-feedback').forEach(el => el.remove());
        
        // Validate required fields
        if (!contactNameInput.value.trim()) {
            contactNameInput.classList.add('is-invalid');
            addValidationFeedback(contactNameInput, 'Contact name is required');
            isValid = false;
        } else {
            contactNameInput.classList.add('is-valid');
        }
        
        if (!clientEmailInput.value.trim() || !clientEmailInput.value.includes('@')) {
            clientEmailInput.classList.add('is-invalid');
            addValidationFeedback(clientEmailInput, 'Valid email address is required');
            isValid = false;
        } else {
            clientEmailInput.classList.add('is-valid');
        }
        
        // Validate passwords if provided
        if (!validatePasswords()) {
            isValid = false;
        }
        
        return isValid;
    }
    
    function addValidationFeedback(element, message) {
        const feedback = document.createElement('div');
        feedback.className = 'invalid-feedback validation-feedback';
        feedback.textContent = message;
        element.parentNode.appendChild(feedback);
    }
    
    // Form submission
    clientForm.addEventListener('submit', function(e) {
        e.preventDefault();
        
        console.log('Form submit event fired');
        
        if (!validateForm()) {
            console.log('Form validation failed');
            return;
        }
        
        const formData = collectFormData();
        console.log('Collected form data:', { ...formData, clientSecret: formData.clientSecret ? '[HIDDEN]' : undefined, configuration: Object.keys(formData.configuration) });
        
        // Set loading state
        saveButton.classList.add('loading');
        saveButton.disabled = true;
        saveButton.querySelector('.spinner-border').classList.remove('d-none');
        
        fetch(`${API_URL}/api/client`, {
            method: 'PUT',
            headers: {
                ...getAuthHeaders(),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(formData)
        })
        .then(response => {
            console.log('Save response received:', response.status, response.statusText);
            
            if (!response.ok) {
                throw new Error(`Network response was not ok: ${response.status}`);
            }
            
            return response.json();
        })
        .then(data => {
            console.log('Save response data:', data);
            
            // Clear loading state
            saveButton.classList.remove('loading');
            saveButton.disabled = false;
            saveButton.querySelector('.spinner-border').classList.add('d-none');
            
            if (data.success) {
                console.log('Client settings saved successfully');
                successModal.show();

                // Quiet refresh to pick up the server-merged configuration
                // (see loadClientData's silent param) -- no overlay, no
                // hiding the form, so the success modal stays visible.
                setTimeout(() => {
                    loadClientData(true);
                }, 1000);
                
            } else {
                throw new Error(data.message || 'Unknown error occurred');
            }
        })
        .catch(error => {
            console.error('Error saving client settings:', error);
            
            // Clear loading state
            saveButton.classList.remove('loading');
            saveButton.disabled = false;
            saveButton.querySelector('.spinner-border').classList.add('d-none');
            
            let errorMessage = 'Failed to save client settings. Please try again.';
            
            if (error.message.includes('validation')) {
                errorMessage = 'Please check your input and try again.';
            } else if (error.message.includes('email')) {
                errorMessage = 'Please enter a valid email address.';
            }
            
            alert('Error: ' + errorMessage);
        });
    });
    
    // Cancel button - reload original data
    cancelButton.addEventListener('click', function() {
        if (originalClientData) {
            populateForm(originalClientData);
            
            // Clear validation states
            document.querySelectorAll('.form-control, .form-select').forEach(el => {
                el.classList.remove('is-invalid', 'is-valid');
            });
            
            // Remove validation feedback
            document.querySelectorAll('.validation-feedback, .password-feedback').forEach(el => el.remove());
            
            console.log('Form reset to original data');
        } else {
            loadClientData();
        }
    });
    
    // ===================================
    // SKELETON KEYS MANAGEMENT
    // ===================================
    
    let skeletonKeys = [];
    let currentQRCode = null;
    
    // Load skeleton keys
    async function loadSkeletonKeys() {
        try {
            const response = await fetch(`${API_URL}/api/skeleton-keys`, {
                headers: {
                    'Authorization': `Bearer ${localStorage.getItem('authToken')}`
                }
            });
            
            if (!response.ok) {
                throw new Error('Failed to load skeleton keys');
            }
            
            const data = await response.json();
            skeletonKeys = data.skeletonKeys || [];
            renderSkeletonKeys();
        } catch (error) {
            console.error('Error loading skeleton keys:', error);
        }
    }
    
    // Render skeleton keys list
    function renderSkeletonKeys() {
        console.log('=== renderSkeletonKeys called ===');
        console.log('Number of skeleton keys:', skeletonKeys.length);
        
        const container = document.getElementById('skeleton-keys-container');
        
        if (skeletonKeys.length === 0) {
            container.innerHTML = '';
            return;
        }
        
        container.innerHTML = skeletonKeys.map(key => {
            const isExpired = key.expiresAt && (new Date().toISOString().slice(0, 10) > key.expiresAt.slice(0, 10));
            const isMaxedOut = key.maxTotalUses && key.totalUses >= key.maxTotalUses;
            return `
            <div class="skeleton-key-card ${key.isActive ? '' : 'inactive'}" id="key-card-${key.qrCode}">
                <div class="skeleton-key-header">
                    <div class="skeleton-key-info">
                        <h6>${key.qrCode}</h6>
                        <span class="badge ${getTypeBadgeClass(key.keyType)}">${formatKeyType(key.keyType)}</span>
                        ${key.isActive ? '<span class="badge bg-success">Active</span>' : '<span class="badge bg-secondary">Inactive</span>'}
                        ${isExpired ? '<span class="badge bg-danger">Expired</span>' : ''}
                        ${isMaxedOut ? '<span class="badge bg-danger">Limit Reached</span>' : ''}
                    </div>
                    <div class="skeleton-key-actions">
                        <div class="form-check form-switch">
                            <input class="form-check-input" type="checkbox" id="show-qr-${key.qrCode}" 
                                   onchange="toggleQRDisplay('${key.qrCode}', this.checked)">
                            <label class="form-check-label" for="show-qr-${key.qrCode}">
                                Show QR
                            </label>
                        </div>
                        <button type="button" class="btn btn-${key.isActive ? 'warning' : 'success'} btn-sm" 
                                onclick="toggleSkeletonKey('${key.qrCode}', ${!key.isActive}, event)">
                            ${key.isActive ? 'Deactivate' : 'Activate'}
                        </button>
                    </div>
                </div>
                
                <div class="skeleton-key-details">
                    <div class="skeleton-key-detail">
                        <span class="skeleton-key-detail-label">Description</span>
                        <span class="skeleton-key-detail-value">${key.description || 'N/A'}</span>
                    </div>
                    <div class="skeleton-key-detail">
                        <span class="skeleton-key-detail-label">Event Name</span>
                        <span class="skeleton-key-detail-value">${key.eventName || 'Generic'}</span>
                    </div>
                    <div class="skeleton-key-detail">
                        <span class="skeleton-key-detail-label">Max Uses/Day</span>
                        <span class="skeleton-key-detail-value">${key.maxUsesPerDay || 'Unlimited'}</span>
                    </div>
                    <div class="skeleton-key-detail">
                        <span class="skeleton-key-detail-label">Total Uses</span>
                        <span class="skeleton-key-detail-value">${key.totalUses || 0}${key.maxTotalUses ? ` / ${key.maxTotalUses}` : ''}</span>
                    </div>
                    <div class="skeleton-key-detail">
                        <span class="skeleton-key-detail-label">Expires</span>
                        <span class="skeleton-key-detail-value">${key.expiresAt ? key.expiresAt.slice(0, 10) : 'Never'}</span>
                    </div>
                    <div class="skeleton-key-detail">
                        <span class="skeleton-key-detail-label">Last Used</span>
                        <span class="skeleton-key-detail-value">${key.lastUsedAt ? formatDate(key.lastUsedAt) : 'Never'}</span>
                    </div>
                </div>
                
                <!-- Inline QR Code Display (hidden by default) -->
                <div class="skeleton-key-qr-display" id="qr-display-${key.qrCode}" style="display: none;">
                    <div class="qr-display-header">
                        <h6>QR Code for ${key.qrCode}</h6>
                    </div>
                    <div class="qr-code-container" id="qr-container-${key.qrCode}"></div>
                    <div class="qr-display-actions">
                        <button type="button" class="btn btn-primary btn-sm" onclick="downloadQR('${key.qrCode}')">
                            Download QR Code
                        </button>
                    </div>
                </div>
            </div>
        `;
        }).join('');

        console.log('Skeleton keys rendered with inline QR displays');
    }
    
    // Helper functions
    function getTypeBadgeClass(type) {
        const classes = {
            'comp': 'bg-info',
            're-entry': 'bg-primary',
            'staff': 'bg-warning',
            'other': 'bg-secondary'
        };
        return classes[type] || 'bg-secondary';
    }
    
    function formatKeyType(type) {
        const types = {
            'comp': 'Comp Pass',
            're-entry': 'Re-entry',
            'staff': 'Staff Pass',
            'other': 'Other'
        };
        return types[type] || type;
    }
    
    function formatDate(dateString) {
        const date = new Date(dateString);
        const now = new Date();
        const diffMs = now - date;
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMins / 60);
        const diffDays = Math.floor(diffHours / 24);
        
        if (diffMins < 60) return `${diffMins} min${diffMins !== 1 ? 's' : ''} ago`;
        if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
        if (diffDays < 7) return `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
        
        return date.toLocaleDateString();
    }
    
    // Create skeleton key
    document.getElementById('create-skeleton-key-btn').addEventListener('click', async function() {
        const qrCode = document.getElementById('sk-qrcode').value.trim();
        const type = document.getElementById('sk-type').value;
        const description = document.getElementById('sk-description').value.trim();
        const eventName = document.getElementById('sk-event-name').value.trim();
        const maxUses = document.getElementById('sk-max-uses').value.trim();
        const maxTotalUses = document.getElementById('sk-max-total-uses').value.trim();
        const expiresAt = document.getElementById('sk-expires-at').value;
        const isActive = document.getElementById('sk-is-active').checked;
        
        // Validation
        if (!qrCode) {
            alert('Please enter a QR code value');
            return;
        }
        
        if (!type) {
            alert('Please select a key type');
            return;
        }
        
        if (!description) {
            alert('Please enter a description');
            return;
        }
        
        // Check for duplicates
        if (skeletonKeys.find(k => k.qrCode === qrCode)) {
            alert('A skeleton key with this QR code already exists');
            return;
        }
        
        const keyData = {
            qrCode,
            keyType: type,
            description,
            eventName: eventName || null,
            maxUsesPerDay: maxUses ? parseInt(maxUses) : null,
            maxTotalUses: maxTotalUses ? parseInt(maxTotalUses) : null,
            expiresAt: expiresAt || null,
            isActive
        };
        
        try {
            const response = await fetch(`${API_URL}/api/skeleton-keys`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${localStorage.getItem('authToken')}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(keyData)
            });
            
            if (!response.ok) {
                throw new Error('Failed to create skeleton key');
            }
            
            // Clear form
            document.getElementById('sk-qrcode').value = '';
            document.getElementById('sk-type').value = '';
            document.getElementById('sk-description').value = '';
            document.getElementById('sk-event-name').value = '';
            document.getElementById('sk-max-uses').value = '';
            document.getElementById('sk-max-total-uses').value = '';
            document.getElementById('sk-expires-at').value = '';
            document.getElementById('sk-is-active').checked = true;
            
            // Reload keys
            await loadSkeletonKeys();
            
            alert('Skeleton key created successfully!');
        } catch (error) {
            console.error('Error creating skeleton key:', error);
            alert('Failed to create skeleton key. Please try again.');
        }
    });
    
    // Toggle inline QR code display
    const qrInstances = {}; // Store QR code instances
    
    window.toggleQRDisplay = function(qrCode, show) {
        console.log('toggleQRDisplay:', qrCode, show);
        
        const displayDiv = document.getElementById(`qr-display-${qrCode}`);
        const containerDiv = document.getElementById(`qr-container-${qrCode}`);
        
        if (!displayDiv || !containerDiv) {
            console.error('QR display elements not found');
            return;
        }
        
        if (show) {
            // Show and generate QR code
            displayDiv.style.display = 'block';
            
            // Generate QR code if not already created
            if (!qrInstances[qrCode]) {
                console.log('Generating QR code for:', qrCode);
                containerDiv.innerHTML = ''; // Clear any existing content
                
                qrInstances[qrCode] = new QRCode(containerDiv, {
                    text: qrCode,
                    width: 256,
                    height: 256,
                    colorDark: "#000000",
                    colorLight: "#ffffff",
                    correctLevel: QRCode.CorrectLevel.H
                });
                
                console.log('QR code generated successfully');
            }
        } else {
            // Hide QR code
            displayDiv.style.display = 'none';
        }
    };
    
    // Download QR code
    window.downloadQR = function(qrCode) {
        console.log('downloadQR:', qrCode);
        
        const containerDiv = document.getElementById(`qr-container-${qrCode}`);
        if (!containerDiv) {
            console.error('QR container not found');
            return;
        }
        
        const canvas = containerDiv.querySelector('canvas');
        if (!canvas) {
            console.error('QR canvas not found');
            return;
        }
        
        // Convert canvas to blob and download
        canvas.toBlob(function(blob) {
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `skeleton-key-${qrCode}.png`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            console.log('QR code downloaded');
        });
    };
    
    // Toggle skeleton key active status
    window.toggleSkeletonKey = async function(qrCode, newStatus, event) {
        // Prevent form submission
        if (event) {
            event.preventDefault();
            event.stopPropagation();
        }
        
        const action = newStatus ? 'activate' : 'deactivate';
        
        if (!confirm(`Are you sure you want to ${action} this skeleton key?`)) {
            return;
        }
        
        try {
            const response = await fetch(`${API_URL}/api/skeleton-keys/${encodeURIComponent(qrCode)}`, {
                method: 'PATCH',
                headers: {
                    'Authorization': `Bearer ${localStorage.getItem('authToken')}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ isActive: newStatus })
            });
            
            if (!response.ok) {
                throw new Error('Failed to update skeleton key');
            }
            
            // Reload keys
            await loadSkeletonKeys();
            
            alert(`Skeleton key ${action}d successfully!`);
        } catch (error) {
            console.error('Error updating skeleton key:', error);
            alert(`Failed to ${action} skeleton key. Please try again.`);
        }
    };
    
    // Load skeleton keys on page load
    loadSkeletonKeys();

    // ===================================
    // API KEYS (public API v1)
    // ===================================

    const escapeText = (value) => String(value ?? '').replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));

    const SCOPE_LABELS = {
        'showtimes:read': 'Showtimes',
        'tickets:read': 'Tickets',
        'orders:read': 'Orders',
        'orders:pii': 'Buyer contact info',
        'reports:read': 'Reports',
        'checkin:write': 'Check-in'
    };

    // ---- API key data filters ----
    // Same {date, event, eventType} rows as User Management's filter editor,
    // with the same event list (ticketed Square items plus sold events).
    let filterEvents = [];

    async function loadFilterEvents() {
        try {
            const response = await fetch(`${API_URL}/api/data-filter/events`, {
                headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` }
            });
            if (!response.ok) throw new Error('Failed to load events');
            const data = await response.json();
            filterEvents = Array.isArray(data.events) ? data.events : [];
        } catch (error) {
            console.error('Error loading filter events:', error);
            filterEvents = [];
        }
    }

    function addApiKeyFilterRow() {
        const row = document.createElement('div');
        row.className = 'ak-filter-row d-flex gap-2 align-items-end flex-wrap mb-2';
        row.innerHTML = `
            <div><label class="form-label small mb-0">Date</label>
                <input type="date" class="form-control form-control-sm ak-filter-date"></div>
            <div><label class="form-label small mb-0">Event</label>
                <select class="form-select form-select-sm ak-filter-event">
                    <option value="">-- Any --</option>
                    ${filterEvents.map(name => `<option value="${escapeText(name)}">${escapeText(name)}</option>`).join('')}
                </select></div>
            <div><label class="form-label small mb-0">Event name contains</label>
                <input type="text" class="form-control form-control-sm ak-filter-eventContains" maxlength="200" placeholder="e.g. Rocky Horror"></div>
            <div><label class="form-label small mb-0">Event Type</label>
                <select class="form-select form-select-sm ak-filter-eventType">
                    <option value="">-- Any --</option>
                    <option value="Movie">Cinema</option>
                    <option value="Live">Live</option>
                </select></div>
            <button type="button" class="btn btn-outline-danger btn-sm ak-remove-filter">Remove</button>`;
        row.querySelector('.ak-remove-filter').addEventListener('click', () => row.remove());
        document.getElementById('ak-filters').appendChild(row);
    }

    function readApiKeyFilters() {
        return [...document.querySelectorAll('#ak-filters .ak-filter-row')].map(row => {
            const filter = {};
            const date = row.querySelector('.ak-filter-date').value;
            const event = row.querySelector('.ak-filter-event').value;
            const eventContains = row.querySelector('.ak-filter-eventContains').value.trim();
            const eventType = row.querySelector('.ak-filter-eventType').value;
            if (date) filter.date = date;
            if (event) filter.event = event;
            if (eventContains) filter.eventContains = eventContains;
            if (eventType) filter.eventType = eventType;
            return filter;
        }).filter(filter => Object.keys(filter).length > 0);
    }

    function describeFilters(dataFilter) {
        const filters = dataFilter?.datafilters || [];
        return filters.map(f => [
            f.event ? `“${f.event}”` : null,
            f.eventContains ? `names containing “${f.eventContains}”` : null,
            f.date || null,
            f.eventType ? ({ movie: 'Cinema', cinema: 'Cinema', live: 'Live' }[String(f.eventType).toLowerCase()] || f.eventType) : null
        ].filter(Boolean).join(', ')).join(' or ');
    }

    document.getElementById('ak-add-filter').addEventListener('click', addApiKeyFilterRow);

    async function loadApiKeys() {
        const container = document.getElementById('api-keys-container');
        try {
            const response = await fetch(`${API_URL}/api/api-keys`, {
                headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` }
            });
            if (!response.ok) throw new Error('Failed to load API keys');
            const data = await response.json();
            renderApiKeys(data.keys || []);
        } catch (error) {
            console.error('Error loading API keys:', error);
            container.innerHTML = '<p class="text-muted">Could not load API keys.</p>';
        }
    }

    function renderApiKeys(keys) {
        const container = document.getElementById('api-keys-container');
        if (keys.length === 0) {
            container.innerHTML = '<p class="text-muted">No API keys yet.</p>';
            return;
        }
        container.innerHTML = keys.map(key => {
            const scopes = (key.scopes || []).map(s => SCOPE_LABELS[s] || s).join(', ');
            const filters = describeFilters(key.dataFilter);
            const lastUsed = key.lastUsedAt ? new Date(key.lastUsedAt).toLocaleString() : 'never';
            const status = key.revokedAt
                ? `<span class="badge bg-secondary">Revoked ${escapeText(new Date(key.revokedAt).toLocaleDateString())}</span>`
                : `<button type="button" class="btn btn-outline-danger btn-sm" data-revoke-key="${key.id}">Revoke</button>`;
            return `
                <div class="border rounded p-2 mb-2 d-flex justify-content-between align-items-start gap-2 flex-wrap">
                    <div>
                        <strong>${escapeText(key.name)}</strong>
                        <code class="ms-2">${escapeText(key.prefix)}…</code><br>
                        <small class="text-muted">Access: ${escapeText(scopes)}${filters ? ` · Only ${escapeText(filters)}` : ''} · Last used: ${escapeText(lastUsed)}</small>
                    </div>
                    <div>${status}</div>
                </div>`;
        }).join('');
    }

    // Two-step revoke: first click arms the button, second click revokes.
    document.getElementById('api-keys-container').addEventListener('click', async (event) => {
        const button = event.target.closest('[data-revoke-key]');
        if (!button) return;
        if (button.dataset.armed !== 'true') {
            button.dataset.armed = 'true';
            button.textContent = 'Click again to revoke';
            button.classList.replace('btn-outline-danger', 'btn-danger');
            return;
        }
        button.disabled = true;
        try {
            const response = await fetch(`${API_URL}/api/api-keys/${button.dataset.revokeKey}/revoke`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${localStorage.getItem('authToken')}` }
            });
            if (!response.ok) throw new Error('Failed to revoke API key');
            await loadApiKeys();
        } catch (error) {
            console.error('Error revoking API key:', error);
            button.disabled = false;
            button.textContent = 'Revoke failed -- try again';
        }
    });

    document.getElementById('create-api-key-btn').addEventListener('click', async () => {
        const errorBox = document.getElementById('ak-error');
        const createdBox = document.getElementById('ak-created');
        errorBox.hidden = true;
        createdBox.hidden = true;

        const name = document.getElementById('ak-name').value.trim();
        const datafilters = readApiKeyFilters();
        const scopes = [...document.querySelectorAll('#ak-scopes input:checked')].map(input => input.value);

        if (!name || scopes.length === 0) {
            errorBox.textContent = 'Give the key a name and choose at least one kind of access.';
            errorBox.hidden = false;
            return;
        }

        try {
            const response = await fetch(`${API_URL}/api/api-keys`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${localStorage.getItem('authToken')}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    name,
                    scopes,
                    dataFilter: datafilters.length > 0 ? { datafilters } : undefined
                })
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.message || 'Failed to create API key');

            document.getElementById('ak-created-value').value = data.key;
            createdBox.hidden = false;
            document.getElementById('ak-name').value = '';
            document.getElementById('ak-filters').innerHTML = '';
            document.querySelectorAll('#ak-scopes input').forEach(input => { input.checked = false; });
            await loadApiKeys();
        } catch (error) {
            console.error('Error creating API key:', error);
            errorBox.textContent = error.message;
            errorBox.hidden = false;
        }
    });

    document.getElementById('ak-created-value').addEventListener('focus', (event) => event.target.select());

    loadApiKeys();
    loadFilterEvents();
    // ---- END API KEYS ----
    
    // Startup diagnostics
    console.log('=== Client.js Startup Diagnostics ===');
    console.log('Bootstrap available:', typeof bootstrap !== 'undefined');
    console.log('Bootstrap.Modal available:', typeof bootstrap !== 'undefined' && typeof bootstrap.Modal !== 'undefined');
    console.log('QRCode library available:', typeof QRCode !== 'undefined');
    
    const modalElement = document.getElementById('skeleton-key-modal');
    console.log('Skeleton key modal element exists:', !!modalElement);
    if (modalElement) {
        console.log('Modal element classes:', modalElement.className);
        console.log('Modal element style:', modalElement.style.cssText);
    }
    
    const qrcodeDisplay = document.getElementById('qrcode-display');
    console.log('QR code display element exists:', !!qrcodeDisplay);
    
    console.log('Client.js initialization complete');
});
