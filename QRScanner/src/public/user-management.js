// user-management.js - User Management System

document.addEventListener('DOMContentLoaded', function() {
    console.log('User Management page loaded');
    
    const API_URL = window.INDIETIX_API_URL;
    
    // Global variables
    let uniqueEvents = [];
    let currentEditingUserId = null;
    
    // Get modal instance
    const userModal = new bootstrap.Modal(document.getElementById('user-modal'));
    
    // Get elements
    const createUserBtn = document.getElementById('create-user-btn');
    const addFilterBtn = document.getElementById('add-filter-btn');
    const saveUserBtn = document.getElementById('save-user-btn');
    const userForm = document.getElementById('user-form');
    
    // Event listeners
    createUserBtn.addEventListener('click', showCreateUserModal);
    addFilterBtn.addEventListener('click', () => addDataFilter());
    saveUserBtn.addEventListener('click', handleFormSubmit);
    
    // Modal close button event listeners
    const modalElement = document.getElementById('user-modal');
    const closeButtons = modalElement.querySelectorAll('[data-bs-dismiss="modal"]');
    closeButtons.forEach(button => {
        button.addEventListener('click', () => {
            closeModal();
        });
    });
    
    // Also handle ESC key and backdrop click
    modalElement.addEventListener('hidden.bs.modal', function() {
        // Clean up any leftover backdrops when modal is hidden
        const backdrops = document.querySelectorAll('.modal-backdrop');
        backdrops.forEach(backdrop => backdrop.remove());
        document.body.classList.remove('modal-open');
        document.body.style.overflow = '';
        document.body.style.paddingRight = '';
    });
    
    // Initialize page
    init();
    
    /**
     * Initialize the page by loading unique events and users
     */
    async function init() {
        await loadUniqueEvents();
        await loadUsers();
    }
    
    /**
     * Load event names for the filter dropdown: ticketed Square catalog
     * items plus anything already sold (see /api/data-filter/events)
     */
    async function loadUniqueEvents() {
        try {
            const response = await fetch(`${API_URL}/api/data-filter/events`, {
                headers: getAuthHeaders()
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            uniqueEvents = Array.isArray(data.events) ? data.events : [];
            console.log('Loaded unique events:', uniqueEvents.length);
        } catch (error) {
            console.error('Error loading unique events:', error);
            // Don't fail completely - just continue with empty events list
            uniqueEvents = [];
        }
    }
    
    /**
     * Load all users from the API
     */
    async function loadUsers() {
        try {
            const response = await fetch(`${API_URL}/api/users`, {
                headers: getAuthHeaders()
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (data.success) {
                renderUsers(data.users);
            } else {
                console.error('Failed to load users:', data.message);
                document.getElementById('users-tbody').innerHTML =
                    '<tr><td colspan="12" style="text-align: center; color: red;">Failed to load users</td></tr>';
            }
        } catch (error) {
            console.error('Error loading users:', error);
            document.getElementById('users-tbody').innerHTML =
                '<tr><td colspan="12" style="text-align: center; color: red;">Error loading users</td></tr>';
        }
    }
    
    /**
     * Render users in the table
     */
    function renderUsers(users) {
        const tbody = document.getElementById('users-tbody');
        
        if (users.length === 0) {
            tbody.innerHTML = '<tr><td colspan="12" style="text-align: center;">No users found</td></tr>';
            return;
        }

        tbody.innerHTML = users.map(user => {
            // Existing rows without checkIn/marketing/admin will have them as
            // undefined → treated as false
            const permissions = user.Permissions || { view: false, edit: false, checkIn: false, marketing: false, admin: false };
            const dataFilters = user.DataFilter?.datafilters || [];
            const filterCount = dataFilters.length;
            const filterSummary = filterCount > 0 ? `${filterCount} filter(s)` : 'None';
            
            const yesBadge = '<span class="badge bg-success">Yes</span>';
            const noBadge = '<span class="badge bg-secondary">No</span>';
            
            return `
                <tr>
                    <td>${user.ID}</td>
                    <td>${escapeHtml(user.Username)}</td>
                    <td>${escapeHtml(user.Email)}</td>
                    <td>${user.FirstName ? escapeHtml(user.FirstName) : '-'}</td>
                    <td>${user.LastName ? escapeHtml(user.LastName) : '-'}</td>
                    <td>${permissions.view ? yesBadge : noBadge}</td>
                    <td>${permissions.edit ? yesBadge : noBadge}</td>
                    <td>${permissions.checkIn ? yesBadge : noBadge}</td>
                    <td>${permissions.marketing ? yesBadge : noBadge}</td>
                    <td>${permissions.admin ? yesBadge : noBadge}</td>
                    <td>${filterSummary}</td>
                    <td>
                        <button class="action-btn edit-btn" onclick="editUser(${user.ID})">Edit</button>
                        <button class="action-btn delete-btn" onclick="deleteUser(${user.ID}, '${escapeHtml(user.Username)}')">Delete</button>
                    </td>
                </tr>
            `;
        }).join('');
    }
    
    /**
     * Show the create user modal
     */
    function showCreateUserModal() {
        currentEditingUserId = null;
        document.getElementById('modal-title').textContent = 'Create User';
        userForm.reset();
        document.getElementById('user-id').value = '';
        document.getElementById('data-filters-container').innerHTML = '';
        document.getElementById('password-group').style.display = 'block';
        document.getElementById('password').required = true;
        document.getElementById('password').placeholder = '';
        // userForm.reset() restores HTML defaults: view checked, edit/checkin unchecked
        userModal.show();
    }
    
    /**
     * Edit an existing user
     */
    async function editUser(userId) {
        try {
            const response = await fetch(`${API_URL}/api/users`, {
                headers: getAuthHeaders()
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            if (!data.success) return;
            
            const user = data.users.find(u => u.ID === userId);
            if (!user) return;
            
            currentEditingUserId = userId;
            document.getElementById('modal-title').textContent = 'Edit User';
            document.getElementById('user-id').value = user.ID;
            document.getElementById('username').value = user.Username;
            document.getElementById('email').value = user.Email;
            document.getElementById('firstName').value = user.FirstName || '';
            document.getElementById('lastName').value = user.LastName || '';
            
            // Existing rows may not have checkIn/marketing/admin — coerce to boolean
            const permissions = user.Permissions || { view: true, edit: false, checkIn: false, marketing: false, admin: false };
            document.getElementById('view-permission').checked = permissions.view === true;
            document.getElementById('edit-permission').checked = permissions.edit === true;
            document.getElementById('checkin-permission').checked = permissions.checkIn === true;
            document.getElementById('marketing-permission').checked = permissions.marketing === true;
            document.getElementById('admin-permission').checked = permissions.admin === true;
            
            // Password optional for editing
            document.getElementById('password-group').style.display = 'block';
            document.getElementById('password').required = false;
            document.getElementById('password').value = '';
            document.getElementById('password').placeholder = 'Leave blank to keep current password';
            
            // Load data filters
            const dataFilters = user.DataFilter?.datafilters || [];
            document.getElementById('data-filters-container').innerHTML = '';
            dataFilters.forEach(filter => {
                addDataFilter(filter);
            });
            
            userModal.show();
        } catch (error) {
            console.error('Error loading user for edit:', error);
            UIDialogs.showMessage({ type: 'error', title: "Couldn't load user", message: 'Something went wrong. Please try again.', details: error.message });
        }
    }
    
    /**
     * Delete a user
     */
    async function deleteUser(userId, username) {
        if (!await UIDialogs.showConfirm({ title: 'Delete user?', message: `Delete the user "${username}"? They won't be able to sign in.`, confirmText: 'Delete User', danger: true })) {
            return;
        }
        
        try {
            const response = await fetch(`${API_URL}/api/users/${userId}`, {
                method: 'DELETE',
                headers: getAuthHeaders()
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (data.success) {
                UIDialogs.showMessage({ type: 'success', title: 'User deleted', message: `"${username}" can no longer sign in.` });
                loadUsers();
            } else {
                UIDialogs.showMessage({ type: 'error', title: "Couldn't delete user", message: data.message || 'The user could not be deleted.' });
            }
        } catch (error) {
            console.error('Error deleting user:', error);
            UIDialogs.showMessage({ type: 'error', title: "Couldn't delete user", message: 'Something went wrong. Please try again.', details: error.message });
        }
    }
    
    /**
     * Add a data filter to the form
     */
    function addDataFilter(existingFilter = null) {
        const container = document.getElementById('data-filters-container');
        const filterId = Date.now();
        
        const filterDiv = document.createElement('div');
        filterDiv.className = 'data-filter-item';
        filterDiv.id = `filter-${filterId}`;
        
        filterDiv.innerHTML = `
            <div class="data-filter-controls">
                <div>
                    <label>Date</label>
                    <input type="date" class="form-control filter-date" value="${existingFilter?.date || ''}">
                </div>
                <div>
                    <label>Event</label>
                    <select class="form-select filter-event">
                        <option value="">-- Any --</option>
                        ${[...uniqueEvents, ...(existingFilter?.event && !uniqueEvents.includes(existingFilter.event) ? [existingFilter.event] : [])].map(event => `<option value="${escapeHtml(event)}" ${existingFilter?.event === event ? 'selected' : ''}>${escapeHtml(event)}</option>`).join('')}
                    </select>
                </div>
                <div>
                    <label>Event name contains</label>
                    <input type="text" class="form-control filter-eventContains" maxlength="200" placeholder="e.g. Rocky Horror" value="${escapeHtml(existingFilter?.eventContains || '')}">
                </div>
                <div>
                    <label>Event Type</label>
                    <select class="form-select filter-eventType">
                        <option value="">-- Any --</option>
                        <option value="Movie" ${['movie', 'cinema'].includes(String(existingFilter?.eventType).toLowerCase()) ? 'selected' : ''}>Cinema</option>
                        <option value="Live" ${String(existingFilter?.eventType).toLowerCase() === 'live' ? 'selected' : ''}>Live</option>
                    </select>
                </div>
            </div>
            <button type="button" class="remove-filter-btn" onclick="removeDataFilter(${filterId})">Remove Filter</button>
        `;
        
        container.appendChild(filterDiv);
    }
    
    /**
     * Remove a data filter from the form
     */
    function removeDataFilter(filterId) {
        const element = document.getElementById(`filter-${filterId}`);
        if (element) {
            element.remove();
        }
    }
    
    /**
     * Properly close modal and remove backdrop
     */
    function closeModal() {
        userModal.hide();
        
        // Force remove any lingering backdrops
        setTimeout(() => {
            const backdrops = document.querySelectorAll('.modal-backdrop');
            backdrops.forEach(backdrop => backdrop.remove());
            
            // Re-enable body scrolling
            document.body.classList.remove('modal-open');
            document.body.style.overflow = '';
            document.body.style.paddingRight = '';
        }, 100);
    }
    
    /**
     * Handle form submission
     */
    async function handleFormSubmit(e) {
        e.preventDefault();
        
        const userId = document.getElementById('user-id').value;
        const username = document.getElementById('username').value;
        const password = document.getElementById('password').value;
        const email = document.getElementById('email').value;
        const firstName = document.getElementById('firstName').value;
        const lastName = document.getElementById('lastName').value;
        
        const permissions = {
            view: document.getElementById('view-permission').checked,
            edit: document.getElementById('edit-permission').checked,
            checkIn: document.getElementById('checkin-permission').checked,
            marketing: document.getElementById('marketing-permission').checked,
            admin: document.getElementById('admin-permission').checked
        };

        // Validate at least one permission is selected
        if (!permissions.view && !permissions.edit && !permissions.checkIn && !permissions.marketing && !permissions.admin) {
            // Error goes under the whole group of permission checkboxes
            UIDialogs.fieldError(document.getElementById('admin-permission').closest('.form-check').parentElement, 'Choose at least one permission.');
            return;
        }
        
        // Collect data filters
        const filterElements = document.querySelectorAll('.data-filter-item');
        const datafilters = [];
        
        filterElements.forEach(element => {
            const date = element.querySelector('.filter-date').value;
            const event = element.querySelector('.filter-event').value;
            const eventContains = element.querySelector('.filter-eventContains').value.trim();
            const eventType = element.querySelector('.filter-eventType').value;
            
            // Only add filter if at least one field is set
            if (date || event || eventContains || eventType) {
                const filter = {};
                if (date) filter.date = date;
                if (event) filter.event = event;
                if (eventContains) filter.eventContains = eventContains;
                if (eventType) filter.eventType = eventType;
                datafilters.push(filter);
            }
        });
        
        const dataFilter = { datafilters };
        
        const userData = {
            username,
            email,
            firstName,
            lastName,
            permissions,
            dataFilter
        };
        
        // Only include password if it's set (for create or if user wants to change it)
        if (password) {
            userData.password = password;
        }
        
        try {
            const url = userId 
                ? `${API_URL}/api/users/${userId}`
                : `${API_URL}/api/users`;
            
            const method = userId ? 'PUT' : 'POST';
            
            const response = await fetch(url, {
                method: method,
                headers: {
                    ...getAuthHeaders(),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(userData)
            });
            
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            
            const data = await response.json();
            
            if (data.success) {
                closeModal();
                UIDialogs.showMessage({ type: 'success', title: userId ? 'User updated' : 'User created', message: userId ? 'The changes apply the next time they sign in.' : 'They can sign in now.' });
                loadUsers();
            } else {
                UIDialogs.showMessage({ type: 'error', title: "Couldn't save user", message: data.message || 'The user could not be saved.' });
            }
        } catch (error) {
            console.error('Error saving user:', error);
            UIDialogs.showMessage({ type: 'error', title: "Couldn't save user", message: 'Something went wrong. Please try again.', details: error.message });
        }
    }
    
    /**
     * Escape HTML to prevent XSS
     */
    function escapeHtml(text) {
        if (!text) return '';
        const div = document.createElement('div');
        div.textContent = text;
        // innerHTML leaves quotes alone; escape them so the result is also
        // safe inside an attribute value (value="...")
        return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    
    // Make functions globally accessible for onclick handlers
    window.editUser = editUser;
    window.deleteUser = deleteUser;
    window.removeDataFilter = removeDataFilter;
});
