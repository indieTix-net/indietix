// user-management.js - User Management System

document.addEventListener('DOMContentLoaded', function() {
    console.log('User Management page loaded');
    
    const API_URL = 'https://dog5g3lykx3v6knpymly6hh6cq0cgyol.lambda-url.us-east-2.on.aws';
    
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
     * Load unique events from the API
     */
    async function loadUniqueEvents() {
        try {
            const token = localStorage.getItem('authToken');
            const response = await fetch(`${API_URL}/api/unique-events`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            
            const data = await response.json();
            
            if (data.success) {
                uniqueEvents = data.events || [];
                console.log('Loaded unique events:', uniqueEvents);
            }
        } catch (error) {
            console.error('Error loading unique events:', error);
        }
    }
    
    /**
     * Load all users from the API
     */
    async function loadUsers() {
        try {
            const token = localStorage.getItem('authToken');
            const response = await fetch(`${API_URL}/api/users`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            
            const data = await response.json();
            
            if (data.success) {
                displayUsers(data.users || []);
            } else {
                console.error('Failed to load users:', data.message);
                const tbody = document.getElementById('users-tbody');
                tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: #dc3545;">Failed to load users</td></tr>';
            }
        } catch (error) {
            console.error('Error loading users:', error);
            const tbody = document.getElementById('users-tbody');
            tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: #dc3545;">Error loading users</td></tr>';
        }
    }
    
    /**
     * Display users in the table
     */
    function displayUsers(users) {
        const tbody = document.getElementById('users-tbody');
        
        if (users.length === 0) {
            tbody.innerHTML = '<tr><td colspan="9" style="text-align: center;">No users found</td></tr>';
            return;
        }
        
        tbody.innerHTML = users.map(user => {
            const permissions = user.Permissions || { view: false, edit: false };
            const dataFilters = user.DataFilter?.datafilters || [];
            const filterCount = dataFilters.length;
            const filterSummary = filterCount > 0 ? `${filterCount} filter(s)` : 'None';
            
            return `
                <tr>
                    <td>${user.ID}</td>
                    <td>${escapeHtml(user.Username)}</td>
                    <td>${escapeHtml(user.Email)}</td>
                    <td>${user.FirstName ? escapeHtml(user.FirstName) : '-'}</td>
                    <td>${user.LastName ? escapeHtml(user.LastName) : '-'}</td>
                    <td>${permissions.view ? '<span class="badge bg-success">Yes</span>' : '<span class="badge bg-secondary">No</span>'}</td>
                    <td>${permissions.edit ? '<span class="badge bg-success">Yes</span>' : '<span class="badge bg-secondary">No</span>'}</td>
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
        userModal.show();
    }
    
    /**
     * Edit an existing user
     */
    async function editUser(userId) {
        try {
            const token = localStorage.getItem('authToken');
            const response = await fetch(`${API_URL}/api/users`, {
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            
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
            
            const permissions = user.Permissions || { view: true, edit: false };
            document.getElementById('view-permission').checked = permissions.view;
            document.getElementById('edit-permission').checked = permissions.edit;
            
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
            alert('Failed to load user details');
        }
    }
    
    /**
     * Delete a user
     */
    async function deleteUser(userId, username) {
        if (!confirm(`Are you sure you want to delete user "${username}"?`)) {
            return;
        }
        
        try {
            const token = localStorage.getItem('authToken');
            const response = await fetch(`${API_URL}/api/users/${userId}`, {
                method: 'DELETE',
                headers: {
                    'Authorization': `Bearer ${token}`
                }
            });
            
            const data = await response.json();
            
            if (data.success) {
                alert('User deleted successfully');
                loadUsers();
            } else {
                alert('Failed to delete user: ' + data.message);
            }
        } catch (error) {
            console.error('Error deleting user:', error);
            alert('Error deleting user');
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
                        ${uniqueEvents.map(event => `<option value="${escapeHtml(event)}" ${existingFilter?.event === event ? 'selected' : ''}>${escapeHtml(event)}</option>`).join('')}
                    </select>
                </div>
                <div>
                    <label>Event Type</label>
                    <select class="form-select filter-eventType">
                        <option value="">-- Any --</option>
                        <option value="cinema" ${existingFilter?.eventType === 'cinema' ? 'selected' : ''}>Cinema</option>
                        <option value="live" ${existingFilter?.eventType === 'live' ? 'selected' : ''}>Live</option>
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
            edit: document.getElementById('edit-permission').checked
        };
        
        // Collect data filters
        const filterElements = document.querySelectorAll('.data-filter-item');
        const datafilters = [];
        
        filterElements.forEach(element => {
            const date = element.querySelector('.filter-date').value;
            const event = element.querySelector('.filter-event').value;
            const eventType = element.querySelector('.filter-eventType').value;
            
            // Only add filter if at least one field is set
            if (date || event || eventType) {
                const filter = {};
                if (date) filter.date = date;
                if (event) filter.event = event;
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
            const token = localStorage.getItem('authToken');
            const url = userId 
                ? `${API_URL}/api/users/${userId}`
                : `${API_URL}/api/users`;
            
            const method = userId ? 'PUT' : 'POST';
            
            const response = await fetch(url, {
                method: method,
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(userData)
            });
            
            const data = await response.json();
            
            if (data.success) {
                alert(userId ? 'User updated successfully' : 'User created successfully');
                userModal.hide();
                loadUsers();
            } else {
                alert('Failed to save user: ' + data.message);
            }
        } catch (error) {
            console.error('Error saving user:', error);
            alert('Error saving user');
        }
    }
    
    /**
     * Escape HTML to prevent XSS
     */
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }
    
    // Make functions globally accessible for onclick handlers
    window.editUser = editUser;
    window.deleteUser = deleteUser;
    window.removeDataFilter = removeDataFilter;
});
