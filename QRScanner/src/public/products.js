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
    
    // ---- LIST PAGING ----
    // Tickets load one page at a time from the server. A new search or date
    // range starts at page 1; reloading after an action stays on the page.
    let listFilters = null;
    let listArgs = ['', '', ''];
    const listPager = window.createListPager({ pageSize: 100, onChange: () => loadEvents(...listArgs) });

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
    // "Confirm Check-in & Print": only when this venue has a print agent
    const confirmCheckinPrintButton = document.getElementById('confirm-checkin-print');
    confirmCheckinPrintButton.hidden = !PRINT_AGENT_URL;
    
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
            UIDialogs.showMessage({ type: 'error', title: 'Couldn\'t download ticket', message: "This ticket has no QR code." });
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
            UIDialogs.showMessage({ type: 'error', title: "Couldn't download ticket", message: error.message });
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
    // Throws on failure; shared by Print Ticket and Confirm Check-in & Print
    async function sendTicketToPrinter(qrCode) {
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
    }

    async function printTicket(qrCode, buttonEl) {
        const originalText = buttonEl ? buttonEl.textContent : null;
        if (buttonEl) {
            buttonEl.disabled = true;
            buttonEl.textContent = 'Printing...';
        }

        try {
            await sendTicketToPrinter(qrCode);
            console.log('Ticket sent to printer successfully');

        } catch (error) {
            console.error('Error printing ticket:', error);
            UIDialogs.showMessage({ type: 'error', title: "Couldn't print ticket", message: "Check that the box office computer running the print agent is on, and that the printer is on and has labels.", details: error.message });
        } finally {
            if (buttonEl) {
                buttonEl.disabled = false;
                buttonEl.textContent = originalText;
            }
        }
    }

    function handlePrintTicketClick(qrCode, eventName, buttonEl) {
        if (!qrCode) {
            UIDialogs.showMessage({ type: 'error', title: 'Couldn\'t print ticket', message: "This ticket has no QR code." });
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
        const filters = JSON.stringify([searchTerm, startDate, endDate]);
        if (filters !== listFilters) { listFilters = filters; listPager.reset(); }
        listArgs = [searchTerm, startDate, endDate];
        params.append('page', listPager.page);
        params.append('pageSize', listPager.pageSize);
        
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
            if (products && !Array.isArray(products) && Array.isArray(products.tickets)) {
                listPager.update(products.total, products.page, products.pageSize);
                products = products.tickets;
            }
            
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
            // ---- ORDER REFUND ATTRIBUTION ----
            // Tickets refunded with their order get no actions, just who refunded them and why
            function escapeRefundText(value) {
                return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
            }
            function orderRefundNote(refund) {
                return `<div class="text-muted small refund-note">Refunded by: ${escapeRefundText(refund.refundedBy || 'Unknown')}<br>Reason: ${escapeRefundText(refund.refundReason || 'None given')}</div>`;
            }
            // ---- END ORDER REFUND ATTRIBUTION ----

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
                // Set by the server for tickets an Orders-page refund invalidated
                const refundNote = product.orderRefund ? orderRefundNote(product.orderRefund) : '';
                
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
                        ${refundNote || `<div class="dropdown">
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
                        </div>`}
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
                            ${refundNote || `<div class="dropdown dropup">
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
                            </div>`}
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
    
    // Confirm check-in button click; "Confirm Check-in & Print" also prints
    // the ticket, only after a successful check-in.
    confirmCheckinButton.addEventListener('click', () => confirmCheckin(false));
    confirmCheckinPrintButton.addEventListener('click', () => confirmCheckin(true));

    function confirmCheckin(alsoPrint) {
        if (!currentQrCode) {
            UIDialogs.showMessage({ type: 'error', title: 'Couldn\'t check in', message: "This ticket has no QR code." });
            return;
        }
        const qrCode = currentQrCode;
        
        console.log("Checking in event with QR Code:", qrCode, alsoPrint ? '(and printing)' : '');
        confirmCheckinButton.disabled = true;
        confirmCheckinPrintButton.disabled = true;
        
        fetch(`${API_URL}/api/checkin`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ qrCode })
        })
        .then(response => UIDialogs.readJson(response))  // 401/403 handling is automatic via auth-helper
        .then(async data => {
            console.log("Check-in response:", data);
            
            if (data.returnStatus === 'successful_checkin' && alsoPrint) {
                try {
                    await sendTicketToPrinter(qrCode);
                    checkinModal.hide();
                    UIDialogs.showMessage({ type: 'success', title: 'Checked in and printed', message: 'The ticket is checked in and was sent to the printer.' });
                } catch (error) {
                    console.error('Error printing ticket after check-in:', error);
                    checkinModal.hide();
                    UIDialogs.showMessage({ type: 'warning', title: "Checked in, but couldn't print", message: "The ticket is checked in. Check that the box office computer running the print agent is on, and that the printer is on and has labels, then use Print Ticket.", details: error.message });
                }
            } else if (data.returnStatus === 'successful_checkin') {
                checkinModal.hide();
                UIDialogs.showMessage({ type: 'success', title: 'Checked in', message: 'The ticket is checked in.' });
            } else {
                checkinModal.hide();
                if (data.returnStatus === 'failed_already_checked_in') {
                    UIDialogs.showMessage({ type: 'warning', title: 'Already checked in', message: 'This ticket was already checked in.' });
                } else if (data.returnStatus === 'failed_expired_qrcode') {
                    UIDialogs.showMessage({ type: 'error', title: "Couldn't check in", message: 'This ticket has expired.' });
                } else if (data.returnStatus === 'failed_no_QRCode') {
                    UIDialogs.showMessage({ type: 'error', title: "Couldn't check in", message: 'This ticket was not found.' });
                } else if (data.returnStatus === 'failed_ticket_not_valid') {
                    UIDialogs.showMessage({ type: 'error', title: "Couldn't check in", message: `This ticket is ${data.ticketStatus || 'not valid'}, so it can't be checked in.` });
                } else {
                    UIDialogs.showMessage({ type: 'error', title: "Couldn't check in", message: data.message || 'The ticket could not be checked in.', details: data.returnStatus });
                }
            }
            
            loadEvents(searchInput.value, startDateInput.value, endDateInput.value);
        })
        .catch(error => {
            console.error('Error checking in event:', error);
            UIDialogs.showMessage({ type: 'error', title: "Couldn't check in", message: 'Something went wrong. Please try again.', details: error.message });
            checkinModal.hide();
        })
        .finally(() => {
            confirmCheckinButton.disabled = false;
            confirmCheckinPrintButton.disabled = false;
        });
    }
    
    // Confirm check-out button click
    confirmCheckoutButton.addEventListener('click', function() {
        if (!currentQrCode) {
            UIDialogs.showMessage({ type: 'error', title: 'Couldn\'t check out', message: "This ticket has no QR code." });
            return;
        }
        
        console.log("Checking out event with QR Code:", currentQrCode);
        
        fetch(`${API_URL}/api/checkout`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ qrCode: currentQrCode })
        })
        .then(response => UIDialogs.readJson(response))  // 401/403 handling is automatic via auth-helper
        .then(data => {
            console.log("Check-out response:", data);
            checkoutModal.hide();
            
            if (data.returnStatus === 'successful_checkout') {
                UIDialogs.showMessage({ type: 'success', title: 'Checked out', message: 'The ticket is no longer checked in.' });
            } else if (data.returnStatus === 'failed_already_checked_out') {
                UIDialogs.showMessage({ type: 'warning', title: 'Not checked in', message: "This ticket wasn't checked in." });
            } else if (data.returnStatus === 'failed_expired_qrcode') {
                UIDialogs.showMessage({ type: 'error', title: "Couldn't check out", message: 'This ticket has expired.' });
            } else if (data.returnStatus === 'failed_no_QRCode') {
                UIDialogs.showMessage({ type: 'error', title: "Couldn't check out", message: 'This ticket was not found.' });
            } else {
                UIDialogs.showMessage({ type: 'error', title: "Couldn't check out", message: data.message || 'The ticket could not be checked out.', details: data.returnStatus });
            }
            
            loadEvents(searchInput.value, startDateInput.value, endDateInput.value);
        })
        .catch(error => {
            console.error('Error checking out event:', error);
            UIDialogs.showMessage({ type: 'error', title: "Couldn't check out", message: 'Something went wrong. Please try again.', details: error.message });
            checkoutModal.hide();
        });
    });
    
    // Confirm refund toggle button click
    confirmRefundButton.addEventListener('click', function() {
        if (!currentProductId) {
            UIDialogs.showMessage({ type: 'error', title: "Couldn't change ticket", message: 'No ticket is selected. Reload the page and try again.' });
            return;
        }
        
        console.log("Toggling refund status for product ID:", currentProductId);
        
        fetch(`${API_URL}/api/products/${currentProductId}/refund`, {
            method: 'POST',
            headers: getAuthHeaders()
        })
        .then(response => UIDialogs.readJson(response))  // 401/403 handling is automatic via auth-helper
        .then(data => {
            console.log("Refund toggle response:", data);
            refundModal.hide();
            
            if (data.returnStatus === 'successful_refund_toggle') {
                UIDialogs.showMessage(data.newStatus === 'valid'
                    ? { type: 'success', title: 'Ticket marked valid', message: 'The ticket will scan at the door again.' }
                    : { type: 'success', title: 'Ticket marked invalid', message: "The ticket won't scan at the door." });
            } else if (data.returnStatus === 'failed_order_refunded') {
                UIDialogs.showMessage({ type: 'warning', title: "Can't mark valid", message: data.message || 'This ticket was refunded with its order.' });
            } else if (data.returnStatus === 'failed_no_product') {
                UIDialogs.showMessage({ type: 'error', title: "Couldn't change ticket", message: 'This ticket was not found.' });
            } else {
                UIDialogs.showMessage({ type: 'error', title: "Couldn't change ticket", message: data.message || 'The ticket could not be changed.', details: data.returnStatus });
            }
            
            loadEvents(searchInput.value, startDateInput.value, endDateInput.value);
        })
        .catch(error => {
            console.error('Error toggling refund status:', error);
            UIDialogs.showMessage({ type: 'error', title: "Couldn't change ticket", message: 'Something went wrong. Please try again.', details: error.message });
            refundModal.hide();
        });
    });

    // Confirm transfer button click
    confirmTransferButton.addEventListener('click', function() {
        if (!currentProductId) {
            UIDialogs.showMessage({ type: 'error', title: "Couldn't transfer ticket", message: 'No ticket is selected. Reload the page and try again.' });
            return;
        }

        const recipientEmail = transferEmailInput.value.trim();
        if (!recipientEmail || !recipientEmail.includes('@')) {
            UIDialogs.fieldError(transferEmailInput, "Enter the recipient's email address.");
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
        .then(response => UIDialogs.readJson(response))
        .then(data => {
            transferModal.hide();

            if (data.returnStatus === 'successful_transfer') {
                UIDialogs.showMessage({ type: 'success', title: 'Ticket transferred', message: `The new ticket was emailed to ${recipientEmail}. The old ticket no longer scans.` });
            } else if (data.returnStatus === 'successful_transfer_email_failed') {
                UIDialogs.showMessage({ type: 'warning', title: 'Transferred, but not emailed', message: `The ticket was transferred, but the email to ${recipientEmail} didn't send. Please follow up with them directly.` });
            } else {
                UIDialogs.showMessage({ type: 'error', title: "Couldn't transfer ticket", message: data.message || 'The ticket could not be transferred.', details: data.returnStatus });
            }

            loadEvents(searchInput.value, startDateInput.value, endDateInput.value);
        })
        .catch(error => {
            console.error('Error transferring ticket:', error);
            UIDialogs.showMessage({ type: 'error', title: "Couldn't transfer ticket", message: 'Something went wrong. Please try again.', details: error.message });
            transferModal.hide();
        })
        .finally(() => {
            confirmTransferButton.disabled = false;
            confirmTransferButton.textContent = 'Transfer Ticket';
        });
    });
});
