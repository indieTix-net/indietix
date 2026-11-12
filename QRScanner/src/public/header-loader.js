// header-loader.js - Dynamic header injection with client branding and role-based menu
(function() {
    'use strict';

    const API_URL = window.INDIETIX_API_URL;
    const CACHE_KEY = 'client_branding_cache';
    const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes in milliseconds
    
    /**
     * Page access map.
     *
     * Each entry describes who can access that page.
     *   clientOnly: true   → only clients (userType === 'client'), regardless of
     *                        permissions -- UNLESS perms is also present, in
     *                        which case sub-users with any of those perms get
     *                        in too (client OR matching perm).
     *   public: true       → no auth required (e.g. login page)
     *   perms: [...]       → sub-users need ANY of these permission flags set true.
     *                        Clients always have access to non-clientOnly pages.
     *
     * Keep the keys in sync with files in /public.
     */
    const PAGE_ACCESS = {
        '/':                       { perms: ['view', 'edit', 'checkIn'] },
        '/index.html':             { perms: ['view', 'edit', 'checkIn'] },
        '/products.html':          { perms: ['view', 'edit', 'checkIn'] },
        '/dashboard.html':         { perms: ['view', 'edit', 'checkIn'] },
        '/order.html':             { perms: ['view', 'edit'] },
        '/reports.html':           { perms: ['view', 'edit'] },
        '/box-office-reports.html': { perms: ['edit'] },
        '/insights.html':          { perms: ['admin'] },
        '/getMovieInfo.html':      { perms: ['edit'] },
        '/getEventInfo.html':      { perms: ['edit'] },
        '/marketing.html':         { perms: ['marketing'] },
        '/marketing-posts.html':   { perms: ['marketing'] },
        '/email-list.html':        { perms: ['marketing'] },
        '/user-management.html':   { clientOnly: true },
        '/client.html':            { clientOnly: true },
        '/privacy-requests.html':  { clientOnly: true },
        '/login.html':             { public: true },
        '/login':                  { public: true },
        '/reset-password.html':    { public: true }
    };
    
    /**
     * Master menu definition. The header builder filters this list based on
     * the current user's access. Order here is the display order.
     */
    const MENU_ITEMS = [
        { href: '/dashboard.html',        label: 'Today\u2019s Dashboard',         perms: ['view', 'edit', 'checkIn'] },
        { href: '/',                      label: 'Ticket Scanner',                perms: ['view', 'edit', 'checkIn'] },
        { href: '/products.html',         label: 'Manual Checkin / List Tickets', perms: ['view', 'edit', 'checkIn'] },
        { href: '/order.html',            label: 'List Orders',                   perms: ['view', 'edit'] },
        { href: '/reports.html',          label: 'Event Report',                  perms: ['view', 'edit'] },
        { href: '/box-office-reports.html', label: 'Box Office Reports',          perms: ['edit'] },
        { href: '/insights.html',         label: 'Insights',                      perms: ['admin'] },
        { href: '/getMovieInfo.html',     label: 'Movie Info Lookup',             perms: ['edit'] },
        { href: '/getEventInfo.html',     label: 'Event Info Entry',              perms: ['edit'] },
        { href: '/marketing.html',        label: 'Marketing Schedule',            perms: ['marketing'] },
        { href: '/marketing-posts.html',  label: 'Marketing Posts',               perms: ['marketing'] },
        { href: '/email-list.html',       label: 'Email List',                    perms: ['marketing'] },
        { href: '/user-management.html',  label: 'User Management',               clientOnly: true },
        { href: '/client.html',           label: 'Client Settings',               clientOnly: true },
        { href: '/help/index.html',       label: 'Help' }                         // public guide, for everyone
    ];
    
    /**
     * Get authentication headers for API calls
     */
    function getAuthHeaders() {
        const token = localStorage.getItem('authToken');
        return {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        };
    }
    
    /**
     * Decode JWT token to get user type
     */
    function getUserType() {
        const token = localStorage.getItem('authToken');
        if (!token) return null;
        
        try {
            const payload = JSON.parse(atob(token.split('.')[1]));
            return payload.userType || null; // 'client' or 'user'
        } catch (error) {
            console.error('Error decoding token:', error);
            return null;
        }
    }
    
    /**
     * Decode JWT token to get sub-user permissions.
     * Returns a normalized object — missing flags read as false.
     * For client users (who don't carry per-permission flags), this still
     * returns all-false; callers should check isClientUser() first.
     */
    function getPermissions() {
        const defaults = { view: false, edit: false, checkIn: false, marketing: false, admin: false };
        const token = localStorage.getItem('authToken');
        if (!token) return defaults;

        try {
            const payload = JSON.parse(atob(token.split('.')[1]));
            const perms = payload.permissions || {};
            return {
                view:      perms.view      === true,
                edit:      perms.edit      === true,
                checkIn:   perms.checkIn   === true,
                marketing: perms.marketing === true,
                admin:     perms.admin     === true
            };
        } catch (error) {
            console.error('Error decoding permissions from token:', error);
            return defaults;
        }
    }
    
    /**
     * Check if current user is a client (not a sub-user)
     */
    function isClientUser() {
        return getUserType() === 'client';
    }
    
    /**
     * Determine the appropriate landing page for the current user based on
     * their userType + permissions. Used both for the page guard's redirect
     * target and for login.js's post-login redirect.
     *
     * Rules:
     *   - Clients land on /order.html
     *   - Sub-users with edit OR view land on /order.html
     *   - Sub-users with only checkIn land on /index.html
     *   - Anyone without any of the above (shouldn't happen, but defensive)
     *     gets sent back to /login.html
     */
    function getLandingPage() {
        if (!localStorage.getItem('authToken')) return '/login.html';
        
        if (isClientUser()) return '/order.html';
        
        const perms = getPermissions();
        if (perms.edit || perms.view) return '/order.html';
        if (perms.checkIn) return '/index.html';
        
        return '/login.html';
    }
    
    /**
     * Look up a page's access rule by path. Handles trailing slashes and
     * unknown paths gracefully (unknown paths default to "allow" — change
     * the default below if you'd rather lock down by default).
     */
    function getPageRule(path) {
        // Normalize: strip query/hash, keep just the path
        const clean = path.split('?')[0].split('#')[0];
        if (PAGE_ACCESS[clean]) return PAGE_ACCESS[clean];
        
        // '/index.html' and '/' are equivalent in practice
        if (clean === '/' || clean === '') return PAGE_ACCESS['/'];
        
        // Unknown page → permissive default. Switch to a deny rule
        // ({perms:['edit']} etc.) if you want strict allow-listing.
        return null;
    }
    
    /**
     * Decide whether the current user can access a given page rule.
     */
    function canAccessRule(rule) {
        if (!rule) return true;             // unknown page → allow (see getPageRule)
        if (rule.public) return true;
        
        // Anything past here requires a token
        if (!localStorage.getItem('authToken')) return false;
        
        if (rule.clientOnly) {
            if (isClientUser()) return true;
            // A clientOnly page can still list perms as an additional allowed
            // path for sub-users (e.g. clientOnly + perms: ['admin']) -- fall
            // through to the perms check below instead of denying outright.
            if (!rule.perms || rule.perms.length === 0) return false;
        } else if (isClientUser()) {
            // Clients see everything that isn't explicitly clientOnly
            return true;
        }
        
        // Sub-users: must have at least one matching permission flag
        if (!rule.perms || rule.perms.length === 0) return true;
        const perms = getPermissions();
        return rule.perms.some(p => perms[p] === true);
    }
    
    /**
     * Page guard: if the current page is off-limits for this user, bounce
     * them to their landing page. Runs synchronously at script load so it
     * fires before the page paints content.
     */
    function enforcePageAccess() {
        const path = window.location.pathname;
        const rule = getPageRule(path);
        
        // Public pages (login, reset-password): never bounce
        if (rule && rule.public) return;
        
        // No token at all on a protected page? Let the page's own auth
        // helper handle login redirect — don't double-redirect here.
        if (!localStorage.getItem('authToken')) return;
        
        if (!canAccessRule(rule)) {
            const target = getLandingPage();
            // Avoid redirect loops if landing page somehow points at the
            // current page (shouldn't happen with the rules above, but
            // defensive).
            if (target && target !== path) {
                console.warn(`Page ${path} not accessible for this user — redirecting to ${target}`);
                window.location.replace(target);
            }
        }
    }
    
    // Run the guard immediately, before any header injection or content paint.
    // Skip on the login page itself so we don't fight with login flow.
    enforcePageAccess();
    
    /**
     * Get cached branding data from localStorage
     */
    function getCachedBranding() {
        try {
            const cached = localStorage.getItem(CACHE_KEY);
            if (!cached) return null;
            
            const { data, timestamp } = JSON.parse(cached);
            const now = Date.now();
            
            // Check if cache is still valid (within 30 minutes)
            if (now - timestamp < CACHE_DURATION) {
                console.log('Using cached branding data');
                return data;
            } else {
                console.log('Cached branding data expired, will fetch fresh data');
                localStorage.removeItem(CACHE_KEY);
                return null;
            }
        } catch (error) {
            console.warn('Error reading branding cache:', error);
            localStorage.removeItem(CACHE_KEY);
            return null;
        }
    }
    
    /**
     * Cache branding data to localStorage
     */
    function cacheBranding(data) {
        try {
            const cacheData = {
                data: data,
                timestamp: Date.now()
            };
            localStorage.setItem(CACHE_KEY, JSON.stringify(cacheData));
            console.log('Branding data cached successfully');
        } catch (error) {
            console.warn('Error caching branding data:', error);
        }
    }
    
    /**
     * Fetch branding configuration from API
     */
    async function fetchBrandingConfig() {
        // Check cache first
        const cached = getCachedBranding();
        if (cached) {
            return cached;
        }
        
        try {
            console.log('Fetching fresh branding data from API');
            const response = await fetch(`${API_URL}/api/client/branding`, {
                headers: getAuthHeaders()
            });
            
            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${response.statusText}`);
            }
            
            const data = await response.json();
            
            if (data.success && data.branding) {
                // Cache the successful response
                cacheBranding(data.branding);
                return data.branding;
            } else {
                throw new Error(data.message || 'Failed to load branding configuration');
            }
        } catch (error) {
            console.error('Error fetching branding config:', error);
            // Return default fallback values
            const defaultBranding = {
                webHeaderCompany: 'IndieTix',
                logoFile: 'indieTixLogo.png',
                theaterName: '',
                clientID: 'default'
            };
            
            // Cache the fallback for a shorter time (5 minutes) to retry sooner
            try {
                const shortCacheData = {
                    data: defaultBranding,
                    timestamp: Date.now() - (CACHE_DURATION - 5 * 60 * 1000) // Expires in 5 minutes
                };
                localStorage.setItem(CACHE_KEY, JSON.stringify(shortCacheData));
            } catch (cacheError) {
                // Ignore cache errors for fallback data
            }
            
            return defaultBranding;
        }
    }
    
    /**
     * Build the nav menu HTML, filtered by the current user's access.
     */
    function buildMenuHtml() {
        const isClient = isClientUser();
        const perms = getPermissions();
        
        const visible = MENU_ITEMS.filter(item => {
            if (item.clientOnly) {
                if (isClient) return true;
                // clientOnly items can still list perms as an additional
                // allowed path for sub-users (e.g. clientOnly + perms: ['admin']).
                if (!item.perms || item.perms.length === 0) return false;
            } else if (isClient) {
                return true;                                     // clients see all non-clientOnly
            }
            if (!item.perms || item.perms.length === 0) return true;
            return item.perms.some(p => perms[p] === true);
        });
        
        return visible
            .map(item => `<a href="${item.href}" class="nav-link">${item.label}</a>`)
            .join('\n');
    }
    
    /**
     * Get inline header template with role-based menu items
     */
    function getHeaderTemplate() {
        const menuItems = buildMenuHtml();
        
        return `
            <div id="app-header" style="background: white; border-radius: 8px; padding: 0 0 0 0; padding-top: 20px; margin-bottom: 20px; border-bottom: 3px solid #000; position: relative;">
                <button id="header-collapse-toggle" class="header-collapse-toggle" type="button" aria-label="Collapse header" title="Collapse header">
                    <span class="collapse-label">Hide</span>
                    <span class="collapse-icon" aria-hidden="true">&#9650;</span>
                </button>
                
                <div id="header-content-wrapper">
                    <div style="text-align: center; padding-bottom: 15px;">	
                        <img id="header-logo" src="indieTixLogo.png" alt="Company Logo" style="max-width: 200px; margin-bottom: 15px;">
                        <h2 id="header-title" style="margin-bottom: 2px; color: var(--lh-heading, #333);">Event Scanner</h2>
                        <h5 id="header-company" style="margin-top: 0px; color: var(--lh-muted, #666);">IndieTix</h5>
                    </div>
                    
                    <div style="padding-top: 0px; margin-top: 10px;"></div>
                    
                    <button id="mobile-menu-toggle" class="mobile-menu-toggle" aria-label="Toggle menu">
                        <span></span>
                        <span></span>
                        <span></span>
                    </button>
                    
                    <div class="header-controls" id="main-nav" style="display: flex; flex-wrap: wrap; justify-content: center; gap: 5px; padding: 0 15px;">
                        <div id="user-info" style="display: none;"></div>
                        ${menuItems}
                    </div>
                </div>
                
                <div id="header-collapsed-bar" class="header-collapsed-bar">
                    <span class="collapsed-page-title">${getPageTitle()}</span>
                </div>
            </div>
        `;
    }
    
    /**
     * Determine page title based on current URL
     */
    function getPageTitle() {
        const path = window.location.pathname;
        const pageTitle = {
            '/': 'Event Scanner',
            '/index.html': 'Event Scanner',
            '/dashboard.html': 'Today\u2019s Shows',
            '/products.html': 'Manual Checkin',
            '/order.html': 'Orders',
            '/reports.html': 'Event Report',
            '/client.html': 'Client Settings',
            '/user-management.html': 'User Management',
            '/getMovieInfo.html': 'Movie Info Lookup',
	    '/getEventInfo.html': 'Event Info Creation',
            '/insights.html': 'Reporting Insights',
            '/marketing.html': 'Marketing Schedule',
            '/marketing-posts.html': 'Marketing Posts',
            '/box-office-reports.html': 'Box Office Reports',
            '/email-list.html': 'Email List',
            '/privacy-requests.html': 'Privacy Requests'
        };
        
        return pageTitle[path] || 'Event Scanner';
    }
    
    /**
     * Populate header template with branding data
     */
    function populateHeader(template, branding) {
        const parser = new DOMParser();
        const doc = parser.parseFromString(template, 'text/html');
        
        // Update logo
        const logoImg = doc.querySelector('#header-logo');
        if (logoImg) {
            logoImg.src = branding.logoFile;
            logoImg.alt = `${branding.webHeaderCompany} Logo`;
        }
        
        // Update page title 
        const titleElement = doc.querySelector('#header-title');
        if (titleElement) {
            const pageTitle = getPageTitle();
            titleElement.textContent = branding.webHeaderCompany? 
                `${branding.webHeaderCompany} ${pageTitle}` : pageTitle;
        }
        
        // Update company name
        const companyElement = doc.querySelector('#header-company');
        if (companyElement) {
            //companyElement.textContent = branding.webHeaderCompany;
            companyElement.textContent = "IndieTix";
        }
        
        return doc.body.innerHTML;
    }
    
    
    /**
     * Inject the CSS rules that drive the collapse/expand behaviour. Self-
     * contained in this file so we don't have to edit every page's
     * stylesheet — matches the existing pattern of the loader being
     * standalone. Idempotent: only adds the <style> block once even if
     * injectHeader runs multiple times.
     */
    function injectCollapseStyles() {
        if (document.getElementById('header-collapse-styles')) return;
        
        const style = document.createElement('style');
        style.id = 'header-collapse-styles';
        style.textContent = `
            #app-header {
                transition: padding 0.2s ease, margin-bottom 0.2s ease;
            }
            
            .header-collapse-toggle {
                position: absolute;
                top: 8px;
                right: 10px;
                background: transparent;
                border: 1px solid #ccc;
                border-radius: 4px;
                padding: 4px 10px;
                cursor: pointer;
                font-size: 12px;
                color: var(--lh-muted, #555);
                display: inline-flex;
                align-items: center;
                gap: 6px;
                line-height: 1;
                z-index: 10;
                user-select: none;
            }
            .header-collapse-toggle:hover {
                background: rgba(255, 255, 255, 0.08);
                border-color: #999;
                color: var(--lh-heading, #222);
            }
            .header-collapse-toggle .collapse-icon {
                font-size: 9px;
                display: inline-block;
                transition: transform 0.2s ease;
            }
            
            /* Collapsed bar is hidden by default; only shown when the header
               carries the .collapsed class. Symmetric horizontal padding
               leaves room for the absolute-positioned toggle button on the
               right while keeping the centered title visually centered. */
            .header-collapsed-bar {
                display: none;
                text-align: center;
                padding: 8px 90px;
                color: var(--lh-text, #444);
                font-size: 14px;
                font-weight: 500;
            }
            
            #app-header.collapsed {
                padding-top: 0 !important;
                margin-bottom: 8px !important;
            }
            #app-header.collapsed #header-content-wrapper {
                display: none;
            }
            #app-header.collapsed .header-collapsed-bar {
                display: block;
            }
            #app-header.collapsed .header-collapse-toggle {
                top: 6px;
            }
            #app-header.collapsed .header-collapse-toggle .collapse-icon {
                transform: rotate(180deg);
            }
            
            /* On very narrow screens, the "Hide"/"Show" word eats space we
               don't have. Drop it and let the icon carry the meaning. */
            @media (max-width: 480px) {
                .header-collapse-toggle .collapse-label {
                    display: none;
                }
                .header-collapsed-bar {
                    padding: 8px 50px;
                    font-size: 13px;
                }
            }
        `;
        document.head.appendChild(style);
    }
    
    /**
     * Wire up the collapse toggle: read the saved preference from
     * localStorage, apply it, and bind the click handler. Called every time
     * a header is injected (since the header DOM is replaced on each page
     * load), but the persisted state means the user's choice carries over
     * across pages and reloads.
     */
    function initializeCollapseToggle() {
        const COLLAPSE_KEY = 'header_collapsed';
        
        const header = document.getElementById('app-header');
        const toggleBtn = document.getElementById('header-collapse-toggle');
        
        if (!header || !toggleBtn) {
            console.log('Header collapse elements not found');
            return;
        }
        
        function applyState(isCollapsed) {
            header.classList.toggle('collapsed', isCollapsed);
            const label = toggleBtn.querySelector('.collapse-label');
            if (label) label.textContent = isCollapsed ? 'Show' : 'Hide';
            const newTitle = isCollapsed ? 'Expand header' : 'Collapse header';
            toggleBtn.title = newTitle;
            toggleBtn.setAttribute('aria-label', newTitle);
            toggleBtn.setAttribute('aria-expanded', String(!isCollapsed));
        }
        
        // Apply saved preference on each injection.
        applyState(localStorage.getItem(COLLAPSE_KEY) === 'true');
        
        toggleBtn.addEventListener('click', function() {
            const willCollapse = !header.classList.contains('collapsed');
            applyState(willCollapse);
            try {
                localStorage.setItem(COLLAPSE_KEY, String(willCollapse));
            } catch (e) {
                // localStorage can fail in private mode / quota; the
                // toggle still works for this session even if we can't
                // remember the preference.
                console.warn('Could not persist header collapse state:', e);
            }
        });
        
        console.log('Header collapse toggle initialized');
    }
    
    /**
     * Initialize mobile menu toggle functionality
     */
    function initializeMobileMenuToggle() {
        const toggleButton = document.getElementById('mobile-menu-toggle');
        const mainNav = document.getElementById('main-nav');
        
        if (!toggleButton || !mainNav) {
            console.log('Mobile menu elements not found');
            return;
        }
        
        // Toggle menu visibility
        toggleButton.addEventListener('click', function() {
            const isOpen = mainNav.classList.contains('mobile-menu-open');
            
            if (isOpen) {
                mainNav.classList.remove('mobile-menu-open');
                toggleButton.classList.remove('menu-open');
            } else {
                mainNav.classList.add('mobile-menu-open');
                toggleButton.classList.add('menu-open');
            }
        });
        
        // Close menu when clicking a nav link (mobile only)
        const navLinks = mainNav.querySelectorAll('.nav-link');
        navLinks.forEach(link => {
            link.addEventListener('click', function() {
                if (window.innerWidth <= 768) {
                    mainNav.classList.remove('mobile-menu-open');
                    toggleButton.classList.remove('menu-open');
                }
            });
        });
        
        console.log('Mobile menu toggle initialized');
    }
    
    /**
     * Inject header into the specified container
     */
    async function injectHeader(containerId = 'header-container') {
        console.log('Loading dynamic header...');
        
        const container = document.getElementById(containerId);
        if (!container) {
            console.error(`Header container '${containerId}' not found`);
            return false;
        }
        
        // Make sure the collapse styles are present in <head> before any
        // header markup is injected. Function is idempotent.
        injectCollapseStyles();
        
        try {
            // Get branding config (from cache or API)
            const branding = await fetchBrandingConfig();
            console.log('Branding config loaded:', branding);
            console.log('User type:', getUserType());
            console.log('Is client user:', isClientUser());
            console.log('Permissions:', getPermissions());
            
            // Get template and populate with branding data
            const template = getHeaderTemplate();
            const populatedHeader = populateHeader(template, branding);
            
            // Inject into container
            container.innerHTML = populatedHeader;
            
            // Show the header (in case it was hidden)
            const headerElement = container.querySelector('#app-header');
            if (headerElement) {
                headerElement.style.display = 'block';
            }
            
            // Initialize mobile menu toggle
            initializeMobileMenuToggle();
            
            // Wire up collapse/expand toggle and apply saved preference.
            initializeCollapseToggle();
            
            console.log('Dynamic header loaded successfully');
            return true;
            
        } catch (error) {
            console.error('Error loading header:', error);
            
            // Fallback header — also permission-aware so a sub-user without
            // edit doesn't see Movie/Event entry links even in the fallback.
            const fallbackMenuItems = buildMenuHtml();
            
            container.innerHTML = `
                <div id="app-header" style="background: white; padding: 0 0 0 0; border-radius: 8px; padding-top: 20px; margin-bottom: 20px; border-bottom: 3px solid #000; position: relative;">
                    <button id="header-collapse-toggle" class="header-collapse-toggle" type="button" aria-label="Collapse header" title="Collapse header">
                        <span class="collapse-label">Hide</span>
                        <span class="collapse-icon" aria-hidden="true">&#9650;</span>
                    </button>
                    
                    <div id="header-content-wrapper">
                        <div style="text-align: center; padding-bottom: 15px;">	
                            <img src="indieTixLogo.png" alt="Logo" style="max-width: 200px; margin-bottom: 15px;">
                            <h2 style="margin-bottom: 2px; color: var(--lh-heading, #333);">${getPageTitle()}</h2>
                            <h5 style="margin-top: 0px; color: var(--lh-muted, #666);">IndieTix</h5>
                        </div>
                        
                        <div style="padding-top: 0px; margin-top: 10px;"></div>
                        
                        <button id="mobile-menu-toggle" class="mobile-menu-toggle" aria-label="Toggle menu">
                            <span></span>
                            <span></span>
                            <span></span>
                        </button>
                        
                        <div class="header-controls" id="main-nav" style="display: flex; flex-wrap: wrap; justify-content: center; gap: 5px; padding: 0 15px;">
                            <div id="user-info" style="display: none;"></div>
                            ${fallbackMenuItems}
                        </div>
                    </div>
                    
                    <div id="header-collapsed-bar" class="header-collapsed-bar">
                        <span class="collapsed-page-title">${getPageTitle()}</span>
                    </div>
                </div>
            `;
            
            // Initialize mobile menu toggle
            initializeMobileMenuToggle();
            
            // Wire up collapse/expand toggle and apply saved preference.
            initializeCollapseToggle();
            
            return false;
        }
    }
    
    /**
     * Ensure every protected page has a working logout button in its
     * footer. Several pages already build their own (index.html,
     * order.html, client.html, products.html, dashboard.html,
     * reports.html) -- this only fills the gap on pages that don't,
     * without creating a duplicate on the ones that do.
     */
    function ensureLogoutButton() {
        const rule = getPageRule(window.location.pathname);
        if (rule && rule.public) return;               // no logout needed on public pages
        if (!localStorage.getItem('authToken')) return; // nothing to log out of

        let footer = document.querySelector('.footer');
        if (!footer) {
            footer = document.createElement('div');
            footer.className = 'footer';
            footer.style.textAlign = 'center';
            document.body.appendChild(footer);
        }

        if (footer.querySelector('.logout-button')) return; // page already has its own

        const logoutButton = document.createElement('button');
        logoutButton.textContent = 'Logout';
        logoutButton.className = 'logout-button';
        logoutButton.onclick = () => {
            if (window.authHelper) {
                window.authHelper.logout('Manual logout');
            } else {
                localStorage.removeItem('authToken');
                window.location.href = 'login.html';
            }
        };
        footer.appendChild(logoutButton);
    }

    /**
     * Initialize header when DOM is ready
     */
    function initializeHeader(containerId) {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                injectHeader(containerId);
                ensureLogoutButton();
            });
        } else {
            injectHeader(containerId);
            ensureLogoutButton();
        }
    }
    
    /**
     * Clear the branding cache (useful when client updates settings)
     */
    function clearCache() {
        localStorage.removeItem(CACHE_KEY);
        console.log('Branding cache cleared');
    }
    
    // ---- MODALS TO BODY ----
    // .page-wrapper (style.css) is position:relative + z-index:1, which makes
    // it a stacking context: any Bootstrap modal inside it can never paint
    // above Bootstrap's backdrop, which is appended to <body> at z-index
    // ~1040. The modal shows through the dim layer but every click lands on
    // the backdrop, so OK/close can't be pressed. Moving each modal to be a
    // direct child of <body> restores Bootstrap's normal stacking. Moving
    // keeps the element, its listeners, and any Modal instance intact.
    function moveModalsToBody() {
        document.querySelectorAll('.modal').forEach((modal) => {
            if (modal.parentElement !== document.body) {
                document.body.appendChild(modal);
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', moveModalsToBody);
    } else {
        moveModalsToBody();
    }
    // ---- END MODALS TO BODY ----

    // Expose functions globally
    window.HeaderLoader = {
        injectHeader,
        initializeHeader,
        fetchBrandingConfig,
        clearCache,
        getUserType,
        isClientUser,
        getPermissions,
        getLandingPage
    };
    
    console.log('Header loader initialized with persistent caching and role-based menus');
})();
