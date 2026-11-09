document.addEventListener('DOMContentLoaded', function() {
    console.log('Order.js DOMContentLoaded fired');
    console.log('Bootstrap available:', typeof bootstrap !== 'undefined');
    
    const API_URL = window.INDIETIX_API_URL;
    // Local print agent, same as products.js: unset means this venue has no
    // ticket printer, so "Print Tickets" is hidden.
    const PRINT_AGENT_URL = window.INDIETIX_PRINT_AGENT_URL;
    
    // Get elements
    const searchInput = document.getElementById('search-input');
    const clearSearchButton = document.getElementById('clear-search');
    const ordersTableBody = document.getElementById('orders-table-body');
    const mobileCardsContainer = document.getElementById('mobile-cards-container');
    const loadingIndicator = document.getElementById('loading');
    
    // Date filter elements
    // ---- LIST PAGING ----
    // Orders load one page at a time from the server. A new search or date
    // range starts at page 1; reloading after an action stays on the page.
    let listFilters = null;
    let listArgs = ['', '', ''];
    const listPager = window.createListPager({ pageSize: 100, onChange: () => loadOrders(...listArgs) });

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

    // Each column's true HTML-authored default visibility (e.g.
    // order-details defaults hidden, unlike every other column) --
    // captured once up front, before loadColumnPreferences() can
    // overwrite toggle.checked with a saved preference, so
    // resetColumnsToDefault() has the real per-column default to restore
    // rather than just blanket-showing everything.
    const defaultColumnVisibility = {};
    columnToggles.forEach(toggle => {
        defaultColumnVisibility[toggle.getAttribute('data-column')] = toggle.checked;
    });
    
    console.log('DOM Elements found:', {
        searchInput: !!searchInput,
        clearSearchButton: !!clearSearchButton,
        ordersTableBody: !!ordersTableBody,
        mobileCardsContainer: !!mobileCardsContainer,
        loadingIndicator: !!loadingIndicator,
        startDateInput: !!startDateInput,
        endDateInput: !!endDateInput,
        columnToggles: columnToggles.length
    });
    
    // Resend email modal elements
    const resendEmailModal = new bootstrap.Modal(document.getElementById('resend-email-modal'));
    const modalOrderId = document.getElementById('modal-order-id');
    const modalCustomerName = document.getElementById('modal-customer-name');
    const modalEmailAddress = document.getElementById('modal-email-address');
    const modalPhoneNumber = document.getElementById('modal-phone-number');
    const modalCreatedDate = document.getElementById('modal-created-date');
    const confirmResendEmailButton = document.getElementById('confirm-resend-email');
    

// Add these elements after your existing modal elements (around line 40)
// Edit order modal elements
const editOrderModal = new bootstrap.Modal(document.getElementById('edit-order-modal'));
const editModalOrderId = document.getElementById('edit-modal-order-id');
const editFirstName = document.getElementById('edit-first-name');
const editLastName = document.getElementById('edit-last-name');
const editPhoneNumber = document.getElementById('edit-phone-number');
const editEmailAddress = document.getElementById('edit-email-address');
const confirmEditOrderButton = document.getElementById('confirm-edit-order');

// Refund order modal elements
// ---- ORDER REFUND ATTRIBUTION ----
// OrderMetaData.refund is written by POST /api/orders/:orderId/refund
function escapeRefundText(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function orderRefundNote(orderMetaData) {
    let meta = orderMetaData;
    if (typeof meta === 'string') {
        try { meta = JSON.parse(meta); } catch { return ''; }
    }
    const refund = meta && meta.refund;
    if (!refund) return '';
    return `Refunded by: ${escapeRefundText(refund.refundedBy || 'Unknown')}<br>Reason: ${escapeRefundText(refund.refundReason || 'None given')}`;
}
// ---- END ORDER REFUND ATTRIBUTION ----

const refundOrderModal = new bootstrap.Modal(document.getElementById('refund-order-modal'));
const refundModalOrderId = document.getElementById('refund-modal-order-id');
const refundModalCustomerName = document.getElementById('refund-modal-customer-name');
const refundModalEmailAddress = document.getElementById('refund-modal-email-address');
const refundModalOrderTotal = document.getElementById('refund-modal-order-total');
const refundModalAmountInput = document.getElementById('refund-modal-amount-input');
const refundModalPaymentId = document.getElementById('refund-modal-payment-id');
const refundModalTicketsList = document.getElementById('refund-modal-tickets-list');
const refundProcessedBySelect = document.getElementById('refund-processed-by');
const refundReasonTextarea = document.getElementById('refund-reason');
const confirmRefundOrderButton = document.getElementById('confirm-refund-order');

console.log('Refund modal elements captured:', {
    refundProcessedBySelect: !!refundProcessedBySelect,
    refundReasonTextarea: !!refundReasonTextarea,
    confirmRefundOrderButton: !!confirmRefundOrderButton
});

// Cancel order modal elements
const cancelOrderModal = new bootstrap.Modal(document.getElementById('cancel-order-modal'));
const cancelModalOrderId = document.getElementById('cancel-modal-order-id');
const cancelModalCustomerName = document.getElementById('cancel-modal-customer-name');
const cancelModalEmailAddress = document.getElementById('cancel-modal-email-address');
const cancelProcessedBySelect = document.getElementById('cancel-processed-by');
const cancelReasonTextarea = document.getElementById('cancel-reason');
const confirmCancelOrderButton = document.getElementById('confirm-cancel-order');

// Delete order modal elements
const deleteOrderModal = new bootstrap.Modal(document.getElementById('delete-order-modal'));
const deleteModalOrderId = document.getElementById('delete-modal-order-id');
const deleteModalCustomerName = document.getElementById('delete-modal-customer-name');
const deleteModalEmailAddress = document.getElementById('delete-modal-email-address');
const deleteProcessedBySelect = document.getElementById('delete-processed-by');
const deleteReasonTextarea = document.getElementById('delete-reason');
const confirmDeleteOrderButton = document.getElementById('confirm-delete-order');

// Add this variable with your other current variables (around line 50)
let currentEditOrderId = null;
let currentRefundOrderId = null;
let currentRefundPaymentId = null;
let currentRefundOrderTotalCents = 0;
let currentCancelOrderId = null;
let currentDeleteOrderId = null;
let userNames = []; // Will be loaded from configuration


    const userInfo = document.getElementById('user-info');
    
    let currentOrderId = null;
    let currentEmailAddress = null;
    let searchTimeout = null;
    
    // Column visibility functions
    function toggleColumn(columnName, isVisible) {
        console.log(`Toggling column ${columnName} to ${isVisible ? 'visible' : 'hidden'}`);
        
        // Toggle table headers
        const headers = document.querySelectorAll(`th[data-column="${columnName}"]`);
        headers.forEach(header => {
            header.style.display = isVisible ? '' : 'none';
        });
        
        // Toggle table cells - need to find the correct column index
        const headerRow = document.querySelector('thead tr');
        const allHeaders = headerRow.querySelectorAll('th');
        let columnIndex = -1;
        
        allHeaders.forEach((header, index) => {
            if (header.getAttribute('data-column') === columnName) {
                columnIndex = index;
            }
        });
        
        if (columnIndex !== -1) {
            // Toggle all cells in this column
            const rows = document.querySelectorAll('#orders-table-body tr');
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
        
        // Save preference
        saveColumnPreferences();
    }
    
    function saveColumnPreferences() {
        const preferences = {};
        columnToggles.forEach(toggle => {
            preferences[toggle.getAttribute('data-column')] = toggle.checked;
        });
        localStorage.setItem('orderColumnPreferences', JSON.stringify(preferences));
        console.log('Column preferences saved:', preferences);
    }
    
    function loadColumnPreferences() {
        const saved = localStorage.getItem('orderColumnPreferences');
        if (saved) {
            try {
                const preferences = JSON.parse(saved);
                console.log('Loading column preferences:', preferences);
                
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
        // Reset each column to its own real HTML-authored default -- NOT
        // a blanket "show everything." order-details defaults hidden; if
        // that ever changes in the HTML, this follows automatically
        // rather than needing a second place updated to match.
        columnToggles.forEach(toggle => {
            const columnName = toggle.getAttribute('data-column');
            const isVisible = defaultColumnVisibility[columnName] !== false;
            toggle.checked = isVisible;
            toggleColumn(columnName, isVisible);
        });
        // Clear saved preferences
        localStorage.removeItem('orderColumnPreferences');
        console.log('Column preferences reset to default');
    }
    
    // Initialize column visibility controls
    function initializeColumnVisibility() {
        console.log('Initializing column visibility controls');
        
        // Add event listeners to column toggles
        columnToggles.forEach(toggle => {
            toggle.addEventListener('change', function() {
                const columnName = this.getAttribute('data-column');
                const isVisible = this.checked;
                toggleColumn(columnName, isVisible);
            });
        });
        
        // Add event listeners to control buttons
        if (showAllColumnsButton) {
            showAllColumnsButton.addEventListener('click', showAllColumns);
        }
        
        if (hideAllColumnsButton) {
            hideAllColumnsButton.addEventListener('click', hideAllColumns);
        }
        
        if (resetColumnsButton) {
            resetColumnsButton.addEventListener('click', resetColumnsToDefault);
        }
        
        // Load saved preferences
        loadColumnPreferences();

        // loadColumnPreferences() only calls toggleColumn() for columns
        // that have a SAVED preference -- a column with no saved
        // preference (e.g. a brand new visitor, or order-details before
        // anyone's ever touched that checkbox) never got its actual
        // table column hidden to match its checkbox's HTML-authored
        // default, since nothing else applies that default to the table
        // at load time. Apply every toggle's current checked state
        // (saved-preference or still-HTML-default) to the table now, so
        // the table always matches what the checkboxes show.
        columnToggles.forEach(toggle => {
            toggleColumn(toggle.getAttribute('data-column'), toggle.checked);
        });
    }
    
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
        
        loadOrders(searchInput.value, todayString, todayString);
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
        
        loadOrders(searchInput.value, startString, endString);
    }
    
    // Clear date filters
    function clearDateFilters() {
        startDateInput.value = '';
        endDateInput.value = '';
        loadOrders(searchInput.value);
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
    
    // Load client configuration to get USERS_NAMES for refund dropdown
    async function loadClientConfiguration() {
        try {
            const response = await fetch(`${API_URL}/api/client/ui-config`, {
                method: 'GET',
                headers: getAuthHeaders()
            });
            
            if (!response.ok) {
                console.error('Failed to load client configuration');
                return;
            }
            
            const data = await response.json();
            console.log('Client config response:', data);
            
            // Fix: API returns data.client.configuration, not data.configuration
            const client = data.client || {};
            const config = client.configuration || {};
            
            // Load USERS_NAMES from configuration
            userNames = config.USERS_NAMES || [];
            console.log('Loaded user names:', userNames);
            
            // Populate all user dropdowns (refund, cancel, delete)
            populateAllUserDropdowns();
            
        } catch (error) {
            console.error('Error loading client configuration:', error);
        }
    }
    
    // Generic helper - populates any user dropdown from the userNames array
    function populateUserDropdown(selectElement) {
        if (!selectElement) return;
        selectElement.innerHTML = '<option value="">-- Select User --</option>';
        userNames.forEach(userName => {
            const option = document.createElement('option');
            option.value = userName;
            option.textContent = userName;
            selectElement.appendChild(option);
        });
    }
    
    // Populate all three modal dropdowns (refund, cancel, delete)
    function populateAllUserDropdowns() {
        console.log('Populating user dropdowns with', userNames.length, 'users');
        populateUserDropdown(refundProcessedBySelect);
        populateUserDropdown(cancelProcessedBySelect);
        populateUserDropdown(deleteProcessedBySelect);
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
    
    // Function to handle resend email clicks
    function handleResendEmailClick(orderId, orderID, customerName, emailAddress, phoneNumber, createdDate) {
        currentOrderId = orderId;
        currentEmailAddress = emailAddress;
        
        modalOrderId.textContent = orderID || 'Unknown';
        modalCustomerName.textContent = customerName || 'Unknown';
        modalEmailAddress.textContent = emailAddress || 'Unknown';
        modalPhoneNumber.textContent = phoneNumber || 'Unknown';
        modalCreatedDate.textContent = formatDate(createdDate) || 'Unknown';
        
        resendEmailModal.show();
    }

// Function to handle edit order clicks
function handleEditOrderClick(orderId, orderID, firstName, lastName, phoneNumber, emailAddress) {
    currentEditOrderId = orderId;
    
    editModalOrderId.textContent = orderID || 'Unknown';
    editFirstName.value = firstName || '';
    editLastName.value = lastName || '';
    editPhoneNumber.value = phoneNumber || '';
    editEmailAddress.value = emailAddress || '';
    
    editOrderModal.show();
}

// Function to extract payment ID from order metadata
function extractPaymentId(orderMetaData) {
    try {
        if (!orderMetaData) return null;
        
        // Parse if it's a string
        const metadata = typeof orderMetaData === 'string' ? JSON.parse(orderMetaData) : orderMetaData;
        
        // Navigate through the structure: order.tenders[0].payment_id
        if (metadata.order && metadata.order.tenders && metadata.order.tenders.length > 0) {
            return metadata.order.tenders[0].payment_id;
        }
        
        return null;
    } catch (error) {
        console.error('Error extracting payment ID:', error);
        return null;
    }
}

// Function to format amount from cents to dollars
function formatAmount(amountInCents) {
    if (!amountInCents) return '$0.00';
    return `$${(amountInCents / 100).toFixed(2)}`;
}

// Function to extract amount from order metadata
function extractAmount(orderMetaData) {
    try {
        if (!orderMetaData) return 0;
        
        // Parse if it's a string
        const metadata = typeof orderMetaData === 'string' ? JSON.parse(orderMetaData) : orderMetaData;
        
        // Navigate through the structure: order.total_money.amount
        if (metadata.order && metadata.order.total_money && metadata.order.total_money.amount) {
            return metadata.order.total_money.amount;
        }
        
        return 0;
    } catch (error) {
        console.error('Error extracting amount:', error);
        return 0;
    }
}

// Function to handle refund order clicks
function handleRefundOrderClick(orderId, orderID, customerName, emailAddress, orderMetaData) {
    // Extract payment_id from OrderMetaData
    const paymentId = extractPaymentId(orderMetaData);

    if (!paymentId) {
        UIDialogs.showMessage({ type: 'error', title: "Can't refund this order", message: "This order has no Square payment ID, so it may not have been paid through Square." });
        return;
    }

    // Extract amount
    const amount = extractAmount(orderMetaData);

    // Store for later use
    currentRefundOrderId = orderId;
    currentRefundPaymentId = paymentId;
    currentRefundOrderTotalCents = amount;

    // Populate modal
    refundModalOrderId.textContent = orderID || 'Unknown';
    refundModalCustomerName.textContent = customerName || 'Unknown';
    refundModalEmailAddress.textContent = emailAddress || 'Unknown';
    refundModalOrderTotal.textContent = formatAmount(amount);
    refundModalPaymentId.textContent = paymentId;

    // Default the refund amount to the full order total; staff can lower it
    refundModalAmountInput.value = (amount / 100).toFixed(2);
    refundModalAmountInput.max = (amount / 100).toFixed(2);

    // Clear form fields
    refundProcessedBySelect.value = '';
    refundReasonTextarea.value = '';

    loadRefundTicketsChecklist(orderId);

    refundOrderModal.show();
}

// Fetches this order's tickets and renders a checklist of which ones to
// invalidate. All valid tickets are checked by default (matches the old
// "refund invalidates everything" behavior); staff can uncheck any they
// don't want touched.
function loadRefundTicketsChecklist(orderId) {
    refundModalTicketsList.innerHTML = '<div class="text-muted small">Loading tickets...</div>';

    fetch(`${API_URL}/api/orders/${orderId}/tickets`, {
        method: 'GET',
        headers: getAuthHeaders()
    })
    .then(response => response.json())
    .then(data => {
        const tickets = (data.tickets || []).filter(t => t.Status === 'valid');

        if (tickets.length === 0) {
            refundModalTicketsList.innerHTML = '<div class="text-muted small">No valid tickets found on this order.</div>';
            return;
        }

        refundModalTicketsList.innerHTML = tickets.map(ticket => {
            const label = [ticket.ProductName, ticket.ProductSeatCode].filter(Boolean).join(' — ');
            const price = ticket.ProductPrice ? ` ($${parseFloat(ticket.ProductPrice).toFixed(2)})` : '';
            return `
                <div class="form-check">
                    <input class="form-check-input refund-ticket-checkbox" type="checkbox"
                           value="${ticket.ID}" id="refund-ticket-${ticket.ID}" checked>
                    <label class="form-check-label" for="refund-ticket-${ticket.ID}">
                        ${label || ticket.QRCode}${price}
                    </label>
                </div>
            `;
        }).join('');
    })
    .catch(error => {
        console.error('Error loading tickets for refund:', error);
        refundModalTicketsList.innerHTML = '<div class="text-danger small">Failed to load tickets. You can still process a money-only refund.</div>';
    });
}

// Handle Cancel Order button click
function handleCancelOrderClick(orderId, orderID, customerName, emailAddress) {
    // Store for later use
    currentCancelOrderId = orderId;
    
    // Populate modal
    cancelModalOrderId.textContent = orderID || 'Unknown';
    cancelModalCustomerName.textContent = customerName || 'Unknown';
    cancelModalEmailAddress.textContent = emailAddress || 'Unknown';
    
    // Clear form fields
    cancelProcessedBySelect.value = '';
    cancelReasonTextarea.value = '';
    
    cancelOrderModal.show();
}

// Handle Delete Order button click
function handleDeleteOrderClick(orderId, orderID, customerName, emailAddress) {
    // Store for later use
    currentDeleteOrderId = orderId;
    
    // Populate modal
    deleteModalOrderId.textContent = orderID || 'Unknown';
    deleteModalCustomerName.textContent = customerName || 'Unknown';
    deleteModalEmailAddress.textContent = emailAddress || 'Unknown';
    
    // Clear form fields
    deleteProcessedBySelect.value = '';
    deleteReasonTextarea.value = '';
    
    deleteOrderModal.show();
}

// ---- PRINT ALL TICKETS IN AN ORDER ----
// Sends every valid ticket on the order to the local print agent, in order.
// The tickets' links are fetched together, then go to the agent's
// /print-batch in one request, which prepares the next ticket while the
// current one prints. An older agent without /print-batch gets them one
// at a time instead. Refunded, cancelled or transferred tickets are
// skipped. No confirmation popup.
const ordersBeingPrinted = new Set();

async function getPresignedTicketUrl(qrCode) {
    const response = await fetch(`${API_URL}/api/presigned-download`, {
        method: 'POST',
        headers: getAuthHeaders(),
        body: JSON.stringify({ qrCode })
    });
    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `Failed to get ticket: ${response.status}`);
    }
    return (await response.json()).downloadUrl;
}

async function printOneTicket(pdfUrl) {
    const printResponse = await fetch(`${PRINT_AGENT_URL}/print`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pdfUrl })
    });
    if (!printResponse.ok) {
        const errorData = await printResponse.json().catch(() => ({}));
        throw new Error(errorData.message || `Print agent returned ${printResponse.status}`);
    }
}

async function handlePrintOrderTicketsClick(orderId, orderID) {
    if (ordersBeingPrinted.has(orderId)) return;
    ordersBeingPrinted.add(orderId);

    let printed = 0;
    let tickets = [];
    try {
        const response = await fetch(`${API_URL}/api/orders/${orderId}/tickets`, { headers: getAuthHeaders() });
        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            throw new Error(errorData.message || `Failed to load tickets: ${response.status}`);
        }
        tickets = ((await response.json()).tickets || []).filter(t => t.Status === 'valid' && t.QRCode);

        if (tickets.length === 0) {
            UIDialogs.showMessage({ type: 'warning', title: 'Nothing to print', message: `Order ${orderID} has no valid tickets.` });
            return;
        }

        const pdfUrls = await Promise.all(tickets.map(ticket => getPresignedTicketUrl(ticket.QRCode)));

        // The agent takes up to 50 tickets per request
        for (let i = 0; i < pdfUrls.length; i += 50) {
            const batch = pdfUrls.slice(i, i + 50);
            const batchResponse = await fetch(`${PRINT_AGENT_URL}/print-batch`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ pdfUrls: batch })
            });
            if (batchResponse.status === 404) {
                // An older agent: one ticket per request
                for (const pdfUrl of batch) {
                    await printOneTicket(pdfUrl);
                    printed++;
                }
                continue;
            }
            const result = await batchResponse.json().catch(() => ({}));
            if (!batchResponse.ok || !result.success) {
                printed += result.printed || 0;
                throw new Error(result.message || `Print agent returned ${batchResponse.status}`);
            }
            printed += result.printed;
        }
        console.log(`Printed ${printed} ticket(s) for order ${orderID}`);

    } catch (error) {
        console.error('Error printing order tickets:', error);
        const progress = tickets.length ? ` ${printed} of ${tickets.length} tickets printed before the problem.` : '';
        UIDialogs.showMessage({ type: 'error', title: "Couldn't print tickets", message: `Check that the box office computer running the print agent is on, and that the printer is on and has labels.${progress}`, details: error.message });
    } finally {
        ordersBeingPrinted.delete(orderId);
    }
}
// ---- END PRINT ALL TICKETS IN AN ORDER ----
    
    // Apply column visibility after table is populated
    function applyColumnVisibility() {
        columnToggles.forEach(toggle => {
            const columnName = toggle.getAttribute('data-column');
            const isVisible = toggle.checked;
            toggleColumn(columnName, isVisible);
        });
    }
    
    // Initialize column visibility and date filters, then load orders
    initializeColumnVisibility();
    initializeDateFilters();
    loadClientConfiguration(); // Load user names for refund dropdown
    console.log('About to call loadOrders for initial load with todays date');
    loadOrders(searchInput.value, startDateInput.value, endDateInput.value);
    
    // Real-time search as user types (with debounce)
    searchInput.addEventListener('input', function() {
        if (searchTimeout) {
            clearTimeout(searchTimeout);
        }
        
        searchTimeout = setTimeout(function() {
            loadOrders(searchInput.value, startDateInput.value, endDateInput.value);
        }, 300);
    });
    
    // Clear search
    clearSearchButton.addEventListener('click', function() {
        searchInput.value = '';
        loadOrders('', startDateInput.value, endDateInput.value);
    });
    
    // Date filter event listeners
    applyDateFilterButton.addEventListener('click', function() {
        loadOrders(searchInput.value, startDateInput.value, endDateInput.value);
    });
    
    clearDateFilterButton.addEventListener('click', clearDateFilters);
    todayFilterButton.addEventListener('click', setTodayFilter);
    weekFilterButton.addEventListener('click', setWeekFilter);
    
    // Auto-apply date filter when dates change
    startDateInput.addEventListener('change', function() {
        loadOrders(searchInput.value, startDateInput.value, endDateInput.value);
    });
    
    endDateInput.addEventListener('change', function() {
        loadOrders(searchInput.value, startDateInput.value, endDateInput.value);
    });
    
    // Function to load orders
    function loadOrders(searchTerm = '', startDate = '', endDate = '') {
        console.log('loadOrders called with params:', { searchTerm, startDate, endDate });
        
        loadingIndicator.style.display = 'block';
        ordersTableBody.innerHTML = '';
        mobileCardsContainer.innerHTML = '';
        
        let url = `${API_URL}/api/orders`;
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
        .then(orders => {
            console.log('Orders data received:', orders);
            
            loadingIndicator.style.display = 'none';
            console.log("Orders received:", orders);
            
            let truncated = false;
            let resultLimit = null;
            if (!Array.isArray(orders) && orders.orders !== undefined) {
                truncated = !!orders.truncated;
                resultLimit = orders.limit;
                if (orders.total !== undefined) listPager.update(orders.total, orders.page, orders.pageSize);
                orders = orders.orders || [];
            }

            if (orders.length === 0) {
                const noResultsMessage = startDate || endDate ? 
                    'No orders found for the selected date range' : 
                    'No orders found';
                    
                ordersTableBody.innerHTML = `
                    <tr>
                        <td colspan="10" class="text-center">${noResultsMessage}</td>
                    </tr>
                `;
                mobileCardsContainer.innerHTML = `
                    <div class="alert alert-info">${noResultsMessage}</div>
                `;
                return;
            }
            
            // Render each order
            orders.forEach((order, index) => {
                console.log("Processing order:", order);
                
                // Normalize field names
                const id = order.ID || order.id;
                const orderID = order.OrderID || order.orderID || 'N/A';
                const createdDate = order.CreatedDate || order.createdDate;
                const lastEditedDate = order.LastEditedDate || order.lastEditedDate;
                const orderMetaData = order.OrderMetaData || order.orderMetaData || {};
                const phoneNumber = order.PhoneNumber || order.phoneNumber || 'N/A';
                const lastName = order.LastName || order.lastName || '';
                const firstName = order.FirstName || order.firstName || '';
                const emailAddress = order.EmailAddress || order.emailAddress || 'N/A';
                const status = order.Status || order.status || 'Valid';
                // A refunded order shows who refunded it and why instead of "No actions available"
                const noActionsNote = orderRefundNote(orderMetaData) || '<em>No actions available</em>';
                
                const customerName = `${firstName} ${lastName}`.trim() || 'Unknown';
                
                // Extract total amount from OrderMetaData
                const totalAmount = extractAmount(orderMetaData);
                const formattedTotal = formatAmount(totalAmount);
                
                // Format order details from metadata
                let orderDetails = 'No details';
                if (orderMetaData && typeof orderMetaData === 'object') {
                    // Try to extract meaningful info from metadata
                    const details = [];
                    if (orderMetaData.eventName) details.push(`Event: ${orderMetaData.eventName}`);
                    if (orderMetaData.ticketCount) details.push(`Tickets: ${orderMetaData.ticketCount}`);
                    if (orderMetaData.totalAmount) details.push(`Total: ${orderMetaData.totalAmount}`);
		    orderDetails = details.length > 0 ? details.join(', ') : JSON.stringify(orderMetaData);
                }
                
                // Create table row for desktop view
                const row = document.createElement('tr');
                
               	row.innerHTML = `
    <td class="column-cell" data-column="order-id">${orderID}</td>
    <td class="column-cell" data-column="created-date">${formatDate(createdDate)}</td>
    <td class="column-cell" data-column="customer-name">${customerName}</td>
    <td class="column-cell" data-column="email">${emailAddress}</td>
    <td class="column-cell" data-column="phone">${phoneNumber}</td>
    <td class="column-cell" data-column="status">
        <span class="status-badge status-${status.toLowerCase()}">${status}</span>
    </td>
    <td class="column-cell" data-column="last-edited">${formatDate(lastEditedDate)}</td>
    <td class="column-cell" data-column="total-amount">${formattedTotal}</td>
    <td class="column-cell" data-column="order-details">${orderDetails}</td>
    <td class="action-cell">
        ${status === 'Valid' ? `
        <div class="dropdown">
            <button class="btn btn-sm btn-outline-secondary dropdown-toggle action-dropdown-btn"
                    type="button" data-bs-toggle="dropdown" aria-expanded="false">
                Actions
            </button>
            <ul class="dropdown-menu action-dropdown-menu">
                <li><button class="dropdown-item action-dropdown-item action-resend"
                            data-action="resend-email"
                            data-id="${id}"
                            data-order-id="${orderID}"
                            data-customer-name="${customerName}"
                            data-email="${emailAddress}"
                            data-phone="${phoneNumber}"
                            data-created-date="${createdDate}">
                    Resend Email
                </button></li>
                ${PRINT_AGENT_URL ? `
                <li><button class="dropdown-item action-dropdown-item action-print"
                            data-action="print-order-tickets"
                            data-id="${id}"
                            data-order-id="${orderID}">
                    Print Tickets
                </button></li>` : ''}
                <li><button class="dropdown-item action-dropdown-item action-edit"
                            data-action="edit-order"
                            data-id="${id}"
                            data-order-id="${orderID}"
                            data-first-name="${firstName}"
                            data-last-name="${lastName}"
                            data-phone="${phoneNumber}"
                            data-email="${emailAddress}">
                    Edit Order
                </button></li>
                <li><button class="dropdown-item action-dropdown-item action-refund"
                            data-action="refund-order"
                            data-id="${id}"
                            data-order-id="${orderID}"
                            data-customer-name="${customerName}"
                            data-email="${emailAddress}"
                            data-order-metadata='${JSON.stringify(orderMetaData || {})}'>
                    Refund Order
                </button></li>
                <li><button class="dropdown-item action-dropdown-item action-cancel"
                            data-action="cancel-order"
                            data-id="${id}"
                            data-order-id="${orderID}"
                            data-customer-name="${customerName}"
                            data-email="${emailAddress}">
                    Cancel Order
                </button></li>
                <li><button class="dropdown-item action-dropdown-item action-delete"
                            data-action="delete-order"
                            data-id="${id}"
                            data-order-id="${orderID}"
                            data-customer-name="${customerName}"
                            data-email="${emailAddress}">
                    Delete Order
                </button></li>
            </ul>
        </div>
        ` : `
        <div class="text-muted small refund-note">
            ${noActionsNote}
        </div>
        `}
    </td>
`;

                // Row color coding by status
                row.classList.add(`row-status-${status.toLowerCase()}`);
 
                ordersTableBody.appendChild(row);
                
                // Create card for mobile view
                const card = document.createElement('div');
                card.className = 'order-card';
                card.id = `card-${index}`;
                
               card.innerHTML = `
    <div class="card-header collapsed" onclick="toggleCardDetails('card-${index}')">
        <h5 data-column="order-id">${orderID}</h5>
        <div class="customer-name" data-column="customer-name">${customerName}</div>
        <div class="card-header-row">
            <div></div>
            <span class="card-collapse-icon">›</span>
        </div>
    </div>
    
    <div class="card-details">
        <dl>
            <dt data-column="created-date">Created Date</dt>
            <dd data-column="created-date">${formatDate(createdDate)}</dd>
            
            <dt data-column="email">Email Address</dt>
            <dd data-column="email">${emailAddress}</dd>
            
            <dt data-column="phone">Phone Number</dt>
            <dd data-column="phone">${phoneNumber}</dd>
            
            <dt data-column="status">Status</dt>
            <dd data-column="status"><span class="status-badge status-${status.toLowerCase()}">${status}</span></dd>
            
            <dt data-column="last-edited">Last Edited</dt>
            <dd data-column="last-edited">${formatDate(lastEditedDate)}</dd>
            
            <dt data-column="total-amount">Total $</dt>
            <dd data-column="total-amount">${formattedTotal}</dd>
            
            <dt data-column="order-details">Order Details</dt>
            <dd data-column="order-details">${orderDetails}</dd>
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
            ${status === 'Valid' ? `
            <div class="dropdown dropup">
                <button class="btn btn-sm btn-outline-secondary dropdown-toggle action-dropdown-btn"
                        type="button" data-bs-toggle="dropdown" aria-expanded="false">
                    Actions
                </button>
                <ul class="dropdown-menu action-dropdown-menu">
                    <li><button class="dropdown-item action-dropdown-item action-resend"
                                data-action="resend-email"
                                data-id="${id}"
                                data-order-id="${orderID}"
                                data-customer-name="${customerName}"
                                data-email="${emailAddress}"
                                data-phone="${phoneNumber}"
                                data-created-date="${createdDate}">
                        Resend Email
                    </button></li>
                    ${PRINT_AGENT_URL ? `
                    <li><button class="dropdown-item action-dropdown-item action-print"
                                data-action="print-order-tickets"
                                data-id="${id}"
                                data-order-id="${orderID}">
                        Print Tickets
                    </button></li>` : ''}
                    <li><button class="dropdown-item action-dropdown-item action-edit"
                                data-action="edit-order"
                                data-id="${id}"
                                data-order-id="${orderID}"
                                data-first-name="${firstName}"
                                data-last-name="${lastName}"
                                data-phone="${phoneNumber}"
                                data-email="${emailAddress}">
                        Edit Order
                    </button></li>
                    <li><button class="dropdown-item action-dropdown-item action-refund"
                                data-action="refund-order"
                                data-id="${id}"
                                data-order-id="${orderID}"
                                data-customer-name="${customerName}"
                                data-email="${emailAddress}"
                                data-order-metadata='${JSON.stringify(orderMetaData || {})}'>
                        Refund Order
                    </button></li>
                    <li><button class="dropdown-item action-dropdown-item action-cancel"
                                data-action="cancel-order"
                                data-id="${id}"
                                data-order-id="${orderID}"
                                data-customer-name="${customerName}"
                                data-email="${emailAddress}">
                        Cancel Order
                    </button></li>
                    <li><button class="dropdown-item action-dropdown-item action-delete"
                                data-action="delete-order"
                                data-id="${id}"
                                data-order-id="${orderID}"
                                data-customer-name="${customerName}"
                                data-email="${emailAddress}">
                        Delete Order
                    </button></li>
                </ul>
            </div>
            ` : `
            <span class="text-muted small refund-note">${noActionsNote}</span>
            `}
        </div>
    </div>
`; 
                // Card color coding by status
                card.classList.add(`row-status-${status.toLowerCase()}`);
                
                mobileCardsContainer.appendChild(card);
            });
            
            // Apply column visibility after table is populated
            applyColumnVisibility();

            if (truncated) {
                const notice = document.createElement('div');
                notice.className = 'alert alert-warning';
                notice.textContent = `Showing the ${resultLimit} most recent orders. Narrow your date range to see more specific results.`;
                mobileCardsContainer.prepend(notice);
            }

            // Actions dropdown menus were getting clipped at the bottom of
            // the table/card scroll container for the last row (or any row
            // when there are only one or two total) -- .desktop-table sets
            // overflow-x:auto, which per the CSS spec forces overflow-y to
            // compute as auto too, clipping anything that renders past the
            // wrapper's bottom edge. Bootstrap's dropdown positions its menu
            // with position:absolute by default, which is clipped by that
            // scrolling ancestor; position:fixed escapes it (same fix
            // pattern as the loading-spinner/backdrop-filter issue found
            // earlier -- confirmed no ancestor here has transform/filter,
            // which would otherwise block position:fixed from escaping too).
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
        
        if (action === 'resend-email') {
            const orderId = this.getAttribute('data-id');
            const orderID = this.getAttribute('data-order-id');
            const customerName = this.getAttribute('data-customer-name');
            const emailAddress = this.getAttribute('data-email');
            const phoneNumber = this.getAttribute('data-phone');
            const createdDate = this.getAttribute('data-created-date');
            
            handleResendEmailClick(orderId, orderID, customerName, emailAddress, phoneNumber, createdDate);
        } else if (action === 'edit-order') {
            const orderId = this.getAttribute('data-id');
            const orderID = this.getAttribute('data-order-id');
            const firstName = this.getAttribute('data-first-name');
            const lastName = this.getAttribute('data-last-name');
            const phoneNumber = this.getAttribute('data-phone');
            const emailAddress = this.getAttribute('data-email');
            
            handleEditOrderClick(orderId, orderID, firstName, lastName, phoneNumber, emailAddress);
        } else if (action === 'refund-order') {
            const orderId = this.getAttribute('data-id');
            const orderID = this.getAttribute('data-order-id');
            const customerName = this.getAttribute('data-customer-name');
            const emailAddress = this.getAttribute('data-email');
            const orderMetaDataStr = this.getAttribute('data-order-metadata');
            
            let orderMetaData = null;
            try {
                orderMetaData = orderMetaDataStr ? JSON.parse(orderMetaDataStr) : null;
            } catch (e) {
                console.error('Error parsing order metadata:', e);
            }
            
            handleRefundOrderClick(orderId, orderID, customerName, emailAddress, orderMetaData);
        } else if (action === 'cancel-order') {
            const orderId = this.getAttribute('data-id');
            const orderID = this.getAttribute('data-order-id');
            const customerName = this.getAttribute('data-customer-name');
            const emailAddress = this.getAttribute('data-email');
            
            handleCancelOrderClick(orderId, orderID, customerName, emailAddress);
        } else if (action === 'print-order-tickets') {
            handlePrintOrderTicketsClick(this.getAttribute('data-id'), this.getAttribute('data-order-id'));
        } else if (action === 'delete-order') {
            const orderId = this.getAttribute('data-id');
            const orderID = this.getAttribute('data-order-id');
            const customerName = this.getAttribute('data-customer-name');
            const emailAddress = this.getAttribute('data-email');
            
            handleDeleteOrderClick(orderId, orderID, customerName, emailAddress);
        }
    });
}); 
            // Make toggleCardDetails available globally
            window.toggleCardDetails = toggleCardDetails;
        })
        .catch(error => {
            console.error('Error fetching orders:', error);
            console.error('Error details:', error.message, error.stack);
            loadingIndicator.style.display = 'none';
            ordersTableBody.innerHTML = `
                <tr>
                    <td colspan="10" class="text-center text-danger">
                        Error loading orders: ${error.message}. Please try again.
                    </td>
                </tr>
            `;
            mobileCardsContainer.innerHTML = `
                <div class="alert alert-danger">
                    Error loading orders: ${error.message}. Please try again.
                </div>
            `;
        });
    }
    
    // Confirm resend email button click
    confirmResendEmailButton.addEventListener('click', function() {
        if (!currentOrderId || !currentEmailAddress) {
            UIDialogs.showMessage({ type: 'error', title: "Couldn't resend email", message: 'The order details are missing. Reload the page and try again.' });
            return;
        }
        
        console.log("Resending email for order ID:", currentOrderId, "to email:", currentEmailAddress);
        
        fetch(`${API_URL}/api/orders/${currentOrderId}/resend-email`, {
            method: 'POST',
            headers: getAuthHeaders(),
            body: JSON.stringify({ 
                orderId: currentOrderId,
                emailAddress: currentEmailAddress 
            })
        })
        .then(response => UIDialogs.readJson(response))  // 401/403 handling is automatic via auth-helper
        .then(data => {
            console.log("Resend email response:", data);
            resendEmailModal.hide();
            
            if (data.returnStatus === 'successful_resend') {
                UIDialogs.showMessage({ type: 'success', title: 'Email sent', message: `The tickets were emailed again to ${currentEmailAddress}.` });
            } else if (data.returnStatus === 'failed_invalid_email') {
                UIDialogs.showMessage({ type: 'error', title: "Couldn't resend email", message: "The order's email address isn't valid. Edit the order to fix it, then try again." });
            } else if (data.returnStatus === 'failed_no_order') {
                UIDialogs.showMessage({ type: 'error', title: "Couldn't resend email", message: 'This order was not found.' });
            } else if (data.returnStatus === 'failed_email_service') {
                UIDialogs.showMessage({ type: 'error', title: "Couldn't resend email", message: 'The email service had a problem. Please try again later.' });
            } else {
                UIDialogs.showMessage({ type: 'error', title: "Couldn't resend email", message: data.message || 'The email could not be sent.', details: data.returnStatus });
            }
            
            loadOrders(searchInput.value, startDateInput.value, endDateInput.value);
        })
        .catch(error => {
            console.error('Error resending email:', error);
            UIDialogs.showMessage({ type: 'error', title: "Couldn't resend email", message: 'Something went wrong. Please try again.', details: error.message });
            resendEmailModal.hide();
        });
    });
confirmEditOrderButton.addEventListener('click', function() {
    if (!currentEditOrderId) {
        UIDialogs.showMessage({ type: 'error', title: "Couldn't update order", message: 'The order details are missing. Reload the page and try again.' });
        return;
    }
    
    // Validate email
    const emailValue = editEmailAddress.value.trim();
    if (!emailValue || !emailValue.includes('@')) {
        UIDialogs.fieldError(editEmailAddress, 'Enter a valid email address.');
        return;
    }
    
    const updateData = {
        firstName: editFirstName.value.trim(),
        lastName: editLastName.value.trim(),
        phoneNumber: editPhoneNumber.value.trim(),
        emailAddress: emailValue
    };
    
    console.log("Updating order ID:", currentEditOrderId, "with data:", updateData);
    
    fetch(`${API_URL}/api/orders/${currentEditOrderId}/edit`, {
        method: 'PUT',
        headers: {
            ...getAuthHeaders(),
            'Content-Type': 'application/json'
        },
        body: JSON.stringify(updateData)
    })
    .then(response => UIDialogs.readJson(response))
    .then(data => {
        console.log("Edit order response:", data);
        editOrderModal.hide();
        
        if (data.returnStatus === 'successful_update') {
            UIDialogs.showMessage({ type: 'success', title: 'Order updated', message: "The order and its tickets have the new contact details." });
        } else if (data.returnStatus === 'failed_no_order') {
            UIDialogs.showMessage({ type: 'error', title: "Couldn't update order", message: 'This order was not found.' });
        } else if (data.returnStatus === 'failed_validation') {
            UIDialogs.showMessage({ type: 'error', title: "Couldn't update order", message: data.message || 'Some of the details are not valid.' });
        } else {
            UIDialogs.showMessage({ type: 'error', title: "Couldn't update order", message: data.message || 'The order could not be updated.', details: data.returnStatus });
        }
        
        // Reload orders to show updated data
        loadOrders(searchInput.value, startDateInput.value, endDateInput.value);
    })
    .catch(error => {
        console.error('Error updating order:', error);
        UIDialogs.showMessage({ type: 'error', title: "Couldn't update order", message: 'Something went wrong. Please try again.', details: error.message });
        editOrderModal.hide();
    });
});

// Confirm refund order button click
confirmRefundOrderButton.addEventListener('click', function() {
    if (!currentRefundOrderId || !currentRefundPaymentId) {
        UIDialogs.showMessage({ type: 'error', title: "Couldn't refund order", message: 'The order or payment details are missing. Reload the page and try again.' });
        return;
    }

    // Validate refund amount: must be a positive number that doesn't exceed
    // the order total. The server re-validates this against the real Square
    // payment amount — this is just to give staff immediate feedback.
    const enteredAmount = parseFloat(refundModalAmountInput.value);
    const orderTotalDollars = currentRefundOrderTotalCents / 100;
    if (isNaN(enteredAmount) || enteredAmount <= 0) {
        UIDialogs.fieldError(refundModalAmountInput, 'Enter an amount greater than $0.');
        return;
    }
    if (enteredAmount > orderTotalDollars) {
        UIDialogs.fieldError(refundModalAmountInput, `The refund can't be more than the order total of ${formatAmount(currentRefundOrderTotalCents)}.`);
        return;
    }
    const refundAmountCents = Math.round(enteredAmount * 100);

    // Validate processed by
    const refundedBy = refundProcessedBySelect.value.trim();
    if (!refundedBy) {
        UIDialogs.fieldError(refundProcessedBySelect, 'Choose who is processing this refund.');
        return;
    }

    // Validate refund reason
    const refundReason = refundReasonTextarea.value.trim();
    if (!refundReason) {
        UIDialogs.fieldError(refundReasonTextarea, 'Enter a reason for the refund.');
        return;
    }

    // Collect the tickets staff left checked
    const ticketIds = Array.from(
        refundModalTicketsList.querySelectorAll('.refund-ticket-checkbox:checked')
    ).map(el => parseInt(el.value, 10));

    console.log("Processing refund for order ID:", currentRefundOrderId, "payment ID:", currentRefundPaymentId);
    console.log("Refunded by:", refundedBy, "Reason:", refundReason, "Amount (cents):", refundAmountCents, "Ticket IDs:", ticketIds);

    // Disable button to prevent double-clicks
    confirmRefundOrderButton.disabled = true;
    confirmRefundOrderButton.textContent = 'Processing...';

    fetch(`${API_URL}/api/orders/${currentRefundOrderId}/refund`, {
        method: 'POST',
        headers: {
            ...getAuthHeaders(),
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            orderId: currentRefundOrderId,
            paymentId: currentRefundPaymentId,
            refundedBy: refundedBy,
            refundReason: refundReason,
            refundAmount: refundAmountCents,
            ticketIds: ticketIds
        })
    })
    .then(response => UIDialogs.readJson(response))
    .then(data => {
        console.log("Refund order response:", data);
        refundOrderModal.hide();
        
        // Re-enable button
        confirmRefundOrderButton.disabled = false;
        confirmRefundOrderButton.textContent = 'Process Refund';
        
        if (data.returnStatus === 'successful_refund') {
            const amountLabel = formatAmount(data.amount) + (data.partial ? ' (partial)' : '');
            UIDialogs.showMessage({
                type: 'success',
                title: 'Order refunded',
                message: `Amount refunded: ${amountLabel}\nTickets invalidated: ${data.ticketsInvalidated || 0}`,
                details: data.refundId ? `Square refund ID: ${data.refundId}` : undefined
            });
        } else if (data.returnStatus === 'failed_no_order') {
            UIDialogs.showMessage({ type: 'error', title: "Couldn't refund order", message: 'This order was not found.' });
        } else if (data.returnStatus === 'failed_no_payment_id') {
            UIDialogs.showMessage({ type: 'error', title: "Couldn't refund order", message: 'This order has no Square payment ID.' });
        } else if (data.returnStatus === 'failed_square_api') {
            UIDialogs.showMessage({ type: 'error', title: 'Square refused the refund', message: data.message || 'Square returned an error.' });
        } else if (data.returnStatus === 'failed_already_refunded') {
            UIDialogs.showMessage({ type: 'warning', title: 'Already refunded', message: 'This order has already been refunded.' });
        } else {
            UIDialogs.showMessage({ type: 'error', title: "Couldn't refund order", message: data.message || 'The refund could not be processed.', details: data.returnStatus });
        }
        
        // Reload orders to show updated data
        loadOrders(searchInput.value, startDateInput.value, endDateInput.value);
    })
    .catch(error => {
        console.error('Error processing refund:', error);
        UIDialogs.showMessage({ type: 'error', title: "Couldn't refund order", message: 'Something went wrong. Check the order in Square before trying again, in case the refund went through.', details: error.message });
        refundOrderModal.hide();
        
        // Re-enable button
        confirmRefundOrderButton.disabled = false;
        confirmRefundOrderButton.textContent = 'Process Refund';
    });
});

// Confirm cancel order button click
confirmCancelOrderButton.addEventListener('click', function() {
    if (!currentCancelOrderId) {
        UIDialogs.showMessage({ type: 'error', title: "Couldn't cancel order", message: 'The order details are missing. Reload the page and try again.' });
        return;
    }
    
    // Validate cancelled by
    const cancelledBy = cancelProcessedBySelect.value.trim();
    if (!cancelledBy) {
        UIDialogs.fieldError(cancelProcessedBySelect, 'Choose who is cancelling this order.');
        return;
    }
    
    // Validate cancel reason
    const cancelReason = cancelReasonTextarea.value.trim();
    if (!cancelReason) {
        UIDialogs.fieldError(cancelReasonTextarea, 'Enter a reason for the cancellation.');
        return;
    }
    
    console.log("Cancelling order ID:", currentCancelOrderId);
    console.log("Cancelled by:", cancelledBy, "Reason:", cancelReason);
    
    // Disable button to prevent double-clicks
    confirmCancelOrderButton.disabled = true;
    confirmCancelOrderButton.textContent = 'Processing...';
    
    fetch(`${API_URL}/api/orders/${currentCancelOrderId}/cancel`, {
        method: 'POST',
        headers: {
            ...getAuthHeaders(),
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            cancelledBy: cancelledBy,
            cancelReason: cancelReason
        })
    })
    .then(response => UIDialogs.readJson(response))
    .then(data => {
        console.log("Cancel order response:", data);
        cancelOrderModal.hide();
        
        // Re-enable button
        confirmCancelOrderButton.disabled = false;
        confirmCancelOrderButton.textContent = 'Cancel Order';
        
        if (data.success) {
            UIDialogs.showMessage({ type: 'success', title: 'Order cancelled', message: "The order is cancelled and its tickets won't scan.", details: data.orderId ? `Order ID: ${data.orderId}` : undefined });
        } else {
            UIDialogs.showMessage({ type: 'error', title: "Couldn't cancel order", message: data.message || 'The order could not be cancelled.', details: data.returnStatus });
        }
        
        // Reload orders to show updated data
        loadOrders(searchInput.value, startDateInput.value, endDateInput.value);
    })
    .catch(error => {
        console.error('Error cancelling order:', error);
        UIDialogs.showMessage({ type: 'error', title: "Couldn't cancel order", message: 'Something went wrong. Please try again.', details: error.message });
        cancelOrderModal.hide();
        
        // Re-enable button
        confirmCancelOrderButton.disabled = false;
        confirmCancelOrderButton.textContent = 'Cancel Order';
    });
});

// Confirm delete order button click
confirmDeleteOrderButton.addEventListener('click', function() {
    if (!currentDeleteOrderId) {
        UIDialogs.showMessage({ type: 'error', title: "Couldn't delete order", message: 'The order details are missing. Reload the page and try again.' });
        return;
    }
    
    // Validate deleted by
    const deletedBy = deleteProcessedBySelect.value.trim();
    if (!deletedBy) {
        UIDialogs.fieldError(deleteProcessedBySelect, 'Choose who is deleting this order.');
        return;
    }
    
    // Validate delete reason
    const deleteReason = deleteReasonTextarea.value.trim();
    if (!deleteReason) {
        UIDialogs.fieldError(deleteReasonTextarea, 'Enter a reason for the deletion.');
        return;
    }
    
    console.log("Deleting order ID:", currentDeleteOrderId);
    console.log("Deleted by:", deletedBy, "Reason:", deleteReason);
    
    // Disable button to prevent double-clicks
    confirmDeleteOrderButton.disabled = true;
    confirmDeleteOrderButton.textContent = 'Processing...';
    
    fetch(`${API_URL}/api/orders/${currentDeleteOrderId}/delete`, {
        method: 'POST',
        headers: {
            ...getAuthHeaders(),
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            deletedBy: deletedBy,
            deleteReason: deleteReason
        })
    })
    .then(response => UIDialogs.readJson(response))
    .then(data => {
        console.log("Delete order response:", data);
        deleteOrderModal.hide();
        
        // Re-enable button
        confirmDeleteOrderButton.disabled = false;
        confirmDeleteOrderButton.textContent = 'Delete Order';
        
        if (data.success) {
            UIDialogs.showMessage({ type: 'success', title: 'Order deleted', message: 'The order is deleted and its tickets won\'t scan.', details: data.orderId ? `Order ID: ${data.orderId}` : undefined });
        } else {
            UIDialogs.showMessage({ type: 'error', title: "Couldn't delete order", message: data.message || 'The order could not be deleted.', details: data.returnStatus });
        }
        
        // Reload orders to show updated data
        loadOrders(searchInput.value, startDateInput.value, endDateInput.value);
    })
    .catch(error => {
        console.error('Error deleting order:', error);
        UIDialogs.showMessage({ type: 'error', title: "Couldn't delete order", message: 'Something went wrong. Please try again.', details: error.message });
        deleteOrderModal.hide();
        
        // Re-enable button
        confirmDeleteOrderButton.disabled = false;
        confirmDeleteOrderButton.textContent = 'Delete Order';
    });
});
});
