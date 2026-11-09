document.addEventListener('DOMContentLoaded', function() {
    const API_URL = window.INDIETIX_API_URL;
    
    // Get elements
    const quickFilterInput = document.getElementById('quick-filter');
    const clearFilterButton = document.getElementById('clear-filter');
    const groupSelect = document.getElementById('group-select');
    const addGroupBtn = document.getElementById('add-group-btn');
    const activeGroupsContainer = document.getElementById('active-groups');
    const columnSelectorBtn = document.getElementById('column-selector-btn');
    const columnSelectorContent = document.getElementById('column-selector-content');
    const exportExcelButton = document.getElementById('export-excel');
    const exportCsvButton = document.getElementById('export-csv');
    const loadingIndicator = document.getElementById('loading');
    const expandToggleBtn = document.getElementById('expand-toggle-btn');
    const liveUpdateToggleBtn = document.getElementById('live-update-toggle-btn');
    const lastRefreshedDisplay = document.getElementById('last-refreshed');
    
    // Track active groups
    let activeGroups = [];
    
    // Track expand/collapse state of all groups (true = expanded)
    let allGroupsExpanded = true;
    
    // Live-update state
    let isLiveUpdating = false;
    let liveUpdateInterval = null;
    let liveUpdateCountdownInterval = null;
    let liveUpdateSecondsLeft = 30;
    const LIVE_UPDATE_SECONDS = 30;
    
    // Last successful data load — used for the "Last refreshed: 5s ago" label.
    // Updated from dataLoaded so it covers both the initial fetch and every
    // live-update refresh. A separate 1s interval keeps the relative-time
    // display ticking forward.
    let lastRefreshedAt = null;
    let lastRefreshedDisplayInterval = null;
    
    // Track row IDs across refreshes so we know which rows are new
    let knownRowIds = new Set();
    
    // Token checking now handled by auth-helper.js automatically
    // auth-helper will redirect to login if token is missing/expired
    
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

    // Function to save column visibility state to localStorage
    function saveColumnVisibility() {
        const columnState = {};
        table.getColumns().forEach(column => {
            const field = column.getField();
            if (field) {
                columnState[field] = column.isVisible();
            }
        });
        localStorage.setItem('reportColumnVisibility', JSON.stringify(columnState));
    }

    // Function to load column visibility state from localStorage
    function loadColumnVisibility() {
        const savedState = localStorage.getItem('reportColumnVisibility');
        if (savedState) {
            try {
                return JSON.parse(savedState);
            } catch (e) {
                console.error('Error parsing saved column state:', e);
                return null;
            }
        }
        return null;
    }

    // Function to apply saved column visibility
    function applySavedColumnVisibility() {
        const savedState = loadColumnVisibility();
        if (savedState) {
            // Apply saved visibility state to columns
            Object.keys(savedState).forEach(field => {
                const column = table.getColumn(field);
                if (column) {
                    if (savedState[field]) {
                        column.show();
                    } else {
                        column.hide();
                    }
                }
            });
            
            // Update checkboxes to match the applied state
            updateColumnSelectorCheckboxes();
            
            // Trigger column resize after visibility changes
            setTimeout(() => {
                table.redraw();
            }, 100);
        }
    }

    // Function to update checkbox states to match current column visibility
    function updateColumnSelectorCheckboxes() {
        table.getColumns().forEach(column => {
            const field = column.getField();
            if (field) {
                const checkbox = document.getElementById('col-' + field);
                if (checkbox) {
                    checkbox.checked = column.isVisible();
                }
            }
        });
    }
    
    /**
     * Populate mobile card view with ticket data
     */
    function populateMobileCards(data) {
        console.log('populateMobileCards called with data:', data);
        const mobileContainer = document.getElementById('mobile-cards-container');
        
        if (!mobileContainer) {
            console.error('Mobile container not found!');
            return;
        }
        
        console.log('Mobile container found, clearing...');
        // Clear existing cards
        mobileContainer.innerHTML = '';
        
        if (!data || data.length === 0) {
            console.log('No data or empty data array');
            mobileContainer.innerHTML = '<div class="text-center text-muted p-4">No tickets found</div>';
            return;
        }
        
        console.log(`Creating ${data.length} cards...`);
        
        // Create a card for each ticket
        data.forEach((ticket, index) => {
            try {
                const card = document.createElement('div');
                card.className = 'ticket-card';
                if (ticket.checkedIn) {
                    card.classList.add('checked-in');
                }
                
                // Status badge
                const statusBadge = document.createElement('div');
                statusBadge.className = `status-badge ${ticket.checkedIn ? 'checked-in' : 'not-checked-in'}`;
                statusBadge.textContent = ticket.checkedIn ? 'Checked In' : 'Not Checked In';
                
                // Card header (collapsible)
                const cardHeader = document.createElement('div');
                cardHeader.className = 'card-header-mobile collapsed';
                cardHeader.onclick = function() {
                    this.classList.toggle('collapsed');
                    const details = this.nextElementSibling;
                    details.classList.toggle('show');
                };
                
                const headerRow = document.createElement('div');
                headerRow.className = 'card-header-row';
                
                const headerInfo = document.createElement('div');
                headerInfo.innerHTML = `
                    <h5>${escapeHtml(ticket.eventName)}</h5>
                    <div class="event-date">${escapeHtml(ticket.eventDate || 'No date')}</div>
                `;
                
                const collapseIcon = document.createElement('div');
                collapseIcon.className = 'card-collapse-icon';
                collapseIcon.innerHTML = '&#9662;'; // Down arrow
                
                headerRow.appendChild(headerInfo);
                headerRow.appendChild(collapseIcon);
                cardHeader.appendChild(headerRow);
                
                // Card details (collapsible)
                const cardDetails = document.createElement('div');
                cardDetails.className = 'card-details';
                
                const detailsList = document.createElement('dl');
                detailsList.innerHTML = `
                    <dt>Customer:</dt>
                    <dd>${escapeHtml(ticket.customerName)}</dd>
                    
                    <dt>Distributor:</dt>
                    <dd>${escapeHtml(ticket.distributor || 'N/A')}</dd>
                    
                    <dt>Event Type:</dt>
                    <dd>${escapeHtml(ticket.eventType || 'N/A')}</dd>
                    
                    <dt>Venue:</dt>
                    <dd>${escapeHtml(ticket.eventVenue || 'N/A')}</dd>
                    
                    <dt>Seat Code:</dt>
                    <dd>${escapeHtml(ticket.eventSeatCode || 'N/A')}</dd>
                    
                    <dt>Price:</dt>
                    <dd>$${parseFloat(ticket.eventPrice || 0).toFixed(2)}</dd>
                    
                    ${ticket.customerEmail ? `
                        <dt>Email:</dt>
                        <dd>${escapeHtml(ticket.customerEmail)}</dd>
                    ` : ''}
                    
                    ${ticket.customerPhoneNumber ? `
                        <dt>Phone:</dt>
                        <dd>${escapeHtml(ticket.customerPhoneNumber)}</dd>
                    ` : ''}
                    
                    ${ticket.eventDetails ? `
                        <dt>Details:</dt>
                        <dd>${escapeHtml(ticket.eventDetails)}</dd>
                    ` : ''}
                    
                    ${ticket.purchaseDate ? `
                        <dt>Purchase Date:</dt>
                        <dd>${escapeHtml(ticket.purchaseDate)}</dd>
                    ` : ''}
                `;
                
                cardDetails.appendChild(detailsList);
                
                // Assemble card
                card.appendChild(statusBadge);
                card.appendChild(cardHeader);
                card.appendChild(cardDetails);
                
                mobileContainer.appendChild(card);
            } catch (error) {
                console.error(`Error creating card ${index}:`, error, ticket);
            }
        });
        
        console.log(`Successfully created ${mobileContainer.children.length} cards`);
    }
    
    /**
     * Escape HTML to prevent XSS
     */
    function escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    /**
     * Filter mobile cards based on search query
     */
    function filterMobileCards(query) {
        const mobileContainer = document.getElementById('mobile-cards-container');
        if (!mobileContainer) return;
        
        const cards = mobileContainer.querySelectorAll('.ticket-card');
        const searchLower = query.toLowerCase();
        
        if (!query) {
            // Show all cards if no search query
            cards.forEach(card => {
                card.style.display = 'block';
            });
            return;
        }
        
        cards.forEach(card => {
            const cardText = card.textContent.toLowerCase();
            if (cardText.includes(searchLower)) {
                card.style.display = 'block';
            } else {
                card.style.display = 'none';
            }
        });
    }

    // Function to update checkbox states to match current column visibility (moved down)

    // ---- REPORT DATE RANGE ----
    // The report covers shows in a date range (default: 30 days back to 30
    // days ahead, so presales show), instead of every ticket ever sold, which
    // grows too big to load (the server refuses more than it can send at once).
    const reportStartInput = document.getElementById('report-start');
    const reportEndInput = document.getElementById('report-end');
    const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const dayOffset = (days) => { const d = new Date(); d.setDate(d.getDate() + days); return isoDay(d); };
    reportStartInput.value = dayOffset(-30);
    reportEndInput.value = dayOffset(30);
    function reportUrl() {
        const params = new URLSearchParams();
        if (reportStartInput.value) params.append('startDate', reportStartInput.value);
        if (reportEndInput.value) params.append('endDate', reportEndInput.value);
        return `${API_URL}/api/products${params.toString() ? `?${params}` : ''}`;
    }
    function showReportError(message) {
        document.querySelectorAll('.report-load-error').forEach(el => el.remove());
        const alertDiv = document.createElement('div');
        alertDiv.className = 'alert alert-danger report-load-error';
        alertDiv.role = 'alert';
        alertDiv.textContent = message;
        const gridContainer = document.querySelector('#ticket-table');
        gridContainer.parentNode.insertBefore(alertDiv, gridContainer);
    }
    // ---- END REPORT DATE RANGE ----

    // Initialize Tabulator with column definitions
    const table = new Tabulator("#ticket-table", {
        height: "fitData", // Auto-size to fit current page data without scrolling
        layout: "fitColumns",
        responsiveLayout: "hide",
        pagination: true,
        paginationSize: 100,
        paginationSizeSelector: [25, 50, 100, 200, 500],
        movableColumns: true,
        selectable: true,
        columns: [
            { 
                title: "QR Code", 
                field: "QRCode", 
                sorter: "string", 
                headerFilter: "input",
                formatter: function(cell) {
                    const value = cell.getValue();
                    if (!value) return "";
                    return value.length > 15 ? value.substring(0, 15) + "..." : value;
                },
                width: 120,
                visible: false
            },
            { 
                title: "Event", 
                field: "eventName", 
                sorter: "string", 
                headerFilter: "input",
                bottomCalc: "count",
                visible: true
            },
            { 
                title: "Event Date", 
                field: "eventDate", 
                sorter: "datetime",
                sorterParams: {
                    // Matches the model's getter format for productDate:
                    // e.g. "April 30, 8:00 PM"  (note: no year in the source format)
		    format: "MMMM d, yyyy, h:mm a",
                    alignEmptyValues: "bottom"
                },
                headerFilter: "input",
                bottomCalc: "count",
                visible: true
            },
            { 
                title: "Details", 
                field: "eventDetails", 
                sorter: "string", 
                headerFilter: "input",
                formatter: "textarea",
                widthGrow: 2,
                visible: false
            },
            { 
                title: "Customer", 
                field: "customerName", 
                sorter: "string", 
                headerFilter: "input",
                visible: true
            },
            { 
                title: "Email", 
                field: "customerEmail", 
                sorter: "string", 
                headerFilter: "input",
                visible: false
            },
            { 
                title: "Phone", 
                field: "customerPhoneNumber", 
                sorter: "string", 
                headerFilter: "input",
                visible: false
            },
            { 
                title: "Distributor", 
                field: "distributor", 
                sorter: "string", 
                headerFilter: "input",
                visible: true
            },
            { 
                title: "Event Type", 
                field: "eventType", 
                sorter: "string", 
                headerFilter: "input",
                visible: true
            },
            { 
                title: "Event Venue", 
                field: "eventVenue", 
                sorter: "string", 
                headerFilter: "input",
                visible: true
            },
            { 
                title: "Seat Code", 
                field: "eventSeatCode", 
                sorter: "string", 
                headerFilter: "input",
                visible: true
            },
            { 
                title: "Price", 
                field: "eventPrice", 
                sorter: "number", 
                headerFilter: "number",
                formatter: "money",
                formatterParams: {
                    decimal: ".",
                    thousand: ",",
                    symbol: "$",
                    precision: 2
                },
                bottomCalc: "sum",
                bottomCalcFormatter: "money",
                bottomCalcFormatterParams: {
                    decimal: ".",
                    thousand: ",",
                    symbol: "$",
                    precision: 2
                },
                visible: true
            },
            { 
                title: "Expiration", 
                field: "expirationDate", 
                sorter: "datetime",
                sorterParams: {
                    // Matches the model's getter format for expirationDate:
                    // e.g. "April 30, 2026, 8:00 PM"
                    format: "MMMM d, yyyy, h:mm a",
                    alignEmptyValues: "bottom"
                },
                headerFilter: "input",
                visible: false
            },
            { 
                title: "Status", 
                field: "checkedIn", 
                sorter: "boolean", 
                headerFilter: "list",
                headerFilterParams: {
                    values: {
                        "true": "Checked In",
                        "false": "Not Checked In"
                    }
                },
                formatter: function(cell) {
                    const value = cell.getValue();
                    if (value === true) {
                        return "<span class='status-checked-in'>Checked In</span>";
                    } else {
                        return "<span class='status-not-checked-in'>Not Checked In</span>";
                    }
                },
                visible: false
            },
            { 
                title: "Purchase Date", 
                field: "purchaseDate", 
                sorter: "datetime",
                sorterParams: {
                    // Matches the model's getter format for purchaseDate (CreatedDate):
                    // e.g. "April 30, 2026, 8:00 PM"
                    format: "MMMM d, yyyy, h:mm a",
                    alignEmptyValues: "bottom"
                },
                headerFilter: "input",
                visible: false
            }
        ],
        rowFormatter: function(row) {
            // Apply styling to checked-in rows
            if (row.getData().checkedIn === true) {
                row.getElement().classList.add("checked-in");
            }
        },
        initialSort: [
            { column: "purchaseDate", dir: "desc" }
        ],
        groupBy: function(){
            // This will be updated when active groups change
            return activeGroups.length > 0 ? activeGroups : false;
        },
        groupHeader: function(value, count, data, group) {
            // Handle the case when no grouping is active
            if (value === false || value === "false") {
                return "No Grouping <span style='margin-left: 10px;'>(" + count + " tickets)</span>";
            }
            
            // Customize group headers
            let header = "";
            
            switch(group.getField()) {
                case "eventName":
                    header = "Event: " + value;
                    break;
                case "customerName":
                    header = "Customer: " + value;
                    break;
                case "distributor":
                    header = "Distributor: " + (value || 'Unknown');
                    break;
                case "eventType":
                    header = "Event Type: " + (value || 'Unknown');
                    break;
                case "eventVenue":
                    header = "Event Venue: " + (value || 'Unknown');
                    break;
                case "eventSeatCode":
                    header = "Seat Code: " + (value || 'Unknown');
                    break;
                case "purchaseDate":
                    // Handle date formatting for group headers
                    header = "Purchase Date: " + (value ? new Date(value).toLocaleDateString() : 'Unknown');
                    break;
                case "checkedIn":
                    header = "Status: " + (value ? "Checked In" : "Not Checked In");
                    break;
                default:
                    header = value;
            }
            
            return header + "<span style='margin-left: 10px;'>(" + count + " tickets)</span>";
        },
        ajaxURL: reportUrl(),
        ajaxConfig: {
            method: "GET",
            headers: getAuthHeaders(),
        },
        ajaxError: function(error) {
            console.error("Error fetching data:", error);
            loadingIndicator.style.display = 'none';
            // 401/403 handling now automatic via auth-helper fetch interceptor.
            // Tabulator passes the failed response; a range with too many
            // tickets comes back with a message saying to narrow it.
            if (error && typeof error.json === 'function') {
                error.json()
                    .then(body => showReportError(body && body.message ? body.message : `Error loading events (HTTP ${error.status}). Please try again.`))
                    .catch(() => showReportError(`Error loading events (HTTP ${error.status}). Please try again.`));
            } else {
                showReportError(`Error loading events: ${(error && error.message) || 'Network error'}. Please try again.`);
            }
        },
        ajaxResponse: function(url, params, response) {
            loadingIndicator.style.display = 'none';
            
            // Use shared formatter so live-update produces identical row shapes.
            return formatProductsData(response);
        },
        dataLoaded: function(data) {
            console.log('Tabulator dataLoaded callback fired', data);
            
            // Apply current grouping
            updateGrouping();
            
            // Populate mobile cards - get data from table instead of callback parameter
            const tableData = table.getData();
            console.log('Getting data from table.getData():', tableData);
            populateMobileCards(tableData);
            
            // Refresh the set of known row IDs so the live-update flash diff is accurate.
            knownRowIds = new Set(tableData.map(r => r && r.id).filter(Boolean));
            
            // Stamp the "Last refreshed" indicator. Fires on initial load and
            // on every replaceData call from doLiveUpdate.
            setLastRefreshed(new Date());
            
            // Apply saved column visibility after data loads
            setTimeout(function() {
                applySavedColumnVisibility();
                
                // Ensure column selector is populated (sometimes needed after data loads)
                if (columnSelectorContent.children.length === 0) {
                    populateColumnSelector();
                }
            }, 100);
        }
    });
    
    // Function to populate column visibility selector
    function populateColumnSelector() {
        // Clear existing checkboxes
        columnSelectorContent.innerHTML = '';
        
        // Add control buttons at the top
        const buttonsDiv = document.createElement('div');
        buttonsDiv.style.display = 'flex';
        buttonsDiv.style.gap = '5px';
        buttonsDiv.style.marginBottom = '10px';
        buttonsDiv.style.flexWrap = 'wrap';
        
        const selectAllBtn = document.createElement('button');
        selectAllBtn.className = 'btn btn-sm btn-outline-primary';
        selectAllBtn.textContent = 'Select All';
        selectAllBtn.addEventListener('click', function() {
            // Select all columns
            table.getColumns().forEach(function(column) {
                column.show();
            });
            // Update checkboxes
            updateColumnSelectorCheckboxes();
            // Save the new state
            saveColumnVisibility();
            // Trigger column resize
            setTimeout(() => {
                table.redraw();
            }, 50);
        });
        
        const deselectAllBtn = document.createElement('button');
        deselectAllBtn.className = 'btn btn-sm btn-outline-secondary';
        deselectAllBtn.textContent = 'Deselect All';
        deselectAllBtn.addEventListener('click', function() {
            // Deselect all columns
            table.getColumns().forEach(function(column) {
                column.hide();
            });
            // Update checkboxes
            updateColumnSelectorCheckboxes();
            // Save the new state
            saveColumnVisibility();
            // Trigger column resize
            setTimeout(() => {
                table.redraw();
            }, 50);
        });
        
        const resetDefaultsBtn = document.createElement('button');
        resetDefaultsBtn.className = 'btn btn-sm btn-outline-warning';
        resetDefaultsBtn.textContent = 'Reset to Defaults';
        resetDefaultsBtn.addEventListener('click', function() {
            // Remove saved state
            localStorage.removeItem('reportColumnVisibility');
            
            // Define default visible columns
            const defaultVisibleColumns = [
                'eventName', 'eventDate', 'customerName', 'distributor', 
                'eventType', 'eventVenue', 'eventSeatCode', 'eventPrice'
            ];
            
            // Apply default visibility
            table.getColumns().forEach(function(column) {
                const field = column.getField();
                if (field && defaultVisibleColumns.includes(field)) {
                    column.show();
                } else if (field) {
                    column.hide();
                }
            });
            
            // Update checkboxes
            updateColumnSelectorCheckboxes();
            
            // Save the default state
            saveColumnVisibility();
            
            // Trigger column resize
            setTimeout(() => {
                table.redraw();
            }, 50);
        });
        
        buttonsDiv.appendChild(selectAllBtn);
        buttonsDiv.appendChild(deselectAllBtn);
        buttonsDiv.appendChild(resetDefaultsBtn);
        columnSelectorContent.appendChild(buttonsDiv);
        
        // Get all column definitions directly from the table configuration
        const columnDefs = table.getColumnDefinitions();
        
        // Create a checkbox for each column
        columnDefs.forEach(columnDef => {
            // Skip columns without field (like row selectors)
            if (!columnDef.field) return;
            
            // Create container div
            const div = document.createElement('div');
            div.className = 'column-selector-item';
            
            // Create checkbox
            const checkbox = document.createElement('input');
            checkbox.type = 'checkbox';
            checkbox.id = 'col-' + columnDef.field;
            checkbox.checked = columnDef.visible !== false; // Default to true if not specified
            
            // Add change event listener
            checkbox.addEventListener('change', function() {
                const column = table.getColumn(columnDef.field);
                if (column) {
                    if (this.checked) {
                        column.show();
                    } else {
                        column.hide();
                    }
                    // Save the new state whenever a column visibility changes
                    saveColumnVisibility();
                    
                    // Trigger column resize after visibility changes
                    setTimeout(() => {
                        table.redraw();
                    }, 50);
                }
            });
            
            // Create label
            const label = document.createElement('label');
            label.htmlFor = 'col-' + columnDef.field;
            label.textContent = columnDef.title || columnDef.field;
            
            // Add to container
            div.appendChild(checkbox);
            div.appendChild(label);
            columnSelectorContent.appendChild(div);
        });
    }
    
    // Column selector
    let columnSelectorInitialized = false;
    
    // Toggle column selector dropdown
    columnSelectorBtn.addEventListener('click', function() {
        columnSelectorContent.classList.toggle('show');
        
        // Populate the column selector if it hasn't been done yet
        if (!columnSelectorInitialized) {
            populateColumnSelector();
            columnSelectorInitialized = true;
        }
    });
    
    // Close column selector when clicking outside
    window.addEventListener('click', function(event) {
        if (!event.target.matches('#column-selector-btn') && !columnSelectorContent.contains(event.target)) {
            columnSelectorContent.classList.remove('show');
        }
    });
    
    // Function to update the active groups display
    function updateActiveGroupsDisplay() {
        activeGroupsContainer.innerHTML = '';
        
        if (activeGroups.length === 0) {
            const noGroupsMsg = document.createElement('div');
            noGroupsMsg.className = 'text-muted';
            noGroupsMsg.textContent = 'No active grouping';
            activeGroupsContainer.appendChild(noGroupsMsg);
            return;
        }
        
        // Create a tag for each active group
        activeGroups.forEach((groupField, index) => {
            const tagDiv = document.createElement('div');
            tagDiv.className = 'group-tag';
            
            // Get a user-friendly name for the field
            let displayName = '';
            switch(groupField) {
                case 'eventName': displayName = 'Event'; break;
                case 'customerName': displayName = 'Customer'; break;
                case 'distributor': displayName = 'Distributor'; break;
                case 'eventType': displayName = 'Event Type'; break;
                case 'eventVenue': displayName = 'Event Venue'; break;
                case 'eventSeatCode': displayName = 'Seat Code'; break;
                case 'purchaseDate': displayName = 'Purchase Date'; break;
                case 'checkedIn': displayName = 'Status'; break;
                default: displayName = groupField;
            }
            
            // Display label with level
            tagDiv.textContent = `Level ${index + 1}: ${displayName}`;
            
            // Add remove button
            const removeBtn = document.createElement('button');
            removeBtn.textContent = '×';
            removeBtn.addEventListener('click', function() {
                removeGroup(index);
            });
            
            tagDiv.appendChild(removeBtn);
            activeGroupsContainer.appendChild(tagDiv);
        });
    }
    
    // Function to update grouping
    function updateGrouping() {
        table.setGroupBy(activeGroups.length > 0 ? activeGroups : false);
        updateActiveGroupsDisplay();
        
        // Whenever grouping config changes, Tabulator rebuilds groups in the
        // default (expanded) state. Reflect that in the toggle button.
        allGroupsExpanded = true;
        if (expandToggleBtn) {
            expandToggleBtn.textContent = 'Collapse All';
            expandToggleBtn.disabled = activeGroups.length === 0;
        }
    }
    
    // Add a new group level
    // Load the report for the chosen show dates (the Enter key in a date box too).
    function loadReportRange() {
        document.querySelectorAll('.report-load-error').forEach(el => el.remove());
        loadingIndicator.style.display = 'block';
        table.setData(reportUrl());
    }
    document.getElementById('report-range-btn').addEventListener('click', loadReportRange);
    [reportStartInput, reportEndInput].forEach(input => input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') loadReportRange(); }));

    addGroupBtn.addEventListener('click', function() {
        const selectedField = groupSelect.value;
        if (selectedField && !activeGroups.includes(selectedField)) {
            activeGroups.push(selectedField);
            updateGrouping();
            groupSelect.value = ''; // Reset select
        }
    });
    
    // Remove a group level
    function removeGroup(index) {
        activeGroups.splice(index, 1);
        updateGrouping();
    }
    
    // Quick filter
    quickFilterInput.addEventListener("keyup", function() {
        const filterValue = this.value;
        table.setFilter(matchAnyField, {value: filterValue});
        
        // Also filter mobile cards - use filtered data from table
        setTimeout(() => {
            const filteredData = table.getData("active"); // Get only visible/filtered rows
            console.log('Filtered data for mobile:', filteredData);
            populateMobileCards(filteredData);
        }, 100);
    });
    
    // Custom filter function to match any field
    function matchAnyField(data, filterParams) {
        const value = filterParams.value.toLowerCase();
        
        // Skip if filter value is empty
        if (!value) return true;
        
        // Check all fields for a match
        for (let key in data) {
            if (data[key] === null || data[key] === undefined) continue;
            
            // Convert all values to string for matching
            const fieldValue = String(data[key]).toLowerCase();
            
            if (fieldValue.includes(value)) {
                return true;
            }
        }
        
        return false;
    }
    
    // Clear filter button
    clearFilterButton.addEventListener("click", function() {
        quickFilterInput.value = "";
        table.clearFilter();
        
        // Repopulate mobile cards with all data
        setTimeout(() => {
            const allData = table.getData();
            console.log('All data for mobile after clear:', allData);
            populateMobileCards(allData);
        }, 100);
    });
    
    // Export to Excel button
    exportExcelButton.addEventListener("click", function() {
        table.download("xlsx", "IndieTix_Report_" + new Date().toISOString().split("T")[0] + ".xlsx", {
            sheetName: "Ticket Data"
        });
    });
    
    // Export to CSV button
    exportCsvButton.addEventListener("click", function() {
        table.download("csv", "IndieTix_Report_" + new Date().toISOString().split("T")[0] + ".csv");
    });
    
    // =====================================================================
    // Shared product data formatter
    // =====================================================================
    // Used by both Tabulator's ajaxResponse and the live-update fetch so
    // both code paths produce identical row shapes.
    function formatProductsData(response) {
        const formatProduct = (product) => {
            const firstName = product.CustomerFirstName || product.customerFirstName || product.FirstName || product.firstName || '';
            const lastName  = product.CustomerLastName  || product.customerLastName  || product.LastName  || product.lastName  || '';
            const customerName = (firstName + ' ' + lastName).trim() || 'Unknown';
            
            return {
                id:                  product.ID || product.id,
                QRCode:              product.QRCode || product.qrCode,
                eventName:           product.ProductName    || product.productName    || product.Name    || product.name    || 'No Name',
                eventDate:           product.ProductDate    || product.productDate,
                eventDetails:        product.ProductDetails || product.productDetails || product.Details || product.details || 'No Details',
                eventPrice:          product.ProductPrice   || product.productPrice   || product.Price   || product.price   || '0.00',
                customerName:        customerName,
                customerEmail:       product.EmailAddress           || product.emailAddress           || product.Email       || product.email       || '',
                customerPhoneNumber: product.CustomerPhoneNumber    || product.customerPhoneNumber    || product.PhoneNumber || product.phoneNumber || '',
                distributor:         product.Distributor            || product.distributor            || '',
                eventType:           product.EventType              || product.eventType              || product.ProductType || '',
                eventVenue:          product.EventVenue             || product.eventVenue             || product.ProductVenue || '',
                eventSeatCode:       product.EventSeatCode          || product.eventSeatCode          || product.ProductSeatCode || '',
                expirationDate:      product.ExpirationDate         || product.expirationDate,
                checkedIn:           product.CheckedIn              || product.checkedIn              || false,
                purchaseDate:        product.PurchaseDate           || product.purchaseDate           || ''
            };
        };
        
        if (Array.isArray(response)) {
            return response.map(formatProduct);
        } else if (response && Array.isArray(response.qrcodes)) {
            return response.qrcodes.map(formatProduct);
        }
        return [];
    }
    
    // =====================================================================
    // Group expansion helpers
    // =====================================================================
    
    // Recursively walk all groups and sub-groups into a flat array.
    function getAllGroupsRecursive(groups) {
        const result = [];
        (groups || []).forEach(g => {
            result.push(g);
            const subs = g.getSubGroups();
            if (subs && subs.length) {
                result.push(...getAllGroupsRecursive(subs));
            }
        });
        return result;
    }
    
    // Build a unique path for a group so we can re-identify it after a data
    // refresh (which destroys and recreates group components).
    function getGroupPath(group) {
        let path = group.getField() + ':' + group.getKey();
        let parent = group.getParentGroup();
        while (parent) {
            path = parent.getField() + ':' + parent.getKey() + '/' + path;
            parent = parent.getParentGroup();
        }
        return path;
    }
    
    // Snapshot expansion state for every current group, keyed by path.
    function captureGroupState() {
        const state = {};
        getAllGroupsRecursive(table.getGroups()).forEach(g => {
            state[getGroupPath(g)] = g.isVisible();
        });
        return state;
    }
    
    // Re-apply a previously captured expansion snapshot to current groups.
    // Groups not in the snapshot (e.g. brand-new ones from new data) keep
    // Tabulator's default expanded state.
    //
    // Same render-sync caveat as toggleAllGroups: bulk show/hide calls
    // need to be wrapped in blockRedraw/restoreRedraw or the renderer
    // won't sync the flag flips back to the DOM.
    //
    // Two passes: shows go top-down (parents before children), hides go
    // bottom-up (leaves before parents).
    function applyGroupState(state) {
        if (!state) return;
        const allGroups = getAllGroupsRecursive(table.getGroups());
        
        table.blockRedraw();
        try {
            // Pass 1: shows top-down.
            for (let i = 0; i < allGroups.length; i++) {
                const g = allGroups[i];
                if (state[getGroupPath(g)] === true) {
                    try { g.show(); } catch (e) { /* ignore */ }
                }
            }
            // Pass 2: hides bottom-up.
            for (let i = allGroups.length - 1; i >= 0; i--) {
                const g = allGroups[i];
                if (state[getGroupPath(g)] === false) {
                    try { g.hide(); } catch (e) { /* ignore */ }
                }
            }
        } finally {
            table.restoreRedraw();
        }
    }
    
    // =====================================================================
    // Expand / Collapse All toggle
    // =====================================================================
    //
    // Why blockRedraw/restoreRedraw: with pagination + grouping both on,
    // calling .hide()/.show() in a tight loop correctly flips each group's
    // internal `visible` flag (verified — every group reports isVisible()
    // going true→false), but the renderer doesn't sync those flag flips
    // back to the DOM. Wrapping the bulk operation in blockRedraw means
    // Tabulator does ONE clean redraw at the end that reflects every flag
    // flip — same effect as a real user click would produce, just batched.
    //
    // Order still matters within the block: collapse bottom-up so leaves
    // are processed while their parent is still expanded; expand top-down
    // so parents are visible before we touch children.
    function toggleAllGroups() {
        if (activeGroups.length === 0) return;
        
        const allGroups = getAllGroupsRecursive(table.getGroups());
        if (allGroups.length === 0) return;
        
        const collapsing = allGroupsExpanded;
        
        table.blockRedraw();
        try {
            if (collapsing) {
                for (let i = allGroups.length - 1; i >= 0; i--) {
                    try { allGroups[i].hide(); }
                    catch (e) { console.warn('group hide failed', e); }
                }
            } else {
                for (let i = 0; i < allGroups.length; i++) {
                    try { allGroups[i].show(); }
                    catch (e) { console.warn('group show failed', e); }
                }
            }
        } finally {
            // Always restore redraws even if something above threw, so we
            // can never leave the table in a permanently-frozen state.
            table.restoreRedraw();
        }
        
        allGroupsExpanded = !collapsing;
        expandToggleBtn.textContent = collapsing ? 'Expand All' : 'Collapse All';
    }
    
    if (expandToggleBtn) {
        expandToggleBtn.addEventListener('click', toggleAllGroups);
    }
    
    // =====================================================================
    // Flash effect for new data and updated totals
    // =====================================================================
    
    // Briefly flash an element green. Removing/re-adding the class around a
    // forced reflow lets us retrigger the animation if the element flashed
    // recently.
    function applyFlash(el) {
        if (!el) return;
        el.classList.remove('flash-new');
        // Force reflow so the animation restarts cleanly.
        void el.offsetWidth;
        el.classList.add('flash-new');
        // Clean the class up after the animation has finished so it doesn't
        // linger on the element forever.
        setTimeout(() => el.classList.remove('flash-new'), 2700);
    }
    
    function flashNewRows(newRowIds) {
        if (!newRowIds || newRowIds.size === 0) return;
        
        // 1) Flash the new data rows themselves.
        table.getRows().forEach(row => {
            const data = row.getData();
            if (data && data.id && newRowIds.has(data.id)) {
                applyFlash(row.getElement());
            }
        });
        
        // 2) Flash any group header that contains a new row (at any nesting
        //    level).
        getAllGroupsRecursive(table.getGroups()).forEach(g => {
            const containsNew = g.getRows().some(r => {
                const d = r.getData();
                return d && d.id && newRowIds.has(d.id);
            });
            if (containsNew) {
                applyFlash(g.getElement());
            }
        });
        
        // 3) Flash all calc rows (group bottom-calcs and the table-level
        //    bottom-calc). Their values just recalculated, so they should
        //    visually update too.
        document
            .querySelectorAll('#ticket-table .tabulator-row.tabulator-calcs')
            .forEach(el => applyFlash(el));
    }
    
    // =====================================================================
    // Live update mode
    // =====================================================================
    
    // Format a Date as a short relative-time string for the toolbar label.
    function formatRelativeTime(date) {
        if (!date) return '';
        const seconds = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
        if (seconds < 5)   return 'just now';
        if (seconds < 60)  return seconds + 's ago';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60)  return minutes + 'm ago';
        const hours   = Math.floor(minutes / 60);
        if (hours < 24)    return hours + 'h ago';
        return date.toLocaleString();
    }
    
    function updateLastRefreshedDisplay() {
        if (!lastRefreshedDisplay) return;
        if (!lastRefreshedAt) {
            lastRefreshedDisplay.textContent = '';
            return;
        }
        // Include absolute time as a tooltip for precision.
        lastRefreshedDisplay.textContent = 'Last refreshed: ' + formatRelativeTime(lastRefreshedAt);
        lastRefreshedDisplay.title = lastRefreshedAt.toLocaleString();
    }
    
    // Called from dataLoaded (initial load + every live refresh). Stamps the
    // timestamp and starts a once-per-second display ticker so "5s ago"
    // gracefully ages into "12s ago" → "1m ago" → ...
    function setLastRefreshed(date) {
        lastRefreshedAt = date;
        updateLastRefreshedDisplay();
        if (!lastRefreshedDisplayInterval) {
            lastRefreshedDisplayInterval = setInterval(updateLastRefreshedDisplay, 1000);
        }
    }
    
    function updateLiveCountdownDisplay() {
        if (!liveUpdateToggleBtn) return;
        if (isLiveUpdating) {
            liveUpdateToggleBtn.innerHTML =
                '<span class="live-dot">&#9679;</span> Live Update: On (' + liveUpdateSecondsLeft + 's)';
        } else {
            liveUpdateToggleBtn.innerHTML =
                '<span class="live-dot">&#9679;</span> Live Update: Off';
        }
    }
    
    async function doLiveUpdate() {
        if (!isLiveUpdating) return;
        
        try {
            // Snapshot what we want to preserve across the refresh.
            const groupState = captureGroupState();
            const tableHolder = document.querySelector('#ticket-table .tabulator-tableholder');
            const scrollTop = tableHolder ? tableHolder.scrollTop : 0;
            const previousIds = new Set(knownRowIds);
            
            const response = await fetch(reportUrl(), {
                method: 'GET',
                headers: getAuthHeaders()
            });
            
            if (!response.ok) {
                console.warn('Live update fetch failed: HTTP ' + response.status);
                return;
            }
            
            const rawData = await response.json();
            const formattedData = formatProductsData(rawData);
            
            // Diff before replacing data so we know what's new.
            const newRowIds = new Set();
            formattedData.forEach(row => {
                if (row.id && !previousIds.has(row.id)) {
                    newRowIds.add(row.id);
                }
            });
            
            // replaceData preserves filters, sort, grouping config, and the
            // current page; it does NOT preserve group expansion state, so we
            // restore that manually below.
            await table.replaceData(formattedData);
            
            // dataLoaded refreshes knownRowIds and lastRefreshedAt for us, but
            // be defensive in case the callback ordering ever changes.
            knownRowIds = new Set(formattedData.map(r => r && r.id).filter(Boolean));
            
            // Wait one tick for Tabulator's redraw to settle, then restore
            // expansion + scroll and trigger flashes.
            setTimeout(() => {
                applyGroupState(groupState);
                
                const th = document.querySelector('#ticket-table .tabulator-tableholder');
                if (th) th.scrollTop = scrollTop;
                
                // Reset the visible countdown so it reads "30s" right after
                // the refresh.
                liveUpdateSecondsLeft = LIVE_UPDATE_SECONDS;
                updateLiveCountdownDisplay();
                
                flashNewRows(newRowIds);
            }, 150);
            
        } catch (err) {
            console.error('Live update error:', err);
        }
    }
    
    // ---- Timer plumbing ----
    // Extracted into helpers so visibilitychange can stop/restart them
    // without duplicating the setInterval bodies.
    function startLiveTimers() {
        stopLiveTimers(); // belt-and-braces against double-up
        liveUpdateInterval = setInterval(doLiveUpdate, LIVE_UPDATE_SECONDS * 1000);
        liveUpdateCountdownInterval = setInterval(() => {
            liveUpdateSecondsLeft--;
            if (liveUpdateSecondsLeft <= 0) liveUpdateSecondsLeft = LIVE_UPDATE_SECONDS;
            updateLiveCountdownDisplay();
        }, 1000);
    }
    
    function stopLiveTimers() {
        if (liveUpdateInterval) {
            clearInterval(liveUpdateInterval);
            liveUpdateInterval = null;
        }
        if (liveUpdateCountdownInterval) {
            clearInterval(liveUpdateCountdownInterval);
            liveUpdateCountdownInterval = null;
        }
    }
    
    function startLiveUpdate() {
        isLiveUpdating = true;
        
        // Seed knownRowIds with what's currently displayed so the next fetch
        // doesn't flash the entire table as "new".
        knownRowIds = new Set(table.getData().map(r => r && r.id).filter(Boolean));
        
        liveUpdateSecondsLeft = LIVE_UPDATE_SECONDS;
        liveUpdateToggleBtn.classList.remove('btn-outline-success');
        liveUpdateToggleBtn.classList.add('btn-success', 'live-active');
        updateLiveCountdownDisplay();
        startLiveTimers();
    }
    
    function stopLiveUpdate() {
        isLiveUpdating = false;
        stopLiveTimers();
        liveUpdateToggleBtn.classList.remove('btn-success', 'live-active');
        liveUpdateToggleBtn.classList.add('btn-outline-success');
        updateLiveCountdownDisplay();
    }
    
    // ---- Pause on hidden tab ----
    // Browsers throttle setInterval in background tabs (often to ~once/min),
    // which would make the visible countdown lie about when the next refresh
    // is due. So when the tab hides we pause completely; when it returns we
    // do an immediate refresh (since who knows how stale the data is now)
    // and restart the regular cadence.
    function handleVisibilityChange() {
        if (!isLiveUpdating) return;
        
        if (document.hidden) {
            stopLiveTimers();
            if (liveUpdateToggleBtn) {
                liveUpdateToggleBtn.innerHTML =
                    '<span class="live-dot">&#9679;</span> Live Update: Paused';
            }
        } else {
            // Resume: refresh now, then restart the timers.
            liveUpdateSecondsLeft = LIVE_UPDATE_SECONDS;
            updateLiveCountdownDisplay();
            doLiveUpdate(); // fire-and-forget
            startLiveTimers();
        }
    }
    
    document.addEventListener('visibilitychange', handleVisibilityChange);
    
    if (liveUpdateToggleBtn) {
        liveUpdateToggleBtn.addEventListener('click', () => {
            if (isLiveUpdating) stopLiveUpdate(); else startLiveUpdate();
        });
        
        // Stop polling cleanly if the user navigates away.
        window.addEventListener('beforeunload', () => {
            if (isLiveUpdating) stopLiveUpdate();
        });
    }
    
    // Logout button event listener
    const logoutButton = document.getElementById('logout-btn');
    if (logoutButton) {
        logoutButton.addEventListener('click', logout);
    }
});
