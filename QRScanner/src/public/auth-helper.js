// auth-helper.js - JWT Token Management and Auto-logout
class AuthHelper {
    constructor(apiUrl = '') {
        this.API_URL = apiUrl;
        this.checkInterval = null;
        this.isCheckingToken = false;
        this.lastHealthStatus = null; // Track last health check result
        
        // Start monitoring when the helper is created
        this.startTokenMonitoring();
        
        // Check token when user returns to tab
        this.setupVisibilityListener();
        
        // Check token when user interacts with page
        this.setupActivityListener();
    }
    
    // Decode JWT token to check expiration
    isTokenExpired(token) {
        if (!token) return true;
        
        try {
            const payload = JSON.parse(atob(token.split('.')[1]));
            const currentTime = Math.floor(Date.now() / 1000);
            
            // Check if token expires within the next 60 seconds (buffer time)
            return payload.exp < (currentTime + 60);
        } catch (error) {
            console.error('Error decoding token:', error);
            return true;
        }
    }
    
    // Get fresh token from localStorage
    getToken() {
        return localStorage.getItem('authToken');
    }
    
    // Check if user is authenticated
    isAuthenticated() {
        const token = this.getToken();
        return token && !this.isTokenExpired(token);
    }
    
    // Logout user and redirect to login
    logout(reason = 'Session expired') {
        console.log('Logging out user:', reason);
        localStorage.removeItem('authToken');
        
        // Show a brief message before redirect
        if (reason === 'Session expired') {
            alert('Your session has expired. Please log in again.');
        }
        
        window.location.href = 'login.html';
    }
    
    // Update API status display on page
    updateApiStatusDisplay(isConnected, data = null, error = null) {
        const apiStatus = document.getElementById("api-status");
        if (!apiStatus) return; // Element doesn't exist on this page
        
        if (isConnected && data) {
            apiStatus.textContent = `API Status: Connected (${data.timestamp})`;
            apiStatus.style.color = 'green';
        } else if (error) {
            apiStatus.textContent = `API Status: Error (${error.message})`;
            apiStatus.style.color = 'red';
        } else {
            apiStatus.textContent = 'API Status: Checking...';
            apiStatus.style.color = '#666';
        }
    }
    
    // Verify token with server
    async verifyTokenWithServer() {
        if (this.isCheckingToken) return true; // Avoid multiple simultaneous checks
        
        const token = this.getToken();
        if (!token) {
            this.logout('No token found');
            return false;
        }
        
        // First check local expiration
        if (this.isTokenExpired(token)) {
            this.logout('Token expired');
            return false;
        }
        
        this.isCheckingToken = true;
        
        // Update status display to show checking state
        this.updateApiStatusDisplay(false);
        
        try {
            const response = await fetch(`${this.API_URL}/api/health`, {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${token}`
                }
            });
            
            this.isCheckingToken = false;
            
            if (response.status === 401 || response.status === 403) {
                this.updateApiStatusDisplay(false, null, { message: 'Authentication failed' });
                this.logout('Token no longer valid');
                return false;
            }
            
            if (!response.ok) {
                console.warn('Health check failed, but token might still be valid');
                this.updateApiStatusDisplay(false, null, { message: `Server error (${response.status})` });
                return true; // Don't logout on server errors
            }
            
            const data = await response.json();
            this.lastHealthStatus = { connected: true, data };
            this.updateApiStatusDisplay(true, data);
            return true;
            
        } catch (error) {
            this.isCheckingToken = false;
            console.error('Token verification failed:', error);
            this.lastHealthStatus = { connected: false, error };
            this.updateApiStatusDisplay(false, null, error);
            // Don't logout on network errors, just log the issue
            return true;
        }
    }
    
    // Get last health status (for other parts of app to use)
    getLastHealthStatus() {
        return this.lastHealthStatus;
    }
    
    // Start periodic token checking
    startTokenMonitoring() {
        // Check every 5 minutes
        this.checkInterval = setInterval(() => {
            if (document.visibilityState === 'visible') {
                this.verifyTokenWithServer();
            }
        }, 5 * 60 * 1000);
        
        // Initial check - do immediately instead of waiting 1 second
        this.verifyTokenWithServer();
    }
    
    // Stop monitoring (cleanup)
    stopTokenMonitoring() {
        if (this.checkInterval) {
            clearInterval(this.checkInterval);
            this.checkInterval = null;
        }
    }
    
    // Check token when user returns to tab
    setupVisibilityListener() {
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                // User returned to tab, check token
                setTimeout(() => this.verifyTokenWithServer(), 500);
            }
        });
    }
    
    // Check token on user activity (optional)
    setupActivityListener() {
        let activityTimeout;
        
        const checkOnActivity = () => {
            clearTimeout(activityTimeout);
            activityTimeout = setTimeout(() => {
                if (document.visibilityState === 'visible') {
                    this.verifyTokenWithServer();
                }
            }, 30000); // Check 30 seconds after user stops activity
        };
        
        // Listen for user activity
        ['mousedown', 'keydown', 'scroll', 'touchstart'].forEach(event => {
            document.addEventListener(event, checkOnActivity, true);
        });
    }
    
    // Intercept fetch calls to handle 401/403 responses
    setupFetchInterceptor() {
        const originalFetch = window.fetch;
        
        window.fetch = async (...args) => {
            const response = await originalFetch(...args);
            
            // If we get 401/403, check if it's due to expired token
            if ((response.status === 401 || response.status === 403) && 
                args[0].includes(this.API_URL)) {
                
                const token = this.getToken();
                if (!token || this.isTokenExpired(token)) {
                    this.logout('Authentication failed');
                }
            }
            
            return response;
        };
    }
    
    // Get auth headers (improved version)
    getAuthHeaders() {
        const token = this.getToken();
        if (!token || this.isTokenExpired(token)) {
            this.logout('Token expired during request');
            return {};
        }
        
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        };
    }
    
    // Enhanced fetch with automatic token checking
    async authenticatedFetch(url, options = {}) {
        if (!this.isAuthenticated()) {
            this.logout('Not authenticated');
            throw new Error('Not authenticated');
        }
        
        const headers = {
            ...options.headers,
            ...this.getAuthHeaders()
        };
        
        try {
            const response = await fetch(url, { ...options, headers });
            
            if (response.status === 401 || response.status === 403) {
                this.logout('Authentication failed');
                throw new Error('Authentication failed');
            }
            
            return response;
        } catch (error) {
            if (error.message === 'Authentication failed') {
                throw error;
            }
            // Re-throw other errors
            throw error;
        }
    }
}

// Initialize the auth helper globally
let authHelper;

// Define getAuthHeaders globally immediately (before DOMContentLoaded)
window.getAuthHeaders = function() {
    if (authHelper) {
        return authHelper.getAuthHeaders();
    } else {
        // Fallback method if auth helper isn't ready yet
        const token = localStorage.getItem('authToken');
        return {
            'Content-Type': 'application/json',
            'Authorization': token ? `Bearer ${token}` : ''
        };
    }
};

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
    // Only initialize on pages that need authentication (not login page)
    if (!window.location.pathname.includes('login.html')) {
        const API_URL = window.INDIETIX_API_URL;
        authHelper = new AuthHelper(API_URL);
        
        // Set up fetch interceptor
        authHelper.setupFetchInterceptor();
        
        // Make auth helper available globally
        window.authHelper = authHelper;
        
        // The getAuthHeaders function is already defined above and will now use authHelper
        console.log('🔐 Auth helper initialized and getAuthHeaders is ready');
    }
});

// Cleanup when page is unloaded
window.addEventListener('beforeunload', () => {
    if (authHelper) {
        authHelper.stopTokenMonitoring();
    }
});

// Export for use in other modules if needed
if (typeof module !== 'undefined' && module.exports) {
    module.exports = AuthHelper;
}
