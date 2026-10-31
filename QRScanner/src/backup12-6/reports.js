document.addEventListener('DOMContentLoaded', function() {
    const API_URL = 'https://dog5g3lykx3v6knpymly6hh6cq0cgyol.lambda-url.us-east-2.on.aws';
    
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
    
    // Track active groups
    let activeGroups = [];
    
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
                sorter: "string", 
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
                sorter: "string", 
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
                sorter: "string", 
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
        ajaxURL: `${API_URL}/api/products`,
        ajaxConfig: {
            method: "GET",
            headers: getAuthHeaders(),
        },
        ajaxError: function(error) {
            console.error("Error fetching data:", error);
            
            // 401/403 handling now automatic via auth-helper fetch interceptor
            
            // Create an alert for error message
            const alertDiv = document.createElement('div');
            alertDiv.className = 'alert alert-danger';
            alertDiv.role = 'alert';
            alertDiv.textContent = `Error loading events: ${error.message || 'Network error'}. Please try again.`;
            
            // Insert before the grid
            const gridContainer = document.querySelector('#ticket-table');
            gridContainer.parentNode.insertBefore(alertDiv, gridContainer);
        },
        ajaxResponse: function(url, params, response) {
            loadingIndicator.style.display = 'none';
            
            // Format the data to match our column structure
            let formattedData = [];
            
            if (Array.isArray(response)) {
                formattedData = response.map(product => {
                    // Create customer name from first and last name
                    const firstName = product.CustomerFirstName || product.customerFirstName || product.FirstName || product.firstName || '';
                    const lastName = product.CustomerLastName || product.customerLastName || product.LastName || product.lastName || '';
                    const customerName = (firstName + ' ' + lastName).trim() || 'Unknown';
                    
                    return {
                        id: product.ID || product.id,
                        QRCode: product.QRCode || product.qrCode,
                        eventName: product.ProductName || product.productName || product.Name || product.name || 'No Name',
                        eventDate: product.ProductDate || product.productDate,
                        eventDetails: product.ProductDetails || product.productDetails || product.Details || product.details || 'No Details',
                        eventPrice: product.ProductPrice || product.productPrice || product.Price || product.price || '0.00',
                        customerName: customerName,
                        customerEmail: product.EmailAddress || product.emailAddress || product.Email || product.email || '',
                        customerPhoneNumber: product.CustomerPhoneNumber || product.customerPhoneNumber || product.PhoneNumber || product.phoneNumber || '',
                        distributor: product.Distributor || product.distributor || '',
                        eventType: product.EventType || product.eventType || product.ProductType || '',
                        eventVenue: product.EventVenue || product.eventVenue || product.ProductVenue || '',
                        eventSeatCode: product.EventSeatCode || product.eventSeatCode || product.ProductSeatCode || '',
                        expirationDate: product.ExpirationDate || product.expirationDate,
                        checkedIn: product.CheckedIn || product.checkedIn || false,
                        purchaseDate: product.PurchaseDate || product.purchaseDate || ''
                    };
                });
            } else if (response.qrcodes) {
                // Handle different response format
                formattedData = response.qrcodes.map(product => {
                    // Create customer name from first and last name
                    const firstName = product.CustomerFirstName || product.customerFirstName || product.FirstName || product.firstName || '';
                    const lastName = product.CustomerLastName || product.customerLastName || product.LastName || product.lastName || '';
                    const customerName = (firstName + ' ' + lastName).trim() || 'Unknown';
                    
                    return {
                        id: product.ID || product.id,
                        QRCode: product.QRCode || product.qrCode,
                        eventName: product.ProductName || product.productName || product.Name || product.name || 'No Name',
                        eventDate: product.ProductDate || product.productDate,
                        eventDetails: product.ProductDetails || product.productDetails || product.Details || product.details || 'No Details',
                        eventPrice: product.ProductPrice || product.productPrice || product.Price || product.price || '0.00',
                        customerName: customerName,
                        customerEmail: product.EmailAddress || product.emailAddress || product.Email || product.email || '',
                        customerPhoneNumber: product.CustomerPhoneNumber || product.customerPhoneNumber || product.PhoneNumber || product.phoneNumber || '',
                        distributor: product.Distributor || product.distributor || '',
                        eventType: product.EventType || product.eventType || product.ProductType || '',
                        eventVenue: product.EventVenue || product.eventVenue || product.ProductVenue || '',
                        eventSeatCode: product.EventSeatCode || product.eventSeatCode || product.ProductSeatCode || '',
                        expirationDate: product.ExpirationDate || product.expirationDate,
                        checkedIn: product.CheckedIn || product.checkedIn || false,
                        purchaseDate: product.PurchaseDate || product.purchaseDate || ''
                    };
                });
            }
            
            return formattedData;
        },
        dataLoaded: function(data) {
            // Apply current grouping
            updateGrouping();
            
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
    }
    
    // Add a new group level
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
        table.setFilter(matchAnyField, {value: this.value});
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
    
    // Logout button event listener
    const logoutButton = document.getElementById('logout-btn');
    if (logoutButton) {
        logoutButton.addEventListener('click', logout);
    }
});
