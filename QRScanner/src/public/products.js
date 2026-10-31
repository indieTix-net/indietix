document.addEventListener('DOMContentLoaded', function() {
    console.log('Product.js DOMContentLoaded fired');
    console.log('Bootstrap available:', typeof bootstrap !== 'undefined');
    
    const API_URL = window.INDIETIX_API_URL;
    // Local print agent (separate "printer" repo) -- one instance serves
    // every computer on the venue's LAN. Falsy/unset means this venue
    // hasn't set up ticket printing; "Print Ticket" is hidden entirely
    // rather than shown as a button that always fails.
    const PRINT_AGENT_URL = window.INDIETIX_PRINT_AGENT_URL;

    // Get elements
    const searchInput = document.getElementById('search-input');
    const clearSearchButton = document.getElementById('clear-search');
    const productsTableBody = document.getElementById('products-table-body');
    const mobileCardsContainer = document.getElementById('mobile-cards-container');
    const loadingIndicator = document.getElementById('loading');
    
    // Date filter elements
    const startDateInput = document.getElementById('start-date');
    const endDateInput = document.getElementById('end-date');
    const applyDateFilterButton = document.getElementById('apply-date-filter');
    const clearDateFilterButton = document.getElementById('clear-date-filter');
    const todayFilterButton = document.getElementById('today-filter');
    const weekFilterButton = document.getElementById('week-filter');
    
    // Column visibility elements
    const columnToggles = document.querySelectorAll('.column-toggle');
    const showAllColumnsButton = document.getElementById('show-all-columns');
    const hideAllColumnsButton = document.getElementById('hide-all-columns');
    const resetColumnsButton = document.getElementById('reset-columns');
    
    console.log('DOM Elements found:', {
        searchInput: !!searchInput,
        clearSearchButton: !!clearSearchButton,
        productsTableBody: !!productsTableBody,
        mobileCardsContainer: !!mobileCardsContainer,
        loadingIndicator: !!loadingIndicator,
        startDateInput: !!startDateInput,
        endDateInput: !!endDateInput
    });
    
    // Check-in modal elements
    const checkinModal = new bootstrap.Modal(document.getElementById('checkin-modal'));
    const modalProductName = document.getElementById('modal-product-name');
    const modalEventName = document.getElementById('modal-event-name');
    const modalEmail = document.getElementById('modal-email');
    const modalCustomerName = document.getElementById('modal-customer-name');
    const modalPhone = document.getElementById('modal-phone');
    const confirmCheckinButton = document.getElementById('confirm-checkin');
    
    // Check-out modal elements
    const checkoutModal = new bootstrap.Modal(document.getElementById('checkout-modal'));
    const checkoutModalProductName = document.getElementById('checkout-modal-product-name');
    const checkoutModalEventName = document.getElementById('checkout-modal-event-name');
    const checkoutModalEmail = document.getElementById('checkout-modal-email');
    const checkoutModalCustomerName = document.getElementById('checkout-modal-customer-name');
    const checkoutModalPhone = document.getElementById('checkout-modal-phone');
    const confirmCheckoutButton = document.getElementById('confirm-checkout');
    
    // Refund modal elements
    const refundModal = new bootstrap.Modal(document.getElementById('refund-modal'));
    const refundModalProductName = document.getElementById('refund-modal-product-name');
    const refundModalEventName = document.getElementById('refund-modal-event-name');
    const refundModalCustomerName = document.getElementById('refund-modal-customer-name');
    const refundModalCurrentStatus = document.getElementById('refund-modal-current-status');
    const refundModalNewStatus = document.getElementById('refund-modal-new-status');
    const confirmRefundButton = document.getElementById('confirm-refund');

    // Transfer modal elements
    const transferModal = new bootstrap.Modal(document.getElementById('transfer-modal'));
    const transferModalEventName = document.getElementById('transfer-modal-event-name');
    const transferModalCustomerName = document.getElementById('transfer-modal-customer-name');
    const transferFirstNameInput = document.getElementById('transfer-first-name');
    const transferLastNameInput = document.getElementById('transfer-last-name');
    const transferPhoneInput = document.getElementById('transfer-phone');
    const transferEmailInput = document.getElementById('transfer-email');
    const confirmTransferButton = document.getElementById('confirm-transfer');

    const userInfo = document.getElementById('user-info');
    
    let currentProductId = null;
    let currentQrCode = null;
    let currentStatus = null;
    let searchTimeout = null;
    
    // Helper function to format date for input[type="date"]
    function formatDateForInput(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }
    
    // Helper function to get start of week (Monday)
    function getStartOfWeek(date) {
        const d = new Date(date);
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Adjust when day is Sunday
        return new Date(d.setDate(diff));
    }
    
    // Helper function to get end of week (Sunday)
    function getEndOfWeek(date) {
        const d = new Date(date);
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? 0 : 7); // Adjust when day is Sunday
        return new Date(d.setDate(diff));
    }
    
    // Initialize date filters with today's date
    function initializeDateFilters() {
        const today = new Date();
        const todayString = formatDateForInput(today);
        
        startDateInput.value = todayString;
        endDateInput.value = todayString;
        
        console.log('Date filters initialized to today:', todayString);
    }
    
    // Set date filter to today only
    function setTodayFilter() {
        const today = new Date();
        const todayString = formatDateForInput(today);
        
        startDateInput.value = todayString;
        endDateInput.value = todayString;
        
        loadEvents(searchInput.value, todayString, todayString);
    }
    
    // Set date filter to this week
    function setWeekFilter() {
        const today = new Date();
        const startOfWeek = getStartOfWeek(today);
        const endOfWeek = getEndOfWeek(today);
        
        const startString = formatDateForInput(startOfWeek);
        const endString = formatDateForInput(endOfWeek);
        
        startDateInput.value = startString;
        endDateInput.value = endString;
        
        loadEvents(searchInput.value, startString, endString);
    }
    
    // Clear date filters
    function clearDateFilters() {
        startDateInput.value = '';
        endDateInput.value = '';
        loadEvents(searchInput.value);
    }
    
    // =============================================
    // COLUMN VISIBILITY
    // =============================================
    function toggleColumn(columnName, isVisible) {
        // Toggle table headers
        const headers = document.querySelectorAll(`th[data-column="${columnName}"]`);
        headers.forEach(header => {
            header.style.display = isVisible ? '' : 'none';
        });
        
        // Find column index from header row
        const headerRow = document.querySelector('thead tr');
        const allHeaders = headerRow.querySelectorAll('th');
        let columnIndex = -1;
        allHeaders.forEach((header, index) => {
            if (header.getAttribute('data-column') === columnName) {
                columnIndex = index;
            }
        });
        
        // Toggle all cells in that column
        if (columnIndex !== -1) {
            const rows = document.querySelectorAll('#products-table-body tr');
            rows.forEach(row => {
                const cells = row.querySelectorAll('td');
                if (cells[columnIndex]) {
                    cells[columnIndex].style.display = isVisible ? '' : 'none';
                }
            });
        }
        
        // Toggle mobile card fields (h5, .customer-name, dt, dd elements with matching data-column)
        const mobileFields = document.querySelectorAll(`.mobile-cards [data-column="${columnName}"]`);
        mobileFields.forEach(field => {
            field.style.display = isVisible ? '' : 'none';
        });
        
        saveColumnPreferences();
    }
    
    function saveColumnPreferences() {
        const preferences = {};
        columnToggles.forEach(toggle => {
            preferences[toggle.getAttribute('data-column')] = toggle.checked;
        });
        localStorage.setItem('productsColumnPreferences', JSON.stringify(preferences));
    }
    
    function loadColumnPreferences() {
        const saved = localStorage.getItem('productsColumnPreferences');
        if (saved) {
            try {
                const preferences = JSON.parse(saved);
                columnToggles.forEach(toggle => {
                    const columnName = toggle.getAttribute('data-column');
                    if (preferences.hasOwnProperty(columnName)) {
                        toggle.checked = preferences[columnName];
                        toggleColumn(columnName, preferences[columnName]);
                    }
                });
            } catch (e) {
                console.error('Error loading column preferences:', e);
            }
        }
    }
    
    function showAllColumns() {
        columnToggles.forEach(toggle => {
            toggle.checked = true;
            toggleColumn(toggle.getAttribute('data-column'), true);
        });
    }
    
    function hideAllColumns() {
        columnToggles.forEach(toggle => {
            toggle.checked = false;
            toggleColumn(toggle.getAttribute('data-column'), false);
        });
    }
    
    function resetColumnsToDefault() {
        columnToggles.forEach(toggle => {
            toggle.checked = true;
            toggleColumn(toggle.getAttribute('data-column'), true);
        });
        localStorage.removeItem('productsColumnPreferences');
    }
    
    function initializeColumnVisibility() {
        columnToggles.forEach(toggle => {
            toggle.addEventListener('change', function() {
                const columnName = this.getAttribute('data-column');
                toggleColumn(columnName, this.checked);
            });
        });
        
        if (showAllColumnsButton) showAllColumnsButton.addEventListener('click', showAllColumns);
        if (hideAllColumnsButton) hideAllColumnsButton.addEventListener('click', hideAllColumns);
        if (resetColumnsButton) resetColumnsButton.addEventListener('click', resetColumnsToDefault);
        
        loadColumnPreferences();
    }
    
    function applyColumnVisibility() {
        columnToggles.forEach(toggle => {
            const columnName = toggle.getAttribute('data-column');
            toggleColumn(columnName, toggle.checked);
        });
    }
    
    // Function to handle ticket download using pre-signed URLs
    // Shared by downloadTicket (View Ticket) and printTicket (Print Ticket)
    // -- same S3 object, same auth, just different things done with the URL.
    async function getPresignedTicketUrl(qrCode) {
        console.log('Requesting pre-signed URL for QR Code:', qrCode);

        const response = await fetch(`${API_URL}/api/presigned-download`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ qrCode: qrCode })
        });

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.message || `Failed to get download URL: ${response.status}`);
        }

        const data = await response.json();
        console.log('Pre-signed URL received:', data);
        return data.downloadUrl;
    }

    async function downloadTicket(qrCode) {
        if (!qrCode) {
            alert('No QR code found for this ticket. Cannot download.');
            return;
        }

        try {
            const downloadUrl = await getPresignedTicketUrl(qrCode);

            // Use the pre-signed URL to download the file
            const downloadLink = document.createElement('a');
            downloadLink.href = downloadUrl;
            downloadLink.download = `ticket-${qrCode}.pdf`;
            downloadLink.target = '_blank';

            // Append to body, click, and remove
            document.body.appendChild(downloadLink);
            downloadLink.click();
            document.body.removeChild(downloadLink);

            console.log('Download initiated successfully');

        } catch (error) {
            console.error('Error downloading ticket:', error);
            alert(`Failed to download ticket: ${error.message}`);
        }
    }
    
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
    
    // getAuthHeaders function removed - now provided by auth-helper.js globally
    
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
    
    // Format date function
    function formatDate(dateString) {
        if (!dateString) return 'N/A';
        try {
            const date = new Date(dateString);
            return date.toLocaleString();
        } catch (e) {
            return dateString;
        }
    }
    
    // Toggle card details
    function toggleCardDetails(cardId) {
        const card = document.getElementById(cardId);
        const details = card.querySelector('.card-details');
        const header = card.querySelector('.card-header');
        
        if (details.style.display === 'block') {
            details.style.display = 'none';
            header.classList.add('collapsed');
        } else {
            details.style.display = 'block';
            header.classList.remove('collapsed');
        }
    }
    
    // Functions to handle check-in status clicks
    function handleCheckinStatusClick(productId, qrCode, name, email, customer, phone, isCheckedIn) {
        currentProductId = productId;
        currentQrCode = qrCode;
        
        if (isCheckedIn) {
            // Show check-out modal
            checkoutModalProductName.textContent = qrCode || 'Unknown';
            checkoutModalEventName.textContent = name || 'Unknown';
            checkoutModalEmail.textContent = email || 'Unknown';
            checkoutModalCustomerName.textContent = customer || 'Unknown';
            checkoutModalPhone.textContent = phone || 'Unknown';
            checkoutModal.show();
        } else {
            // Show check-in modal
            modalProductName.textContent = qrCode || 'Unknown';
            modalEventName.textContent = name || 'Unknown';
            modalEmail.textContent = email || 'Unknown';
            modalCustomerName.textContent = customer || 'Unknown';
            modalPhone.textContent = phone || 'Unknown';
            checkinModal.show();
        }
    }
    
    // Function to handle refund status clicks
    function handleRefundStatusClick(productId, qrCode, name, customer, status) {
        currentProductId = productId;
        currentQrCode = qrCode;
        currentStatus = status;
        
        refundModalProductName.textContent = qrCode || 'Unknown';
        refundModalEventName.textContent = name || 'Unknown';
        refundModalCustomerName.textContent = customer || 'Unknown';
        refundModalCurrentStatus.textContent = status || 'valid';
        refundModalNewStatus.textContent = status === 'valid' ? 'refunded' : 'valid';
        refundModal.show();
    }
    
    // Function to handle transfer ticket clicks
    function handleTransferClick(productId, name, customer) {
        currentProductId = productId;
        transferModalEventName.textContent = name || 'Unknown';
        transferModalCustomerName.textContent = customer || 'Unknown';
        transferFirstNameInput.value = '';
        transferLastNameInput.value = '';
        transferPhoneInput.value = '';
        transferEmailInput.value = '';
        transferModal.show();
    }

    // Function to handle view ticket clicks
    function handleViewTicketClick(qrCode, eventName) {
        console.log('View ticket clicked for:', eventName, 'QR Code:', qrCode);
        downloadTicket(qrCode);
    }

    // Sends the ticket to the local print agent (see the separate
    // "printer" repo) -- one agent instance on the venue's LAN, reached
    // by its LAN address (PRINT_AGENT_URL), not through the Lambda
    // backend (which has no network path to a printer on-site).
    async function printTicket(qrCode, buttonEl) {
        const originalText = buttonEl ? buttonEl.textContent : null;
        if (buttonEl) {
            buttonEl.disabled = true;
            buttonEl.textContent = 'Printing...';
        }

        try {
            const pdfUrl = await getPresignedTicketUrl(qrCode);

            const response = await fetch(`${PRINT_AGENT_URL}/print`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pdfUrl })
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                throw new Error(errorData.message || `Print agent returned ${response.status}`);
            }

            console.log('Ticket sent to printer successfully');

        } catch (error) {
            console.error('Error printing ticket:', error);
            alert(`Failed to print ticket: ${error.message}\n\nCheck that the print agent is running and reachable on this computer's network.`);
        } finally {
            if (buttonEl) {
                buttonEl.disabled = false;
                buttonEl.textContent = originalText;
            }
        }
    }

    function handlePrintTicketClick(qrCode, eventName, buttonEl) {
        if (!qrCode) {
            alert('No QR code found for this ticket. Cannot print.');
            return;
        }
        console.log('Print ticket clicked for:', eventName, 'QR Code:', qrCode);
        printTicket(qrCode, buttonEl);
    }

    // Initialize date filters and load events when page loads
    initializeDateFilters();
    initializeColumnVisibility();
    console.log('About to call loadEvents for initial load with todays date');
    loadEvents(searchInput.value, startDateInput.value, endDateInput.value);
    
    // Real-time search as user types (with debounce)
    searchInput.addEventListener('input', function() {
        if (searchTimeout) {
            clearTimeout(searchTimeout);
        }
        
        searchTimeout = setTimeout(function() {
            loadEvents(searchInput.value, startDateInput.value, endDateInput.value);
        }, 300);
    });
    
    // Clear search
    clearSearchButton.addEventListener('click', function() {
        searchInput.value = '';
        loadEvents('', startDateInput.value, endDateInput.value);
    });
    
    // Date filter event listeners
    applyDateFilterButton.addEventListener('click', function() {
        loadEvents(searchInput.value, startDateInput.value, endDateInput.value);
    });
    
    clearDateFilterButton.addEventListener('click', clearDateFilters);
    todayFilterButton.addEventListener('click', setTodayFilter);
    weekFilterButton.addEventListener('click', setWeekFilter);
    
    // Auto-apply date filter when dates change
    startDateInput.addEventListener('change', function() {
        loadEvents(searchInput.value, startDateInput.value, endDateInput.value);
    });
    
    endDateInput.addEventListener('change', function() {
        loadEvents(searchInput.value, startDateInput.value, endDateInput.value);
    });
    
    // Function to load events
    function loadEvents(searchTerm = '', startDate = '', endDate = '') {
        console.log('loadEvents called with params:', { searchTerm, startDate, endDate });
        
        loadingIndicator.style.display = 'block';
        productsTableBody.innerHTML = '';
        mobileCardsContainer.innerHTML = '';
        
        let url = `${API_URL}/api/products`;
        const params = new URLSearchParams();
        
        if (searchTerm) {
            params.append('search', searchTerm);
        }
        
        if (startDate) {
            params.append('startDate', startDate);
        }
        
        if (endDate) {
            params.append('endDate', endDate);
        }
        
        if (params.toString()) {
            url += `?${params.toString()}`;
        }
        
        console.log('Making API call to:', url);
        
        fetch(url, {
            headers: getAuthHeaders()
        })
        .then(response => {
            console.log('API Response received:', response.status, response.statusText);
            
            // 401/403 handling now automatic via auth-helper fetch interceptor
            if (!response.ok) {
                throw new Error(`Network response was not ok: ${response.status}`);
            }
            
            return response.json();
        })
        .then(products => {
            console.log('Products data received:', products);
            
            loadingIndicator.style.display = 'none';
            console.log("Products received:", products);
            
            if (!products.length && products.count !== undefined) {
                products = products.qrcodes || [];
            }
            
            if (products.length === 0) {
                const noResultsMessage = startDate || endDate ? 
                    'No events found for the selected date range' : 
                    'No events found';
                    
                productsTableBody.innerHTML = `
                    <tr>
                        <td colspan="9" class="text-center">${noResultsMessage}</td>
                    </tr>
                `;
                mobileCardsContainer.innerHTML = `
                    <div class="alert alert-info">${noResultsMessage}</div>
                `;
                return;
            }
            
            // Render each event
            products.forEach((product, index) => {
                console.log("Processing product:", product);
                
                // Normalize field names
                const id = product.ID || product.id;
                const qrCode = product.QRCode || product.qrCode;
                const eventName = product.ProductName || product.productName || product.Name || product.name || 'No Name';
                const eventDate = (product.ProductDate || product.productDate);
                const eventDetails = product.ProductDetails || product.productDetails || product.Details || product.details || 'No Details';
                const eventPrice = product.ProductPrice || product.productPrice || product.Price || product.price || 'N/A';
                const emailAddress = product.EmailAddress || product.emailAddress || product.Email || product.email || '';
                const expirationDate = (product.ExpirationDate || product.expirationDate);
                const checkedIn = product.CheckedIn || product.checkedIn || false;
                const status = product.Status || product.status || 'valid';
                
                const customerFirstName = product.CustomerFirstName || product.customerFirstName || product.FirstName || product.firstName || '';
                const customerLastName = product.CustomerLastName || product.customerLastName || product.LastName || product.lastName || '';
                const customerPhoneNumber = product.CustomerPhoneNumber || product.customerPhoneNumber || product.PhoneNumber || product.phoneNumber || 'N/A';
                
                const customerName = `${customerFirstName} ${customerLastName}`.trim() || 'Unknown';
                
                // Create table row for desktop view
                const row = document.createElement('tr');
                row.className = status === 'valid' ? 'row-status-valid' : 'row-status-invalid';
                if (checkedIn) row.classList.add('row-checked-in');
                
                row.innerHTML = `
                    <td data-column="event">${eventName}</td>
                    <td data-column="date">${eventDate}</td>
                    <td data-column="details">${eventDetails}</td>
                    <td data-column="customer-name">${customerName}</td>
                    <td data-column="email">${emailAddress || 'No Email'}</td>
                    <td data-column="phone">${customerPhoneNumber}</td>
                    <td data-column="price">${eventPrice}</td>
                    <td data-column="expiration">${expirationDate}</td>
                    <td class="action-cell">
                        <div class="dropdown">
                            <button class="btn btn-sm btn-outline-secondary dropdown-toggle action-dropdown-btn"
                                    type="button" data-bs-toggle="dropdown" aria-expanded="false">
                                Actions
                            </button>
                            <ul class="dropdown-menu action-dropdown-menu">
                                <li><button class="dropdown-item action-dropdown-item action-checkin"
                                            data-action="checkin"
                                            data-id="${id}"
                                            data-qrcode="${qrCode || ''}"
                                            data-name="${eventName}"
                                            data-email="${emailAddress}"
                                            data-customer="${customerName}"
                                            data-phone="${customerPhoneNumber}"
                                            data-checked-in="${checkedIn}">
                                    ${checkedIn ? 'Check Out' : 'Check In'}
                                </button></li>
                                <li><button class="dropdown-item action-dropdown-item ${status === 'valid' ? 'action-refund-destructive' : 'action-refund-restore'}"
                                            data-action="refund"
                                            data-id="${id}"
                                            data-qrcode="${qrCode || ''}"
                                            data-name="${eventName}"
                                            data-customer="${customerName}"
                                            data-status="${status}">
                                    ${status === 'valid' ? 'Mark as Invalid' : 'Mark as Valid'}
                                </button></li>
                                ${status === 'valid' && !checkedIn ? `
                                <li><button class="dropdown-item action-dropdown-item action-transfer"
                                            data-action="transfer"
                                            data-id="${id}"
                                            data-name="${eventName}"
                                            data-customer="${customerName}">
                                    Transfer Ticket
                                </button></li>` : ''}
                                <li><button class="dropdown-item action-dropdown-item action-view"
                                            data-action="view-ticket"
                                            data-qrcode="${qrCode || ''}"
                                            data-name="${eventName}">
                                    View Ticket
                                </button></li>
                                ${PRINT_AGENT_URL ? `
                                <li><button class="dropdown-item action-dropdown-item action-print"
                                            data-action="print-ticket"
                                            data-qrcode="${qrCode || ''}"
                                            data-name="${eventName}">
                                    Print Ticket
                                </button></li>` : ''}
                            </ul>
                        </div>
                    </td>
                `;
                
                productsTableBody.appendChild(row);
                
                // Create card for mobile view
                const card = document.createElement('div');
                card.className = `event-card ${status === 'valid' ? 'row-status-valid' : 'row-status-invalid'}${checkedIn ? ' row-checked-in' : ''}`;
                card.id = `card-${index}`;
                
                card.innerHTML = `
                    <div class="card-header collapsed" onclick="toggleCardDetails('card-${index}')">
                        <h5 data-column="event">${eventName}</h5>
                        <div class="customer-name" data-column="customer-name">${customerName}</div>
                        <div class="card-header-row">
                            <div></div>
                            <span class="card-collapse-icon">›</span>
                        </div>
                    </div>
                    
                    <div class="card-details">
                        <dl>
                            <dt data-column="date">Date</dt>
                            <dd data-column="date">${eventDate}</dd>
                            
                            <dt data-column="details">Details</dt>
                            <dd data-column="details">${eventDetails}</dd>
                            
                            <dt data-column="phone">Phone</dt>
                            <dd data-column="phone">${customerPhoneNumber}</dd>
                            
                            <dt data-column="email">Email</dt>
                            <dd data-column="email">${emailAddress || 'No Email'}</dd>
                            
                            <dt data-column="price">Price</dt>
                            <dd data-column="price">${eventPrice}</dd>
                            
                            <dt data-column="expiration">Expires</dt>
                            <dd data-column="expiration">${expirationDate}</dd>
                        </dl>
                    </div>
                    
                    <div class="card-action">
                        <div class="card-action-left">
                            <button class="btn btn-sm btn-outline-secondary" 
                                onclick="event.stopPropagation(); toggleCardDetails('card-${index}')">
                                Details
                            </button>
                        </div>
                        
                        <div class="card-action-right">
                            <div class="dropdown dropup">
                                <button class="btn btn-sm btn-outline-secondary dropdown-toggle action-dropdown-btn"
                                        type="button" data-bs-toggle="dropdown" aria-expanded="false">
                                    Actions
                                </button>
                                <ul class="dropdown-menu action-dropdown-menu">
                                    <li><button class="dropdown-item action-dropdown-item action-checkin"
                                                data-action="checkin"
                                                data-id="${id}"
                                                data-qrcode="${qrCode || ''}"
                                                data-name="${eventName}"
                                                data-email="${emailAddress}"
                                                data-customer="${customerName}"
                                                data-phone="${customerPhoneNumber}"
                                                data-checked-in="${checkedIn}">
                                        ${checkedIn ? 'Check Out' : 'Check In'}
                                    </button></li>
                                    <li><button class="dropdown-item action-dropdown-item ${status === 'valid' ? 'action-refund-destructive' : 'action-refund-restore'}"
                                                data-action="refund"
                                                data-id="${id}"
                                                data-qrcode="${qrCode || ''}"
                                                data-name="${eventName}"
                                                data-customer="${customerName}"
                                                data-status="${status}">
                                        ${status === 'valid' ? 'Mark as Invalid' : 'Mark as Valid'}
                                    </button></li>
                                    ${status === 'valid' && !checkedIn ? `
                                    <li><button class="dropdown-item action-dropdown-item action-transfer"
                                                data-action="transfer"
                                                data-id="${id}"
                                                data-name="${eventName}"
                                                data-customer="${customerName}">
                                        Transfer Ticket
                                    </button></li>` : ''}
                                    <li><button class="dropdown-item action-dropdown-item action-view"
                                                data-action="view-ticket"
                                                data-qrcode="${qrCode || ''}"
                                                data-name="${eventName}">
                                        View Ticket
                                    </button></li>
                                    ${PRINT_AGENT_URL ? `
                                    <li><button class="dropdown-item action-dropdown-item action-print"
                                                data-action="print-ticket"
                                                data-qrcode="${qrCode || ''}"
                                                data-name="${eventName}">
                                        Print Ticket
                                    </button></li>` : ''}
                                </ul>
                            </div>
                        </div>
                    </div>
                `;
                
                mobileCardsContainer.appendChild(card);
            });
            
            // Apply column visibility after table is populated
            applyColumnVisibility();
            
            // Actions dropdown menus were getting clipped at the bottom of
            // the table/card scroll container for the last row (or any row
            // when there are only one or two total) -- see order.js for the
            // full explanation; same fix here.
            document.querySelectorAll('.action-dropdown-btn').forEach(btn => {
                new bootstrap.Dropdown(btn, {
                    popperConfig: (defaultBsPopperConfig) => ({
                        ...defaultBsPopperConfig,
                        strategy: 'fixed'
                    })
                });
            });

            // Add event listeners to all action dropdown items
            document.querySelectorAll('.action-dropdown-item').forEach(element => {
                element.addEventListener('click', function(e) {
                    e.stopPropagation(); // Prevent card toggle when clicking actions
                    
                    const action = this.getAttribute('data-action');
                    
                    if (action === 'checkin') {
                        const productId = this.getAttribute('data-id');
                        const qrCode = this.getAttribute('data-qrcode');
                        const name = this.getAttribute('data-name');
                        const email = this.getAttribute('data-email');
                        const customer = this.getAttribute('data-customer');
                        const phone = this.getAttribute('data-phone');
                        const isCheckedIn = this.getAttribute('data-checked-in') === 'true';
                        
                        handleCheckinStatusClick(productId, qrCode, name, email, customer, phone, isCheckedIn);
                    } else if (action === 'refund') {
                        const productId = this.getAttribute('data-id');
                        const qrCode = this.getAttribute('data-qrcode');
                        const name = this.getAttribute('data-name');
                        const customer = this.getAttribute('data-customer');
                        const status = this.getAttribute('data-status');
                        
                        handleRefundStatusClick(productId, qrCode, name, customer, status);
                    } else if (action === 'view-ticket') {
                        const qrCode = this.getAttribute('data-qrcode');
                        const name = this.getAttribute('data-name');

                        handleViewTicketClick(qrCode, name);
                    } else if (action === 'print-ticket') {
                        const qrCode = this.getAttribute('data-qrcode');
                        const name = this.getAttribute('data-name');

                        handlePrintTicketClick(qrCode, name, this);
                    } else if (action === 'transfer') {
                        const productId = this.getAttribute('data-id');
                        const name = this.getAttribute('data-name');
                        const customer = this.getAttribute('data-customer');

                        handleTransferClick(productId, name, customer);
                    }
                });
            });
            
            // Make toggleCardDetails available globally
            window.toggleCardDetails = toggleCardDetails;
        })
        .catch(error => {
            console.error('Error fetching events:', error);
            console.error('Error details:', error.message, error.stack);
            loadingIndicator.style.display = 'none';
            productsTableBody.innerHTML = `
                <tr>
                    <td colspan="9" class="text-center text-danger">
                        Error loading events: ${error.message}. Please try again.
                    </td>
                </tr>
            `;
            mobileCardsContainer.innerHTML = `
                <div class="alert alert-danger">
                    Error loading events: ${error.message}. Please try again.
                </div>
            `;
        });
    }
    
    // Confirm check-in button click
    confirmCheckinButton.addEventListener('click', function() {
        if (!currentQrCode) {
            alert('No QR code found for this event. Cannot check in.');
            return;
        }
        
        console.log("Checking in event with QR Code:", currentQrCode);
        
        fetch(`${API_URL}/api/checkin`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ qrCode: currentQrCode })
        })
        .then(response => {
            // 401/403 handling now automatic via auth-helper
            if (!response.ok) {
                throw new Error('Network response was not ok');
            }
            
            return response.json();
        })
        .then(data => {
            console.log("Check-in response:", data);
            checkinModal.hide();
            
            if (data.returnStatus === 'successful_checkin') {
                alert('Event checked in successfully!');
            } else if (data.returnStatus === 'failed_already_checked_in') {
                alert('This event has already been checked in.');
            } else if (data.returnStatus === 'failed_expired_qrcode') {
                alert('This QR code has expired.');
            } else if (data.returnStatus === 'failed_no_QRCode') {
                alert('QR code not found in the system.');
            } else if (data.returnStatus === 'failed_ticket_not_valid') {
                alert(`This ticket is not valid (${data.ticketStatus}) and can't be checked in.`);
            } else {
                alert(`Check-in status: ${data.returnStatus}`);
            }
            
            loadEvents(searchInput.value, startDateInput.value, endDateInput.value);
        })
        .catch(error => {
            console.error('Error checking in event:', error);
            alert('Failed to check in event. Please try again.');
            checkinModal.hide();
        });
    });
    
    // Confirm check-out button click
    confirmCheckoutButton.addEventListener('click', function() {
        if (!currentQrCode) {
            alert('No QR code found for this event. Cannot check out.');
            return;
        }
        
        console.log("Checking out event with QR Code:", currentQrCode);
        
        fetch(`${API_URL}/api/checkout`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ qrCode: currentQrCode })
        })
        .then(response => {
            // 401/403 handling now automatic via auth-helper
            if (!response.ok) {
                throw new Error('Network response was not ok');
            }
            
            return response.json();
        })
        .then(data => {
            console.log("Check-out response:", data);
            checkoutModal.hide();
            
            if (data.returnStatus === 'successful_checkout') {
                alert('Event checked out successfully!');
            } else if (data.returnStatus === 'failed_already_checked_out') {
                alert('This event has already been checked out.');
            } else if (data.returnStatus === 'failed_expired_qrcode') {
                alert('This QR code has expired.');
            } else if (data.returnStatus === 'failed_no_QRCode') {
                alert('QR code not found in the system.');
            } else {
                alert(`Check-out status: ${data.returnStatus}`);
            }
            
            loadEvents(searchInput.value, startDateInput.value, endDateInput.value);
        })
        .catch(error => {
            console.error('Error checking out event:', error);
            alert('Failed to check out event. Please try again.');
            checkoutModal.hide();
        });
    });
    
    // Confirm refund toggle button click
    confirmRefundButton.addEventListener('click', function() {
        if (!currentProductId) {
            alert('No product ID found. Cannot change status.');
            return;
        }
        
        console.log("Toggling refund status for product ID:", currentProductId);
        
        fetch(`${API_URL}/api/products/${currentProductId}/refund`, {
            method: 'POST',
            headers: getAuthHeaders()
        })
        .then(response => {
            // 401/403 handling now automatic via auth-helper
            if (!response.ok) {
                throw new Error('Network response was not ok');
            }
            
            return response.json();
        })
        .then(data => {
            console.log("Refund toggle response:", data);
            refundModal.hide();
            
            if (data.returnStatus === 'successful_refund_toggle') {
                alert(`Status changed to ${data.newStatus} successfully!`);
            } else if (data.returnStatus === 'failed_no_product') {
                alert('Product not found in the system.');
            } else {
                alert(`Status change result: ${data.returnStatus}`);
            }
            
            loadEvents(searchInput.value, startDateInput.value, endDateInput.value);
        })
        .catch(error => {
            console.error('Error toggling refund status:', error);
            alert('Failed to change status. Please try again.');
            refundModal.hide();
        });
    });

    // Confirm transfer button click
    confirmTransferButton.addEventListener('click', function() {
        if (!currentProductId) {
            alert('No ticket selected. Cannot transfer.');
            return;
        }

        const recipientEmail = transferEmailInput.value.trim();
        if (!recipientEmail || !recipientEmail.includes('@')) {
            alert('A valid recipient email address is required.');
            return;
        }

        const payload = {
            recipientFirstName: transferFirstNameInput.value.trim(),
            recipientLastName: transferLastNameInput.value.trim(),
            recipientPhone: transferPhoneInput.value.trim(),
            recipientEmail: recipientEmail
        };

        confirmTransferButton.disabled = true;
        confirmTransferButton.textContent = 'Transferring...';

        fetch(`${API_URL}/api/products/${currentProductId}/transfer`, {
            method: 'POST',
            headers: {
                ...getAuthHeaders(),
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        })
        .then(response => response.json().then(data => ({ ok: response.ok, data })))
        .then(({ ok, data }) => {
            transferModal.hide();

            if (data.returnStatus === 'successful_transfer') {
                alert('Ticket transferred successfully. The new ticket has been emailed to the recipient.');
            } else if (data.returnStatus === 'successful_transfer_email_failed') {
                alert('Ticket transferred, but the email to the recipient failed to send. Please follow up manually.');
            } else if (!ok) {
                alert(`Transfer failed: ${data.message || data.returnStatus}`);
            } else {
                alert(`Transfer result: ${data.returnStatus}`);
            }

            loadEvents(searchInput.value, startDateInput.value, endDateInput.value);
        })
        .catch(error => {
            console.error('Error transferring ticket:', error);
            alert('Failed to transfer ticket. Please try again.');
            transferModal.hide();
        })
        .finally(() => {
            confirmTransferButton.disabled = false;
            confirmTransferButton.textContent = 'Transfer Ticket';
        });
    });
});
